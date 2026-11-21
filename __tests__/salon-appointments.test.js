process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { zonedToUtc, localDate, addDays } = require('../api/service/salonTime')
const { computeSlots, buildItems } = require('../api/service/salonSlots')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Salon S1-c: slots, appointments (create / idempotency / double booking /
// reschedule / transitions / deposit / wa-text) and customers.
// Shapes follow FE-SALON-App src/api/contract.ts; rules SALON-BA BR-SLN-001…009.

const TZ = 'Asia/Jakarta'
const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
const users = {}
const tokens = {}
const tenants = {}
const stores = {}
const createdUserIds = []
const registers = []
// A day well in the future (outlet calendar), so "now" never cuts slots.
const DAY = addDays(localDate(Date.now(), TZ), 3)
const at = (hhmm, date = DAY) => new Date(zonedToUtc(date, hhmm, TZ)).toISOString()

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
    salonSettings: { openTime: '09:00', closeTime: '21:00' }
  })
const sign = async (key, user) => {
  tokens[key] = await signSessionToken(
    { id: user.id, userName: user.userName, roleType: user.roleType, store: user.store },
    JWT_SECRET
  )
}
const makeUser = async (key, roleType, storeId) => {
  users[key] = await db.user.create({
    userName: `slc_${key}_${stamp}`,
    fullName: `Salon ${key}`,
    email: `slc_${key}_${stamp}@test.com`,
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

const svc = {}
const staff = {}
let keySeq = 0
const booking = (extra = {}) => ({
  serviceIds: [svc.cut.id],
  staffId: staff.senior.userId,
  startAt: at('10:00'),
  memberId: null,
  customerName: 'Rina',
  customerPhone: '081234567890',
  source: 'phone',
  depositAmount: 0,
  depositMethod: null,
  notes: '',
  idempotencyKey: `key-${stamp}-${++keySeq}`,
  ...extra
})
const book = (extra, key = 'admin') => call(key, 'post', `/salon/appointments${qa()}`, booking(extra))

const makeService = async (name, durationMin, bufferMin, levelPrices) => {
  const res = await call('owner', 'post', '/salon/services', {
    name: `${name} ${stamp}`,
    category: 'Rambut',
    basePrice: levelPrices.junior,
    serviceConfig: { durationMin, bufferMin, levelPrices, commission: { type: 'percent', value: 40 } },
    active: true
  })
  expect(res.status).toBe(201)
  return res.body
}
const makeStylist = async (key, level, serviceIds, store = stores.a) => {
  const created = await call('owner', 'post', `/salon/staff?store=${store.id}`, {
    name: `Stylist ${key}`,
    username: `c${key.slice(0, 3)}_${stamp}`.toLowerCase().slice(0, 30),
    position: 'Stylist',
    positionId: null,
    level,
    colorTag: '#10b981',
    acceptsOnline: true,
    active: true,
    commissionOverride: null
  })
  expect(created.status).toBe(201)
  const id = created.body.userId
  const skills = await call('owner', 'put', `/salon/staff/${id}/skills?store=${store.id}`,
    serviceIds.map((productId) => ({ productId, durationOverride: null, priceOverride: null })))
  expect(skills.status).toBe(200)
  const avail = await call('owner', 'put', `/salon/staff/${id}/availability?store=${store.id}`,
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: '09:00', endTime: '18:00' })))
  expect(avail.status).toBe(200)
  return avail.body
}

beforeAll(async () => {
  tenants.salon = await db.tenant.create({ code: `slc-${stamp}`, name: 'Salon C', businessType: 'salon' })
  tenants.other = await db.tenant.create({ code: `slc-o-${stamp}`, name: 'Salon Lain', businessType: 'salon' })
  stores.a = await makeLocation(tenants.salon.id, 'SLC_A')
  stores.other = await makeLocation(tenants.other.id, 'SLC_O')
  await makeUser('owner', 'super_admin', stores.a.id)
  await makeUser('admin', 'admin', stores.a.id)
  await makeUser('kasir', 'kasir', stores.a.id)
  await makeUser('otherOwner', 'super_admin', stores.other.id)

  svc.cut = await makeService('Potong', 45, 15, { junior: 50000, senior: 65000, master: 80000 })
  svc.cream = await makeService('Creambath', 60, 0, { junior: 90000, senior: 110000, master: 130000 })
  staff.senior = await makeStylist('senior', 'senior', [svc.cut.id, svc.cream.id])
  staff.junior = await makeStylist('junior', 'junior', [svc.cut.id])
  const stylistUser = await db.user.findByPk(Number(staff.junior.userId))
  await sign('stylist', stylistUser)
})

