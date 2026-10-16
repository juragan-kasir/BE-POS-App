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
let discountFixed = null
let discountPercent = null
let cashierToken = null

beforeAll(async () => {
  location = await db.location.create({ name: 'INFO03_STORE', status: 'active' })
  category = await db.category.create({ name: 'INFO03_CAT' })
  product = await db.product.create({
    nameProduct: 'INFO03_PRODUCT',
    category: category.id,
    price: 10000,
    stock: 100
  })
  await db.product_store_stock.create({ product: product.id, store: location.id, stock: 100 })
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed the rate
  // so these discount-cap assertions exercise configured tax.
  await db.taxConfig.create({
    name: 'INFO03_PPN',
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: location.id
  })

  // Fixed discount 1000
  discountFixed = await db.discount.create({
    store: location.id,
    name: 'INFO03_FIXED_1K',
    code: 'INFO03FIXED1K',
    type: 'nominal',
    value: 1000,
    status: 'active'
  })
  // Fixed discount 1000000 (greater than subtotal)
  // We will use direct nominal via Discount table, but need to test the cap via API: we need a discount that exceeds subtotal
  // For the >subtotal case we will create a huge nominal discount and use it
  discountPercent = await db.discount.create({
    store: location.id,
    name: 'INFO03_PERCENT_10',
    code: 'INFO03PCT10',
    type: 'percent',
    value: 10,
    status: 'active'
  })

  // P1-4: central gate denies unknown caller identities; these rows
  // satisfy the identity invariant. Assertions below are unchanged.
  await db.user.create({
    id: 9801,
    userName: 'info03_cashier',
    email: 'p14-9801-info03-discount-cap@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: location.id,
    status: 'active',
    fullName: 'info03_cashier'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  cashierToken = await signSessionToken(
    { id: 9801, userName: 'info03_cashier', roleType: 'kasir', store: location.id },
    JWT_SECRET
  )
  // P1 (DR-PAY-ATTR-02): counter sales under test require an open register.
  await db.cashRegister.create({ store: location.id, user: 9801, status: 'open', openingBalance: 0, openedAt: new Date() })
})

afterAll(async () => {
  await db.cashRegister.destroy({ where: { store: location?.id }, force: true })
  await db.user.destroy({ where: { id: [9801] }, force: true })
  await db.taxConfig.destroy({ where: { store: location?.id }, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: location.id }, force: true })
  await db.discount.destroy({ where: { store: location.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product?.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

const createOrderWithDiscount = (discountId, promoCode) =>
  request(app)
    .post('/order/create')
    .set('Authorization', `Bearer ${cashierToken}`)
    .send(withIdempotencyKey({
      store: location.id,
      items: [{ product: product.id, quantity: 1 }],
      paymentMethod: 'cash',
      cashierName: 'INFO03 Cashier',
      discountId,
      promoCode
    }))

describe('INFO-03 discount capping / non-negative total', () => {
  test('normal discount 1000 on subtotal 10000 → total 9000+tax', async () => {
    const res = await createOrderWithDiscount(discountFixed.id)
    expect(res.status).toBe(201)
    expect(res.body.data.subTotal).toBe(10000)
    expect(res.body.data.discountAmount).toBe(1000)
    expect(res.body.data.totalPrice).toBeGreaterThanOrEqual(0)
    // afterDiscount 9000 + tax 990 (11%) = 9990? Actually tax 11% of 9000 = 990
    expect(res.body.data.totalPrice).toBe(9000 + res.body.data.taxAmount + res.body.data.serviceChargeAmount)
  })

  test('discount exactly equals subtotal → total 0 (afterDiscount 0)', async () => {
    const exactDiscount = await db.discount.create({
      store: location.id,
      name: 'INFO03_EXACT',
      code: 'INFO03EXACT',
      type: 'nominal',
      value: 10000,
      status: 'active'
    })
    const res = await createOrderWithDiscount(exactDiscount.id)
    expect(res.status).toBe(201)
    expect(res.body.data.subTotal).toBe(10000)
    expect(res.body.data.discountAmount).toBe(10000)
    expect(res.body.data.totalPrice).toBe(0)
    // Cleanup: remove orders referencing this discount before destroying discount (FK)
    await db.order.destroy({ where: { discountId: exactDiscount.id }, force: true })
    await exactDiscount.destroy({ force: true })
  })

  test('discount greater than subtotal → never negative total (capped)', async () => {
    const hugeDiscount = await db.discount.create({
      store: location.id,
      name: 'INFO03_HUGE',
      code: 'INFO03HUGE',
      type: 'nominal',
      value: 1000000,
      status: 'active'
    })
    const res = await createOrderWithDiscount(hugeDiscount.id)
    // Current defect: totalPrice would be negative (-990000 + tax). After fix, should be 0 or capped.
    expect(res.status).toBe(201)
    expect(res.body.data.subTotal).toBe(10000)
    // discountAmount should be capped to subTotal
    expect(res.body.data.discountAmount).toBeLessThanOrEqual(10000)
    expect(res.body.data.discountAmount).toBe(10000)
    expect(res.body.data.totalPrice).toBe(0)
    expect(res.body.data.totalPrice).toBeGreaterThanOrEqual(0)
    await db.order.destroy({ where: { discountId: hugeDiscount.id }, force: true })
    await hugeDiscount.destroy({ force: true })
  })

  test('percentage discount remains unchanged', async () => {
    const res = await createOrderWithDiscount(discountPercent.id)
    expect(res.status).toBe(201)
    expect(res.body.data.discountAmount).toBe(1000) // 10% of 10000
    expect(res.body.data.totalPrice).toBeGreaterThan(0)
  })

  test('no discount → total = subtotal + tax', async () => {
    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send(withIdempotencyKey({
        store: location.id,
        items: [{ product: product.id, quantity: 1 }],
        paymentMethod: 'cash',
        cashierName: 'INFO03 Cashier'
      }))
    expect(res.status).toBe(201)
    expect(res.body.data.discountAmount).toBe(0)
    expect(res.body.data.subTotal).toBe(10000)
    expect(res.body.data.totalPrice).toBeGreaterThan(0)
  })

  test('financial invariants: subTotal>=0, discountAmount>=0, discountAmount<=subTotal, totalPrice>=0', async () => {
    const huge = await db.discount.create({
      store: location.id,
      name: 'INFO03_INV',
      code: 'INFO03INV',
      type: 'nominal',
      value: 50000,
      status: 'active'
    })
    const res = await createOrderWithDiscount(huge.id)
    expect(res.status).toBe(201)
    const d = res.body.data
    expect(d.subTotal).toBeGreaterThanOrEqual(0)
    expect(d.discountAmount).toBeGreaterThanOrEqual(0)
    expect(d.discountAmount).toBeLessThanOrEqual(d.subTotal)
    expect(d.totalPrice).toBeGreaterThanOrEqual(0)
    expect(d.taxAmount).toBeGreaterThanOrEqual(0)
    expect(d.serviceChargeAmount).toBeGreaterThanOrEqual(0)
    await db.order.destroy({ where: { discountId: huge.id }, force: true })
    await huge.destroy({ force: true })
  })
})
