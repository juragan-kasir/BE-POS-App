process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const RUN = Date.now()

let store, otherStore, category, admin, adminToken, product

beforeAll(async () => {
  store = await db.location.create({ name: `BKR_STORE_${RUN}`, status: 'active', businessType: 'bakery' })
  otherStore = await db.location.create({ name: `BKR_OTHER_${RUN}`, status: 'active', businessType: 'bakery' })
  category = await db.category.create({ name: `BKR_CAT_${RUN}`, status: 'active' })
  admin = await db.user.create({ userName: `bkr_admin_${RUN}`, email: `bkr_admin_${RUN}@t.test`, roleType: 'admin', userType: 'admin', store: store.id, status: 'active', fullName: 'Bakery Admin' })
  adminToken = await signSessionToken({ id: admin.id, userName: admin.userName, roleType: 'admin', store: store.id }, JWT_SECRET)
  product = await db.product.create({ nameProduct: `Roti ${RUN}`, category: category.id, price: 25000, status: 'active', isAvailable: true, store: store.id })
  if (db.product_store) await db.product_store.create({ product: product.id, store: store.id }).catch(() => {})
  await db.cashRegister.create({ store: store.id, user: admin.id, status: 'open', openingBalance: 0, openedAt: new Date() })
})

afterAll(async () => {
  try { await db.bakery_status_history.destroy({ where: {}, force: true }) } catch {}
  try { await db.bakery_order.destroy({ where: { store: [store.id, otherStore.id] }, force: true }) } catch {}
  try { await db.transaction.destroy({ where: {}, force: true }) } catch {}
  try { await db.order_item.destroy({ where: {}, force: true }) } catch {}
  try { await db.order.destroy({ where: { store: [store.id, otherStore.id] }, force: true }) } catch {}
  try { await db.product.destroy({ where: { id: product.id }, force: true }) } catch {}
  try { await db.category.destroy({ where: { id: category.id }, force: true }) } catch {}
  try { await db.user.destroy({ where: { id: admin.id }, force: true }) } catch {}
  try { await db.location.destroy({ where: { id: [store.id, otherStore.id] }, force: true }) } catch {}
})

const asAdmin = () => ({ Authorization: `Bearer ${adminToken}` })
const baseBody = (overrides = {}) => ({
  store: store.id,
  idempotencyKey: `bkr-${RUN}-${Math.random()}`,
  customerName: 'Budi',
  customerPhone: '08123456789',
  fulfillmentType: 'pickup',
  scheduledAt: new Date(Date.now() + 86400000).toISOString(),
  items: [{ productId: product.id, quantity: 2 }],
  dpAmount: 10000,
  dpMethod: 'cash',
  ...overrides
})

