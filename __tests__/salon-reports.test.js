process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { zonedToUtc, localDate, addDays } = require('../api/service/salonTime')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Salon S2-b reports. Shapes follow FE-SALON-App src/api/contract.ts
// (RevenueReport, CommissionReport, OccupancyReport, NoShowReport); rules
// follow src/mocks/engine/reports.ts. Every number below is worked out by hand
// from the scenario in beforeAll.
//
// Scenario (outlet open 00:00–23:59, Potong 60 min no buffer, senior 65.000,
// commission 40%):
//   B1 Dewi, member, deposit 20.000 cash → checkout: disc 10%, tip 10.000 to
//      Dewi, rest 48.500 by QRIS.            paid
//   B2 Rina, no member → cash 65.000, then refunded by the owner.
//   B3 Rina, deposit 15.000 cash → no-show (deposit forfeited).
//   B4 Rina → cancelled.

const TZ = 'Asia/Jakarta'
const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
const users = {}
const tokens = {}
const tenants = {}
const stores = {}
const createdUserIds = []
const f = {}
const today = localDate(Date.now(), TZ)
const tomorrow = addDays(today, 1)
const range = `from=${today}&to=${addDays(today, 2)}`
let keySeq = 0
const key = () => `srp-${stamp}-${++keySeq}`

const nextLocationId = async () => {
  const [rows] = await db.sequelize.query("SELECT nextval('location_id_seq') AS id")
  return Number(rows[0].id)
}
const makeLocation = async (tenantId, name) =>
  db.location.create({
    id: await nextLocationId(),
    name: `${name}_${stamp}`,
    phoneNumber: '0215550000',
    status: 'active',
    tenantId,
    businessType: 'salon',
    timezone: TZ,
    salonSettings: { openTime: '00:00', closeTime: '23:59' }
  })
const sign = async (k, user) => {
  tokens[k] = await signSessionToken({ id: user.id, userName: user.userName, roleType: user.roleType, store: user.store }, JWT_SECRET)
}
const makeUser = async (k, roleType, storeId) => {
  users[k] = await db.user.create({
    userName: `srp_${k}_${stamp}`,
    fullName: `Salon ${k}`,
    email: `srp_${k}_${stamp}@test.com`,
    roleType,
    userType: roleType === 'user' ? 'user' : 'admin',
    store: storeId,
    status: 'active'
  })
  createdUserIds.push(users[k].id)
  await sign(k, users[k])
}
const call = (k, method, path, body) => {
  const r = request(app)[method](path).set('Authorization', `Bearer ${tokens[k]}`)
  return body === undefined ? r : r.send(body)
}
const qa = () => `?store=${stores.a.id}`
const stylist = async (k, name) => {
  const created = await call('owner', 'post', `/salon/staff${qa()}`, {
    name,
    username: `srp_${k}_${stamp}`.toLowerCase().slice(0, 30),
    position: 'Stylist',
    positionId: null,
    level: 'senior',
    colorTag: '#10b981',
    acceptsOnline: true,
    active: true,
    commissionOverride: null
  })
  expect(created.status).toBe(201)
  const id = created.body.userId
  await call('owner', 'put', `/salon/staff/${id}/skills${qa()}`, [{ productId: f.cut.id, durationOverride: null, priceOverride: null }])
  const avail = await call('owner', 'put', `/salon/staff/${id}/availability${qa()}`,
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: '00:00', endTime: '23:59' })))
  expect(avail.status).toBe(200)
  users[k] = await db.user.findByPk(Number(id))
  await sign(k, users[k])
  return id
}
const book = async (staffId, hhmm, extra = {}) => {
  const res = await call('admin', 'post', `/salon/appointments${qa()}`, {
    serviceIds: [f.cut.id],
    staffId,
    startAt: new Date(zonedToUtc(tomorrow, hhmm, TZ)).toISOString(),
    memberId: null,
    customerName: 'Tamu',
    customerPhone: '081234567890',
    source: 'phone',
    depositAmount: 0,
    depositMethod: null,
    notes: '',
    idempotencyKey: key(),
    ...extra
  })
  expect(res.status).toBe(201)
  return res.body
}
const serve = async (id) => {
  for (const step of ['check-in', 'start', 'complete']) {
    expect((await call('admin', 'post', `/salon/appointments/${id}/${step}${qa()}`, { reason: null })).status).toBe(200)
  }
}
const checkout = async (appointmentId, extra) => {
  const res = await call('kasir', 'post', `/salon/checkout${qa()}`, {
    appointmentId,
    extras: [],
    tip: { amount: 0, staffId: null },
    discount: { type: 'none' },
    customerName: '',
    memberId: null,
    idempotencyKey: key(),
    ...extra
  })
  expect(res.status).toBe(201)
  return res.body
}

