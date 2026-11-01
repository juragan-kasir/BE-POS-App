process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const crypto = require('crypto')
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// E2E audit #8 open bill (product owner, 2026-11-01; batch B9): a dine-in
// order is saved unpaid and sent to the kitchen; the cashier or the QR diner
// adds rounds while nothing is collected; stock is deducted once, when the
// bill is paid. Every refusal leaves the bill as it was.

const unique = (p) => `${p}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
const PRICE = 10000
const STOCK = 1000
const TAX_RATE = 10
const withTax = (quantity) => (quantity * PRICE * (100 + TAX_RATE)) / 100

let store = null
let category = null
let product = null
let adminToken = null
const tables = []

const makeTable = async () => {
  const table = await db.table.create({ store: store.id, name: unique('OB_TABLE') })
  tables.push(table.id)
  return table
}

const as = (method, path) =>
  request(app)[method](path).set('Authorization', `Bearer ${adminToken}`).query({ store: store.id })

const line = (quantity) => ({ product: product.id, productName: product.nameProduct, quantity })

const openBill = (table, body = {}) =>
  as('post', '/order/open-bill').send({
    store: store.id,
    tableId: table.id,
    cashierName: 'OB',
    items: [line(2)],
    idempotencyKey: unique('ob'),
    ...body
  })

const addRound = (orderId, body = {}) =>
  as('post', `/order/${orderId}/items`).send({
    items: [line(1)],
    idempotencyKey: unique('round'),
    ...body
  })

const outletStock = async () =>
  Number((await db.product_store_stock.findOne({ where: { product: product.id, store: store.id } })).stock)

beforeAll(async () => {
  store = await db.location.create({ name: unique('OB_STORE'), status: 'active' })
  category = await db.category.create({ name: unique('OB_CAT') })
  product = await db.product.create({
    nameProduct: unique('OB_PRODUCT'),
    category: category.id,
    price: PRICE,
    stock: STOCK,
    isAvailable: true
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: STOCK })
  await db.taxConfig.create({
    store: store.id,
    name: unique('OB_PPN'),
    rate: TAX_RATE,
    type: 'ppn',
    status: 'active'
  })
  const admin = await db.user.create({
    userName: unique('ob_admin'),
    email: `${unique('ob_admin')}@test.com`,
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
    .send({ store: store.id, openingBalance: 0, shift: 1 })
  if (![200, 201].includes(open.status)) throw new Error('register: ' + JSON.stringify(open.body))
})

afterAll(async () => {
  const orders = (await db.order.findAll({ where: { store: store?.id }, paranoid: false })).map((o) => o.id)
  await db.auditLog.destroy({ where: { entity: 'order', entityId: orders } }).catch(() => {})
  await db.accounting_outbox.destroy({ where: { store: store?.id }, force: true })
  await db.transaction.destroy({ where: { order: orders }, force: true })
  await db.order_status.destroy({ where: { order: orders }, force: true })
  await db.order_item.destroy({ where: { order: orders }, force: true })
  await db.order_round.destroy({ where: { order: orders } })
  await db.order.destroy({ where: { id: orders }, force: true })
  const registers = (await db.cashRegister.findAll({ where: { store: store?.id } })).map((r) => r.id)
  await db.cashMovement.destroy({ where: { cashRegisterId: registers }, force: true })
  await db.cashRegister.destroy({ where: { store: store?.id }, force: true })
  await db.best_selling.destroy({ where: { store: store?.id }, force: true })
  await db.stock_history.destroy({ where: { store: store?.id }, force: true })
  await db.product_store_stock.destroy({ where: { store: store?.id }, force: true })
  await db.taxConfig.destroy({ where: { store: store?.id }, force: true })
  await db.table.destroy({ where: { id: tables }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { store: store?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('open bill (batch B9)', () => {
  test('saving a bill holds the table, reaches the kitchen, and charges nothing yet', async () => {
    const table = await makeTable()
    const stockBefore = await outletStock()
    const res = await openBill(table)
    expect(res.status).toBe(201)
    const order = res.body.data
    expect(order.status).toBe('pending')
    expect(order.paymentStatus).toBe('unpaid')
    expect(Number(order.subTotal)).toBe(2 * PRICE)
    expect(Number(order.totalPrice)).toBe(withTax(2))

    expect((await db.table.findByPk(table.id)).status).toBe('occupied')
    expect(await db.transaction.count({ where: { order: order.id } })).toBe(0)
    expect(await outletStock()).toBe(stockBefore)

    const kitchen = await as('get', '/order/kitchen')
    expect(kitchen.body.data.map((o) => o.id)).toContain(order.id)
  })

  test('a bill needs a table and an idempotency key', async () => {
    const noTable = await as('post', '/order/open-bill').send({
      store: store.id,
      items: [line(1)],
      idempotencyKey: unique('ob')
    })
    expect(noTable.status).toBe(422)
    expect(noTable.body.code).toBe('TABLE_REQUIRED')

    const noKey = await openBill(await makeTable(), { idempotencyKey: '' })
    expect(noKey.status).toBe(422)
    expect(noKey.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED')
  })

  test('a retried save returns the same bill; a different cart with the key is refused', async () => {
    const table = await makeTable()
    const key = unique('ob')
    const first = await openBill(table, { idempotencyKey: key })
    const retry = await openBill(table, { idempotencyKey: key })
    expect(retry.status).toBe(200)
    expect(retry.body.data.id).toBe(first.body.data.id)

    const changed = await openBill(table, { idempotencyKey: key, items: [line(5)] })
    expect(changed.status).toBe(409)
    expect(changed.body.code).toBe('IDEMPOTENCY_MISMATCH')
    expect(await db.order.count({ where: { store: store.id, idempotencyKey: key } })).toBe(1)
  })

  test('a round adds items once, recomputes the bill, and a retry adds nothing', async () => {
    const bill = (await openBill(await makeTable())).body.data
    const key = unique('round')
    const added = await addRound(bill.id, { idempotencyKey: key, items: [line(3)] })
    expect(added.status).toBe(201)
    expect(Number(added.body.data.subTotal)).toBe(5 * PRICE)
    expect(Number(added.body.data.taxAmount)).toBe((5 * PRICE * TAX_RATE) / 100)
    expect(Number(added.body.data.totalPrice)).toBe(withTax(5))
    expect(Number(added.body.data.totalQuantity)).toBe(5)

    const retry = await addRound(bill.id, { idempotencyKey: key, items: [line(3)] })
    expect(retry.status).toBe(200)
    expect(await db.order_item.count({ where: { order: bill.id } })).toBe(2)

    const changed = await addRound(bill.id, { idempotencyKey: key, items: [line(4)] })
    expect(changed.status).toBe(409)
    expect(changed.body.code).toBe('IDEMPOTENCY_MISMATCH')

    const items = await db.order_item.findAll({ where: { order: bill.id }, order: [['id', 'ASC']] })
    expect(items[0].roundId).toBeNull()
    expect(items[1].roundId).not.toBeNull()
    expect(items[1].status).toBe('pending')
  })

  test('paying the bill deducts stock once for every round and records one payment', async () => {
    const bill = (await openBill(await makeTable())).body.data
    await addRound(bill.id, { items: [line(1)] })
    const stockBefore = await outletStock()

    const paid = await as('put', '/order/update-status').send({
      id: bill.id,
      store: store.id,
      status: 'paid',
      paymentMethod: 'cash'
    })
    expect(paid.status).toBe(200)
    expect(await outletStock()).toBe(stockBefore - 3)
    const rows = await db.transaction.findAll({ where: { order: bill.id } })
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].amount)).toBe(withTax(3))

    const late = await addRound(bill.id)
    expect(late.status).toBe(409)
    expect(late.body.code).toBe('ORDER_NOT_OPEN')
    expect(await db.order_item.count({ where: { order: bill.id } })).toBe(2)
  })

  test('nothing can be added once part of the bill is collected', async () => {
    const bill = (await openBill(await makeTable())).body.data
    await db.transaction.create({ order: bill.id, typePayment: 'CASH', amount: 1000 })
    const res = await addRound(bill.id)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('ORDER_PARTIALLY_PAID')
    expect(await db.order_item.count({ where: { order: bill.id } })).toBe(1)
  })

  test("another store's order cannot be reached", async () => {
    const other = await db.location.create({ name: unique('OB_OTHER'), status: 'active' })
    const foreign = await db.order.create({
      orderNumber: unique('OBF'),
      store: other.id,
      status: 'pending',
      paymentStatus: 'unpaid'
    })
    const res = await addRound(foreign.id)
    expect(res.status).toBe(404)
    await db.order.destroy({ where: { id: foreign.id }, force: true })
    await db.location.destroy({ where: { id: other.id }, force: true })
  })
})

describe('QR diner adds a round to their own unpaid order', () => {
  const qrOrder = (table) =>
    request(app)
      .post('/order/customer-create')
      .send({
        store: store.id,
        tableId: table.id,
        customerName: 'Tamu',
        items: [{ productId: product.id, productName: product.nameProduct, quantity: 1 }],
        idempotencyKey: unique('qr')
      })

  test('the diner adds items by the order token and sees only the bill', async () => {
    const created = await qrOrder(await makeTable())
    expect(created.status).toBe(201)
    const token = (await db.order.findByPk(created.body.data.id)).publicToken

    const res = await request(app)
      .post(`/order/customer-order/${token}/items`)
      .send({ items: [line(2)], idempotencyKey: unique('qr-round') })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.subTotal)).toBe(3 * PRICE)
    expect(res.body.data.transactions).toBeUndefined()
    expect(res.body.data.cashierName).toBeUndefined()
    const round = await db.order_round.findOne({ where: { order: created.body.data.id } })
    expect(round.source).toBe('customer')
  })

  test('a retried diner round sent the way the QR app sends it (productId) adds nothing', async () => {
    const created = await qrOrder(await makeTable())
    const token = (await db.order.findByPk(created.body.data.id)).publicToken
    const body = {
      items: [{ productId: product.id, productName: product.nameProduct, quantity: 2, price: PRICE }],
      idempotencyKey: unique('qr-round')
    }
    const first = await request(app).post(`/order/customer-order/${token}/items`).send(body)
    const retry = await request(app).post(`/order/customer-order/${token}/items`).send(body)
    expect(first.status).toBe(201)
    expect(retry.status).toBe(200)
    expect(await db.order_item.count({ where: { order: created.body.data.id } })).toBe(2)
  })

  test("a counter bill's token does not accept diner rounds", async () => {
    const bill = (await openBill(await makeTable())).body.data
    const token = (await db.order.findByPk(bill.id)).publicToken
    const res = await request(app)
      .post(`/order/customer-order/${token}/items`)
      .send({ items: [line(1)], idempotencyKey: unique('qr-round') })
    expect(res.status).toBe(404)
  })
})
