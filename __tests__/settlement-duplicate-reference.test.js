process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// BA gap 004 (DR-23 §D, §M): a non-cash settlement reference (CARD,
// BANK_TRANSFER, E_WALLET, QRIS) is unique per store and method across
// successful settlements. A reuse — on update-status, a counter sale or a
// split payment — is refused 409 DUPLICATE_REFERENCE with no effect.
// Compared trimmed and case-insensitively. Another store, another method,
// refund rows and OTHER descriptions do not collide.

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

const PRICE = 50000

let store = null
let category = null
let product = null
let adminToken = null
const createdTableIds = []
const createdOrderIds = []

async function makeQrOrder({ paymentMethod } = {}) {
  const table = await db.table.create({ store: store.id, name: unique('SDUP_TABLE') })
  createdTableIds.push(table.id)
  const res = await request(app)
    .post('/order/customer-create')
    .send({
      store: store.id,
      tableId: table.id,
      ...(paymentMethod === undefined ? {} : { paymentMethod }),
      customerName: 'SDUP QR',
      items: [{ productId: product.id, productName: product.nameProduct, quantity: 1 }],
      idempotencyKey: unique('srefqr')
    })
  if (res.status !== 201) throw new Error('qr setup failed: ' + JSON.stringify(res.body))
  createdOrderIds.push(res.body.data.id)
  return res.body.data
}

const settlePaid = (body) =>
  request(app)
    .put('/order/update-status')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ store: store.id, status: 'paid', ...body })

const ledgerRows = (orderId) => db.transaction.findAll({ where: { order: orderId } })

