process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const RUN = Date.now()

let store, category, admin, adminToken, sa, saToken, service, member

beforeAll(async () => {
  store = await db.location.create({ name: `LDRY_STORE_${RUN}`, status: 'active', businessType: 'laundry' })
  category = await db.category.create({ name: `LDRY_CAT_${RUN}`, status: 'active' })
  admin = await db.user.create({ userName: `ldry_admin_${RUN}`, email: `ldry_admin_${RUN}@t.test`, roleType: 'admin', userType: 'admin', store: store.id, status: 'active', fullName: 'Laundry Admin' })
  adminToken = await signSessionToken({ id: admin.id, userName: admin.userName, roleType: 'admin', store: store.id }, JWT_SECRET)
  sa = await db.user.create({ userName: `ldry_sa_${RUN}`, email: `ldry_sa_${RUN}@t.test`, roleType: 'super_admin', userType: 'super_admin', status: 'active' })
  saToken = await signSessionToken({ id: sa.id, userName: sa.userName, roleType: 'super_admin' }, JWT_SECRET)

  member = await db.member.create({ store: store.id, name: 'Budi', phoneNumber: `08${RUN}`.slice(0, 15), status: 'active', isCredit: true, creditLimit: 500000 })

  const svcRes = await request(app)
    .post('/product/add-product')
    .set('Authorization', `Bearer ${saToken}`)
    .send({
      nameProduct: `Cuci Setrika ${RUN}`,
      category: category.id,
      price: 8000,
      status: 'active',
      isAvailable: true,
      stores: [store.id],
      tipeProduk: 'laundry_service',
      inventoryMode: 'make_to_order',
      allowDecimalQty: true,
      unit: 'kg',
      serviceConfig: { pricingType: 'kiloan', channel: 'full', pricingMode: 'unit', minQty: 3, rounding: 0.1, requiresIroning: true, costComponents: [{ kind: 'chemical', amount: 1000 }] }
    })
  service = svcRes.body.data
})

afterAll(async () => {
  try {
    await db.laundry_status_history.destroy({ where: {}, force: true, truncate: true, cascade: true })
  } catch {}
  try { await db.laundry_order.destroy({ where: { store: store.id }, force: true }) } catch {}
  try { await db.transaction.destroy({ where: {}, force: true }) } catch {}
  try { await db.order_item.destroy({ where: {}, force: true }) } catch {}
  try { await db.order.destroy({ where: { store: store.id }, force: true }) } catch {}
  try { await db.laundry_turnaround.destroy({ where: { store: store.id }, force: true }) } catch {}
  try { await db.cashRegister.destroy({ where: { store: store.id }, force: true }) } catch {}
  try { await db.product.destroy({ where: { id: service?.id }, force: true }) } catch {}
  try { await db.member.destroy({ where: { id: member.id }, force: true }) } catch {}
  try { await db.category.destroy({ where: { id: category.id }, force: true }) } catch {}
  try { await db.user.destroy({ where: { id: [admin.id, sa.id] }, force: true }) } catch {}
  try { await db.location.destroy({ where: { id: store.id }, force: true }) } catch {}
})

const asAdmin = () => ({ Authorization: `Bearer ${adminToken}` })
const asSA = () => ({ Authorization: `Bearer ${saToken}` })

test('laundry master data fields persist', async () => {
  expect(service).toBeTruthy()
  expect(service.serviceConfig).toBeTruthy()
  expect(service.serviceConfig.pricingType).toBe('kiloan')

  const loc = await request(app).get(`/location/get-location-detail/${store.id}`).set(asSA())
  expect(loc.status).toBe(200)
  expect(loc.body.data.businessType).toBe('laundry')

  const mem = await db.member.findByPk(member.id)
  expect(mem.isCredit).toBe(true)
})

test('POS product payload without serviceConfig still works', async () => {
  const res = await request(app)
    .post('/product/add-product')
    .set('Authorization', `Bearer ${saToken}`)
    .send({ nameProduct: `POS_${RUN}`, category: category.id, price: 5000, stores: [store.id], status: 'active' })
  expect(res.status).toBe(200)
  expect(res.body.data.serviceConfig).toBeNull()
})

