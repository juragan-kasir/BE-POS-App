process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 32 Batch B (PR-06): purchase-return tax reversal + HPP preservation.
// Forward model (F22-B2-01): GR posts Dr Inventory (net) + Dr Input Tax 1250
// (pro-rated PO tax) / Cr AP (sum). The return must reverse its own share:
// Dr AP (base + tax share) / Cr Inventory (base) / Cr Input Tax (tax share).
// HPP (weighted-average product.costPrice) is preserved by issuing the
// return at current average cost — the average itself must not move.
let store = null
let category = null
let product = null
let adminToken = null

const PRICE = 10000
const TAX_RATE = 11

beforeAll(async () => {
  store = await db.location.create(await withTestTenant({ name: 'PR_FIN_STORE', status: 'active' }))
  category = await db.category.create({ name: 'PR_FIN_CAT' })
  product = await db.product.create({
    nameProduct: 'PR_FIN_PRODUCT',
    category: category.id,
    price: PRICE,
    costPrice: 0,
    stock: 0
  })
  const adminUser = await db.user.create({
    userName: 'admin_pr_fin',
    email: 'admin_pr_fin@test.com',
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
  await db.product_store_stock.destroy({ where: { product: product.id }, force: true })
  await db.product.destroy({ where: { id: product.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { userName: 'admin_pr_fin' }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

async function makeTaxedPOWithReceipt(qty, price = PRICE, taxRate = TAX_RATE) {
  const poRes = await request(app)
    .post('/purchase-order/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      store: store.id,
      status: 'ordered',
      taxRate,
      items: [{ product: product.id, quantity: qty, price }]
    })
  expect(poRes.status).toBe(201)
  const po = poRes.body.data
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

async function approveReturn(retId, resolution = 'credit') {
  return request(app)
    .patch(`/purchase-return/approve/${retId}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ id: retId, resolution })
}

async function journalLines(retId) {
  const entries = await db.journal_entry.findAll({
    where: { store: store.id, sourceType: 'purchase_return', referenceId: retId },
    include: [{ model: db.journal_entry_line, as: 'lines', include: [{ model: db.account, as: 'accountData' }] }]
  })
  const byCode = {}
  for (const e of entries) {
    for (const l of e.lines || []) {
      const code = l.accountData?.code || String(l.account)
      byCode[code] = byCode[code] || { debit: 0, credit: 0 }
      byCode[code].debit += Number(l.debit) || 0
      byCode[code].credit += Number(l.credit) || 0
    }
  }
  return { entries, byCode }
}

describe('PR-06 tax reversal on approve', () => {
  test('partial return reverses proportional base + tax share in finalAmount and journal', async () => {
    // PO: 10 × 10000 = 100000 base + 11% tax (11000) = 111000 final.
    const po = await makeTaxedPOWithReceipt(10)
    expect(Number(po.taxAmount)).toBe(11000)
    expect(Number(po.finalAmount)).toBe(111000)

    const createRes = await request(app)
      .post('/purchase-return/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ purchaseOrder: po.id, reason: 'tax test', items: [{ productId: product.id, qty: 4, unit: 'pcs' }] })
    expect(createRes.status).toBe(201)

    const approveRes = await approveReturn(createRes.body.data.id, 'credit')
    expect(approveRes.status).toBe(200)

    // Return base 40000 → tax share round(11000 × 40000/100000) = 4400.
    const poAfter = await db.purchase_order.findByPk(po.id)
    expect(Number(poAfter.finalAmount)).toBe(111000 - 40000 - 4400)

    const { entries, byCode } = await journalLines(createRes.body.data.id)
    expect(entries).toHaveLength(1)
    expect(byCode['2000'].debit).toBe(44400)
    expect(byCode['1200'].credit).toBe(40000)
    expect(byCode['1250'].credit).toBe(4400)
    const debits = Object.values(byCode).reduce((s, l) => s + l.debit, 0)
    const credits = Object.values(byCode).reduce((s, l) => s + l.credit, 0)
    expect(debits).toBe(credits)
  })

  test('untaxed PO return posts no tax leg (behavior unchanged)', async () => {
    const po = await makeTaxedPOWithReceipt(10, PRICE, 0)
    expect(Number(po.taxAmount)).toBe(0)
    const createRes = await request(app)
      .post('/purchase-return/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ purchaseOrder: po.id, reason: 'untaxed test', items: [{ productId: product.id, qty: 3, unit: 'pcs' }] })
    expect(createRes.status).toBe(201)
    expect((await approveReturn(createRes.body.data.id, 'credit')).status).toBe(200)

    const poAfter = await db.purchase_order.findByPk(po.id)
    expect(Number(poAfter.finalAmount)).toBe(Number(po.totalAmount) - 3 * PRICE)
    const { entries, byCode } = await journalLines(createRes.body.data.id)
    expect(entries).toHaveLength(1)
    expect(byCode['2000'].debit).toBe(3 * PRICE)
    expect(byCode['1200'].credit).toBe(3 * PRICE)
    expect(byCode['1250']).toBeUndefined()
  })
})

describe('PR-06 HPP preservation', () => {
  test('return approve leaves weighted-average HPP untouched while moving stock exactly', async () => {
    await makeTaxedPOWithReceipt(10)
    const hppBefore = Number((await db.product.findByPk(product.id)).costPrice)
    expect(hppBefore).toBe(PRICE)
    const stockBefore = Number((await db.product.findByPk(product.id)).stock)

    const po = await db.purchase_order.findOne({
      where: { store: store.id },
      order: [['id', 'DESC']]
    })
    const createRes = await request(app)
      .post('/purchase-return/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ purchaseOrder: po.id, reason: 'hpp test', items: [{ productId: product.id, qty: 4, unit: 'pcs' }] })
    expect(createRes.status).toBe(201)
    expect((await approveReturn(createRes.body.data.id, 'credit')).status).toBe(200)

    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(stockBefore - 4)
    expect(Number((await db.product.findByPk(product.id)).costPrice)).toBe(hppBefore)
  })
})