afterAll(async () => {
  const tenantIds = Object.values(tenants).map((t) => t.id)
  const products = await db.product.findAll({ where: { tenantId: tenantIds }, paranoid: false, attributes: ['id'] })
  const productIds = products.map((p) => p.id)
  const locations = await db.location.findAll({ where: { tenantId: tenantIds }, paranoid: false, attributes: ['id'] })
  const storeIds = locations.map((l) => l.id)
  const profiles = await db.salon_staff_profile.findAll({ where: { tenantId: tenantIds }, paranoid: false, attributes: ['userId'] })
  const staffUserIds = profiles.map((p) => p.userId)
  const del = (model, where) => db[model].destroy({ where, force: true }).catch(() => {})
  await del('salon_appointment_event', { tenantId: tenantIds })
  await del('salon_appointment_item', { tenantId: tenantIds })
  await del('salon_appointment', { tenantId: tenantIds })
  await del('member', { tenantId: tenantIds })
  await del('salon_time_off', { tenantId: tenantIds })
  await del('salon_availability', { tenantId: tenantIds })
  await del('salon_staff_skill', { tenantId: tenantIds })
  await del('salon_staff_profile', { tenantId: tenantIds })
  await db.sequelize.query('DELETE FROM document_counter WHERE store IN (:ids)', { replacements: { ids: storeIds } }).catch(() => {})
  await del('cashRegister', { id: registers })
  await del('product_store_stock', { product: productIds })
  await del('product_store', { product: productIds })
  await del('product', { id: productIds })
  await del('category', { tenantId: tenantIds })
  await del('position', { tenantId: tenantIds })
  await del('user', { id: [...createdUserIds, ...staffUserIds] })
  await del('location', { id: storeIds })
  await del('tenant', { id: tenantIds })
  await db.sequelize.close()
})

describe('slot engine (pure)', () => {
  const store = { timezone: TZ, openTime: '09:00', closeTime: '21:00' }
  const service = { id: 1, name: 'Potong', basePrice: 50000, serviceConfig: { durationMin: 45, bufferMin: 15, levelPrices: { senior: 65000 } } }
  const person = (userId, busy = []) => ({
    userId,
    name: `S${userId}`,
    level: 'senior',
    skills: [{ productId: 1, durationOverride: null, priceOverride: null }],
    availability: [{ weekday: new Date(`${DAY}T00:00:00Z`).getUTCDay(), startTime: '09:00', endTime: '12:00' }],
    timeOff: [],
    busy
  })

  test('slots step by slotStepMin inside the window and never overlap a booked block', () => {
    const tenOClock = zonedToUtc(DAY, '10:00', TZ)
    const slots = computeSlots({
      store, date: DAY, services: [service], staff: [person(7, [{ startAt: tenOClock, endAt: tenOClock + 3600000 }])],
      stepMin: 30, now: 0
    })
    const starts = slots.map((s) => new Date(s.startAt).toISOString())
    // 09:00 fits (ends 10:00); 09:30 / 10:00 / 10:30 collide; 11:00 fits (ends 12:00).
    expect(starts).toEqual([at('09:00'), at('11:00')])
    for (const s of slots) expect(s.endAt - s.startAt).toBe(60 * 60000)
  })

  test('"siapa saja" picks the staff with the lightest load; ties go to the lower id', () => {
    const nine = zonedToUtc(DAY, '09:00', TZ)
    const busy = [{ startAt: nine, endAt: nine + 3600000 }]
    const slots = computeSlots({ store, date: DAY, services: [service], staff: [person(9), person(8, busy)], stepMin: 60, now: 0 })
    expect(slots.map((s) => [new Date(s.startAt).toISOString(), s.staffId])).toEqual([
      [at('09:00'), 9],
      [at('10:00'), 9],
      [at('11:00'), 9]
    ])
    const even = computeSlots({ store, date: DAY, services: [service], staff: [person(9), person(8)], stepMin: 60, now: 0 })
    expect(even.every((s) => s.staffId === 8)).toBe(true)
  })

  test('items are consecutive and carry the level price (BR-SLN-002/005)', () => {
    const start = zonedToUtc(DAY, '10:00', TZ)
    const items = buildItems(person(7), [service, service], start)
    expect(items[0].endAt).toBe(items[1].startAt)
    expect(items.map((i) => i.price)).toEqual([65000, 65000])
  })
})

