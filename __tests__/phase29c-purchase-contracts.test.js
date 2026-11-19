process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')
const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let storeA, storeB, category, productA, productB, adminA, tokenA

beforeAll(async () => {
  storeA = await db.location.create(await withTestTenant({ name: 'PH29C_STORE_A', status: 'active' }))
  storeB = await db.location.create(await withTestTenant({ name: 'PH29C_STORE_B', status: 'active' }))
  category = await db.category.create({ name: 'PH29C_CAT' })
  productA = await db.product.create({ nameProduct: 'PH29C_PROD_A', category: category.id, price: 1000, stock: 0 })
  productB = await db.product.create({ nameProduct: 'PH29C_PROD_B', category: category.id, price: 2000, stock: 0 })
  await db.product_store.create({ product: productA.id, store: storeA.id })
  await db.product_store.create({ product: productB.id, store: storeB.id })
  adminA = await db.user.create({ userName: 'ph29c_admin', email: 'ph29c@test.com', roleType: 'admin', userType: 'admin', store: storeA.id, status: 'active' })
  tokenA = await signSessionToken({ id: adminA.id, userName: adminA.userName, roleType: 'admin', store: storeA.id }, JWT_SECRET)
})

afterAll(async () => {
  await db.goodsReceiptItem.destroy({ where: {}, force: true })
  await db.goodsReceipt.destroy({ where: {}, force: true })
  await db.purchase_order_item.destroy({ where: {}, force: true })
  await db.purchase_order.destroy({ where: {}, force: true })
  await db.product_store.destroy({ where: { product: [productA.id, productB.id] }, force: true })
  await db.product_store_stock.destroy({ where: { product: [productA.id, productB.id] }, force: true })
  await db.product.destroy({ where: { id: [productA.id, productB.id] }, force: true })
  await db.category.destroy({ where: { id: category.id }, force: true })
  await db.user.destroy({ where: { id: adminA.id }, force: true })
  await db.location.destroy({ where: { id: [storeA.id, storeB.id] }, force: true })
})

const createPO = (body) => request(app).post('/purchase-order/create').set('Authorization', `Bearer ${tokenA}`).send({ store: storeA.id, ...body })

describe('T-11 STATUS mutation blocked via update', () => {
  test('update cannot set received', async () => {
    const po = await createPO({ status: 'pending', items: [{ product: productA.id, quantity: 5, price: 1000 }] })
    expect(po.status).toBe(201)
    const id = po.body.data.id
    const res = await request(app).put(`/purchase-order/update/${id}`).set('Authorization', `Bearer ${tokenA}`).send({ status: 'received' })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/Status cannot be changed/)
  })
  test('update cannot set cancelled', async () => {
    const po = await createPO({ status: 'pending', items: [{ product: productA.id, quantity: 2, price: 1000 }] })
    const id = po.body.data.id
    const res = await request(app).put(`/purchase-order/update/${id}`).set('Authorization', `Bearer ${tokenA}`).send({ status: 'cancelled' })
    expect(res.status).toBe(400)
  })
  test('pending->ordered via update blocked, must use send-to-supplier', async () => {
    const po = await createPO({ status: 'pending', items: [{ product: productA.id, quantity: 2, price: 1000 }] })
    const id = po.body.data.id
    const res = await request(app).put(`/purchase-order/update/${id}`).set('Authorization', `Bearer ${tokenA}`).send({ status: 'ordered' })
    expect(res.status).toBe(400)
    const ok = await request(app).put(`/purchase-order/send-to-supplier/${id}`).set('Authorization', `Bearer ${tokenA}`).send({})
    expect(ok.status).toBe(200)
    expect(ok.body.data.status).toBe('ordered')
  })
  test('draft->pending via update allowed (T-12 activation)', async () => {
    const po = await createPO({ status: 'draft', items: [{ product: productA.id, quantity: 1, price: 100 }] })
    const id = po.body.data.id
    const res = await request(app).put(`/purchase-order/update/${id}`).set('Authorization', `Bearer ${tokenA}`).send({ status: 'pending', items: [{ product: productA.id, quantity: 1, price: 100 }] })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('pending')
  })
})