beforeAll(async () => {
  store = await db.location.create({ name: unique('SDUP_STORE'), status: 'active' })
  category = await db.category.create({ name: unique('SDUP_CAT') })
  product = await db.product.create({
    nameProduct: unique('SDUP_PRODUCT'),
    category: category.id,
    price: PRICE,
    stock: 500
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 500 })
  // Explicit 0% PPN keeps the due exactly PRICE.
  await db.taxConfig.create({
    store: store.id,
    name: `SDUP_PPN_${store.id}`,
    rate: 0,
    type: 'ppn',
    status: 'active'
  })
  const admin = await db.user.create({
    userName: unique('admin_sref'),
    email: `${unique('admin_sref')}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: admin.id, userName: admin.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  const open = await request(app)
    .post('/cash-register/open')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ store: store.id, openingBalance: 100000, shift: 1 })
  if (open.status !== 201 && open.status !== 200) {
    throw new Error('register setup failed: ' + JSON.stringify(open.body))
  }
})

afterAll(async () => {
  const orderIds = createdOrderIds
  await db.accounting_outbox.destroy({ where: { store: store?.id }, force: true })
  await db.transaction.destroy({ where: { order: orderIds }, force: true })
  await db.split_bill.destroy({ where: { order: orderIds }, force: true })
  await db.order_item.destroy({ where: { order: orderIds }, force: true })
  await db.order_status.destroy({ where: { order: orderIds }, force: true })
  await db.order.destroy({ where: { store: store?.id }, force: true })
  const registerIds = (await db.cashRegister.findAll({ where: { store: store?.id } })).map((r) => r.id)
  await db.cashMovement.destroy({ where: { cashRegisterId: registerIds }, force: true })
  await db.cashRegister.destroy({ where: { store: store?.id }, force: true })
  await db.best_selling.destroy({ where: { store: store?.id }, force: true })
  await db.product_store_stock.destroy({ where: { store: store?.id }, force: true })
  await db.stock_history.destroy({ where: { store: store?.id }, force: true })
  await db.taxConfig.destroy({ where: { store: store?.id }, force: true })
  await db.table.destroy({ where: { id: createdTableIds }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { store: store?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})



const expectDuplicateRefused = async (res, orderId) => {
  expect(res.status).toBe(409)
  expect(res.body.code).toBe('DUPLICATE_REFERENCE')
  if (orderId) {
    const order = await db.order.findByPk(orderId)
    expect(order.paymentStatus).toBe('unpaid')
    expect((await ledgerRows(orderId)).filter((r) => Number(r.amount) > 0)).toHaveLength(0)
  }
}

describe('duplicate settlement reference (BA 004)', () => {
  test('a QRIS reference used once is refused on another order, trimmed and case-insensitive', async () => {
    const ref = unique('QRDUP')
    const first = await makeQrOrder()
    expect((await settlePaid({ id: first.id, paymentMethod: 'qris', referenceNumber: ref })).status).toBe(200)

    for (const variant of [ref, `  ${ref.toLowerCase()} `]) {
      const second = await makeQrOrder()
      await expectDuplicateRefused(
        await settlePaid({ id: second.id, paymentMethod: 'qris', referenceNumber: variant }),
        second.id
      )
    }
  })

  test('the same reference under another method, or another store, is accepted', async () => {
    const ref = unique('XMETHOD')
    const a = await makeQrOrder()
    expect((await settlePaid({ id: a.id, paymentMethod: 'qris', referenceNumber: ref })).status).toBe(200)
    const b = await makeQrOrder()
    expect((await settlePaid({ id: b.id, paymentMethod: 'transfer', referenceNumber: ref })).status).toBe(200)

    const otherStore = await db.location.create({ name: unique('SDUP_OTHER'), status: 'active' })
    const foreign = await db.order.create({
      orderNumber: unique('SDUP-FOREIGN'),
      store: otherStore.id,
      status: 'paid',
      paymentStatus: 'paid',
      totalPrice: 1000
    })
    const foreignRef = unique('FOREIGN')
    await db.transaction.create({ order: foreign.id, typePayment: 'QRIS', amount: 1000, referenceNumber: foreignRef })
    const c = await makeQrOrder()
    expect((await settlePaid({ id: c.id, paymentMethod: 'qris', referenceNumber: foreignRef })).status).toBe(200)
    await db.transaction.destroy({ where: { order: foreign.id }, force: true })
    await db.order.destroy({ where: { id: foreign.id }, force: true })
    await db.location.destroy({ where: { id: otherStore.id }, force: true })
  })

  test('a refund row carrying the reference does not block it', async () => {
    const ref = unique('REFUNDROW')
    const holder = await makeQrOrder()
    await db.transaction.create({ order: holder.id, typePayment: 'QRIS', amount: -1000, referenceNumber: ref })
    const order = await makeQrOrder()
    expect((await settlePaid({ id: order.id, paymentMethod: 'qris', referenceNumber: ref })).status).toBe(200)
  })

  test('OTHER descriptions may repeat', async () => {
    const a = await makeQrOrder()
    expect((await settlePaid({ id: a.id, paymentMethod: 'other', referenceNumber: 'Voucher kantor' })).status).toBe(200)
    const b = await makeQrOrder()
    expect((await settlePaid({ id: b.id, paymentMethod: 'other', referenceNumber: 'Voucher kantor' })).status).toBe(200)
  })

  test('a counter sale reusing a reference is refused and creates no order', async () => {
    const ref = unique('COUNTER')
    const first = await makeQrOrder()
    expect((await settlePaid({ id: first.id, paymentMethod: 'qris', referenceNumber: ref })).status).toBe(200)
    const key = unique('dupcounter')
    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: store.id,
        items: [{ product: product.id, productName: product.nameProduct, quantity: 1 }],
        paymentMethod: 'qris',
        referenceNumber: ref,
        cashierName: 'SDUP',
        idempotencyKey: key
      })
    await expectDuplicateRefused(res)
    expect(await db.order.count({ where: { idempotencyKey: key } })).toBe(0)
  })

  test('a split payment reusing a reference is refused', async () => {
    const ref = unique('SPLIT')
    const order = await makeQrOrder()
    const created = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ order: order.id, items: [{ amount: PRICE / 2 }, { amount: PRICE / 2 }] })
    expect(created.status).toBe(201)
    const [splitA, splitB] = created.body.data
    const payA = await request(app)
      .put(`/split-bill/pay/${splitA.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ paymentMethod: 'qris', referenceNumber: ref })
    expect(payA.status).toBe(200)
    const payB = await request(app)
      .put(`/split-bill/pay/${splitB.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ paymentMethod: 'qris', referenceNumber: ref })
    expect(payB.status).toBe(409)
    expect(payB.body.code).toBe('DUPLICATE_REFERENCE')
    expect((await db.split_bill.findByPk(splitB.id)).status).toBe('pending')
  })

  test('two concurrent settlements with one reference: exactly one succeeds', async () => {
    const ref = unique('RACE')
    const a = await makeQrOrder()
    const b = await makeQrOrder()
    const results = await Promise.all([
      settlePaid({ id: a.id, paymentMethod: 'qris', referenceNumber: ref }),
      settlePaid({ id: b.id, paymentMethod: 'qris', referenceNumber: ref })
    ])
    const statuses = results.map((r) => r.status).sort()
    expect(statuses).toEqual([200, 409])
    const used = await db.transaction.count({ where: { referenceNumber: ref } })
    expect(used).toBe(1)
  })
})