describe('slots API', () => {
  test('lists slots in the outlet zone for the requested services', async () => {
    const res = await call('kasir', 'get', `/salon/slots${qa()}&date=${DAY}&serviceIds=${svc.cut.id}`)
    expect(res.status).toBe(200)
    expect(res.body.timezone).toBe(TZ)
    expect(res.body.slots[0]).toEqual({ startAt: at('09:00'), endAt: at('10:00'), staffId: expect.any(String) })
    // 09:00 … 17:00 every 15 min (60-min block must end by 18:00).
    expect(res.body.slots).toHaveLength(33)
  })

  test('a service only the senior can do yields only the senior', async () => {
    const res = await call('kasir', 'get', `/salon/slots${qa()}&date=${DAY}&serviceIds=${svc.cut.id},${svc.cream.id}`)
    expect(res.status).toBe(200)
    expect(new Set(res.body.slots.map((s) => s.staffId))).toEqual(new Set([staff.senior.userId]))
  })

  test('unknown service → 404; another tenant cannot read the outlet', async () => {
    expect((await call('kasir', 'get', `/salon/slots${qa()}&date=${DAY}&serviceIds=999999999`)).status).toBe(404)
    expect((await call('otherOwner', 'get', `/salon/slots${qa()}&date=${DAY}&serviceIds=${svc.cut.id}`)).status).toBe(403)
  })
})