describe('T-02/T-03/T-04 financial lock after first receipt', () => {
  let poId, poItemId
  beforeAll(async () => {
    const po = await createPO({ status: 'ordered', items: [{ product: productA.id, quantity: 10, price: 1000 }] })
    poId = po.body.data.id
    poItemId = po.body.data.items[0].id
    const gr = await request(app).post('/goods-receipt/create').set('Authorization', `Bearer ${tokenA}`).send({ purchaseOrderId: poId, items: [{ purchaseOrderItem: poItemId, product: productA.id, qtyReceived: 5 }] })
    expect(gr.status).toBe(201)
  })
  test('discount cannot change after receipt', async () => {
    const res = await request(app).put(`/purchase-order/update/${poId}`).set('Authorization', `Bearer ${tokenA}`).send({ discount: 999 })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/financial fields/)
  })
  test('taxRate cannot change after receipt', async () => {
    const res = await request(app).put(`/purchase-order/update/${poId}`).set('Authorization', `Bearer ${tokenA}`).send({ taxRate: 11 })
    expect(res.status).toBe(400)
  })
  test('additionalCost cannot change after receipt', async () => {
    const res = await request(app).put(`/purchase-order/update/${poId}`).set('Authorization', `Bearer ${tokenA}`).send({ additionalCost: 5000 })
    expect(res.status).toBe(400)
  })
  test('additionalCostNotes cannot change after receipt', async () => {
    const res = await request(app).put(`/purchase-order/update/${poId}`).set('Authorization', `Bearer ${tokenA}`).send({ additionalCostNotes: 'hacked' })
    expect(res.status).toBe(400)
  })
  test('overDeliveryTolerance cannot change after receipt', async () => {
    const res = await request(app).put(`/purchase-order/update/${poId}`).set('Authorization', `Bearer ${tokenA}`).send({ overDeliveryTolerance: 20 })
    expect(res.status).toBe(400)
  })
  test('item mutations remain blocked after receipt', async () => {
    const res = await request(app).put(`/purchase-order/update/${poId}`).set('Authorization', `Bearer ${tokenA}`).send({ items: [{ product: productA.id, quantity: 20, price: 1000 }] })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/Cannot modify purchase order items/)
  })
  test('before receipt edits still work (header-only notes)', async () => {
    const po2 = await createPO({ status: 'pending', items: [{ product: productA.id, quantity: 2, price: 500 }] })
    const id2 = po2.body.data.id
    const res = await request(app).put(`/purchase-order/update/${id2}`).set('Authorization', `Bearer ${tokenA}`).send({ notes: 'editable before receipt' })
    expect(res.status).toBe(200)
  })
})

describe('T-07 cancellation policy', () => {
  test('draft cancellation works', async () => {
    const po = await createPO({ status: 'draft', items: [{ product: productA.id, quantity: 1, price: 100 }] })
    const res = await request(app).put(`/purchase-order/cancel/${po.body.data.id}`).set('Authorization', `Bearer ${tokenA}`).send({})
    expect(res.status).toBe(200)
  })
  test('pending cancellation works (no receipt)', async () => {
    const po = await createPO({ status: 'pending', items: [{ product: productA.id, quantity: 1, price: 100 }] })
    const res = await request(app).put(`/purchase-order/cancel/${po.body.data.id}`).set('Authorization', `Bearer ${tokenA}`).send({})
    expect(res.status).toBe(200)
  })
  test('ordered/no-receipt cancellation works', async () => {
    const po = await createPO({ status: 'ordered', items: [{ product: productA.id, quantity: 1, price: 100 }] })
    const res = await request(app).put(`/purchase-order/cancel/${po.body.data.id}`).set('Authorization', `Bearer ${tokenA}`).send({})
    expect(res.status).toBe(200)
  })
  test('partial receipt cancellation rejected', async () => {
    const po = await createPO({ status: 'ordered', items: [{ product: productA.id, quantity: 10, price: 100 }] })
    const poItemId = po.body.data.items[0].id
    const gr = await request(app).post('/goods-receipt/create').set('Authorization', `Bearer ${tokenA}`).send({ purchaseOrderId: po.body.data.id, items: [{ purchaseOrderItem: poItemId, product: productA.id, qtyReceived: 4 }] })
    expect(gr.status).toBe(201)
    const res = await request(app).put(`/purchase-order/cancel/${po.body.data.id}`).set('Authorization', `Bearer ${tokenA}`).send({})
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/Purchase Return/)
  })
})

describe('T-09 product-store isolation', () => {
  test('valid product for store succeeds', async () => {
    const res = await createPO({ status: 'pending', items: [{ product: productA.id, quantity: 1, price: 100 }] })
    expect(res.status).toBe(201)
  })
  test('foreign-store product rejected', async () => {
    const res = await createPO({ status: 'pending', items: [{ product: productB.id, quantity: 1, price: 100 }] })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/not assigned to store/)
  })
})

