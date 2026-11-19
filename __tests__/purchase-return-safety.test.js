process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const { Op } = require('sequelize')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 32 Batch A — purchase return safety remediation:
// PR-01 unmatched items rejected + rollback
// PR-02 atomic approve (no duplicate financial effects)
// PR-03 atomic reject (single restore) + approve/reject race
// PR-04 integer-only quantities (fractional rejected, never truncated)
// PR-09 no silent clamp (insufficient stock rejected, history exact)
let store = null
let category = null
let product = null
let adminToken = null

beforeAll(async () => {
  store = await db.location.create(await withTestTenant({ name: 'PR_SAFETY_STORE', status: 'active' }))
  category = await db.category.create({ name: 'PR_SAFETY_CAT' })
  product = await db.product.create({
    nameProduct: 'PR_SAFETY_PRODUCT',
    category: category.id,
    price: 8000,
    costPrice: 5000,
    stock: 0
  })
  const adminUser = await db.user.create({
    userName: 'admin_pr_safety',
    email: 'admin_pr_safety@test.com',
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
  await db.product_batch_stock.destroy({ where: {}, force: true })
  await db.product_batch.destroy({ where: {}, force: true })
  await db.product_store_stock.destroy({ where: { product: product.id }, force: true })
  await db.product.destroy({ where: { id: product.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { userName: 'admin_pr_safety' }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

async function makePOWithReceipt(qty, price = 5000) {
  const poRes = await request(app)
    .post('/purchase-order/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ store: store.id, status: 'ordered', items: [{ product: product.id, quantity: qty, price }] })
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
  return po
}

async function createReturn(poId, items, extra = {}) {
  return request(app)
    .post('/purchase-return/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ purchaseOrder: poId, reason: 'safety test', ...extra, items })
}

async function returnsForPO(poId) {
  return db.purchase_return.findAll({ where: { purchaseOrder: poId } })
}

describe('PR-04 integer-only quantities', () => {
  test('integer qty passes', async () => {
    const po = await makePOWithReceipt(100)
    const res = await createReturn(po.id, [{ productId: product.id, qty: 2, unit: 'pcs' }])
    expect(res.status).toBe(201)
  })

  test('fractional qty is rejected, never truncated', async () => {
    const po = await makePOWithReceipt(100)
    const stockBefore = Number((await db.product.findByPk(product.id)).stock)
    const res = await createReturn(po.id, [{ productId: product.id, qty: 2.5, unit: 'pcs' }])
    expect(res.status).toBe(422)
    expect(await returnsForPO(po.id)).toHaveLength(0)
    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(stockBefore)
  })

  test('fractional kg qty is rejected', async () => {
    const po = await makePOWithReceipt(100)
    const res = await createReturn(po.id, [{ productId: product.id, qty: 2.5, unit: 'kg' }])
    expect(res.status).toBe(422)
    expect(await returnsForPO(po.id)).toHaveLength(0)
  })

  test('mathematically integer decimal string passes', async () => {
    const po = await makePOWithReceipt(100)
    const res = await createReturn(po.id, [{ productId: product.id, qty: '2.0000', unit: 'pcs' }])
    expect(res.status).toBe(201)
  })

  test('NaN and Infinity are rejected', async () => {
    const po = await makePOWithReceipt(100)
    for (const bad of ['abc', 'Infinity', null, undefined]) {
      const res = await createReturn(po.id, [{ productId: product.id, qty: bad, unit: 'pcs' }])
      expect(res.status).toBe(422)
    }
    expect(await returnsForPO(po.id)).toHaveLength(0)
  })

  test('zero and negative qty are rejected', async () => {
    const po = await makePOWithReceipt(100)
    for (const bad of [0, -3]) {
      const res = await createReturn(po.id, [{ productId: product.id, qty: bad, unit: 'pcs' }])
      expect(res.status).toBe(422)
    }
    expect(await returnsForPO(po.id)).toHaveLength(0)
  })
})

describe('PR-01 unmatched items', () => {
  test('product never on the PO is rejected with no stock mutation', async () => {
    const po = await makePOWithReceipt(100)
    const stranger = await db.product.create({
      nameProduct: 'PR_SAFETY_STRANGER',
      category: category.id,
      price: 100,
      stock: 50
    })
    const stockBefore = Number((await db.product.findByPk(stranger.id)).stock)
    const res = await createReturn(po.id, [{ productId: stranger.id, qty: 5, unit: 'pcs' }])
    expect([400, 422]).toContain(res.status)
    expect(await returnsForPO(po.id)).toHaveLength(0)
    expect(Number((await db.product.findByPk(stranger.id)).stock)).toBe(stockBefore)
    await db.product.destroy({ where: { id: stranger.id }, force: true })
  })

  test('unknown ingredientName is rejected', async () => {
    const po = await makePOWithReceipt(100)
    const res = await createReturn(po.id, [{ ingredientName: 'NoSuchIngredient', qty: 5, unit: 'pcs' }])
    expect([400, 422]).toContain(res.status)
    expect(await returnsForPO(po.id)).toHaveLength(0)
  })

  test('mixed valid + invalid items roll back the entire transaction', async () => {
    const po = await makePOWithReceipt(100)
    const stockBefore = Number((await db.product.findByPk(product.id)).stock)
    const res = await createReturn(po.id, [
      { productId: product.id, qty: 5, unit: 'pcs' },
      { productId: 999999999, qty: 5, unit: 'pcs' }
    ])
    expect([400, 422]).toContain(res.status)
    expect(await returnsForPO(po.id)).toHaveLength(0)
    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(stockBefore)
  })
})

describe('PR-09 stock history invariant', () => {
  test('return against base stock without a store row seeds and deducts exactly', async () => {
    const poRes = await request(app)
      .post('/purchase-order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ store: store.id, status: 'ordered', items: [{ product: product.id, quantity: 5, price: 5000 }] })
    expect(poRes.status).toBe(201)
    const po = poRes.body.data
    await db.purchase_order_item.update({ receivedQuantity: 5 }, { where: { purchaseOrder: po.id } })
    await db.product.update({ stock: 20 }, { where: { id: product.id } })
    await db.product_store_stock.destroy({ where: { product: product.id, store: store.id }, force: true })
    const res = await createReturn(po.id, [{ productId: product.id, qty: 2, unit: 'pcs' }])
    expect(res.status).toBe(201)
    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(18)
    const storeRow = await db.product_store_stock.findOne({
      where: { product: product.id, store: store.id }
    })
    expect(Number(storeRow.stock)).toBe(18)
    const rows = await db.stock_history.findAll({
      where: { referenceType: 'purchase_return', referenceId: res.body.data.id, product: product.id }
    })
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].quantityBefore)).toBe(20)
    expect(Number(rows[0].quantityChange)).toBe(-2)
    expect(Number(rows[0].quantityAfter)).toBe(18)
  })

  test('sufficient stock produces exact before/change/after history', async () => {
    const po = await makePOWithReceipt(100)
    const before = Number((await db.product.findByPk(product.id)).stock)
    const res = await createReturn(po.id, [{ productId: product.id, qty: 7, unit: 'pcs' }])
    expect(res.status).toBe(201)
    const retId = res.body.data.id
    const rows = await db.stock_history.findAll({
      where: { referenceType: 'purchase_return', referenceId: retId, product: product.id }
    })
    expect(rows.length).toBeGreaterThanOrEqual(1)
    for (const r of rows) {
      expect(Number(r.quantityAfter)).toBe(Number(r.quantityBefore) + Number(r.quantityChange))
    }
    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(before - 7)
  })

  test('insufficient stock is rejected with no mutation and no history', async () => {
    const po = await makePOWithReceipt(100)
    await db.product.update({ stock: 5 }, { where: { id: product.id } })
    await db.product_store_stock.update({ stock: 5 }, { where: { product: product.id, store: store.id } })
    const histBefore = await db.stock_history.count({ where: { store: store.id } })
    const res = await createReturn(po.id, [{ productId: product.id, qty: 70, unit: 'pcs' }])
    expect(res.status).toBe(422)
    expect(await returnsForPO(po.id)).toHaveLength(0)
    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(5)
    expect(await db.stock_history.count({ where: { store: store.id } })).toBe(histBefore)
  })
})

describe('PR-02 atomic approve', () => {
  test('concurrent approves: exactly one wins, single credit, single outbox, no duplicate replacement', async () => {
    const po = await makePOWithReceipt(100, 5000)
    const poBefore = await db.purchase_order.findByPk(po.id)
    const createRes = await createReturn(po.id, [{ productId: product.id, qty: 10, unit: 'pcs' }])
    expect(createRes.status).toBe(201)
    const retId = createRes.body.data.id

    const approve = () =>
      request(app)
        .patch(`/purchase-return/approve/${retId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ id: retId, resolution: 'replacement' })
    const [a, b] = await Promise.all([approve(), approve()])
    expect([a.status, b.status].sort()).toEqual([200, 400])

    const poAfter = await db.purchase_order.findByPk(po.id)
    expect(Number(poAfter.finalAmount)).toBe(Number(poBefore.finalAmount) - 10 * 5000)
    const rplCount = await db.purchase_order.count({
      where: { notes: { [Op.like]: `%${createRes.body.data.returnNumber}%` } }
    })
    expect(rplCount).toBe(1)
    const jobs = await db.accounting_outbox.count({
      where: { referenceType: 'purchase_return', referenceId: retId }
    })
    expect(jobs).toBe(1)
    expect((await db.purchase_return.findByPk(retId)).status).toBe('approved')
  })
})

describe('PR-03 atomic reject', () => {
  test('concurrent rejects: one wins, stock restored exactly once', async () => {
    const po = await makePOWithReceipt(100)
    const stockAfterCreate = Number((await db.product.findByPk(product.id)).stock)
    const createRes = await createReturn(po.id, [{ productId: product.id, qty: 10, unit: 'pcs' }])
    expect(createRes.status).toBe(201)
    const retId = createRes.body.data.id
    const stockAfterReturn = Number((await db.product.findByPk(product.id)).stock)
    expect(stockAfterReturn).toBe(stockAfterCreate - 10)

    const reject = () =>
      request(app)
        .patch(`/purchase-return/reject/${retId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ id: retId })
    const [a, b] = await Promise.all([reject(), reject()])
    expect([a.status, b.status].sort()).toEqual([200, 400])

    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(stockAfterCreate)
    expect((await db.purchase_return.findByPk(retId)).status).toBe('rejected')
    const restores = await db.stock_history.count({
      where: { referenceId: retId, referenceType: 'adjustment' }
    })
    expect(restores).toBe(1)
  })

  test('approve/reject race: exactly one terminal state, effects consistent', async () => {
    const po = await makePOWithReceipt(100, 5000)
    const poBefore = await db.purchase_order.findByPk(po.id)
    const createRes = await createReturn(po.id, [{ productId: product.id, qty: 10, unit: 'pcs' }])
    expect(createRes.status).toBe(201)
    const retId = createRes.body.data.id
    const stockAfterReturn = Number((await db.product.findByPk(product.id)).stock)

    const [appr, rej] = await Promise.all([
      request(app)
        .patch(`/purchase-return/approve/${retId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ id: retId, resolution: 'credit' }),
      request(app)
        .patch(`/purchase-return/reject/${retId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ id: retId })
    ])
    expect([appr.status, rej.status].sort()).toEqual([200, 400])
    const final = await db.purchase_return.findByPk(retId)
    expect(['approved', 'rejected']).toContain(final.status)
    const poAfter = await db.purchase_order.findByPk(po.id)
    const stockFinal = Number((await db.product.findByPk(product.id)).stock)
    if (final.status === 'approved') {
      expect(Number(poAfter.finalAmount)).toBe(Number(poBefore.finalAmount) - 10 * 5000)
      expect(stockFinal).toBe(stockAfterReturn)
    } else {
      expect(Number(poAfter.finalAmount)).toBe(Number(poBefore.finalAmount))
      expect(stockFinal).toBe(stockAfterReturn + 10)
    }
  })
})