let turnaroundId, orderId

test('turnaround CRUD', async () => {
  const created = await request(app)
    .post('/laundry/turnaround')
    .set(asAdmin())
    .send({ store: store.id, name: 'Reguler', durationHours: 72, surchargeType: 'none', surchargeValue: 0, isDefault: true, status: 'active' })
  expect(created.status).toBe(201)
  turnaroundId = created.body.data.id

  const list = await request(app).get(`/laundry/turnaround?store=${store.id}`).set(asAdmin())
  expect(list.status).toBe(200)
  expect(list.body.data.some((r) => r.id === turnaroundId)).toBe(true)
})

test('quote applies minimum weight', async () => {
  const res = await request(app)
    .post('/laundry/quote')
    .set(asAdmin())
    .send({ store: store.id, items: [{ product: service.id, quantity: 2.2 }], turnaroundId })
  expect(res.status).toBe(200)
  expect(res.body.data.subtotal).toBe(24000)
  expect(res.body.data.pieceRequired).toBe(true)
})

test('create laundry order with DP, collect, status, pickup', async () => {
  const open = await request(app).post('/cash-register/open').set(asAdmin()).send({ store: store.id, openingBalance: 100000, shift: 1 })
  expect([200, 201]).toContain(open.status)

  const created = await request(app)
    .post('/laundry/order')
    .set(asAdmin())
    .send({
      store: store.id,
      idempotencyKey: `ldry-${RUN}`,
      customerId: member.id,
      turnaroundId,
      pieceCount: 5,
      items: [{ product: service.id, quantity: 2.2 }],
      paymentMethod: 'CASH',
      paymentAmount: 10000,
      cashAmount: 10000,
      changeAmount: 0
    })
  expect(created.status).toBe(201)
  expect(created.body.data).toBeTruthy()
  orderId = created.body.data.id
  expect(created.body.data.paymentStatus).toBe('partially_paid')
  expect(created.body.data.laundryOrder.processStatus).toBe('RECEIVED')

  const dup = await request(app)
    .post('/laundry/order')
    .set(asAdmin())
    .send({
      store: store.id,
      idempotencyKey: `ldry-${RUN}`,
      customerId: member.id,
      turnaroundId,
      pieceCount: 5,
      items: [{ product: service.id, quantity: 2.2 }],
      paymentMethod: 'CASH',
      paymentAmount: 10000,
      cashAmount: 10000,
      changeAmount: 0
    })
  expect(dup.status).toBe(200)
  expect(dup.body.data.id).toBe(orderId)

  const collect = await request(app)
    .post(`/order/${orderId}/payments`)
    .set(asAdmin())
    .send({ store: store.id, paymentMethod: 'CASH', amount: 14000, cashAmount: 14000, changeAmount: 0, idempotencyKey: `pay-${RUN}` })
  expect(collect.status).toBe(200)
  expect(['paid']).toContain(collect.body.data.paymentStatus)

  const st = await request(app)
    .patch(`/laundry/order/${orderId}/status`)
    .set(asAdmin())
    .send({ store: store.id, toStatus: 'WASHING' })
  expect(st.status).toBe(200)

  const st2 = await request(app)
    .patch(`/laundry/order/${orderId}/status`)
    .set(asAdmin())
    .send({ store: store.id, toStatus: 'READY' })
  expect(st2.status).toBe(200)

  const wa = await request(app).get(`/laundry/order/${orderId}/wa-text?type=ready`).set(asAdmin())
  expect(wa.status).toBe(200)
  expect(wa.body.data.text).toContain('siap diambil')

  const pickup = await request(app)
    .post(`/laundry/order/${orderId}/pickup`)
    .set(asAdmin())
    .send({ store: store.id, pickupPieceCount: 5 })
  expect(pickup.status).toBe(200)

  const detail = await request(app).get(`/laundry/order/${orderId}`).set(asAdmin())
  expect(detail.status).toBe(200)
  expect(detail.body.data.laundryOrder.processStatus).toBe('PICKED_UP')
})
