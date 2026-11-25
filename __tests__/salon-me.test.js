process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { zonedToUtc, localDate, addDays } = require('../api/service/salonTime')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Salon S2-b: stylist phone app (/salon/me/*: schedule, commission,
// attendance, shift swaps) and shift-swap approval. Shapes follow
// FE-SALON-App src/api/contract.ts; rules follow src/mocks/handlers.ts.

const TZ = 'Asia/Jakarta'
const STORE_LAT = -6.2
const STORE_LNG = 106.8
const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
const users = {}
const tokens = {}
const tenants = {}
const stores = {}
const createdUserIds = []
const today = localDate(Date.now(), TZ)
const day2 = addDays(today, 2)
const day3 = addDays(today, 3)

const nextLocationId = async () => {
  const [rows] = await db.sequelize.query("SELECT nextval('location_id_seq') AS id")
  return Number(rows[0].id)
}
const makeLocation = async (tenantId, name, extra = {}) =>
  db.location.create({
    id: await nextLocationId(),
    name: `${name}_${stamp}`,
    phoneNumber: '0215550000',
    status: 'active',
    tenantId,
    businessType: 'salon',
    timezone: TZ,
    salonSettings: { openTime: '08:00', closeTime: '22:00' },
    ...extra
  })
const sign = async (key, user) => {
  tokens[key] = await signSessionToken(
    { id: user.id, userName: user.userName, roleType: user.roleType, store: user.store },
    JWT_SECRET
  )
}
const makeUser = async (key, roleType, storeId) => {
  users[key] = await db.user.create({
    userName: `sme_${key}_${stamp}`,
    fullName: `Salon ${key}`,
    email: `sme_${key}_${stamp}@test.com`,
    roleType,
    userType: roleType === 'user' ? 'user' : 'admin',
    store: storeId,
    status: 'active'
  })
  createdUserIds.push(users[key].id)
  await sign(key, users[key])
}
const call = (key, method, path, body) => {
  const r = request(app)[method](path).set('Authorization', `Bearer ${tokens[key]}`)
  return body === undefined ? r : r.send(body)
}
const qa = () => `?store=${stores.a.id}`
let keySeq = 0
const key = () => `sme-${stamp}-${++keySeq}`
const f = {}

const makeStylist = async (keyName, name) => {
  const created = await call('owner', 'post', `/salon/staff${qa()}`, {
    name,
    username: `sme_${keyName}_${stamp}`.toLowerCase().slice(0, 30),
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
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: '08:00', endTime: '22:00' })))
  expect(avail.status).toBe(200)
  users[keyName] = await db.user.findByPk(Number(id))
  await sign(keyName, users[keyName])
  return avail.body
}

const workShift = async (name, date, startTime, endTime, employeeIds) => {
  const res = await call('owner', 'post', `/salon/work-shifts${qa()}`, {
    name: `${name} ${stamp}`,
    type: 'harian',
    startDate: date,
    endDate: null,
    startTime,
    endTime,
    employeeIds,
    status: 'active'
  })
  expect(res.status).toBe(201)
  return res.body
}

const clockBody = (extra = {}) => ({
  store: String(stores.a.id),
  shiftId: f.todayShift.id,
  type: 'check_in',
  latitude: STORE_LAT,
  longitude: STORE_LNG,
  accuracy: 12,
  note: '',
  idempotencyKey: key(),
  ...extra
})

const swapBody = (extra = {}) => ({
  requesterShiftId: f.shiftA.id,
  targetShiftId: f.shiftB.id,
  targetId: f.rina.userId,
  date: day2,
  note: 'Ada acara keluarga',
  idempotencyKey: key(),
  ...extra
})

beforeAll(async () => {
  tenants.salon = await db.tenant.create({ code: `sme-${stamp}`, name: 'Salon HP', businessType: 'salon' })
  tenants.other = await db.tenant.create({ code: `sme-o-${stamp}`, name: 'Salon Lain', businessType: 'salon' })
  stores.a = await makeLocation(tenants.salon.id, 'SME_A', { latitude: STORE_LAT, longitude: STORE_LNG })
  stores.other = await makeLocation(tenants.other.id, 'SME_O')
  await makeUser('owner', 'super_admin', stores.a.id)
  await makeUser('admin', 'admin', stores.a.id)
  await makeUser('kasir', 'kasir', stores.a.id)
  await makeUser('otherOwner', 'super_admin', stores.other.id)

  const svc = await call('owner', 'post', '/salon/services', {
    name: `Potong ${stamp}`,
    category: 'Rambut',
    basePrice: 50000,
    serviceConfig: { durationMin: 45, bufferMin: 15, levelPrices: { junior: 50000, senior: 65000, master: 80000 }, commission: { type: 'percent', value: 40 } },
    active: true
  })
  expect(svc.status).toBe(201)
  f.cut = svc.body
  f.dewi = await makeStylist('dewi', 'Dewi')
  f.rina = await makeStylist('rina', 'Rina')

  f.todayShift = await workShift('Pagi', today, '00:00', '23:59', [f.dewi.userId])
  f.shiftA = await workShift('Pagi D2', day2, '09:00', '13:00', [f.dewi.userId])
  f.shiftB = await workShift('Sore D2', day2, '14:00', '18:00', [f.rina.userId])
  f.shiftA3 = await workShift('Pagi D3', day3, '10:00', '14:00', [f.dewi.userId])
  f.shiftB3 = await workShift('Sore D3', day3, '15:00', '19:00', [f.rina.userId])
  // Rina already works 09–12 on day 3: taking Dewi's 10–14 would clash.
  f.rinaEarly3 = await workShift('Rina Awal D3', day3, '09:00', '12:00', [f.rina.userId])
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
    await del('transaction', { order: orderIds })
    await del('order_item', { order: orderIds })
    await del('order_status', { order: orderIds })
    await del('order', { id: orderIds })
  }
  await del('shift_swap', { store: storeIds })
  await del('attendance', { store: storeIds })
  await del('shift', { store: storeIds })
  await del('stock_history', { product: productIds })
  await del('salon_appointment_event', { tenantId: tenantIds })
  await del('salon_appointment_item', { tenantId: tenantIds })
  await del('salon_appointment', { tenantId: tenantIds })
  await del('salon_availability', { tenantId: tenantIds })
  await del('salon_staff_skill', { tenantId: tenantIds })
  await del('salon_staff_profile', { tenantId: tenantIds })
  await q('DELETE FROM document_counter WHERE store IN (:ids)', { ids: storeIds })
  await del('cashRegister', { store: storeIds })
  await del('product_store_stock', { product: productIds })
  await del('product_store', { product: productIds })
  await del('product', { id: productIds })
  await del('category', { tenantId: tenantIds })
  await del('user', { id: [...createdUserIds, ...staffUserIds] })
  await del('position', { tenantId: tenantIds })
  await del('location', { id: storeIds })
  await del('tenant', { id: tenantIds })
  await db.sequelize.close()
})

describe('jadwal & komisi saya', () => {
  test('an account without a staff profile gets 404 on /me', async () => {
    const res = await call('owner', 'get', `/salon/me/schedule?date=${day2}`)
    expect(res.status).toBe(404)
    expect(res.body.message).toBe('Akun ini bukan staff layanan')
  })

  test('a stylist sees only their own bookings of the day', async () => {
    const booked = await call('admin', 'post', `/salon/appointments${qa()}`, {
      serviceIds: [f.cut.id],
      staffId: f.dewi.userId,
      startAt: new Date(zonedToUtc(day2, '10:00', TZ)).toISOString(),
      memberId: null,
      customerName: 'Sari',
      customerPhone: '081234567890',
      source: 'phone',
      depositAmount: 0,
      depositMethod: null,
      notes: '',
      idempotencyKey: key()
    })
    expect(booked.status).toBe(201)
    f.booking = booked.body
    const mine = await call('dewi', 'get', `/salon/me/schedule?date=${day2}`)
    expect(mine.status).toBe(200)
    expect(mine.body.staff).toMatchObject({ userId: f.dewi.userId, name: 'Dewi', position: 'Stylist' })
    expect(mine.body.appointments.map((a) => a.id)).toEqual([f.booking.id])
    const other = await call('rina', 'get', `/salon/me/schedule?date=${day2}`)
    expect(other.body.appointments).toEqual([])
  })

  test('commission: earned rows of a sale, then the reversal of its refund (net 0)', async () => {
    for (const step of ['check-in', 'start', 'complete']) {
      expect((await call('admin', 'post', `/salon/appointments/${f.booking.id}/${step}${qa()}`, { reason: null })).status).toBe(200)
    }
    expect((await call('kasir', 'post', `/salon/shift/open${qa()}`, { openingCash: 0 })).status).toBe(201)
    const paid = await call('kasir', 'post', `/salon/checkout${qa()}`, {
      appointmentId: f.booking.id,
      extras: [],
      tip: { amount: 0, staffId: null },
      discount: { type: 'none' },
      payments: [{ method: 'cash', amount: 65000, tendered: 65000, reference: null }],
      customerName: '',
      memberId: null,
      idempotencyKey: key()
    })
    expect(paid.status).toBe(201)
    const range = `?from=${today}&to=${addDays(today, 1)}`
    const earned = await call('dewi', 'get', `/salon/me/commission${range}`)
    expect(earned.status).toBe(200)
    expect(earned.body).toMatchObject({ earned: 26000, reversed: 0, net: 26000 })
    expect(earned.body.rows[0]).toMatchObject({
      orderId: expect.any(String),
      orderNumber: paid.body.number,
      staffId: f.dewi.userId,
      kind: 'service',
      amount: 26000,
      status: 'earned'
    })
    expect((await call('rina', 'get', `/salon/me/commission${range}`)).body).toMatchObject({ rows: [], net: 0 })

    const refund = await call('owner', 'post', `/salon/orders/${paid.body.id}/refund${qa()}`, { reason: 'Pelanggan komplain', ownerPin: null })
    expect(refund.status).toBe(200)
    const after = await call('dewi', 'get', `/salon/me/commission${range}`)
    expect(after.body).toMatchObject({ earned: 26000, reversed: -26000, net: 0 })
    expect(after.body.rows).toHaveLength(2)
  })

  test('commission range is required and at most 62 days', async () => {
    expect((await call('dewi', 'get', '/salon/me/commission')).status).toBe(400)
    const long = await call('dewi', 'get', `/salon/me/commission?from=${today}&to=${addDays(today, 70)}`)
    expect(long.status).toBe(400)
  })
})

describe('absensi', () => {
  test('pulang before masuk is refused; outside the outlet radius is refused', async () => {
    const early = await call('dewi', 'post', '/salon/me/attendance', clockBody({ type: 'check_out' }))
    expect(early.status).toBe(409)
    expect(early.body.code).toBe('INVALID_TRANSITION')
    const far = await call('dewi', 'post', '/salon/me/attendance', clockBody({ latitude: STORE_LAT - 0.1 }))
    expect(far.status).toBe(400)
    expect(far.body.details.distanceM).toBeGreaterThan(1000)
  })

  test('only the own outlet and own shift', async () => {
    const otherStore = await call('dewi', 'post', '/salon/me/attendance', clockBody({ store: String(stores.other.id) }))
    expect(otherStore.status).toBe(403)
    const notMine = await call('rina', 'post', '/salon/me/attendance', clockBody())
    expect(notMine.status).toBe(403)
    expect(notMine.body.message).toBe('Kamu tidak ditugaskan di shift ini')
    const future = await call('dewi', 'post', '/salon/me/attendance', clockBody({ shiftId: f.shiftA.id }))
    expect(future.status).toBe(400)
  })

  test('masuk: 201 stored as a core check-in; same key replays, changed payload is a mismatch', async () => {
    f.clock = clockBody()
    const res = await call('dewi', 'post', '/salon/me/attendance', f.clock)
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      store: String(stores.a.id),
      staffId: f.dewi.userId,
      shiftId: f.todayShift.id,
      date: today,
      type: 'check_in',
      latitude: STORE_LAT,
      accuracy: 12,
      note: 'Lokasi terverifikasi'
    })
    const row = await db.attendance.findByPk(Number(res.body.id))
    expect(row).toMatchObject({ type: 'check-in', status: 'valid', userId: Number(f.dewi.userId) })

    const replay = await call('dewi', 'post', '/salon/me/attendance', f.clock)
    expect(replay.status).toBe(200)
    expect(replay.headers['idempotent-replay']).toBe('true')
    expect(replay.body.id).toBe(res.body.id)
    const mismatch = await call('dewi', 'post', '/salon/me/attendance', { ...f.clock, accuracy: 30 })
    expect(mismatch.status).toBe(409)
    expect(mismatch.body.code).toBe('IDEMPOTENCY_MISMATCH')
    const twice = await call('dewi', 'post', '/salon/me/attendance', clockBody())
    expect(twice.status).toBe(409)
    expect(twice.body.code).toBe('DUPLICATE')
  })

  test('pulang, then the day lists both; an untrusted GPS fix is kept but flagged', async () => {
    const out = await call('dewi', 'post', '/salon/me/attendance', clockBody({ type: 'check_out', accuracy: 500, note: 'Pulang' }))
    expect(out.status).toBe(201)
    expect(out.body).toMatchObject({ type: 'check_out', note: 'Pulang' })
    expect((await db.attendance.findByPk(Number(out.body.id))).status).toBe('untrusted')
    const day = await call('dewi', 'get', `/salon/me/attendance?date=${today}`)
    expect(day.status).toBe(200)
    expect(day.body.date).toBe(today)
    expect(day.body.rows.map((r) => r.type)).toEqual(['check_in', 'check_out'])
    expect((await call('rina', 'get', '/salon/me/attendance')).body.rows).toEqual([])
  })
})

describe('tukar shift', () => {
  test('candidates: active shifts of the outlet in range and its active stylists', async () => {
    const res = await call('dewi', 'get', `/salon/me/shift-swaps/candidates?from=${day2}&to=${day3}`)
    expect(res.status).toBe(200)
    expect(res.body.shifts.map((s) => s.id)).toEqual(
      expect.arrayContaining([f.shiftA.id, f.shiftB.id, f.shiftA3.id, f.shiftB3.id, f.rinaEarly3.id])
    )
    expect(res.body.shifts.map((s) => s.id)).not.toContain(f.todayShift.id)
    expect(res.body.staff).toEqual(
      expect.arrayContaining([{ id: f.rina.userId, name: 'Rina', position: 'Stylist', colorTag: '#10b981' }])
    )
  })

  test('request is validated against the mock rules', async () => {
    const self = await call('dewi', 'post', '/salon/me/shift-swaps', swapBody({ targetId: f.dewi.userId }))
    expect(self.status).toBe(400)
    const notTheirs = await call('dewi', 'post', '/salon/me/shift-swaps', swapBody({ targetShiftId: f.shiftA3.id }))
    expect(notTheirs.status).toBe(404)
    const notMine = await call('dewi', 'post', '/salon/me/shift-swaps', swapBody({ requesterShiftId: f.shiftB.id }))
    expect(notMine.status).toBe(403)
    const otherDay = await call('dewi', 'post', '/salon/me/shift-swaps', swapBody({ targetShiftId: f.shiftB3.id }))
    expect(otherDay.status).toBe(400)
  })

  test('a pending request: replay, one pending per shift, only the requester cancels', async () => {
    f.swapBody = swapBody()
    const res = await call('dewi', 'post', '/salon/me/shift-swaps', f.swapBody)
    expect(res.status).toBe(201)
    f.swap = res.body
    expect(res.body).toMatchObject({
      store: String(stores.a.id),
      date: day2,
      requesterId: f.dewi.userId,
      requesterName: 'Dewi',
      targetId: f.rina.userId,
      targetName: 'Rina',
      requesterShift: { id: f.shiftA.id, startTime: '09:00', endTime: '13:00', type: 'harian', endDate: null },
      targetShift: { id: f.shiftB.id, startTime: '14:00' },
      note: 'Ada acara keluarga',
      status: 'pending',
      decidedAt: null,
      decidedBy: null
    })
    const replay = await call('dewi', 'post', '/salon/me/shift-swaps', f.swapBody)
    expect(replay.status).toBe(200)
    expect(replay.body.id).toBe(f.swap.id)
    expect((await call('dewi', 'post', '/salon/me/shift-swaps', { ...f.swapBody, note: 'lain' })).body.code).toBe('IDEMPOTENCY_MISMATCH')
    const dup = await call('dewi', 'post', '/salon/me/shift-swaps', swapBody())
    expect(dup.status).toBe(409)
    expect(dup.body.code).toBe('DUPLICATE')

    const theirs = await call('rina', 'get', '/salon/me/shift-swaps')
    expect(theirs.body.data.map((s) => s.id)).toContain(f.swap.id)
    const byTarget = await call('rina', 'post', `/salon/me/shift-swaps/${f.swap.id}/cancel`, {})
    expect(byTarget.status).toBe(403)
  })

  test('approval: stylists and other tenants cannot; admin approves and the employees swap', async () => {
    expect((await call('dewi', 'get', `/salon/shift-swaps${qa()}`)).status).toBe(403)
    expect((await call('dewi', 'patch', `/salon/shift-swaps/${f.swap.id}${qa()}`, { decision: 'approved' })).status).toBe(403)
    const foreign = await call('otherOwner', 'patch', `/salon/shift-swaps/${f.swap.id}?store=${stores.other.id}`, { decision: 'approved' })
    expect(foreign.status).toBe(404)

    const pending = await call('admin', 'get', `/salon/shift-swaps${qa()}&status=pending`)
    expect(pending.body.data.map((s) => s.id)).toEqual([f.swap.id])
    const res = await call('admin', 'patch', `/salon/shift-swaps/${f.swap.id}${qa()}`, { decision: 'approved' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ status: 'approved', decidedBy: 'Salon admin', decidedAt: expect.any(String) })
    const a = await db.shift.findByPk(Number(f.shiftA.id))
    const b = await db.shift.findByPk(Number(f.shiftB.id))
    expect(a.karyawan.map(Number)).toEqual([Number(f.rina.userId)])
    expect(b.karyawan.map(Number)).toEqual([Number(f.dewi.userId)])
    const again = await call('admin', 'patch', `/salon/shift-swaps/${f.swap.id}${qa()}`, { decision: 'rejected' })
    expect(again.status).toBe(409)
    expect(again.body.code).toBe('INVALID_TRANSITION')
  })

  test('approval refuses a swap that would double-book; it can still be rejected', async () => {
    const req = await call('dewi', 'post', '/salon/me/shift-swaps', swapBody({ requesterShiftId: f.shiftA3.id, targetShiftId: f.shiftB3.id, date: day3 }))
    expect(req.status).toBe(201)
    const clash = await call('kasir', 'patch', `/salon/shift-swaps/${req.body.id}${qa()}`, { decision: 'approved' })
    expect(clash.status).toBe(409)
    expect(clash.body).toMatchObject({ code: 'SLOT_TAKEN', details: { shiftId: f.rinaEarly3.id } })
    expect(clash.body.message).toBe('Rina punya shift lain di jam yang sama')
    const reject = await call('kasir', 'patch', `/salon/shift-swaps/${req.body.id}${qa()}`, { decision: 'rejected' })
    expect(reject.body).toMatchObject({ status: 'rejected', decidedBy: 'Salon kasir' })
    expect((await db.shift.findByPk(Number(f.shiftA3.id))).karyawan.map(Number)).toEqual([Number(f.dewi.userId)])
  })

  test('the requester cancels a pending request; an expired one shows as cancelled', async () => {
    // Day 2 shifts were swapped above: Rina now holds A, Dewi holds B.
    const req = await call('rina', 'post', '/salon/me/shift-swaps', swapBody({
      requesterShiftId: f.shiftA.id,
      targetShiftId: f.shiftB.id,
      targetId: f.dewi.userId
    }))
    expect(req.status).toBe(201)
    const cancel = await call('rina', 'post', `/salon/me/shift-swaps/${req.body.id}/cancel`, {})
    expect(cancel.status).toBe(200)
    expect(cancel.body).toMatchObject({ status: 'cancelled', decidedBy: 'Rina' })
    expect((await call('rina', 'post', `/salon/me/shift-swaps/${req.body.id}/cancel`, {})).status).toBe(409)

    await db.shift_swap.update({ status: 'expired' }, { where: { id: Number(req.body.id) } })
    const list = await call('owner', 'get', `/salon/shift-swaps${qa()}&status=cancelled`)
    expect(list.body.data.find((s) => s.id === req.body.id)).toMatchObject({ status: 'cancelled' })
    const mine = await call('dewi', 'get', '/salon/me/shift-swaps')
    const statuses = mine.body.data.map((s) => s.status)
    expect(statuses).toEqual([...statuses].sort((x, y) => ['pending', 'approved', 'rejected', 'cancelled'].indexOf(x) - ['pending', 'approved', 'rejected', 'cancelled'].indexOf(y)))
  })
})
