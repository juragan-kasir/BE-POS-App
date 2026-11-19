process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const { Op } = require('sequelize')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 32 Batch B (PR-07): replacement-PO supplier/terms fidelity.
// Standing supplier purchase terms (payment method/tenor/dp, tax rate)
// must carry to the replacement PO; generated fields (order number,
// status, dates, creator) must be fresh; per-line supplier identity,
// quantities, units, prices and conversion factors must be preserved.
let store = null
let category = null
let product = null
let supplier = null
let adminToken = null

const PRICE = 10000
const TAX_RATE = 11

beforeAll(async () => {
  store = await db.location.create(await withTestTenant({ name: 'PR_RPL_STORE', status: 'active' }))
  category = await db.category.create({ name: 'PR_RPL_CAT' })
  product = await db.product.create({
    nameProduct: 'PR_RPL_PRODUCT',
    category: category.id,
    price: PRICE,
    costPrice: PRICE,
    stock: 0
  })
  supplier = await db.supplier.create({ name: 'PR_RPL_SUPPLIER', store: store.id })
  const adminUser = await db.user.create({
    userName: 'admin_pr_rpl',
    email: 'admin_pr_rpl@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.purchase_return_item.destroy({ where: {}, force: true })
  await db.purchase_return.destroy({ where: { store: store.id }, force: true })
  await db.stock_history.destroy({ where: { store: store.id }, force: true })
  await db.accounting_outbox.destroy({ where: { store: store.id }, force: true })
  await db.journal_entry_line.destroy({ where: {}, force: true })
  await db.journal_entry.destroy({ where: { store: store.id }, force: true })
  const ownReceipts = await db.goodsReceipt.findAll({ where: { store: store.id }, attributes: ['id'] })
  const ownReceiptIds = ownReceipts.map((r) => r.id)
  await db.goodsReceiptItem.destroy({ where: { goodsReceipt: ownReceiptIds }, force: true })
  await db.goodsReceipt.destroy({ where: { store: store.id }, force: true })
  await db.purchase_order_item.destroy({ where: {}, force: true })
  await db.purchase_order.destroy({ where: { store: store.id }, force: true })
  await db.purchase_payment.destroy({ where: { store: store.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product.id }, force: true })
  await db.product.destroy({ where: { id: product.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.supplier.destroy({ where: { id: supplier?.id }, force: true })
  await db.user.destroy({ where: { userName: 'admin_pr_rpl' }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

async function makePO({ qty = 10, price = PRICE, taxRate = TAX_RATE, paymentMethod = 'credit', tenor = 14, dpPercent = 20 } = {}) {
  const poRes = await request(app)
    .post('/purchase-order/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      store: store.id,
      status: 'ordered',
      taxRate,
      paymentMethod,
      tenor,
      dpPercent,
      dueDate: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
      supplier: supplier.id,
      items: [{ product: product.id, quantity: qty, price, supplier: supplier.id }]
    })
  expect(poRes.status).toBe(201)
  const po = poRes.body.data
  // DP must be settled before goods can be received on a credit PO.
  const dpAmount = Math.round((Number(po.finalAmount) * dpPercent) / 100)
  if (dpAmount > 0) {
    const payRes = await request(app)
      .post('/purchase-payment/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ purchaseOrder: po.id, supplier: supplier.id, amount: dpAmount, paymentMethod: 'cash' })
    expect(payRes.status).toBe(201)
  }
  const grRes = await request(app)
    .post('/goods-receipt/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      store: store.id,
      purchaseOrderId: po.id,
      status: 'completed',
      items: [{ purchaseOrderItem: po.items[0].id, product: product.id, qtyReceived: qty, price }]
    })
  expect(grRes.status).toBe(201)
  return db.purchase_order.findByPk(po.id)
}

async function approveReplacement(po, qty) {
  const createRes = await request(app)
    .post('/purchase-return/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ purchaseOrder: po.id, reason: 'replacement test', items: [{ productId: product.id, qty, unit: 'pcs' }] })
  expect(createRes.status).toBe(201)
  const approveRes = await request(app)
    .patch(`/purchase-return/approve/${createRes.body.data.id}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ id: createRes.body.data.id, resolution: 'replacement' })
  expect(approveRes.status).toBe(200)
  const rpl = await db.purchase_order.findOne({
    where: { store: store.id, notes: { [Op.like]: `%${createRes.body.data.returnNumber}%` } }
  })
  expect(rpl).not.toBeNull()
  return rpl
}

describe('PR-07 replacement-PO fidelity', () => {
  test('standing terms carry over: payment, tenor, dp, tax rate with canonical tax math', async () => {
    const po = await makePO({ qty: 10 })
    const rpl = await approveReplacement(po, 4)
    expect(rpl.paymentMethod).toBe('credit')
    expect(Number(rpl.tenor)).toBe(14)
    expect(Number(rpl.dpPercent)).toBe(20)
    expect(Number(rpl.taxRate)).toBe(11)
    // Canonical PO math on the replacement base (40000, no discount):
    // tax 4400, final 44400.
    expect(Number(rpl.totalAmount)).toBe(40000)
    expect(Number(rpl.taxAmount)).toBe(4400)
    expect(Number(rpl.finalAmount)).toBe(44400)
  })

  test('untaxed PO replacement stays untaxed (behavior unchanged)', async () => {
    const po = await makePO({ qty: 10, taxRate: 0 })
    const rpl = await approveReplacement(po, 4)
    expect(Number(rpl.taxRate)).toBe(0)
    expect(Number(rpl.taxAmount)).toBe(0)
    expect(Number(rpl.finalAmount)).toBe(40000)
  })

  test('lifecycle and identity fields stay generated, line fidelity preserved', async () => {
    const po = await makePO({ qty: 10 })
    const rpl = await approveReplacement(po, 4)
    expect(rpl.status).toBe('draft')
    expect(rpl.receivedDate).toBeNull()
    expect(rpl.orderNumber).toMatch(/^RPL-/)
    expect(rpl.orderNumber).not.toBe(po.orderNumber)
    expect(rpl.store).toBe(store.id)
    const items = await db.purchase_order_item.findAll({ where: { purchaseOrder: rpl.id } })
    expect(items).toHaveLength(1)
    expect(Number(items[0].product)).toBe(Number(product.id))
    expect(Number(items[0].supplier)).toBe(Number(supplier.id))
    expect(Number(items[0].quantity)).toBe(4)
    expect(Number(items[0].price)).toBe(PRICE)
    expect(Number(items[0].receivedQuantity)).toBe(0)
    expect(Number(items[0].conversionToBase)).toBe(1)
  })
})
