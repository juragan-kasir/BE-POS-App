process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let location = null
let category = null
let product = null
let adminToken = null

const receivedPO = async (qty) => {
  const poRes = await request(app)
    .post('/purchase-order/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      store: location.id,
      status: 'ordered',
      items: [{ product: product.id, quantity: qty, price: 5000 }]
    })
  const poItemId = poRes.body.data.items[0].id

  await request(app)
    .put(`/purchase-order/receive/${poRes.body.data.id}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ items: [{ id: poItemId, product: product.id, receivedQuantity: qty }] })

  return poRes.body.data
}

beforeAll(async () => {
  location = await db.location.create({ name: 'PR_REJECT_STORE', status: 'active' })
  category = await db.category.create({ name: 'PR_REJECT_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'PR_REJECT_PRODUCT',
    category: category.id,
    price: 8000,
    costPrice: 5000,
    stock: 0
  })
  await db.product_store_stock.create({ product: product.id, store: location.id, stock: 0 })

  // purchase_return.createdBy FKs to user.id — the token subject needs a
  // real user row.
  const adminUser = await db.user.create({
    userName: 'admin_pr_reject',
    email: 'admin_pr_reject@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: location.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: location.id },
    JWT_SECRET
  )
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed the rate
  // so these reject-flow assertions exercise configured tax.
  await db.taxConfig.create({
    name: 'PR_REJECT_PPN',
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: location.id
  })
  // P1 (DR-PAY-ATTR-02): counter sales under test require an open register.
  await db.cashRegister.create({ store: location.id, user: adminUser.id, status: 'open', openingBalance: 0, openedAt: new Date() })
})

afterAll(async () => {
  await db.cashRegister.destroy({ where: { store: location?.id }, force: true })
  await db.taxConfig.destroy({ where: { store: location?.id }, force: true })
  await db.product_batch_stock.destroy({ where: {}, force: true })
  await db.product_batch.destroy({ where: { product: product?.id }, force: true })
  await db.stock_history.destroy({ where: { product: product?.id }, force: true })
  await db.best_selling.destroy({ where: { productId: product?.id }, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: location.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product?.id }, force: true })
  await db.purchase_return_item.destroy({ where: {}, force: true })
  await db.purchase_return.destroy({ where: { store: location.id }, force: true })
  await db.purchase_order_item.destroy({ where: {}, force: true })
  await db.purchase_order.destroy({ where: { store: location.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { userName: 'admin_pr_reject' }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

describe('Purchase return reject — restores stock via the shared, locked, atomic-delta helper', () => {
  test('rejecting a pending return restores stock and writes an accurate audit row', async () => {
    await receivedPO(20)
    const beforeReturn = await db.product.findByPk(product.id)

    const returnRes = await request(app)
      .post('/purchase-return/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        purchaseOrder: (await db.purchase_order.findOne({ where: { store: location.id }, order: [['id', 'DESC']] })).id,
        reason: 'Damaged goods',
        items: [{ productId: product.id, qty: 6 }]
      })
    expect(returnRes.status).toBe(201)

    const afterReturnCreate = await db.product.findByPk(product.id)
    expect(Number(afterReturnCreate.stock)).toBe(Number(beforeReturn.stock) - 6)

    const rejectRes = await request(app)
      .patch(`/purchase-return/reject/${returnRes.body.data.id}`)
      .set('Authorization', `Bearer ${adminToken}`)

    expect(rejectRes.status).toBe(200)

    const afterReject = await db.product.findByPk(product.id)
    expect(Number(afterReject.stock)).toBe(Number(beforeReturn.stock))

    const history = await db.stock_history.findAll({
      where: { product: product.id, referenceType: 'adjustment' },
      order: [['id', 'ASC']]
    })
    expect(history.length).toBe(1)
    expect(Number(history[0].quantityBefore)).toBe(Number(afterReturnCreate.stock))
    expect(Number(history[0].quantityChange)).toBe(6)
    expect(Number(history[0].quantityAfter)).toBe(Number(beforeReturn.stock))
  })

  test('reject racing a concurrent sale on the same product: neither effect is lost', async () => {
    await receivedPO(30)
    const beforeReturn = await db.product.findByPk(product.id)

    const returnRes = await request(app)
      .post('/purchase-return/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        purchaseOrder: (await db.purchase_order.findOne({ where: { store: location.id }, order: [['id', 'DESC']] })).id,
        reason: 'Wrong item',
        items: [{ productId: product.id, qty: 4 }]
      })
    const afterReturnCreate = await db.product.findByPk(product.id)

    const [rejectRes, saleRes] = await Promise.all([
      request(app)
        .patch(`/purchase-return/reject/${returnRes.body.data.id}`)
        .set('Authorization', `Bearer ${adminToken}`),
      request(app)
        .post('/order/create')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(withIdempotencyKey({
          store: location.id,
          items: [{ product: product.id, quantity: 3 }],
          paymentMethod: 'cash',
          cashierName: 'Test Cashier'
        }))
    ])

    expect(rejectRes.status).toBe(200)
    expect(saleRes.status).toBe(201)

    const afterBoth = await db.product.findByPk(product.id)
    // Reject restores +4, sale deducts -3 — net effect from the
    // post-return-creation baseline must be +1, regardless of which
    // committed first. Neither operation's effect may be silently lost.
    expect(Number(afterBoth.stock)).toBe(Number(afterReturnCreate.stock) + 4 - 3)
    expect(Number(afterBoth.stock)).toBe(Number(beforeReturn.stock) - 3)
  })
})