beforeAll(async () => {
  tenants.salon = await db.tenant.create({ code: `srp-${stamp}`, name: 'Salon Laporan', businessType: 'salon' })
  tenants.other = await db.tenant.create({ code: `srp-o-${stamp}`, name: 'Salon Lain', businessType: 'salon' })
  stores.a = await makeLocation(tenants.salon.id, 'SRP_A')
  stores.other = await makeLocation(tenants.other.id, 'SRP_O')
  await makeUser('owner', 'super_admin', stores.a.id)
  await makeUser('admin', 'admin', stores.a.id)
  await makeUser('kasir', 'kasir', stores.a.id)
  await makeUser('otherOwner', 'super_admin', stores.other.id)
  const svc = await call('owner', 'post', '/salon/services', {
    name: `Potong ${stamp}`,
    category: 'Rambut',
    basePrice: 50000,
    serviceConfig: { durationMin: 60, bufferMin: 0, levelPrices: { junior: 50000, senior: 65000, master: 80000 }, commission: { type: 'percent', value: 40 } },
    active: true
  })
  expect(svc.status).toBe(201)
  f.cut = svc.body
  f.dewi = await stylist('dewi', 'Dewi')
  f.rina = await stylist('rina', 'Rina')
  const member = await call('admin', 'post', `/salon/customers${qa()}`, { name: 'Sari Member', phone: `0813${String(Date.now()).slice(-8)}`, notes: '' })
  expect(member.status).toBe(201)
  f.member = member.body

  expect((await call('kasir', 'post', `/salon/shift/open${qa()}`, { openingCash: 0 })).status).toBe(201)

  const b1 = await book(f.dewi, '10:00', { memberId: f.member.id, depositAmount: 20000, depositMethod: 'cash' })
  await serve(b1.id)
  await checkout(b1.id, {
    tip: { amount: 10000, staffId: f.dewi },
    discount: { type: 'percent', value: 10 },
    memberId: f.member.id,
    payments: [{ method: 'qris', amount: 48500, tendered: null, reference: 'QR-SRP-1' }]
  })

  const b2 = await book(f.rina, '10:00')
  await serve(b2.id)
  const o2 = await checkout(b2.id, { payments: [{ method: 'cash', amount: 65000, tendered: 70000, reference: null }] })
  expect((await call('owner', 'post', `/salon/orders/${o2.id}/refund${qa()}`, { reason: 'Pelanggan komplain', ownerPin: null })).status).toBe(200)

  const b3 = await book(f.rina, '13:00', { depositAmount: 15000, depositMethod: 'cash' })
  expect((await call('admin', 'post', `/salon/appointments/${b3.id}/no-show${qa()}`, { reason: null })).status).toBe(200)
  const b4 = await book(f.rina, '15:00')
  expect((await call('admin', 'post', `/salon/appointments/${b4.id}/cancel${qa()}`, { reason: 'Batal mendadak' })).status).toBe(200)
})

afterAll(async () => {
  const tenantIds = Object.values(tenants).map((t) => t.id)
  const storeIds = (await db.location.findAll({ where: { tenantId: tenantIds }, paranoid: false, attributes: ['id'] })).map((l) => l.id)
  const productIds = (await db.product.findAll({ where: { tenantId: tenantIds }, paranoid: false, attributes: ['id'] })).map((p) => p.id)
  const staffUserIds = (await db.salon_staff_profile.findAll({ where: { tenantId: tenantIds }, paranoid: false, attributes: ['userId'] })).map((p) => p.userId)
  const orderIds = (await db.order.findAll({ where: { store: storeIds }, paranoid: false, attributes: ['id'] })).map((o) => o.id)
  const q = (sql, replacements) => db.sequelize.query(sql, { replacements }).catch((e) => console.error(e.message))
  const del = (model, where) => db[model].destroy({ where, force: true }).catch((e) => console.error(model, e.message))
  if (orderIds.length) {
    await q('ALTER TABLE salon_staff_commission DISABLE TRIGGER USER')
    await q('DELETE FROM salon_staff_commission WHERE "orderId" IN (:ids)', { ids: orderIds })
    await q('ALTER TABLE salon_staff_commission ENABLE TRIGGER USER')
    await del('salon_order', { orderId: orderIds })
    await q('DELETE FROM accounting_outbox WHERE "referenceType" = \'order\' AND "referenceId" IN (:ids)', { ids: orderIds })
    await q('DELETE FROM journal_entry_line WHERE "journalEntry" IN (SELECT id FROM journal_entry WHERE store IN (:s))', { s: storeIds })
    await del('journal_entry', { store: storeIds })
    await del('account', { store: storeIds })
  }
  // Deposit rows of this test's bookings without an order live on the till too.
  const aptIds = (await db.salon_appointment.findAll({ where: { tenantId: tenantIds }, attributes: ['id'] })).map((a) => a.id)
  const depositKeys = aptIds.map((id) => `salon-deposit:${id}`)
  await q('DELETE FROM "transaction" WHERE "order" IN (:ids) OR "idempotencyKey" IN (:keys)', {
    ids: orderIds.length ? orderIds : [0],
    keys: depositKeys.length ? depositKeys : ['-']
  })
  if (orderIds.length) {
    await del('order_item', { order: orderIds })
    await del('order_status', { order: orderIds })
    await del('order', { id: orderIds })
  }
  await del('salon_appointment_event', { tenantId: tenantIds })
  await del('salon_appointment_item', { tenantId: tenantIds })
  await del('salon_appointment', { tenantId: tenantIds })
  await del('member', { tenantId: tenantIds })
  await del('salon_availability', { tenantId: tenantIds })
  await del('salon_staff_skill', { tenantId: tenantIds })
  await del('salon_staff_profile', { tenantId: tenantIds })
  await q('DELETE FROM document_counter WHERE store IN (:ids)', { ids: storeIds })
  await del('cashRegister', { store: storeIds })
  await del('product_store', { product: productIds })
  await del('product', { id: productIds })
  await del('category', { tenantId: tenantIds })
  await del('user', { id: [...createdUserIds, ...staffUserIds] })
  await del('position', { tenantId: tenantIds })
  await del('location', { id: storeIds })
  await del('tenant', { id: tenantIds })
  await db.sequelize.close()
})