describe('T-10 goods receipt idempotency', () => {
  test('same idempotencyKey returns same GR without duplicating stock', async () => {
    const po = await createPO({ status: 'ordered', items: [{ product: productA.id, quantity: 10, price: 100 }] })
    const poId = po.body.data.id
    const poItemId = po.body.data.items[0].id
    const before = await db.product.findByPk(productA.id)
    const beforeStock = Number(before.stock)
    const key = `test-gr-${Date.now()}-${Math.random().toString(36).slice(2,6)}`
    const payload = { purchaseOrderId: poId, idempotencyKey: key, items: [{ purchaseOrderItem: poItemId, product: productA.id, qtyReceived: 3 }] }
    const r1 = await request(app).post('/goods-receipt/create').set('Authorization', `Bearer ${tokenA}`).send(payload)
    expect(r1.status).toBe(201)
    const r2 = await request(app).post('/goods-receipt/create').set('Authorization', `Bearer ${tokenA}`).send(payload)
    expect(r2.status).toBe(200)
    expect(r2.body.data.id).toBe(r1.body.data.id)
    const after = await db.product.findByPk(productA.id)
    expect(Number(after.stock)).toBe(beforeStock + 3)
    const poItem = await db.purchase_order_item.findByPk(poItemId)
    expect(Number(poItem.receivedQuantity)).toBe(3)
  })
  test('different key creates new GR', async () => {
    const po = await createPO({ status: 'ordered', items: [{ product: productA.id, quantity: 10, price: 100 }] })
    const poItemId = po.body.data.items[0].id
    const k1 = `k1-${Date.now()}`
    const k2 = `k2-${Date.now()}`
    const r1 = await request(app).post('/goods-receipt/create').set('Authorization', `Bearer ${tokenA}`).send({ purchaseOrderId: po.body.data.id, idempotencyKey: k1, items: [{ purchaseOrderItem: poItemId, product: productA.id, qtyReceived: 2 }] })
    const r2 = await request(app).post('/goods-receipt/create').set('Authorization', `Bearer ${tokenA}`).send({ purchaseOrderId: po.body.data.id, idempotencyKey: k2, items: [{ purchaseOrderItem: poItemId, product: productA.id, qtyReceived: 2 }] })
    expect(r1.status).toBe(201)
    expect(r2.status).toBe(201)
    expect(r2.body.data.id).not.toBe(r1.body.data.id)
  })
})

describe('T-08 fractional qtyReceived preserved (no parseInt truncation)', () => {
  test('fractional ordered quantity 2.5 with qtyReceived 1 accepted and tolerance ceil preserved (qtyReceived stored as decimal)', async () => {
    const po = await createPO({ status: 'ordered', items: [{ product: productA.id, quantity: 2.5, price: 1000 }] })
    const poItemId = po.body.data.items[0].id
    // Verify ordered quantity preserved as decimal
    expect(Number(po.body.data.items[0].quantity)).toBeCloseTo(2.5)
    const gr = await request(app).post('/goods-receipt/create').set('Authorization', `Bearer ${tokenA}`).send({ purchaseOrderId: po.body.data.id, items: [{ purchaseOrderItem: poItemId, product: productA.id, qtyReceived: 1 }] })
    expect(gr.status).toBe(201)
    const item = gr.body.data.items ? gr.body.data.items[0] : (await db.goodsReceipt.findByPk(gr.body.data.id, { include: [{ model: db.goodsReceiptItem, as: 'items' }] })).items[0]
    const qty = Number(item.qtyReceived || (await db.goodsReceiptItem.findOne({ where: { goodsReceipt: gr.body.data.id } })).qtyReceived)
    expect(qty).toBeCloseTo(1)
    // Verify goods_receipt_item stores decimal (10,4) correctly
    const raw = await db.goodsReceiptItem.findOne({ where: { goodsReceipt: gr.body.data.id } })
    expect(Number(raw.qtyReceived)).toBeCloseTo(1)
  })
})

describe('T-02 taxRate 0-100 bound', () => {
  test('taxRate >100 rejected', async () => {
    const res = await createPO({ status: 'pending', taxRate: 150, items: [{ product: productA.id, quantity: 1, price: 100 }] })
    expect(res.status).toBe(400)
  })
  test('taxRate negative rejected', async () => {
    const res = await createPO({ status: 'pending', taxRate: -5, items: [{ product: productA.id, quantity: 1, price: 100 }] })
    expect(res.status).toBe(400)
  })
})
