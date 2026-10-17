process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// DR-23 §L (BA §35.10): sale journals follow the tender's method class —
// CASH → 1000 Cash; CARD/BANK_TRANSFER/E_WALLET/QRIS → 1400 Bank &
// E-Wallet; mixed tender → one debit line per class. A void reverses the
// original entry, so it reverses the same classes. POINTS/OTHER have no
// decided account ([DEFERRED CONFIG]) and keep class 1000.

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
const PRICE = 40000

let store = null
let category = null
let product = null
let adminToken = null
const tableIds = []

const as = () => ({ Authorization: `Bearer ${adminToken}` })

async function counterSale(paymentMethod, extra = {}) {
  const res = await request(app)
    .post('/order/create')
    .set(as())
    .send(withIdempotencyKey({
      store: store.id,
      items: [{ product: product.id, quantity: 1 }],
      paymentMethod,
      cashierName: 'Journal Cashier',
      idempotencyKey: unique('jrn'),
      // G-02 (DR-23 §D): a non-cash sale carries its reference (OTHER: a description).
      ...(String(paymentMethod).toUpperCase() === 'CASH' ? {} : { referenceNumber: unique('JREF') }),
      ...extra
    }))
  if (res.status !== 201) throw new Error('sale failed: ' + JSON.stringify(res.body))
  return res.body.data
}

async function qrOrder() {
  const table = await db.table.create({ store: store.id, name: unique('JRN_TABLE') })
  tableIds.push(table.id)
  const res = await request(app)
    .post('/order/customer-create')
    .send({
      store: store.id,
      tableId: table.id,
      customerName: unique('Jrn Guest'),
      items: [{ productId: product.id, productName: product.nameProduct, quantity: 1 }],
      idempotencyKey: unique('jrnqr')
    })
  if (res.status !== 201) throw new Error('qr failed: ' + JSON.stringify(res.body))
  return res.body.data
}

// Debit amount per account code of the journal entry for one source.
async function debitsByCode(sourceType, orderId) {
  const entry = await db.journal_entry.findOne({
    where: { store: store.id, sourceType, referenceId: orderId }
  })
  if (!entry) return null
  const lines = await db.journal_entry_line.findAll({ where: { journalEntry: entry.id } })
  const out = {}
  for (const line of lines) {
    const debit = Number(line.debit)
    if (debit <= 0) continue
    const account = await db.account.findByPk(line.account)
    out[account.code] = (out[account.code] || 0) + debit
  }
  return out
}

async function creditsByCode(sourceType, orderId) {
  const entry = await db.journal_entry.findOne({
    where: { store: store.id, sourceType, referenceId: orderId }
  })
  if (!entry) return null
  const lines = await db.journal_entry_line.findAll({ where: { journalEntry: entry.id } })
  const out = {}
  for (const line of lines) {
    const credit = Number(line.credit)
    if (credit <= 0) continue
    const account = await db.account.findByPk(line.account)
    out[account.code] = (out[account.code] || 0) + credit
  }
  return out
}