describe('bakery domain', () => {
  test('create order idempotent and returns bakery shape', async () => {
    const body = baseBody({ idempotencyKey: `idem-${RUN}` })
    const r1 = await request(app).post('/bakery/orders').set(asAdmin()).send(body)
    expect(r1.status).toBe(201)
    expect(r1.body.orderNo).toBeTruthy()
    expect(r1.body.processStatus).toBe('PENDING_CONFIRMATION')
    expect(r1.body.total).toBe(50000)
    expect(r1.body.paidAmount).toBe(10000)
    expect(r1.body.remainingAmount).toBe(40000)

    const r2 = await request(app).post('/bakery/orders').set(asAdmin()).send(body)
    expect(r2.status).toBe(200)
    expect(r2.body.id).toBe(r1.body.id)
  })

  test('status transition rejects invalid path', async () => {
    const created = await request(app).post('/bakery/orders').set(asAdmin()).send(baseBody())
    expect(created.status).toBe(201)
    const bad = await request(app).patch(`/bakery/orders/${created.body.id}/status`).set(asAdmin()).send({ store: store.id, toStatus: 'READY' })
    expect(bad.status).toBe(409)
    expect(bad.body.code).toBe('INVALID_BAKERY_STATUS_TRANSITION')
  })

  test('tenant/store scoping blocks other store', async () => {
    const created = await request(app).post('/bakery/orders').set(asAdmin()).send(baseBody())
    expect(created.status).toBe(201)
    const other = await request(app).get(`/bakery/orders/${created.body.id}`).set(asAdmin()).query({ store: otherStore.id })
    expect([403, 404]).toContain(other.status)
  })

  test('status accepts FE alias and payment is idempotent', async () => {
    const created = await request(app).post('/bakery/orders').set(asAdmin()).send(baseBody({ idempotencyKey: `alias-${RUN}` }))
    expect(created.status).toBe(201)
    const st = await request(app).patch(`/bakery/orders/${created.body.id}/status`).set(asAdmin()).send({ store: store.id, status: 'CONFIRMED', idempotencyKey: `st-${RUN}` })
    expect(st.status).toBe(200)
    expect(st.body.processStatus).toBe('CONFIRMED')

    const payBody = { store: store.id, amount: 40000, method: 'cash', idempotencyKey: `pay-${RUN}` }
    const p1 = await request(app).post(`/bakery/orders/${created.body.id}/payments`).set(asAdmin()).send(payBody)
    expect(p1.status).toBe(200)
    expect(p1.body.paidAmount).toBe(50000)
    expect(p1.body.paymentStatus).toBe('paid')
    const p2 = await request(app).post(`/bakery/orders/${created.body.id}/payments`).set(asAdmin()).send(payBody)
    expect(p2.status).toBe(200)
    expect(p2.body.paidAmount).toBe(50000)
  })

  test('catalog/settings/stores endpoints return contract shapes', async () => {
    const members = await request(app).get('/bakery/members').set(asAdmin()).query({ store: store.id, q: '' })
    expect(members.status).toBe(200)
    expect(Array.isArray(members.body.data)).toBe(true)

    const products = await request(app).get('/bakery/products').set(asAdmin()).query({ store: store.id })
    expect(products.status).toBe(200)
    expect(products.body.data[0]).toEqual(expect.objectContaining({ id: String(product.id), name: expect.any(String), price: expect.any(Number) }))

    const settings = await request(app).get('/bakery/settings').set(asAdmin()).query({ store: store.id })
    expect(settings.status).toBe(200)
    expect(settings.body.businessType).toBe('bakery')

    const stores = await request(app).get('/bakery/stores').set(asAdmin())
    expect(stores.status).toBe(200)
    expect(Array.isArray(stores.body.data)).toBe(true)
  })

  test('cancel and dashboard/calendar/production endpoints work', async () => {
    const created = await request(app).post('/bakery/orders').set(asAdmin()).send(baseBody({ idempotencyKey: `cancel-${RUN}` }))
    expect(created.status).toBe(201)
    const cancelled = await request(app).post(`/bakery/orders/${created.body.id}/cancel`).set(asAdmin()).send({ store: store.id, reason: 'Customer request', idempotencyKey: `cancel-req-${RUN}` })
    expect(cancelled.status).toBe(200)
    expect(cancelled.body.processStatus).toBe('CANCELLED')

    const date = new Date().toISOString().slice(0, 10)
    const dash = await request(app).get('/bakery/dashboard').set(asAdmin()).query({ store: store.id, date })
    expect(dash.status).toBe(200)
    expect(dash.body).toEqual(expect.objectContaining({ date, totalOrders: expect.any(Number) }))

    const cal = await request(app).get('/bakery/calendar').set(asAdmin()).query({ store: store.id, from: date, to: date })
    expect(cal.status).toBe(200)
    expect(Array.isArray(cal.body.data)).toBe(true)

    const plan = await request(app).get('/bakery/production-plan').set(asAdmin()).query({ store: store.id, date })
    expect(plan.status).toBe(200)
    expect(Array.isArray(plan.body.items)).toBe(true)
  })
})
