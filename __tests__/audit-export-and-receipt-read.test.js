process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const db = require('../db/models')
const reportExport = require('../api/controller/reportExport')
const receiptController = require('../api/controller/receipt')
const orderController = require('../api/controller/order')
const { AUDIT_ACTIONS } = require('../utils/auditLog')

let location
let order
let category
let product

const makeRes = () => {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return this
    },
    send(body) {
      this.body = body
      return this
    },
    setHeader(key, value) {
      this.headers[key] = value
    }
  }
  return res
}

beforeAll(async () => {
  location = await db.location.create({
    name: 'AUDIT_RECEIPT_STORE',
    status: 'active',
    timezone: 'Asia/Jakarta'
  })
  category = await db.category.create({ name: 'AUDIT_RECEIPT_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'AUDIT_RECEIPT_PRODUCT',
    category: category.id,
    price: 1000,
    stock: 10
  })
  order = await db.order.create({
    orderNumber: 'AUDIT-RECEIPT-1',
    store: location.id,
    customerName: 'Audit Customer',
    cashierName: 'Audit Cashier',
    status: 'paid',
    paymentStatus: 'paid',
    subTotal: 1000,
    totalPrice: 1000,
    publicToken: 'audit-public-token'
  })
  await db.order_item.create({
    order: order.id,
    product: product.id,
    productName: 'Audit Item',
    quantity: 1,
    price: 1000,
    totalPrice: 1000
  })
})

afterAll(async () => {
  await db.auditLog.destroy({
    where: { store: location.id },
    force: true,
    __auditMaintenance: true
  })
  await db.order_item.destroy({ where: { order: order.id }, force: true })
  await db.order.destroy({ where: { id: order.id }, force: true })
  await db.product.destroy({ where: { id: product.id }, force: true })
  await db.category.destroy({ where: { id: category.id }, force: true })
  await db.location.destroy({ where: { id: location.id }, force: true })
})

test('the new audit actions exist', () => {
  expect(AUDIT_ACTIONS.REPORT_EXPORT).toBe('report_export')
  expect(AUDIT_ACTIONS.RECEIPT_READ).toBe('receipt_read')
})

test('reading report data writes a report_export audit row', async () => {
  const req = {
    params: { key: 'daily' },
    query: {},
    user: { id: 9901, roleType: 'super_admin' },
    storeId: location.id,
    ip: '127.0.0.1',
    get: () => 'jest'
  }
  const res = makeRes()

  await reportExport.reportData(req, res)
  expect(res.statusCode).toBe(200)

  const row = await db.auditLog.findOne({
    where: {
      action: AUDIT_ACTIONS.REPORT_EXPORT,
      store: location.id
    }
  })
  expect(row).toBeTruthy()
  expect(row.metadata).toMatchObject({ key: 'daily' })
})

test('the staff receipt read writes a receipt_read audit row', async () => {
  const req = {
    params: { orderId: order.id },
    user: { id: 9901, roleType: 'admin', store: location.id },
    storeId: location.id,
    ip: '127.0.0.1',
    get: () => 'jest'
  }
  const res = makeRes()

  await receiptController.getOrderReceipt(req, res)
  expect(res.statusCode).toBe(200)

  const row = await db.auditLog.findOne({
    where: {
      action: AUDIT_ACTIONS.RECEIPT_READ,
      entityId: order.id
    }
  })
  expect(row).toBeTruthy()
})

test('the public receipt read is audited with a token hash, never the token', async () => {
  const req = {
    params: { token: 'audit-public-token' },
    ip: '127.0.0.1',
    get: () => 'jest'
  }
  const res = makeRes()

  await orderController.getReceiptHTML(req, res)
  expect(res.statusCode).toBe(200)

  const row = await db.auditLog.findOne({
    where: {
      action: AUDIT_ACTIONS.RECEIPT_READ,
      entityId: order.id
    },
    order: [['id', 'DESC']]
  })
  expect(row).toBeTruthy()
  expect(row.metadata.tokenHash).toMatch(/^[a-f0-9]{16}$/)
  expect(JSON.stringify(row.metadata)).not.toContain('audit-public-token')
})
