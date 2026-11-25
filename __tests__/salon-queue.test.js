process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { localDate } = require('../api/service/salonTime')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Salon walk-in queue (S2-b; table from B26). Shapes follow FE-SALON-App
// src/api/contract.ts QueueBoard; rules follow src/mocks/engine/queue.ts.

const TZ = 'Asia/Jakarta'
const MIN = 60000
const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
const users = {}
const tokens = {}
const tenants = {}
const stores = {}
const createdUserIds = []
const f = {}
let keySeq = 0
const key = () => `sq-${stamp}-${++keySeq}`

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
    userName: `sq_${k}_${stamp}`,
    fullName: `Salon ${k}`,
    email: `sq_${k}_${stamp}@test.com`,
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
const service = async (name, durationMin) => {
  const res = await call('owner', 'post', '/salon/services', {
    name: `${name} ${stamp}`,
    category: 'Rambut',
    basePrice: 50000,
    serviceConfig: { durationMin, bufferMin: 0, levelPrices: { junior: 50000, senior: 65000, master: 80000 }, commission: { type: 'percent', value: 40 } },
    active: true
  })
  expect(res.status).toBe(201)
  return res.body
}
const stylist = async (k, name, serviceIds) => {
  const created = await call('owner', 'post', `/salon/staff${qa()}`, {
    name,
    username: `sq_${k}_${stamp}`.toLowerCase().slice(0, 30),
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
  await call('owner', 'put', `/salon/staff/${id}/skills${qa()}`, serviceIds.map((productId) => ({ productId, durationOverride: null, priceOverride: null })))
  await call('owner', 'put', `/salon/staff/${id}/availability${qa()}`,
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: '00:00', endTime: '23:59' })))
  users[k] = await db.user.findByPk(Number(id))
  await sign(k, users[k])
  return id
}
const ticketInput = (extra = {}) => ({
  customerName: 'Tamu',
  customerPhone: '',
  memberId: null,
  serviceIds: [f.cut.id],
  preferredStaffId: null,
  idempotencyKey: key(),
  ...extra
})
const ticket = (board, label) => board.tickets.find((t) => t.label === label)

beforeAll(async () => {
  tenants.salon = await db.tenant.create({ code: `sq-${stamp}`, name: 'Salon Antri', businessType: 'salon' })
  tenants.other = await db.tenant.create({ code: `sq-o-${stamp}`, name: 'Salon Lain', businessType: 'salon' })
  stores.a = await makeLocation(tenants.salon.id, 'SQ_A')
  stores.other = await makeLocation(tenants.other.id, 'SQ_O')
  await makeUser('owner', 'super_admin', stores.a.id)
  await makeUser('admin', 'admin', stores.a.id)
  await makeUser('otherOwner', 'super_admin', stores.other.id)
  f.cut = await service('Potong', 60)
  f.cream = await service('Creambath', 30)
  f.nobody = await service('Smoothing', 120)
  f.dewi = await stylist('dewi', 'Dewi', [f.cut.id, f.cream.id])
  f.rina = await stylist('rina', 'Rina', [f.cut.id])
})

afterAll(async () => {
  const tenantIds = Object.values(tenants).map((t) => t.id)
  const storeIds = (await db.location.findAll({ where: { tenantId: tenantIds }, paranoid: false, attributes: ['id'] })).map((l) => l.id)
  const productIds = (await db.product.findAll({ where: { tenantId: tenantIds }, paranoid: false, attributes: ['id'] })).map((p) => p.id)
  const staffUserIds = (await db.salon_staff_profile.findAll({ where: { tenantId: tenantIds }, paranoid: false, attributes: ['userId'] })).map((p) => p.userId)
  const q = (sql, replacements) => db.sequelize.query(sql, { replacements }).catch((e) => console.error(e.message))
  const del = (model, where) => db[model].destroy({ where, force: true }).catch((e) => console.error(model, e.message))
  await del('salon_queue_ticket', { tenantId: tenantIds })
  await del('salon_appointment_event', { tenantId: tenantIds })
  await del('salon_appointment_item', { tenantId: tenantIds })
  await del('salon_appointment', { tenantId: tenantIds })
  await del('salon_availability', { tenantId: tenantIds })
  await del('salon_staff_skill', { tenantId: tenantIds })
  await del('salon_staff_profile', { tenantId: tenantIds })
  await q('DELETE FROM document_counter WHERE store IN (:ids)', { ids: storeIds })
  await del('product_store', { product: productIds })
  await del('product', { id: productIds })
  await del('category', { tenantId: tenantIds })
  await del('user', { id: [...createdUserIds, ...staffUserIds] })
  await del('position', { tenantId: tenantIds })
  await del('location', { id: storeIds })
  await del('tenant', { id: tenantIds })
  await db.sequelize.close()
})

