process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// F-PAY-1 regression: a successfully paid order must always carry its
// payment-ledger row. paymentMethod is optional in the schema and the
// established product contract treats an absent method as cash exact
// tender (status notes, paid-transition fallbacks) — so a missing method
// must persist a cash transaction row, never zero rows.

const unique = (prefix) =>
  `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

let store = null
let category = null
let product = null
let token = null

beforeAll(async () => {
  store = await db.location.create({ name: `PAYNOM_STORE_${Date.now()}`, status: 'active' })
  category = await db.category.create({ name: `PAYNOM_CAT_${Date.now()}` })
  product = await db.product.create({
    nameProduct: `PAYNOM_PRODUCT_${Date.now()}`,
    category: category.id,
    price: 25000,
    stock: 100
  })
  await db.product_store_stock.create({
    product: product.id,
    store: store.id,
    stock: 100
  })
  // P1-4: central gate denies unknown caller identities; these rows
  // satisfy the identity invariant. Assertions below are unchanged.
  await db.user.create({
    id: 7501,
    userName: 'cashier_paynom',
    email: 'p14-7501-payment-no-method-safety@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: store.id,
    status: 'active',
    fullName: 'cashier_paynom'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  token = await signSessionToken(
    { id: 7501, userName: 'cashier_paynom', roleType: 'kasir', store: store.id },
    JWT_SECRET
  )
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed the rate
  // so these no-method assertions exercise configured tax.
  await db.taxConfig.create({
    name: 'PAYNOM_PPN',
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: store.id
  })
  // P1 (DR-PAY-ATTR-02): counter sales under test require an open register.
  // The persisted-tender assertions below are unchanged apart from the
  // locked canonical vocabulary (CASH/QRIS).
  await db.cashRegister.create({ store: store.id, user: 7501, status: 'open', openingBalance: 0, openedAt: new Date() })
})

afterAll(async () => {
  await db.cashRegister.destroy({ where: { store: store?.id }, force: true })
  await db.user.destroy({ where: { id: [7501] }, force: true })
  await db.taxConfig.destroy({ where: { store: store?.id }, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: store?.id }, force: true })
  await db.best_selling.destroy({ where: { productId: product?.id }, force: true })
  await db.stock_history.destroy({ where: { product: product?.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product?.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

async function createOrder(body) {
  return request(app)
    .post('/order/create')
    .set('Authorization', `Bearer ${token}`)
    .send(withIdempotencyKey({
      store: store.id,
      items: [{ product: product.id, quantity: 1, productName: 'nomethod' }],
      cashierName: 'NoMethod Cashier',
      ...body
    }))
}

describe('F-PAY-1 no-payment-method paid order', () => {
  // G-02 (DR-23 §D/§O): an omitted method is refused, never assumed to be
  // cash — so a paid order without a ledger row still cannot happen.
  test('omitted paymentMethod is refused with no order and no ledger row', async () => {
    const key = unique('paynom')
    const before = await db.order.count({ where: { store: store.id } })
    const res = await createOrder({ idempotencyKey: key })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('PAYMENT_METHOD_REQUIRED')
    expect(await db.order.count({ where: { store: store.id } })).toBe(before)
    expect(await db.order.count({ where: { idempotencyKey: key } })).toBe(0)
  })

  test('explicit cash with exact tender still writes the identical ledger row', async () => {
    const key = unique('paycash')
    const res = await createOrder({
      idempotencyKey: key,
      paymentMethod: 'cash'
    })
    expect(res.status).toBe(201)
    const rows = await db.transaction.findAll({
      where: { order: res.body.data.id }
    })
    expect(rows.length).toBe(1)
    expect(rows[0].typePayment).toBe('CASH')
  })

  test('explicit non-cash method still writes its ledger row', async () => {
    const key = unique('payqris')
    const res = await createOrder({
      idempotencyKey: key,
      paymentMethod: 'qris',
      referenceNumber: unique('payqrisref')
    })
    expect(res.status).toBe(201)
    const rows = await db.transaction.findAll({
      where: { order: res.body.data.id }
    })
    expect(rows.length).toBe(1)
    expect(rows[0].typePayment).toBe('QRIS')
  })
})
