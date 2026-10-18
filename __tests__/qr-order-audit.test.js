process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const app = require('../api/index')
const db = require('../db/models')

// DR-24 C-24b / DR-20 §35.6: a public QR order is created by no authenticated
// actor, so the create event must be traceable via the append-only audit log:
// actorType SYSTEM, source 'qr', with the order identity and scope. An
// idempotent replay of the same key must not duplicate the audit row.

let uniqueSeq = 0
const unique = (prefix) => `${prefix}_${Date.now()}_${++uniqueSeq}`

let location = null
let category = null
let product = null
let table = null
const orderIds = []

const createQrOrder = (body) => request(app).post('/order/customer-create').send(body)

beforeAll(async () => {
  location = await db.location.create({ name: unique('C24B_STORE'), status: 'active' })
  category = await db.category.create({ name: unique('C24B_CATEGORY') })
  product = await db.product.create({
    nameProduct: unique('C24B_PRODUCT'),
    category: category.id,
    price: 15000,
    stock: 10
  })
  await db.product_store_stock.create({
    product: product.id,
    store: location.id,
    stock: product.stock
  })
  table = await db.table.create({ store: location.id, name: unique('C24B_TABLE') })
  // W3-3 (DR-17): PPN is explicit setup, never a fallback.
  await db.taxConfig.create({
    name: unique('C24B_PPN'),
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: location.id
  })
})

beforeEach(async () => {
  await db.table.update({ status: 'available' }, { where: { id: table.id } })
})

afterAll(async () => {
  await db.taxConfig.destroy({ where: { store: location?.id }, force: true })
  await db.auditLog.destroy({
    where: { entity: 'order', entityId: orderIds },
    force: true,
    __auditMaintenance: true
  })
  await db.order_item.destroy({ where: { order: orderIds }, force: true })
  await db.transaction.destroy({ where: { order: orderIds }, force: true })
  await db.order_status.destroy({ where: { order: orderIds }, force: true })
  await db.order.destroy({ where: { id: orderIds }, force: true })
  await db.table.destroy({ where: { id: table?.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product?.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

test('QR order creation writes a SYSTEM/SUCCESS audit row with the QR channel', async () => {
  const res = await createQrOrder({
    store: location.id,
    tableId: table.id,
    customerName: 'QR Guest',
    idempotencyKey: unique('c24b-key'),
    items: [{ productId: product.id, productName: product.nameProduct, quantity: 2 }]
  })
  expect(res.status).toBe(201)
  orderIds.push(res.body.data.id)

  const [row] = await db.auditLog.findAll({
    where: { entity: 'order', entityId: res.body.data.id },
    limit: 1
  })
  expect(row).toBeTruthy()
  expect(row.action).toBe('create')
  expect(row.actorType).toBe('SYSTEM')
  expect(row.result).toBe('SUCCESS')
  expect(row.source).toBe('qr')
  expect(row.store).toBe(location.id)
  expect(row.userName).toBe('QR Guest')
  expect(row.userId).toBeNull()
  expect(row.metadata?.orderNumber).toBe(res.body.data.orderNumber)
  expect(row.metadata?.tableId).toBe(table.id)
  expect(row.metadata?.itemCount).toBe(1)
  expect(row.metadata?.totalPrice).toBe(Number(res.body.data.totalPrice))
  expect(row.reason).toBeNull()
})

test('an idempotent replay does not duplicate the audit row', async () => {
  const key = unique('c24b-replay')
  const body = {
    store: location.id,
    tableId: table.id,
    customerName: 'QR Replay',
    idempotencyKey: key,
    items: [{ productId: product.id, productName: product.nameProduct, quantity: 1 }]
  }

  const first = await createQrOrder(body)
  expect(first.status).toBe(201)
  orderIds.push(first.body.data.id)

  const replay = await createQrOrder(body)
  expect(replay.status).toBe(200)
  expect(replay.body.data.id).toBe(first.body.data.id)

  const rows = await db.auditLog.findAll({
    where: { entity: 'order', entityId: first.body.data.id }
  })
  expect(rows).toHaveLength(1)
})