describe('appointments', () => {
  let first

  test('creates a booking with locked prices, consecutive items, a number and history', async () => {
    const res = await book({ serviceIds: [svc.cut.id, svc.cream.id] })
    expect(res.status).toBe(201)
    first = res.body
    expect(first.number).toMatch(new RegExp(`^BK-${DAY.slice(2).replace(/-/g, '')}-\\d{3}$`))
    expect(first.status).toBe('booked')
    expect(first.startAt).toBe(at('10:00'))
    expect(first.endAt).toBe(at('12:00'))
    expect(first.items.map((i) => [i.price, i.durationMin, i.startAt])).toEqual([
      [65000, 45, at('10:00')],
      [110000, 60, at('11:00')]
    ])
    expect(first.history).toEqual([{ status: 'booked', at: expect.any(String), by: 'Salon admin', reason: null }])
    expect(first.createdBy).toBe('Salon admin')
  })

  test('same key + same body replays; same key + other body → IDEMPOTENCY_MISMATCH', async () => {
    const input = booking({ startAt: at('15:00'), staffId: staff.junior.userId })
    const one = await call('admin', 'post', `/salon/appointments${qa()}`, input)
    const two = await call('admin', 'post', `/salon/appointments${qa()}`, input)
    expect(one.status).toBe(201)
    expect(two.status).toBe(200)
    expect(two.headers['idempotent-replay']).toBe('true')
    expect(two.body.id).toBe(one.body.id)
    const other = await call('admin', 'post', `/salon/appointments${qa()}`, { ...input, notes: 'beda' })
    expect(other.status).toBe(409)
    expect(other.body.code).toBe('IDEMPOTENCY_MISMATCH')
  })

  test('overlap with the same staff → SLOT_TAKEN; the slot list skips the booked time', async () => {
    const clash = await book({ startAt: at('11:30') })
    expect(clash.status).toBe(409)
    expect(clash.body.code).toBe('SLOT_TAKEN')
    const slots = await call('kasir', 'get', `/salon/slots${qa()}&date=${DAY}&serviceIds=${svc.cut.id}&staffId=${staff.senior.userId}`)
    const starts = slots.body.slots.map((s) => s.startAt)
    expect(starts).toContain(at('09:00'))
    expect(starts).not.toContain(at('09:15'))
    expect(starts).not.toContain(at('11:45'))
    expect(starts).toContain(at('12:00'))
  })

  test('20 parallel bookings of one slot → exactly one wins (DB exclusion constraint)', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => book({ startAt: at('16:00'), staffId: staff.senior.userId }))
    )
    const statuses = results.map((r) => r.status)
    expect(statuses.filter((s) => s === 201)).toHaveLength(1)
    expect(statuses.filter((s) => s === 409)).toHaveLength(19)
    for (const r of results.filter((x) => x.status === 409)) expect(r.body.code).toBe('SLOT_TAKEN')
  }, 60000)

  test('"siapa saja" books the free skilled staff', async () => {
    const res = await book({ staffId: null, startAt: at('10:00') })
    expect(res.status).toBe(201)
    expect(res.body.items[0].staffId).toBe(staff.junior.userId)
    expect(res.body.items[0].price).toBe(50000)
  })

  test('rule refusals: unskilled, outside hours, in the past, deposit rules', async () => {
    const unskilled = await book({ serviceIds: [svc.cream.id], staffId: staff.junior.userId, startAt: at('13:00') })
    expect([unskilled.status, unskilled.body.code]).toEqual([409, 'STAFF_NOT_SKILLED'])
    const late = await book({ startAt: at('17:30') })
    expect([late.status, late.body.code]).toEqual([409, 'OUTSIDE_AVAILABILITY'])
    const past = await book({ startAt: new Date(Date.now() - 3600000).toISOString() })
    expect([past.status, past.body.code]).toEqual([409, 'SLOT_IN_PAST'])
    const noMethod = await book({ startAt: at('13:00'), depositAmount: 20000 })
    expect([noMethod.status, noMethod.body.code]).toEqual([400, 'VALIDATION_FAILED'])
    const noShift = await book({ startAt: at('13:00'), depositAmount: 20000, depositMethod: 'cash' })
    expect([noShift.status, noShift.body.code]).toEqual([409, 'SHIFT_CLOSED'])
  })

  test('cash deposit lands on the open register; non-cash needs none', async () => {
    const register = await db.cashRegister.create({
      store: stores.a.id,
      user: users.kasir.id,
      openingBalance: 100000,
      status: 'open',
      openedAt: new Date()
    })
    registers.push(register.id)
    const cash = await book({ startAt: at('13:00'), depositAmount: 20000, depositMethod: 'cash' })
    expect(cash.status).toBe(201)
    expect(cash.body.depositAmount).toBe(20000)
    const row = await db.salon_appointment.findByPk(Number(cash.body.id))
    expect([row.depositCashRegisterId, row.depositStatus, row.depositMethod]).toEqual([register.id, 'held', 'cash'])
    await register.update({ status: 'closed', closedAt: new Date() })
    const qris = await book({ startAt: at('13:00'), staffId: staff.junior.userId, depositAmount: 15000, depositMethod: 'qris' })
    expect(qris.status).toBe(201)
    const qrisRow = await db.salon_appointment.findByPk(Number(qris.body.id))
    expect([qrisRow.depositCashRegisterId, qrisRow.depositStatus]).toEqual([null, 'held'])
  })

  test('reschedule over its own old time works; onto a taken slot → SLOT_TAKEN', async () => {
    const moved = await call('admin', 'post', `/salon/appointments/${first.id}/reschedule${qa()}`, {
      startAt: at('10:30'),
      staffId: staff.senior.userId
    })
    expect(moved.status).toBe(200)
    expect([moved.body.startAt, moved.body.endAt]).toEqual([at('10:30'), at('12:30')])
    expect(moved.body.history.at(-1).reason).toMatch(/^Dipindah ke /)
    const taken = await call('admin', 'post', `/salon/appointments/${first.id}/reschedule${qa()}`, {
      startAt: at('12:30'),
      staffId: staff.senior.userId
    })
    expect([taken.status, taken.body.code]).toEqual([409, 'SLOT_TAKEN'])
  })

  test('state machine: confirm → check-in → start → complete; wrong order → INVALID_TRANSITION', async () => {
    const path = (t) => `/salon/appointments/${first.id}/${t}${qa()}`
    const early = await call('admin', 'post', path('complete'), { reason: null })
    expect([early.status, early.body.code]).toEqual([409, 'INVALID_TRANSITION'])
    expect(early.body.details).toEqual({ from: 'booked', transition: 'complete' })
    for (const [t, status] of [['confirm', 'confirmed'], ['check-in', 'checked_in'], ['start', 'in_service']]) {
      const res = await call('kasir', 'post', path(t), { reason: null })
      expect(res.status).toBe(200)
      expect(res.body.status).toBe(status)
      expect(res.body.items.every((i) => i.status === status)).toBe(true)
    }
    const move = await call('admin', 'post', `/salon/appointments/${first.id}/reschedule${qa()}`, {
      startAt: at('14:00'),
      staffId: staff.senior.userId
    })
    expect([move.status, move.body.code]).toEqual([409, 'INVALID_TRANSITION'])
    const done = await call('kasir', 'post', path('complete'), {})
    expect(done.body.status).toBe('completed')
    expect(done.body.history.map((h) => h.status)).toEqual(['booked', 'booked', 'confirmed', 'checked_in', 'in_service', 'completed'])
  })

  test('cancel needs a reason, forfeits the deposit and frees the slot', async () => {
    const apt = await book({ startAt: at('09:00'), staffId: staff.senior.userId, depositAmount: 10000, depositMethod: 'transfer' })
    expect(apt.status).toBe(201)
    const bare = await call('admin', 'post', `/salon/appointments/${apt.body.id}/cancel${qa()}`, { reason: '  ' })
    expect([bare.status, bare.body.code]).toEqual([400, 'VALIDATION_FAILED'])
    const cancel = await call('admin', 'post', `/salon/appointments/${apt.body.id}/cancel${qa()}`, { reason: 'Sakit' })
    expect(cancel.status).toBe(200)
    expect(cancel.body.history.at(-1)).toMatchObject({ status: 'cancelled', reason: 'Sakit' })
    expect((await db.salon_appointment.findByPk(Number(apt.body.id))).depositStatus).toBe('forfeited')
    const again = await book({ startAt: at('09:00'), staffId: staff.senior.userId })
    expect(again.status).toBe(201)
    const noShow = await call('admin', 'post', `/salon/appointments/${again.body.id}/no-show${qa()}`, { reason: null })
    expect(noShow.body.status).toBe('no_show')
  })

  test('list by outlet date range; a stylist sees only their own bookings', async () => {
    const all = await call('kasir', 'get', `/salon/appointments${qa()}&from=${DAY}&to=${DAY}`)
    expect(all.status).toBe(200)
    expect(all.body.data.length).toBeGreaterThanOrEqual(6)
    const starts = all.body.data.map((a) => a.startAt)
    expect([...starts].sort()).toEqual(starts)
    const mine = await call('stylist', 'get', `/salon/appointments${qa()}&from=${DAY}&to=${DAY}`)
    expect(mine.status).toBe(200)
    expect(mine.body.data.length).toBeGreaterThan(0)
    expect(mine.body.data.every((a) => a.items.some((i) => i.staffId === staff.junior.userId))).toBe(true)
    const write = await call('stylist', 'post', `/salon/appointments${qa()}`, booking({ startAt: at('14:00') }))
    expect(write.status).toBe(403)
    const empty = await call('kasir', 'get', `/salon/appointments${qa()}&from=${addDays(DAY, 1)}&to=${addDays(DAY, 1)}`)
    expect(empty.body.data).toEqual([])
    const wide = await call('kasir', 'get', `/salon/appointments${qa()}&from=${DAY}&to=${addDays(DAY, 90)}`)
    expect(wide.status).toBe(400)
  })

  test('detail and wa-text; other tenant gets 404/403', async () => {
    const one = await call('kasir', 'get', `/salon/appointments/${first.id}${qa()}`)
    expect(one.status).toBe(200)
    expect(one.body.id).toBe(first.id)
    const wa = await call('kasir', 'get', `/salon/appointments/${first.id}/wa-text${qa()}&kind=reminder`)
    expect(wa.status).toBe(200)
    expect(wa.body.phone).toBe('081234567890')
    expect(wa.body.text).toContain(first.number)
    expect(wa.body.text).toContain('Halo Rina')
    const thanks = await call('kasir', 'get', `/salon/appointments/${first.id}/wa-text${qa()}&kind=thanks`)
    expect(thanks.body.text).toMatch(/terima kasih/)
    expect((await call('otherOwner', 'get', `/salon/appointments/${first.id}?store=${stores.other.id}`)).status).toBe(404)
    expect((await call('otherOwner', 'get', `/salon/appointments/${first.id}${qa()}`)).status).toBe(403)
  })
})