describe('salon walk-in queue', () => {
  test('B26 table: status CHECK and one number per outlet day', async () => {
    const [rows] = await db.sequelize.query(
      "SELECT conname FROM pg_constraint WHERE conrelid = '\"salon_queue_ticket\"'::regclass AND contype = 'c'"
    )
    expect(rows.map((r) => r.conname)).toContain('salon_queue_ticket_status_check')
    const [idx] = await db.sequelize.query("SELECT indexname FROM pg_indexes WHERE tablename = 'salon_queue_ticket'")
    expect(idx.map((r) => r.indexname)).toEqual(expect.arrayContaining(['uq_salon_queue_store_day_seq', 'uq_salon_queue_store_idempotency']))
  })

  test('an empty board of today lists when each stylist is free', async () => {
    const res = await call('dewi', 'get', `/salon/queue${qa()}`)
    expect(res.status).toBe(200)
    expect(res.body.businessDate).toBe(localDate(Date.now(), TZ))
    expect(res.body.tickets).toEqual([])
    expect(res.body.staffFreeAt.map((s) => s.staffId).sort()).toEqual([f.dewi, f.rina].sort())
  })

  test('enqueue is refused for a stylist, an unknown service or staff, and nobody skilled', async () => {
    expect((await call('dewi', 'post', `/salon/queue${qa()}`, ticketInput())).status).toBe(403)
    expect((await call('admin', 'post', `/salon/queue${qa()}`, ticketInput({ serviceIds: ['999999999'] }))).status).toBe(404)
    expect((await call('admin', 'post', `/salon/queue${qa()}`, ticketInput({ preferredStaffId: String(users.admin.id) }))).status).toBe(404)
    const nobody = await call('admin', 'post', `/salon/queue${qa()}`, ticketInput({ serviceIds: [f.nobody.id] }))
    expect(nobody.status).toBe(409)
    expect(nobody.body.code).toBe('STAFF_NOT_SKILLED')
    const rinaCream = await call('admin', 'post', `/salon/queue${qa()}`, ticketInput({ serviceIds: [f.cream.id], preferredStaffId: f.rina }))
    expect(rinaCream.body.code).toBe('STAFF_NOT_SKILLED')
  })

  test('numbered tickets A001…; estimates: greedy in number order on the fastest free skilled stylist', async () => {
    const t0 = Date.now()
    f.first = ticketInput({ customerName: 'Andi' })
    const a = await call('admin', 'post', `/salon/queue${qa()}`, f.first)
    expect(a.status).toBe(201)
    await call('admin', 'post', `/salon/queue${qa()}`, ticketInput({ customerName: 'Budi' }))
    const c = await call('admin', 'post', `/salon/queue${qa()}`, ticketInput({ customerName: 'Citra', serviceIds: [f.cream.id], preferredStaffId: f.dewi }))
    expect(c.status).toBe(201)
    const board = c.body
    expect(board.tickets.map((t) => [t.label, t.seq, t.status])).toEqual([['A001', 1, 'waiting'], ['A002', 2, 'waiting'], ['A003', 3, 'waiting']])
    expect(ticket(board, 'A003')).toMatchObject({ customerName: 'Citra', serviceNames: [`Creambath ${stamp}`], preferredStaffId: f.dewi, staffId: null, appointmentId: null })
    const at = (label) => Date.parse(ticket(board, label).estimatedStartAt)
    // A001 → Dewi now, A002 → Rina now, A003 waits for Dewi's 60 minutes.
    expect(at('A001') - t0).toBeLessThan(MIN)
    expect(at('A002') - t0).toBeLessThan(MIN)
    expect(at('A003') - at('A001')).toBeGreaterThanOrEqual(59 * MIN)
    const row = await db.salon_queue_ticket.findByPk(Number(ticket(board, 'A001').id))
    expect(row.tenantId).toBe(tenants.salon.id)
  })

  test('same key replays the board; a changed body with the key is a mismatch', async () => {
    const replay = await call('admin', 'post', `/salon/queue${qa()}`, f.first)
    expect(replay.status).toBe(200)
    expect(replay.headers['idempotent-replay']).toBe('true')
    expect(replay.body.tickets).toHaveLength(3)
    const mismatch = await call('admin', 'post', `/salon/queue${qa()}`, { ...f.first, customerName: 'Andika' })
    expect(mismatch.status).toBe(409)
    expect(mismatch.body.code).toBe('IDEMPOTENCY_MISMATCH')
  })

  test('parallel enqueues get consecutive, unique numbers', async () => {
    const results = await Promise.all([0, 1, 2].map(() => call('admin', 'post', `/salon/queue${qa()}`, ticketInput({ customerName: 'Paralel' }))))
    expect(results.map((r) => r.status)).toEqual([201, 201, 201])
    const board = (await call('admin', 'get', `/salon/queue${qa()}`)).body
    expect(board.tickets.map((t) => t.seq)).toEqual([1, 2, 3, 4, 5, 6])
  })

  test('call: the ticket becomes a walk-in appointment in service with the estimated stylist', async () => {
    const before = (await call('admin', 'get', `/salon/queue${qa()}`)).body
    const res = await call('admin', 'post', `/salon/queue/${ticket(before, 'A001').id}/call${qa()}`, { staffId: null })
    expect(res.status).toBe(200)
    const a1 = ticket(res.body, 'A001')
    expect(a1).toMatchObject({ status: 'serving', staffId: f.dewi, appointmentId: expect.any(String) })
    f.a1 = a1
    const apt = await call('admin', 'get', `/salon/appointments/${a1.appointmentId}${qa()}`)
    expect(apt.status).toBe(200)
    expect(apt.body).toMatchObject({ status: 'in_service', source: 'walk_in', customerName: 'Andi', notes: 'Antrian A001', depositAmount: 0 })
    expect(apt.body.items).toEqual([expect.objectContaining({ staffId: f.dewi, status: 'in_service', durationMin: 60 })])
    expect(apt.body.history.map((h) => h.status)).toEqual(['checked_in', 'in_service'])
    // Dewi is busy for the next hour.
    const dewiFree = Date.parse(res.body.staffFreeAt.find((s) => s.staffId === f.dewi).freeAt)
    expect(dewiFree - Date.now()).toBeGreaterThan(55 * MIN)

    const again = await call('admin', 'post', `/salon/queue/${a1.id}/call${qa()}`, { staffId: null })
    expect(again.status).toBe(409)
    expect(again.body.code).toBe('INVALID_TRANSITION')
  })

  test('calling for a busy stylist is refused; another stylist can be chosen', async () => {
    const board = (await call('admin', 'get', `/salon/queue${qa()}`)).body
    const busy = await call('admin', 'post', `/salon/queue/${ticket(board, 'A003').id}/call${qa()}`, {})
    expect(busy.status).toBe(409)
    expect(busy.body.code).toBe('SLOT_TAKEN')
    expect(ticket((await call('admin', 'get', `/salon/queue${qa()}`)).body, 'A003').status).toBe('waiting')
    const rina = await call('admin', 'post', `/salon/queue/${ticket(board, 'A002').id}/call${qa()}`, { staffId: f.rina })
    expect(rina.status).toBe(200)
    expect(ticket(rina.body, 'A002')).toMatchObject({ status: 'serving', staffId: f.rina })
  })

  test('skip a waiting ticket only; other tenants cannot touch a ticket', async () => {
    const board = (await call('admin', 'get', `/salon/queue${qa()}`)).body
    const foreign = await call('otherOwner', 'post', `/salon/queue/${ticket(board, 'A003').id}/skip?store=${stores.other.id}`, {})
    expect(foreign.status).toBe(404)
    const skip = await call('admin', 'post', `/salon/queue/${ticket(board, 'A003').id}/skip${qa()}`, {})
    expect(skip.status).toBe(200)
    expect(ticket(skip.body, 'A003').status).toBe('skipped')
    expect((await call('admin', 'post', `/salon/queue/${ticket(board, 'A003').id}/skip${qa()}`, {})).body.code).toBe('INVALID_TRANSITION')
    expect((await call('admin', 'post', `/salon/queue/${f.a1.id}/skip${qa()}`, {})).status).toBe(409)
  })

  test('the ticket is done once its appointment is completed, and the stylist is free again', async () => {
    const done = await call('admin', 'post', `/salon/appointments/${f.a1.appointmentId}/complete${qa()}`, { reason: null })
    expect(done.status).toBe(200)
    const board = (await call('admin', 'get', `/salon/queue${qa()}`)).body
    expect(ticket(board, 'A001').status).toBe('done')
    expect(ticket(board, 'A002').status).toBe('serving')
    const dewiFree = Date.parse(board.staffFreeAt.find((s) => s.staffId === f.dewi).freeAt)
    expect(dewiFree - Date.now()).toBeLessThan(MIN)
  })
})