describe('salon reports', () => {
  test('revenue: paid orders only, refund and forfeited deposit apart, deposit under its own method', async () => {
    const res = await call('owner', 'get', `/salon/reports/revenue?${range}`)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      gross: 65000,
      discount: 6500,
      tips: 10000,
      net: 58500,
      refunds: 65000,
      depositForfeited: 15000,
      orderCount: 1,
      byService: [{ name: `Potong ${stamp}`, count: 1, net: 58500 }],
      byStaff: [{ staffId: f.dewi, name: 'Dewi', count: 1, net: 58500 }]
    })
    expect(res.body.byDay).toHaveLength(3)
    expect(res.body.byDay[0]).toEqual({ date: today, net: 58500 })
    expect(res.body.byMethod).toEqual(expect.arrayContaining([{ method: 'cash', amount: 20000 }, { method: 'qris', amount: 48500 }]))
    expect(res.body.byMethod).toHaveLength(2)
    // Σ by method = what the guest paid for the paid order (total incl. tip).
    expect(res.body.byMethod.reduce((s, m) => s + m.amount, 0)).toBe(res.body.net + res.body.tips)
  })

  test('commission: earned, tips and reversals per stylist; a stylist sees only their own row', async () => {
    const res = await call('admin', 'get', `/salon/reports/commission?${range}`)
    expect(res.status).toBe(200)
    expect(res.body.rows).toEqual([
      { staffId: f.dewi, name: 'Dewi', earned: 23400, reversed: 0, tips: 10000, net: 33400 },
      { staffId: f.rina, name: 'Rina', earned: 26000, reversed: -26000, tips: 0, net: 0 }
    ])
    expect(res.body.total).toBe(33400)
    const own = await call('rina', 'get', `/salon/reports/commission?${range}`)
    expect(own.status).toBe(200)
    expect(own.body.rows.map((r) => r.staffId)).toEqual([f.rina])
  })

  test('occupancy: open minutes from availability, booked minutes without cancelled / no-show', async () => {
    const res = await call('owner', 'get', `/salon/reports/occupancy?${range}`)
    expect(res.status).toBe(200)
    const row = (id) => res.body.rows.find((r) => r.staffId === id)
    // 3 days × 00:00–23:59 = 3 × 1439 minutes.
    expect(row(f.dewi)).toMatchObject({ name: 'Dewi', availableMin: 4317, bookedMin: 60 })
    expect(row(f.rina)).toMatchObject({ availableMin: 4317, bookedMin: 60 })
    expect(row(f.dewi).rate).toBeCloseTo(60 / 4317, 6)
  })

  test('no-show: bookings made ahead, no-show rate, new vs returning members', async () => {
    const res = await call('owner', 'get', `/salon/reports/no-show?${range}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ total: 4, noShow: 1, cancelled: 1, rate: 0.25, newCustomers: 1, returningCustomers: 0 })
  })

  test('scope and validation: kasir 403, foreign outlet 403, other tenant sees nothing, range required and ≤ 92 days', async () => {
    expect((await call('kasir', 'get', `/salon/reports/revenue?${range}`)).status).toBe(403)
    const foreign = await call('owner', 'get', `/salon/reports/revenue?${range}&store=${stores.other.id}`)
    expect(foreign.status).toBe(403)
    const other = await call('otherOwner', 'get', `/salon/reports/revenue?${range}`)
    expect(other.body).toMatchObject({ gross: 0, orderCount: 0, refunds: 0, depositForfeited: 0 })
    expect((await call('otherOwner', 'get', `/salon/reports/commission?${range}`)).body).toEqual({ rows: [], total: 0 })
    expect((await call('owner', 'get', '/salon/reports/revenue')).status).toBe(400)
    expect((await call('owner', 'get', `/salon/reports/no-show?from=${today}&to=${addDays(today, 100)}`)).status).toBe(400)
    const one = await call('owner', 'get', `/salon/reports/revenue?${range}&store=${stores.a.id}`)
    expect(one.body.gross).toBe(65000)
  })
})