beforeAll(async () => {
  store = await db.location.create({ name: unique('JRN_STORE'), status: 'active' })
  category = await db.category.create({ name: unique('JRN_CAT') })
  product = await db.product.create({
    nameProduct: unique('JRN_PRODUCT'),
    category: category.id,
    price: PRICE,
    stock: 1000
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 1000 })
  await db.taxConfig.create({ store: store.id, name: unique('JRN_PPN'), rate: 0, type: 'ppn', status: 'active' })
  const admin = await db.user.create({
    userName: unique('jrn_admin'),
    email: `${unique('jrn_admin')}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: admin.id, userName: admin.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  const openRes = await request(app)
    .post('/cash-register/open')
    .set(as())
    .send({ store: store.id, openingBalance: 100000, shift: 1 })
  if (![200, 201].includes(openRes.status)) {
    throw new Error('register setup failed: ' + JSON.stringify(openRes.body))
  }
})

afterAll(async () => {
  const orderIds = (await db.order.findAll({ where: { store: store.id }, attributes: ['id'] })).map((o) => o.id)
  const entryIds = (await db.journal_entry.findAll({ where: { store: store.id }, attributes: ['id'] })).map((e) => e.id)
  await db.journal_entry_line.destroy({ where: { journalEntry: entryIds }, force: true })
  await db.journal_entry.destroy({ where: { id: entryIds }, force: true })
  await db.accounting_outbox.destroy({ where: { store: store.id }, force: true })
  await db.account.destroy({ where: { store: store.id }, force: true })
  await db.split_bill.destroy({ where: { order: orderIds }, force: true })
  await db.transaction.destroy({ where: { order: orderIds }, force: true })
  await db.order_item.destroy({ where: { order: orderIds }, force: true })
  await db.order_status.destroy({ where: { order: orderIds }, force: true })
  await db.stock_history.destroy({ where: { store: store.id }, force: true })
  await db.order.destroy({ where: { id: orderIds }, force: true })
  await db.table.destroy({ where: { id: tableIds }, force: true })
  await db.cashRegister.destroy({ where: { store: store.id }, force: true })
  await db.taxConfig.destroy({ where: { store: store.id }, force: true })
  await db.product_store_stock.destroy({ where: { store: store.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { store: store.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('DR-23 §L — sale journal debit follows the tender class', () => {
  test('cash sale debits 1000 Cash', async () => {
    const order = await counterSale('cash', { cashAmount: PRICE, changeAmount: 0 })
    expect(await debitsByCode('order', order.id)).toEqual({ 1000: PRICE })
  })

  test('QRIS sale debits 1400, not Cash', async () => {
    const order = await counterSale('qris')
    expect(await debitsByCode('order', order.id)).toEqual({ 1400: PRICE })
  })

  test('card sale debits 1400', async () => {
    const order = await counterSale('CARD')
    expect(await debitsByCode('order', order.id)).toEqual({ 1400: PRICE })
  })

  test('mixed tender via splits produces one debit line per class', async () => {
    const order = await qrOrder()
    const half = order.totalPrice / 2
    const created = await request(app)
      .post('/split-bill/create')
      .set(as())
      .send({ order: order.id, items: [{ amount: half }, { amount: half }], idempotencyKey: unique('jrnsplit') })
    expect(created.status).toBe(201)
    const splits = await db.split_bill.findAll({ where: { order: order.id }, order: [['id', 'ASC']] })

    const cash = await request(app)
      .put(`/split-bill/pay/${splits[0].id}`)
      .set(as())
      .send({ paymentMethod: 'cash', cashAmount: half, changeAmount: 0 })
    expect(cash.status).toBe(200)
    const qris = await request(app)
      .put(`/split-bill/pay/${splits[1].id}`)
      .set(as())
      .send({ paymentMethod: 'qris', referenceNumber: unique('QRREF') })
    expect(qris.status).toBe(200)

    expect(await debitsByCode('order', order.id)).toEqual({ 1000: half, 1400: half })
  })

  test('a void reverses the original tender class', async () => {
    const order = await counterSale('qris')
    const res = await request(app)
      .put('/order/update-status')
      .set(as())
      .send({ id: order.id, store: store.id, status: 'void', reason: 'journal class test', refundReference: unique('RFREF') })
    expect(res.status).toBe(200)

    expect(await creditsByCode('order_reversal', order.id)).toMatchObject({ 1400: PRICE })
  })

  test('OTHER tender keeps class 1000 (its account is deferred config)', async () => {
    // No account is decided for OTHER/POINTS (DR-23 §L [DEFERRED CONFIG]); the
    // pre-DR-23 class is kept rather than an invented account.
    const order = await counterSale('OTHER')
    expect(await debitsByCode('order', order.id)).toEqual({ 1000: PRICE })
  })
})