describe('customers', () => {
  let rina

  test('create (phone stored E.164, returned 08…), duplicate phone → DUPLICATE', async () => {
    const res = await call('kasir', 'post', '/salon/customers', { name: 'Rina Wati', phone: '081298765432', notes: 'Suka creambath' })
    expect(res.status).toBe(201)
    rina = res.body
    expect(rina).toMatchObject({ name: 'Rina Wati', phone: '081298765432', points: 0, tier: 'regular', visitCount: 0, lastVisitAt: null, totalSpent: 0 })
    expect((await db.member.findByPk(Number(rina.id))).phoneNumber).toBe('+6281298765432')
    const dup = await call('admin', 'post', '/salon/customers', { name: 'Orang Lain', phone: '+6281298765432', notes: '' })
    expect([dup.status, dup.body.code]).toEqual([409, 'DUPLICATE'])
    const stylist = await call('stylist', 'post', '/salon/customers', { name: 'X Y', phone: '081200000001', notes: '' })
    expect(stylist.status).toBe(403)
  })

  test('search by name or phone digits; other tenant does not see them', async () => {
    const byName = await call('kasir', 'get', '/salon/customers?q=rina')
    expect(byName.body.data.map((c) => c.id)).toContain(rina.id)
    const byPhone = await call('kasir', 'get', '/salon/customers?q=0812987')
    expect(byPhone.body.data.map((c) => c.id)).toEqual([rina.id])
    const other = await call('otherOwner', 'get', '/salon/customers?q=rina')
    expect(other.body.data).toEqual([])
  })

  test('update; another tenant cannot', async () => {
    const res = await call('admin', 'patch', `/salon/customers/${rina.id}`, { name: 'Rina W', phone: '081298765432', notes: '' })
    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Rina W')
    const foreign = await call('otherOwner', 'patch', `/salon/customers/${rina.id}`, { name: 'Hack', phone: '081298765432', notes: '' })
    expect(foreign.status).toBe(404)
  })

  test('history lists the member bookings (orders arrive with checkout)', async () => {
    const apt = await book({ memberId: rina.id, startAt: at('14:00'), customerName: 'Rina W' })
    expect(apt.status).toBe(201)
    expect(apt.body.memberId).toBe(rina.id)
    const unknown = await book({ memberId: '999999999', startAt: at('14:00') })
    expect(unknown.status).toBe(404)
    const history = await call('kasir', 'get', `/salon/customers/${rina.id}/history`)
    expect(history.status).toBe(200)
    expect(history.body.appointments.map((a) => a.id)).toEqual([apt.body.id])
    expect(history.body.orders).toEqual([])
    expect((await call('otherOwner', 'get', `/salon/customers/${rina.id}/history`)).status).toBe(404)
  })
})
