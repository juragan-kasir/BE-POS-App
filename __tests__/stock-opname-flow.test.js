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

beforeAll(async () => {
  location = await db.location.create({ name: 'OPNAME_FLOW_STORE', status: 'active' })
  category = await db.category.create({ name: 'OPNAME_FLOW_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'OPNAME_FLOW_PRODUCT',
    category: category.id,
    price: 6000,
    stock: 20
  })
  // P1-4: central gate denies unknown caller identities; these rows
  // satisfy the identity invariant. Assertions below are unchanged.
  await db.user.create({
    id: 7401,
    userName: 'admin_opname_flow',
    email: 'p14-7401-stock-opname-flow@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: location.id,
    status: 'active',
    fullName: 'admin_opname_flow'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  adminToken = await signSessionToken(
    { id: 7401, userName: 'admin_opname_flow', roleType: 'admin', store: location.id },
    JWT_SECRET
  )
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed the rate
  // so these opname assertions exercise configured tax.
  await db.taxConfig.create({
    name: 'OPNAME_FLOW_PPN',
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: location.id
  })
  // P1 (DR-PAY-ATTR-02): counter sales under test require an open register.
  await db.cashRegister.create({ store: location.id, user: 7401, status: 'open', openingBalance: 0, openedAt: new Date() })
})

afterAll(async () => {
  await db.cashRegister.destroy({ where: { store: location?.id }, force: true })
  await db.user.destroy({ where: { id: [7401] }, force: true })
  await db.taxConfig.destroy({ where: { store: location?.id }, force: true })
  await db.stock_history.destroy({ where: { product: product?.id }, force: true })
  await db.best_selling.destroy({ where: { productId: product?.id }, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: location.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product?.id }, force: true })
  await db.stockOpnameItem.destroy({ where: {}, force: true })
  await db.stockOpname.destroy({ where: { store: location.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

describe('POST /stock-opname/create + PATCH /stock-opname/status/:id — reconciliation flow', () => {
  test('creating a draft opname does not touch stock yet', async () => {
    const res = await request(app)
      .post('/stock-opname/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: location.id,
        status: 'draft',
        items: [
          {
            product: product.id,
            namaBarang: product.nameProduct,
            stokAkhirJumlah: 20,
            stokFisikJumlah: 15,
            selisihJumlah: -5
          }
        ]
      })

    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('draft')

    const fresh = await db.product.findByPk(product.id)
    expect(Number(fresh.stock)).toBe(20)
  })

  test('completing the opname sets stock to the counted physical quantity', async () => {
    const createRes = await request(app)
      .post('/stock-opname/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: location.id,
        status: 'draft',
        items: [
          {
            product: product.id,
            namaBarang: product.nameProduct,
            stokAkhirJumlah: 20,
            stokFisikJumlah: 15,
            selisihJumlah: -5
          }
        ]
      })
    expect(createRes.status).toBe(201)

    const completeRes = await request(app)
      .patch(`/stock-opname/status/${createRes.body.data.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'completed' })

    expect(completeRes.status).toBe(200)

    const fresh = await db.product.findByPk(product.id)
    expect(Number(fresh.stock)).toBe(15)

    const history = await db.stock_history.findAll({
      where: { product: product.id, referenceType: 'opname' }
    })
    expect(history.length).toBe(1)
    expect(Number(history[0].quantityChange)).toBe(-5)
    expect(Number(history[0].quantityAfter)).toBe(15)

    const opname = await db.stockOpname.findByPk(createRes.body.data.id)
    expect(opname.status).toBe('completed')
  })

  test('cannot change status of an opname that is not in draft status', async () => {
    const createRes = await request(app)
      .post('/stock-opname/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: location.id,
        status: 'draft',
        items: [
          {
            product: product.id,
            namaBarang: product.nameProduct,
            stokAkhirJumlah: 15,
            stokFisikJumlah: 15,
            selisihJumlah: 0
          }
        ]
      })
    expect(createRes.status).toBe(201)

    const firstComplete = await request(app)
      .patch(`/stock-opname/status/${createRes.body.data.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'completed' })
    expect(firstComplete.status).toBe(200)

    const secondComplete = await request(app)
      .patch(`/stock-opname/status/${createRes.body.data.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'cancelled' })

    expect(secondComplete.status).toBe(400)
  })

  test('completing an opname racing a concurrent sale: the sale is never silently overwritten', async () => {
    // Regression test for the audit's flagged race: an absolute "set stock
    // to the counted value" completing at the same moment as a sale's
    // atomic decrement. Baseline is 15 (from the prior test). The opname
    // counts 12 (a -3 adjustment); concurrently, a sale of 2 units is
    // rung up. Whichever commits second must see the other's already-
    // committed change under its own lock, not a stale pre-transaction
    // read — so the final stock must reflect BOTH effects combined, never
    // just one of them.
    const before = await db.product.findByPk(product.id)

    const createRes = await request(app)
      .post('/stock-opname/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: location.id,
        status: 'draft',
        items: [
          {
            product: product.id,
            namaBarang: product.nameProduct,
            stokAkhirJumlah: Number(before.stock),
            stokFisikJumlah: before.stock - 3,
            selisihJumlah: -3
          }
        ]
      })
    expect(createRes.status).toBe(201)

    const [completeRes, saleRes] = await Promise.all([
      request(app)
        .patch(`/stock-opname/status/${createRes.body.data.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'completed' }),
      request(app)
        .post('/order/create')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(withIdempotencyKey({
          store: location.id,
          items: [{ product: product.id, quantity: 2 }],
          paymentMethod: 'cash',
          cashierName: 'Test Cashier'
        }))
    ])

    expect(completeRes.status).toBe(200)
    expect(saleRes.status).toBe(201)

    const after = await db.product.findByPk(product.id)
    // Combined effect: -3 (opname) and -2 (sale) from the pre-race
    // baseline, regardless of ordering. NOT before.stock - 3 (sale lost)
    // and NOT before.stock - 2 (opname lost).
    expect(Number(after.stock)).toBe(before.stock - 5)
  })
})
