process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Salon S1-b: catalog (services, retail products), staff (profile, skills,
// availability, time off), positions, work shifts, settings, outlets.
// Shapes follow FE-SALON-App src/api/contract.ts.

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
const users = {}
const tokens = {}
const tenants = {}
const stores = {}
const createdUserIds = []

const nextLocationId = async () => {
  const [rows] = await db.sequelize.query("SELECT nextval('location_id_seq') AS id")
  return Number(rows[0].id)
}
const makeLocation = async (tenantId, name) =>
  db.location.create({
    id: await nextLocationId(),
    name: `${name}_${stamp}`,
    status: 'active',
    tenantId,
    businessType: 'salon',
    timezone: 'Asia/Jakarta',
    salonSettings: { openTime: '09:00', closeTime: '21:00', ownerPinHash: 'hash-keep-me' }
  })
const makeUser = async (key, roleType, storeId) => {
  users[key] = await db.user.create({
    userName: `slb_${key}_${stamp}`,
    fullName: `Salon ${key}`,
    email: `slb_${key}_${stamp}@test.com`,
    roleType,
    userType: roleType === 'user' ? 'user' : 'admin',
    store: storeId,
    status: 'active'
  })
  createdUserIds.push(users[key].id)
  tokens[key] = await signSessionToken(
    { id: users[key].id, userName: users[key].userName, roleType, store: storeId },
    JWT_SECRET
  )
}
const call = (key, method, path, body) => {
  const r = request(app)[method](path).set('Authorization', `Bearer ${tokens[key]}`)
  return body === undefined ? r : r.send(body)
}

const service = (name, extra = {}) => ({
  name,
  category: 'Rambut',
  basePrice: 50000,
  serviceConfig: {
    durationMin: 45,
    bufferMin: 15,
    levelPrices: { junior: 50000, senior: 65000, master: 80000 },
    commission: { type: 'percent', value: 40 }
  },
  active: true,
  ...extra
})
const staffInput = (username, extra = {}) => ({
  name: `Stylist ${username}`,
  username,
  position: 'Stylist',
  positionId: null,
  level: 'senior',
  colorTag: '#10b981',
  acceptsOnline: true,
  active: true,
  commissionOverride: null,
  ...extra
})
const shiftInput = (extra = {}) => ({
  name: 'Pagi',
  type: 'harian',
  startDate: '2026-12-01',
  endDate: null,
  startTime: '09:00',
  endTime: '15:00',
  employeeIds: [],
  status: 'active',
  ...extra
})

beforeAll(async () => {
  tenants.salon = await db.tenant.create({ code: `slb-${stamp}`, name: 'Salon B', businessType: 'salon' })
  tenants.other = await db.tenant.create({ code: `slb-o-${stamp}`, name: 'Salon Lain', businessType: 'salon' })
  stores.a = await makeLocation(tenants.salon.id, 'SLB_A')
  stores.b = await makeLocation(tenants.salon.id, 'SLB_B')
  stores.other = await makeLocation(tenants.other.id, 'SLB_O')
  await makeUser('owner', 'super_admin', stores.a.id)
  await makeUser('admin', 'admin', stores.a.id)
  await makeUser('kasir', 'kasir', stores.a.id)
  await makeUser('otherOwner', 'super_admin', stores.other.id)
  await makeUser('newOwner', 'super_admin', null)
  tenants.fresh = await db.tenant.create({ code: `slb-n-${stamp}`, name: 'Salon Baru', businessType: 'salon', ownerId: users.newOwner.id })
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
  await del('salon_appointment_item', { tenantId: tenantIds })
  await del('salon_appointment', { tenantId: tenantIds })
  await del('salon_time_off', { tenantId: tenantIds })
  await del('salon_availability', { tenantId: tenantIds })
  await del('salon_staff_skill', { tenantId: tenantIds })
  await del('salon_staff_profile', { tenantId: tenantIds })
  await del('shift', { store: storeIds })
  await del('stock_history', { product: productIds })
  await del('product_store_stock', { product: productIds })
  await del('product_store', { product: productIds })
  await del('product', { id: productIds })
  await del('category', { tenantId: tenantIds })
  await del('position', { tenantId: tenantIds })
  await del('user', { id: [...createdUserIds, ...staffUserIds] })
  await del('tenant', { id: tenantIds }).catch(() => {})
  await del('location', { id: storeIds })
  await del('tenant', { id: tenantIds })
  await db.sequelize.close()
})

describe('services', () => {
  let svc
  test('owner creates a service; it is linked to every outlet and listed', async () => {
    const res = await call('owner', 'post', '/salon/services', service(`Potong ${stamp}`))
    expect(res.status).toBe(201)
    svc = res.body
    expect(svc).toMatchObject({ name: `Potong ${stamp}`, category: 'Rambut', basePrice: 50000, tipeProduk: 'service', active: true })
    expect(svc.serviceConfig.levelPrices.master).toBe(80000)
    const row = await db.product.findByPk(Number(svc.id))
    expect(row).toMatchObject({ tipeProduk: 'salon_service', inventoryMode: 'make_to_order', tenantId: tenants.salon.id })
    expect(row.sku).toMatch(/^PRD-/)
    const links = await db.product_store.findAll({ where: { product: row.id } })
    expect(links.map((l) => l.store).sort()).toEqual([stores.a.id, stores.b.id].sort())

    const list = await call('kasir', 'get', '/salon/services')
    expect(list.status).toBe(200)
    expect(list.body.data.map((s) => s.id)).toContain(svc.id)
  })

  test('duplicate name (case-insensitive) is DUPLICATE; kasir cannot manage', async () => {
    const dup = await call('admin', 'post', '/salon/services', service(`POTONG ${stamp}`))
    expect(dup.status).toBe(409)
    expect(dup.body.code).toBe('DUPLICATE')
    const kasir = await call('kasir', 'post', '/salon/services', service(`Creambath ${stamp}`))
    expect(kasir.status).toBe(403)
    expect(kasir.body.code).toBe('FORBIDDEN')
  })

  test('invalid serviceConfig is VALIDATION_FAILED', async () => {
    const res = await call('owner', 'post', '/salon/services', service(`Bad ${stamp}`, { serviceConfig: { durationMin: 2 } }))
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  test('update; deactivating a service with an upcoming booking is IN_USE', async () => {
    const upd = await call('owner', 'patch', `/salon/services/${svc.id}`, service(`Potong ${stamp}`, { basePrice: 55000, category: 'Potong' }))
    expect(upd.status).toBe(200)
    expect(upd.body).toMatchObject({ basePrice: 55000, category: 'Potong' })

    const appt = await db.salon_appointment.create({
      tenantId: tenants.salon.id,
      store: stores.a.id,
      number: `BK-${stamp}`,
      customerName: 'Bu Sari',
      startAt: new Date('2026-12-02T03:00:00Z'),
      endAt: new Date('2026-12-02T04:00:00Z'),
      idempotencyKey: `slb-${stamp}`,
      requestHash: 'h'.repeat(64)
    })
    await db.salon_appointment_item.create({
      tenantId: tenants.salon.id,
      store: stores.a.id,
      appointmentId: appt.id,
      productId: Number(svc.id),
      serviceName: 'Potong',
      staffId: users.admin.id,
      startAt: appt.startAt,
      endAt: appt.endAt,
      price: 50000,
      durationMin: 45,
      bufferMin: 15,
      status: 'booked'
    })
    const off = await call('owner', 'patch', `/salon/services/${svc.id}`, service(`Potong ${stamp}`, { active: false }))
    expect(off.status).toBe(409)
    expect(off.body.code).toBe('IN_USE')
    await db.salon_appointment_item.destroy({ where: { appointmentId: appt.id }, force: true })
    await appt.destroy({ force: true })
    const ok = await call('owner', 'patch', `/salon/services/${svc.id}`, service(`Potong ${stamp}`, { active: false }))
    expect(ok.status).toBe(200)
    expect(ok.body.active).toBe(false)
  })

  test('another salon tenant cannot see or edit it', async () => {
    const list = await call('otherOwner', 'get', '/salon/services')
    expect(list.body.data.map((s) => s.id)).not.toContain(svc.id)
    const edit = await call('otherOwner', 'patch', `/salon/services/${svc.id}`, service('Hijack'))
    expect(edit.status).toBe(404)
  })
})

describe('retail products', () => {
  let product
  test('admin (one outlet) creates with stock; stock lands on the outlet row', async () => {
    const res = await call('admin', 'post', '/salon/products', {
      name: `Pomade ${stamp}`,
      price: 85000,
      stock: 12,
      commission: { type: 'flat', value: 5000 },
      active: true
    })
    expect(res.status).toBe(201)
    product = res.body
    expect(product).toMatchObject({ price: 85000, stock: 12, commission: { type: 'flat', value: 5000 } })
    const row = await db.product_store_stock.findOne({ where: { product: Number(product.id), store: stores.a.id } })
    expect(Number(row.stock)).toBe(12)
  })

  test('owner of two outlets: stock change needs ?store=', async () => {
    const body = { name: `Pomade ${stamp}`, price: 85000, stock: 20, commission: { type: 'flat', value: 5000 }, active: true }
    const noStore = await call('owner', 'patch', `/salon/products/${product.id}`, body)
    expect(noStore.status).toBe(400)
    const withStore = await call('owner', 'patch', `/salon/products/${product.id}?store=${stores.a.id}`, body)
    expect(withStore.status).toBe(200)
    expect(withStore.body.stock).toBe(20)
    const history = await db.stock_history.findAll({ where: { product: Number(product.id) } })
    expect(history.length).toBeGreaterThanOrEqual(2)
    const kasirList = await call('kasir', 'get', '/salon/products')
    expect(kasirList.body.data.find((p) => p.id === product.id).stock).toBe(20)
  })

  test('percent commission above 100 is refused', async () => {
    const res = await call('owner', 'post', '/salon/products', {
      name: `Serum ${stamp}`, price: 1000, stock: 0, commission: { type: 'percent', value: 120 }, active: true
    })
    expect(res.status).toBe(400)
  })
})

describe('positions', () => {
  let pos
  test('create, duplicate, rename', async () => {
    const res = await call('owner', 'post', '/salon/positions', { name: `Kapster ${stamp}`, description: 'Potong', active: true })
    expect(res.status).toBe(201)
    pos = res.body
    expect(pos).toEqual({ id: expect.any(String), name: `Kapster ${stamp}`, description: 'Potong', active: true })
    const dup = await call('admin', 'post', '/salon/positions', { name: `kapster ${stamp}`, description: '', active: true })
    expect(dup.status).toBe(409)
    const ren = await call('admin', 'patch', `/salon/positions/${pos.id}`, { name: `Barber ${stamp}`, description: '', active: true })
    expect(ren.status).toBe(200)
    expect(ren.body.name).toBe(`Barber ${stamp}`)
    const list = await call('kasir', 'get', '/salon/positions')
    expect(list.body.data.map((p) => p.id)).toContain(pos.id)
  })

  test('delete refused while used, allowed after', async () => {
    const staff = await call('admin', 'post', `/salon/staff?store=${stores.a.id}`, staffInput(`slb_pos_${stamp}`.slice(0, 30).toLowerCase(), { positionId: pos.id, position: 'Lain' }))
    expect(staff.status).toBe(201)
    expect(staff.body.position).toBe(`Barber ${stamp}`)
    const used = await call('owner', 'delete', `/salon/positions/${pos.id}`)
    expect(used.status).toBe(409)
    expect(used.body.code).toBe('IN_USE')
    await db.salon_staff_profile.update({ positionId: null }, { where: { userId: Number(staff.body.userId) } })
    const del = await call('owner', 'delete', `/salon/positions/${pos.id}`)
    expect(del.status).toBe(200)
  })
})

describe('staff', () => {
  let stylist
  let svcId
  const username = `slb_st_${stamp}`.slice(0, 30).toLowerCase()
  beforeAll(async () => {
    const s = await call('owner', 'post', '/salon/services', service(`Creambath ${stamp}`))
    svcId = s.body.id
  })

  test('create: user (roleType user) + profile + one-time password; position created by name', async () => {
    const res = await call('admin', 'post', `/salon/staff?store=${stores.a.id}`, staffInput(username))
    expect(res.status).toBe(201)
    stylist = res.body
    expect(stylist).toMatchObject({ store: String(stores.a.id), username, position: 'Stylist', level: 'senior', skills: [], availability: [], timeOff: [] })
    expect(stylist.temporaryPassword).toEqual(expect.any(String))
    const account = await db.user.scope('withCredentials').findByPk(Number(stylist.userId))
    expect(account).toMatchObject({ roleType: 'user', store: stores.a.id })
    expect(account.password).not.toBe(stylist.temporaryPassword)
    const dup = await call('admin', 'post', `/salon/staff?store=${stores.a.id}`, staffInput(username))
    expect(dup.status).toBe(409)
    expect(dup.body.code).toBe('DUPLICATE')
    // sign the stylist in for the self-scope checks below
    tokens.stylist = await signSessionToken({ id: account.id, userName: username, roleType: 'user', store: stores.a.id }, JWT_SECRET)
  })

  test('kasir of the outlet reads staff; another outlet is FORBIDDEN', async () => {
    const list = await call('kasir', 'get', `/salon/staff?store=${stores.a.id}`)
    expect(list.status).toBe(200)
    expect(list.body.data.map((s) => s.userId)).toContain(stylist.userId)
    const other = await call('kasir', 'get', `/salon/staff?store=${stores.b.id}`)
    expect(other.status).toBe(403)
    const write = await call('kasir', 'put', `/salon/staff/${stylist.userId}/skills?store=${stores.a.id}`, [])
    expect(write.status).toBe(403)
  })

  test('profile, skills, availability', async () => {
    const prof = await call('admin', 'put', `/salon/staff/${stylist.userId}/profile?store=${stores.a.id}`, {
      ...staffInput(username, { level: 'master', name: 'Rina', commissionOverride: { type: 'percent', value: 50 } })
    })
    expect(prof.status).toBe(200)
    expect(prof.body).toMatchObject({ name: 'Rina', level: 'master', commissionOverride: { type: 'percent', value: 50 } })

    const unknown = await call('admin', 'put', `/salon/staff/${stylist.userId}/skills?store=${stores.a.id}`, [
      { productId: '999999999', durationOverride: null, priceOverride: null }
    ])
    expect(unknown.status).toBe(404)
    const twice = await call('admin', 'put', `/salon/staff/${stylist.userId}/skills?store=${stores.a.id}`, [
      { productId: svcId, durationOverride: null, priceOverride: null },
      { productId: svcId, durationOverride: 30, priceOverride: null }
    ])
    expect(twice.status).toBe(400)
    const skills = await call('admin', 'put', `/salon/staff/${stylist.userId}/skills?store=${stores.a.id}`, [
      { productId: svcId, durationOverride: 30, priceOverride: 70000 }
    ])
    expect(skills.status).toBe(200)
    expect(skills.body.skills).toEqual([{ productId: svcId, durationOverride: 30, priceOverride: 70000 }])

    const overlap = await call('admin', 'put', `/salon/staff/${stylist.userId}/availability?store=${stores.a.id}`, [
      { weekday: 1, startTime: '09:00', endTime: '13:00' },
      { weekday: 1, startTime: '12:00', endTime: '17:00' }
    ])
    expect(overlap.status).toBe(400)
    const avail = await call('admin', 'put', `/salon/staff/${stylist.userId}/availability?store=${stores.a.id}`, [
      { weekday: 1, startTime: '13:00', endTime: '17:00' },
      { weekday: 1, startTime: '09:00', endTime: '12:00' }
    ])
    expect(avail.status).toBe(200)
    expect(avail.body.availability).toEqual([
      { weekday: 1, startTime: '09:00', endTime: '12:00' },
      { weekday: 1, startTime: '13:00', endTime: '17:00' }
    ])
  })

  test('time off: refused over a booking (BR-SLN-008), added and removed otherwise', async () => {
    const appt = await db.salon_appointment.create({
      tenantId: tenants.salon.id,
      store: stores.a.id,
      number: `BK2-${stamp}`,
      customerName: 'Pak Budi',
      startAt: new Date('2026-12-03T03:00:00Z'),
      endAt: new Date('2026-12-03T04:00:00Z'),
      idempotencyKey: `slb2-${stamp}`,
      requestHash: 'h'.repeat(64)
    })
    await db.salon_appointment_item.create({
      tenantId: tenants.salon.id,
      store: stores.a.id,
      appointmentId: appt.id,
      productId: Number(svcId),
      serviceName: 'Creambath',
      staffId: Number(stylist.userId),
      startAt: appt.startAt,
      endAt: appt.endAt,
      price: 50000,
      durationMin: 45,
      bufferMin: 15,
      status: 'confirmed'
    })
    const clash = await call('admin', 'post', `/salon/staff/${stylist.userId}/time-off?store=${stores.a.id}`, {
      startAt: '2026-12-03T09:00:00+07:00', endAt: '2026-12-03T18:00:00+07:00', reason: 'Sakit'
    })
    expect(clash.status).toBe(409)
    expect(clash.body.code).toBe('SLOT_TAKEN')

    const add = await call('admin', 'post', `/salon/staff/${stylist.userId}/time-off?store=${stores.a.id}`, {
      startAt: '2026-12-04T09:00:00+07:00', endAt: '2026-12-04T18:00:00+07:00', reason: 'Cuti'
    })
    expect(add.status).toBe(201)
    expect(add.body.timeOff).toEqual([{ id: expect.any(String), startAt: '2026-12-04T02:00:00.000Z', endAt: '2026-12-04T11:00:00.000Z', reason: 'Cuti' }])
    const del = await call('admin', 'delete', `/salon/staff/${stylist.userId}/time-off/${add.body.timeOff[0].id}?store=${stores.a.id}`)
    expect(del.status).toBe(200)
    expect(del.body.timeOff).toEqual([])
  })

  test('a stylist lists only themself', async () => {
    const res = await call('stylist', 'get', `/salon/staff?store=${stores.a.id}`)
    expect(res.status).toBe(200)
    expect(res.body.data.map((s) => s.userId)).toEqual([stylist.userId])
  })

  describe('work shifts', () => {
    let ws
    test('create, overlap is SLOT_TAKEN, non-outlet employee is NOT_FOUND', async () => {
      const res = await call('kasir', 'post', `/salon/work-shifts?store=${stores.a.id}`, shiftInput({ employeeIds: [stylist.userId] }))
      expect(res.status).toBe(201)
      ws = res.body
      expect(ws).toEqual({
        id: expect.any(String), store: String(stores.a.id), name: 'Pagi', type: 'harian', startDate: '2026-12-01', endDate: null,
        startTime: '09:00', endTime: '15:00', employeeIds: [stylist.userId], status: 'active'
      })
      const clash = await call('kasir', 'post', `/salon/work-shifts?store=${stores.a.id}`, shiftInput({
        name: 'Minggu ini', type: 'mingguan', startDate: '2026-11-30', endDate: '2026-12-06', startTime: '14:00', endTime: '20:00', employeeIds: [stylist.userId]
      }))
      expect(clash.status).toBe(409)
      expect(clash.body.code).toBe('SLOT_TAKEN')
      const draft = await call('kasir', 'post', `/salon/work-shifts?store=${stores.a.id}`, shiftInput({
        name: 'Draft', startTime: '10:00', employeeIds: [stylist.userId], status: 'draft'
      }))
      expect(draft.status).toBe(201)
      const foreign = await call('kasir', 'post', `/salon/work-shifts?store=${stores.a.id}`, shiftInput({ employeeIds: [String(users.otherOwner.id)] }))
      expect(foreign.status).toBe(404)
      const weeklyNoEnd = await call('kasir', 'post', `/salon/work-shifts?store=${stores.a.id}`, shiftInput({ type: 'mingguan' }))
      expect(weeklyNoEnd.status).toBe(400)
    })

    test('list by range and per stylist; update; delete', async () => {
      const inRange = await call('admin', 'get', `/salon/work-shifts?store=${stores.a.id}&from=2026-12-01&to=2026-12-01`)
      expect(inRange.body.data.map((w) => w.id)).toContain(ws.id)
      const outRange = await call('admin', 'get', `/salon/work-shifts?store=${stores.a.id}&from=2026-12-02&to=2026-12-09`)
      expect(outRange.body.data.map((w) => w.id)).not.toContain(ws.id)
      const mine = await call('stylist', 'get', `/salon/work-shifts?store=${stores.a.id}`)
      expect(mine.status).toBe(200)
      expect(mine.body.data.every((w) => w.employeeIds.includes(stylist.userId))).toBe(true)

      const upd = await call('kasir', 'patch', `/salon/work-shifts/${ws.id}?store=${stores.a.id}`, shiftInput({ endTime: '16:00', employeeIds: [stylist.userId] }))
      expect(upd.status).toBe(200)
      expect(upd.body.endTime).toBe('16:00')
      const del = await call('kasir', 'delete', `/salon/work-shifts/${ws.id}?store=${stores.a.id}`)
      expect(del.status).toBe(200)
      const gone = await call('kasir', 'patch', `/salon/work-shifts/${ws.id}?store=${stores.a.id}`, shiftInput())
      expect(gone.status).toBe(404)
    })
  })
})

describe('settings and outlets', () => {
  test('owner updates tenant settings; admin cannot', async () => {
    const body = { salonProfile: 'barbershop', slotStepMin: 20, depositDefault: 25000, pointsPer: 20000 }
    const res = await call('owner', 'patch', '/salon/settings', body)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: String(tenants.salon.id), businessType: 'salon', settings: body })
    const admin = await call('admin', 'patch', '/salon/settings', body)
    expect(admin.status).toBe(403)
    const bad = await call('owner', 'patch', '/salon/settings', { ...body, slotStepMin: 7 })
    expect(bad.status).toBe(400)
  })

  test('owner creates an outlet: salon type, hours, catalog linked; duplicate name refused', async () => {
    const body = { name: `Cabang ${stamp}`, address: 'Jl. Melati 1', phone: '081234567890', timezone: 'Asia/Makassar', openTime: '10:00', closeTime: '20:00', active: true }
    const res = await call('owner', 'post', '/salon/stores', body)
    expect(res.status).toBe(201)
    expect(res.body).toEqual({ id: expect.any(String), name: body.name, address: body.address, phone: body.phone, timezone: 'Asia/Makassar', openTime: '10:00', closeTime: '20:00', active: true, hasOwnerPin: false })
    const row = await db.location.findByPk(Number(res.body.id))
    expect(row).toMatchObject({ tenantId: tenants.salon.id, businessType: 'salon' })
    const services = await db.product.count({ where: { tenantId: tenants.salon.id } })
    const links = await db.product_store.count({ where: { store: row.id } })
    expect(links).toBe(services)
    const dup = await call('owner', 'post', '/salon/stores', { ...body, name: body.name.toUpperCase() })
    expect(dup.status).toBe(409)
    const admin = await call('admin', 'post', '/salon/stores', { ...body, name: `X ${stamp}` })
    expect(admin.status).toBe(403)
  })

  test('update keeps the owner-PIN hash; foreign outlet is NOT_FOUND', async () => {
    const body = { name: `SLB_A_${stamp}`, address: 'Jl. Mawar', phone: '', timezone: 'Asia/Jakarta', openTime: '08:00', closeTime: '22:00', active: true }
    const res = await call('owner', 'patch', `/salon/stores/${stores.a.id}`, body)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ openTime: '08:00', closeTime: '22:00', address: 'Jl. Mawar' })
    const raw = (await db.location.findByPk(stores.a.id)).getDataValue('salonSettings')
    expect(raw).toMatchObject({ openTime: '08:00', closeTime: '22:00', ownerPinHash: 'hash-keep-me' })
    const foreign = await call('owner', 'patch', `/salon/stores/${stores.other.id}`, body)
    expect(foreign.status).toBe(404)
  })

  test('onboarding: a store-less owner creates the first outlet and is bound to it', async () => {
    const before = await call('newOwner', 'get', '/salon/context')
    expect(before.body.onboardingRequired).toBe(true)
    const res = await call('newOwner', 'post', '/salon/stores', {
      name: `Pertama ${stamp}`, address: '', phone: '', timezone: 'Asia/Jakarta', openTime: '09:00', closeTime: '21:00', active: true
    })
    expect(res.status).toBe(201)
    const owner = await db.user.findByPk(users.newOwner.id)
    expect(owner.store).toBe(Number(res.body.id))
    const after = await call('newOwner', 'get', '/salon/context')
    expect(after.body.onboardingRequired).toBe(false)
    expect(after.body.stores.map((s) => s.id)).toEqual([res.body.id])
  })
})
