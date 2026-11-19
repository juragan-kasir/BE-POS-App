// F-05 — regression: createCustomerOrder must re-read the table row under a
// FOR UPDATE lock inside the SAME transaction that creates the booking, and
// re-check its status from that locked value (the pre-transaction check is a
// fast-path 400 only). This serializes a booking against concurrent
// table-status mutations (operator update, queue seat activation) instead of
// racing them.
//
// The pure table-status RACE (two concurrent distinct-key submits both
// reading 'available' before either writes) is timing-dependent and not
// deterministically reproducible at the HTTP layer; it is additionally
// documented as a residual, because a DB-level "one live order per table"
// unique index is not deployable on current data (dev already contains
// multiple live orders per table) and booking-blocking would change product
// table semantics. This file pins the authoritative locked-recheck path and
// the current booking semantics so neither regresses silently.

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let store = null
let category = null
let product = null
let table = null
let releaseTable = null
let adminToken = null

const createBooking = (tableId, key) =>
  request(app).post('/order/customer-create').send({
    store: store.id,
    tableId,
    customerName: 'F05 Locked Recheck',
    idempotencyKey: key,
    items: [{ productId: product.id, productName: product.nameProduct, quantity: 1 }]
  })

beforeAll(async () => {
  store = await db.location.create(await withTestTenant({ name: 'F05_TABLE_LOCK_STORE', status: 'active' }))
  category = await db.category.create({ name: 'F05_TABLE_LOCK_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'F05_TABLE_LOCK_PRODUCT',
    category: category.id,
    price: 12000,
    stock: 50,
    isAvailable: true
  })
  await db.product_store_stock.create({
    product: product.id,
    store: store.id,
    stock: product.stock
  })
  table = await db.table.create({ store: store.id, name: 'F05_TABLE', status: 'available' })
  releaseTable = await db.table.create({
    store: store.id,
    name: 'F05_TABLE_RELEASE',
    status: 'available'
  })
  // P1-4: central gate denies unknown caller identities; these rows
  // satisfy the identity invariant. Assertions below are unchanged.
  await db.user.create({
    id: 9406,
    userName: 'f05_admin',
    email: 'p14-9406-customer-order-table-lock@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active',
    fullName: 'f05_admin'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  adminToken = await signSessionToken(
    { id: 9406, userName: 'f05_admin', roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed the rate
  // so these table-lock assertions exercise configured tax.
  await db.taxConfig.create({
    name: 'F05_PPN',
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: store.id
  })
})

afterAll(async () => {
  await db.user.destroy({ where: { id: [9406] }, force: true })
  await db.taxConfig.destroy({ where: { store: store?.id }, force: true })
  const orders = await db.order.findAll({ where: { store: store.id } })
  for (const o of orders) {
    await db.order_item.destroy({ where: { order: o.id }, force: true })
    await db.order_status.destroy({ where: { order: o.id }, force: true })
    await db.transaction.destroy({ where: { order: o.id }, force: true })
    await db.order.destroy({ where: { id: o.id }, force: true })
  }
  await db.product_store_stock.destroy({ where: { product: product?.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.table.destroy({ where: { id: [table?.id, releaseTable?.id] }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('F-05 — createCustomerOrder authoritative in-transaction table check', () => {
  test('a successful QR booking transitions the table available -> occupied; the locked recheck then rejects a further booking (400)', async () => {
    const first = await createBooking(table.id, `f05-ok-${Date.now()}`)
    expect(first.status).toBe(201)
    expect(first.body.data.paymentStatus).toBe('unpaid')

    // Phase 39 — a successful QR/BISA-MAKAN order now occupies the table
    // atomically, in the same transaction and under the same row lock as
    // the authoritative check above (not a separate write, not a race).
    const afterFirst = await db.table.findByPk(table.id)
    expect(afterFirst.status).toBe('occupied')

    // The locked recheck rejects a second booking against the now-occupied
    // table — this is the authoritative in-transaction check, not a new
    // pre-check-only behavior.
    const blocked = await createBooking(table.id, `f05-blocked-${Date.now()}`)
    expect(blocked.status).toBe(400)
    expect(blocked.body.message).toBe('Table is already occupied')

    await db.table.update({ status: 'available' }, { where: { id: table.id } })

    const again = await createBooking(table.id, `f05-again-${Date.now()}`)
    expect(again.status).toBe(201)

    const afterAgain = await db.table.findByPk(table.id)
    expect(afterAgain.status).toBe('occupied')

    await db.table.update({ status: 'available' }, { where: { id: table.id } })
  })

  // Item 8 — end-to-end occupancy lifecycle proof, narrowly scoped to table
  // status: available -> QR order created -> occupied -> QR order voided ->
  // available. Does not touch or assert refund behavior.
  test('a cancelled unpaid QR order releases its table back to available', async () => {
    const booking = await createBooking(releaseTable.id, `f05-release-${Date.now()}`)
    expect(booking.status).toBe(201)
    expect(booking.body.data.paymentStatus).toBe('unpaid')

    const occupied = await db.table.findByPk(releaseTable.id)
    expect(occupied.status).toBe('occupied')

    // Unpaid cancels do not require a reason (only a paid cancel does) and
    // must not introduce any refund ledger entry.
    const cancelled = await request(app)
      .put('/order/update-status')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ id: booking.body.data.id, status: 'cancelled', store: store.id })
    expect(cancelled.status).toBe(200)

    const released = await db.table.findByPk(releaseTable.id)
    expect(released.status).toBe('available')

    expect(
      await db.transaction.findAll({ where: { order: booking.body.data.id } })
    ).toHaveLength(0)
  })
})