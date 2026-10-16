process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let location = null
let category = null
let product = null
let adminToken = null

beforeAll(async () => {
  location = await db.location.create({ name: 'GR_REV_STORE', status: 'active' })
  category = await db.category.create({ name: 'GR_REV_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'GR_REV_PRODUCT',
    category: category.id,
    price: 8000,
    costPrice: 5000,
    stock: 0
  })
  // P1-4: central gate denies unknown caller identities; these rows
  // satisfy the identity invariant. Assertions below are unchanged.
  await db.user.create({
    id: 7601,
    userName: 'admin_gr_rev',
    email: 'p14-7601-goods-receipt-reversal-flow@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: location.id,
    status: 'active',
    fullName: 'admin_gr_rev'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  adminToken = await signSessionToken(
    { id: 7601, userName: 'admin_gr_rev', roleType: 'admin', store: location.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.product_batch_stock.destroy({ where: {}, force: true })
  await db.product_batch.destroy({ where: { product: product?.id }, force: true })
  await db.stock_history.destroy({ where: { product: product?.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product?.id }, force: true })
  await db.goodsReceiptItem.destroy({ where: {}, force: true })
  await db.goodsReceipt.destroy({ where: { store: location.id }, force: true })
  await db.purchase_order_item.destroy({ where: {}, force: true })
  await db.purchase_order.destroy({ where: { store: location.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  // Users last: purchase orders reference the creator (FK).
  await db.user.destroy({ where: { id: [7601] }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

describe('Goods receipt edit — drafts post nothing until completed', () => {
  test('creating then editing a draft moves no stock; completing posts the final lines once', async () => {
    const poRes = await request(app)
      .post('/purchase-order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: location.id,
        status: 'ordered',
        items: [{ product: product.id, quantity: 10, price: 5000 }]
      })
    expect(poRes.status).toBe(201)
    const poItemId = poRes.body.data.items[0].id

    const beforeStock = await db.product.findByPk(product.id)

    const grRes = await request(app)
      .post('/goods-receipt/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: location.id,
        purchaseOrderId: poRes.body.data.id,
        status: 'draft',
        items: [
          {
            purchaseOrderItem: poItemId,
            product: product.id,
            qtyReceived: 10,
            price: 5000
          }
        ]
      })
    expect(grRes.status).toBe(201)

    // P1-5: a draft posts nothing at create.
    const afterCreate = await db.product.findByPk(product.id)
    expect(Number(afterCreate.stock)).toBe(Number(beforeStock.stock))

    // Editing the draft down to 6 replaces rows with no stock movement
    // (nothing was posted, so there is nothing to reverse).
    const updateRes = await request(app)
      .put(`/goods-receipt/update/${grRes.body.data.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        items: [
          {
            purchaseOrderItem: poItemId,
            product: product.id,
            qtyReceived: 6,
            price: 5000
          }
        ]
      })
    expect(updateRes.status).toBe(200)

    const afterUpdate = await db.product.findByPk(product.id)
    expect(Number(afterUpdate.stock)).toBe(Number(beforeStock.stock))

    // Completing posts the final lines exactly once.
    const completeRes = await request(app)
      .patch(`/goods-receipt/status/${grRes.body.data.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'completed', store: location.id })
    expect(completeRes.status).toBe(200)

    const afterComplete = await db.product.findByPk(product.id)
    expect(Number(afterComplete.stock)).toBe(Number(beforeStock.stock) + 6)

    // The only stock movement is the completion's purchase row.
    const history = await db.stock_history.findAll({
      where: { product: product.id, referenceType: 'purchase' },
      order: [['id', 'ASC']]
    })
    expect(history.length).toBe(1)
    expect(Number(history[0].quantityBefore)).toBe(Number(beforeStock.stock))
    expect(Number(history[0].quantityChange)).toBe(6)
    expect(Number(history[0].quantityAfter)).toBe(Number(beforeStock.stock) + 6)
  })
})
