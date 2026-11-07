process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

let location = null
let category = null
let product = null
let admin = null
let adminToken = null

const makeCompletedReceipt = async ({ qty = 10, price = 5000 } = {}) => {
  const poRes = await request(app)
    .post('/purchase-order/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      store: location.id,
      status: 'ordered',
      items: [{ product: product.id, quantity: qty, price }]
    })
  if (poRes.status !== 201) {
    throw new Error('PO setup failed: ' + JSON.stringify(poRes.body))
  }
  const po = poRes.body.data

  const grRes = await request(app)
    .post('/goods-receipt/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      store: location.id,
      purchaseOrderId: po.id,
      status: 'completed',
      items: [
        {
          purchaseOrderItem: po.items[0].id,
          product: product.id,
          qtyReceived: qty,
          price
        }
      ]
    })
  if (grRes.status !== 201) {
    throw new Error('GR setup failed: ' + JSON.stringify(grRes.body))
  }
  return { po, gr: grRes.body.data }
}

const cancel = (id) =>
  request(app)
    .patch(`/goods-receipt/status/${id}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ status: 'cancelled', store: location.id })

beforeAll(async () => {
  location = await db.location.create({
    name: `GR_CANCEL_COMPLETED_${SUFFIX}`,
    status: 'active'
  })
  category = await db.category.create({ name: `GR_CANCEL_CAT_${SUFFIX}` })
  product = await db.product.create({
    nameProduct: `GR_CANCEL_PROD_${SUFFIX}`,
    category: category.id,
    price: 9000,
    costPrice: 5000,
    stock: 0
  })
  admin = await db.user.create({
    userName: `admin_gr_cancel_${SUFFIX}`,
    email: `admin_gr_cancel_${SUFFIX}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: location.id,
    status: 'active',
    fullName: 'GR_CANCEL_ADMIN'
  })
  adminToken = await signSessionToken(
    {
      id: admin.id,
      userName: admin.userName,
      roleType: 'admin',
      store: location.id
    },
    JWT_SECRET
  )
})

afterAll(async () => {
  const receiptIds = await db.goodsReceipt
    .findAll({ where: { store: location.id }, attributes: ['id'], raw: true })
    .then((rows) => rows.map((r) => r.id))
  const poIds = await db.purchase_order
    .findAll({ where: { store: location.id }, attributes: ['id'], raw: true })
    .then((rows) => rows.map((r) => r.id))
  const batchIds = await db.product_batch
    .findAll({ where: { product: product.id }, attributes: ['id'], raw: true })
    .then((rows) => rows.map((r) => r.id))

  await db.accounting_outbox.destroy({ where: { store: location.id }, force: true })
  const journalIds = await db.journal_entry
    .findAll({ where: { store: location.id }, attributes: ['id'], raw: true })
    .then((rows) => rows.map((r) => r.id))
  if (journalIds.length) {
    await db.journal_entry_line.destroy({
      where: { journalEntry: journalIds },
      force: true
    })
  }
  await db.journal_entry.destroy({ where: { store: location.id }, force: true })
  if (batchIds.length) {
    await db.product_batch_stock.destroy({
      where: { batch: batchIds },
      force: true
    })
  }
  await db.product_batch.destroy({ where: { product: product.id }, force: true })
  await db.stock_history.destroy({ where: { product: product.id }, force: true })
  await db.product_store_stock.destroy({ where: { store: location.id }, force: true })
  if (receiptIds.length) {
    await db.goodsReceiptItem.destroy({
      where: { goodsReceipt: receiptIds },
      force: true
    })
  }
  await db.goodsReceipt.destroy({ where: { store: location.id }, force: true })
  if (poIds.length) {
    await db.purchase_order_item.destroy({
      where: { purchaseOrder: poIds },
      force: true
    })
  }
  await db.purchase_order.destroy({ where: { store: location.id }, force: true })
  await db.best_selling.destroy({ where: { store: location.id }, force: true })
  await db.product.destroy({ where: { id: product.id }, force: true })
  await db.category.destroy({ where: { id: category.id }, force: true })
  await db.user.destroy({ where: { id: admin.id }, force: true })
  await db.location.destroy({ where: { id: location.id }, force: true })
})

describe('GR lifecycle — cancelling an already-completed receipt', () => {
  test('reverses stock, PO received quantity, batches, and the purchase journal', async () => {
    const { po, gr } = await makeCompletedReceipt({ qty: 10, price: 5000 })

    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(10)
    expect(Number((await db.purchase_order_item.findByPk(po.items[0].id)).receivedQuantity)).toBe(10)

    const original = await db.journal_entry.findOne({
      where: { store: location.id, sourceType: 'purchase', referenceId: gr.id }
    })
    expect(original).not.toBeNull()

    const res = await cancel(gr.id)
    expect(res.status).toBe(200)

    const freshGr = await db.goodsReceipt.findByPk(gr.id)
    expect(freshGr.status).toBe('cancelled')
    expect(freshGr.stockPosted).toBe(false)

    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(0)
    expect(Number((await db.purchase_order_item.findByPk(po.items[0].id)).receivedQuantity)).toBe(0)

    const batch = await db.product_batch.findOne({
      where: { product: product.id, store: location.id }
    })
    expect(batch.status).toBe('reversed')
    const batchStock = await db.product_batch_stock.findOne({
      where: { batch: batch.id }
    })
    expect(Number(batchStock.quantity)).toBe(0)

    const reversal = await db.journal_entry.findOne({
      where: {
        store: location.id,
        sourceType: 'purchase_reversal',
        referenceId: gr.id
      }
    })
    expect(reversal).not.toBeNull()
    expect(Number(reversal.totalDebit)).toBe(Number(original.totalCredit))
    expect(Number(reversal.totalCredit)).toBe(Number(original.totalDebit))
  })

  test('a second cancellation is rejected and never double-reverses', async () => {
    const { gr } = await makeCompletedReceipt({ qty: 4, price: 5000 })
    expect((await cancel(gr.id)).status).toBe(200)
    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(0)

    const again = await cancel(gr.id)
    expect(again.status).toBe(400)

    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(0)
    const reversals = await db.journal_entry.findAll({
      where: {
        store: location.id,
        sourceType: 'purchase_reversal',
        referenceId: gr.id
      }
    })
    expect(reversals).toHaveLength(1)
  })
})
