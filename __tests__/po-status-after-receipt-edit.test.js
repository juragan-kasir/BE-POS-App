process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// E2E audit (2026-10-31): a purchase order stayed "ordered" after its goods
// were received through an edited (draft -> completed) receipt. Every receipt
// path that moves the PO lines' receivedQuantity now recomputes the PO status
// (edits and deletes are allowed on drafts only).

const SUFFIX = Date.now()
const ADMIN_ID = 7951

let location = null
let category = null
let product = null
let adminToken = null

const as = (method, path) =>
  request(app)[method](path).set('Authorization', `Bearer ${adminToken}`)

const makePO = async (qty = 10) => {
  const res = await as('post', '/purchase-order/create').send({
    store: location.id,
    status: 'ordered',
    items: [{ product: product.id, quantity: qty, price: 5000 }]
  })
  if (res.status !== 201) throw new Error('PO setup failed: ' + JSON.stringify(res.body))
  return res.body.data
}

const line = (po, qtyReceived) => ({
  purchaseOrderItem: po.items[0].id,
  product: product.id,
  qtyReceived,
  price: 5000
})

const makeReceipt = async (po, qtyReceived, status) => {
  const res = await as('post', '/goods-receipt/create').send({
    store: location.id,
    purchaseOrderId: po.id,
    status,
    items: [line(po, qtyReceived)]
  })
  if (res.status !== 201) throw new Error('GR setup failed: ' + JSON.stringify(res.body))
  return res.body.data
}

const poStatus = async (poId) => (await db.purchase_order.findByPk(poId)).status

beforeAll(async () => {
  location = await db.location.create({ name: `PO_STATUS_STORE_${SUFFIX}`, status: 'active' })
  category = await db.category.create({ name: `PO_STATUS_CAT_${SUFFIX}` })
  product = await db.product.create({
    nameProduct: `PO_STATUS_PROD_${SUFFIX}`,
    category: category.id,
    price: 8000,
    costPrice: 5000,
    stock: 0
  })
  await db.user.create({
    id: ADMIN_ID,
    userName: `admin_po_status_${SUFFIX}`,
    email: `admin_po_status_${SUFFIX}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: location.id,
    status: 'active',
    fullName: 'PO_STATUS_ADMIN'
  })
  adminToken = await signSessionToken(
    { id: ADMIN_ID, userName: `admin_po_status_${SUFFIX}`, roleType: 'admin', store: location.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  const receiptIds = await db.goodsReceipt
    .findAll({ where: { store: location.id }, attributes: ['id'], raw: true, paranoid: false })
    .then((rows) => rows.map((r) => r.id))
  const poIds = await db.purchase_order
    .findAll({ where: { store: location.id }, attributes: ['id'], raw: true })
    .then((rows) => rows.map((r) => r.id))
  const batchIds = await db.product_batch
    .findAll({ where: { product: product.id }, attributes: ['id'], raw: true })
    .then((rows) => rows.map((r) => r.id))
  if (batchIds.length) {
    await db.product_batch_stock.destroy({ where: { batch: batchIds }, force: true })
  }
  await db.product_batch.destroy({ where: { product: product.id }, force: true })
  await db.stock_history.destroy({ where: { product: product.id }, force: true })
  await db.product_store_stock.destroy({ where: { store: location.id }, force: true })
  await db.accounting_outbox.destroy({ where: { store: location.id }, force: true })
  if (receiptIds.length) {
    await db.goodsReceiptItem.destroy({ where: { goodsReceipt: receiptIds }, force: true })
  }
  await db.goodsReceipt.destroy({ where: { store: location.id }, force: true })
  if (poIds.length) {
    await db.purchase_order_item.destroy({ where: { purchaseOrder: poIds }, force: true })
  }
  await db.purchase_order.destroy({ where: { store: location.id }, force: true })
  await db.best_selling.destroy({ where: { store: location.id }, force: true })
  await db.product.destroy({ where: { id: product.id }, force: true })
  await db.category.destroy({ where: { id: category.id }, force: true })
  await db.user.destroy({ where: { id: [ADMIN_ID] }, force: true })
  await db.location.destroy({ where: { id: location.id }, force: true })
})

describe('PO status follows every goods receipt change', () => {
  test('a draft completed through edit marks the PO received', async () => {
    const po = await makePO(10)
    const draft = await makeReceipt(po, 10, 'draft')
    expect(await poStatus(po.id)).toBe('ordered')

    const res = await as('put', `/goods-receipt/update/${draft.id}`).send({
      status: 'completed',
      items: [line(po, 10)]
    })
    expect(res.status).toBe(200)
    expect(await poStatus(po.id)).toBe('received')
  })

  test('partial receipts completed through edit keep the PO ordered until the last unit', async () => {
    const po = await makePO(10)
    const first = await makeReceipt(po, 4, 'draft')
    await as('put', `/goods-receipt/update/${first.id}`).send({
      status: 'completed',
      items: [line(po, 4)]
    })
    expect(await poStatus(po.id)).toBe('ordered')

    const second = await makeReceipt(po, 6, 'draft')
    const res = await as('put', `/goods-receipt/update/${second.id}`).send({
      status: 'completed',
      items: [line(po, 6)]
    })
    expect(res.status).toBe(200)
    expect(await poStatus(po.id)).toBe('received')
  })
})
