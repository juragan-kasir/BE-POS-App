process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { SALON_PERMISSIONS, SALON_ROLE_PERMISSIONS } = require('../utils/salonCapabilities')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Salon S1-a (batch B26): schema + GET /salon/context.
// - DR-SLN-05: the DB refuses a second blocking booking of the same staff
//   minutes (EXCLUDE USING gist), also under 50 parallel inserts.
// - DR-SLN-07: the commission ledger is immutable.
// - BR-SLN-020 / SALON-BA §3: context = salon tenant + role permissions.

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
const users = {}
const tokens = {}
let salonTenant = null
let fnbTenant = null
let store = null
let store2 = null
let fnbStore = null
let product = null
let category = null
let order = null

const nextLocationId = async () => {
  const [rows] = await db.sequelize.query("SELECT nextval('location_id_seq') AS id")
  return Number(rows[0].id)
}
const makeLocation = async (tenantId, name) =>
  db.location.create({
    id: await nextLocationId(),
    name: `${name}_${stamp}`,
    status: 'active',
    phoneNumber: '081234567890',
    email: `${name.toLowerCase()}_${stamp}@test.com`,
    tenantId,
    timezone: 'Asia/Jakarta',
    salonSettings: { openTime: '10:00', closeTime: '21:00' }
  })
const makeUser = async (key, roleType, storeId) => {
  users[key] = await db.user.create({
    userName: `sln_${key}_${stamp}`,
    fullName: `Salon ${key}`,
    email: `sln_${key}_${stamp}@test.com`,
    roleType,
    userType: roleType === 'user' ? 'user' : 'admin',
    store: storeId,
    status: 'active'
  })
  tokens[key] = await signSessionToken(
    { id: users[key].id, userName: users[key].userName, roleType, store: storeId },
    JWT_SECRET
  )
}
const ctx = (key, query = '') =>
  request(app).get(`/salon/context${query}`).set('Authorization', `Bearer ${tokens[key]}`)

const at = (hhmm) => new Date(`2026-12-01T${hhmm}:00+07:00`)
let apptSeq = 0
const makeAppointment = () =>
  db.salon_appointment.create({
    tenantId: salonTenant.id,
    store: store.id,
    number: `BK-T-${stamp}-${++apptSeq}`,
    customerName: 'Bu Sari',
    startAt: at('10:00'),
    endAt: at('11:00'),
    idempotencyKey: `idem-${stamp}-${apptSeq}`,
    requestHash: 'h'.repeat(64)
  })
const item = (appointment, staffId, start, end, status = 'booked') => ({
  tenantId: salonTenant.id,
  store: store.id,
  appointmentId: appointment.id,
  productId: product.id,
  serviceName: 'Potong rambut',
  staffId,
  startAt: at(start),
  endAt: at(end),
  price: 50000,
  durationMin: 45,
  bufferMin: 15,
  status
})

beforeAll(async () => {
  salonTenant = await db.tenant.create({ code: `sln-${stamp}`, name: 'Salon Juragan', businessType: 'salon', salonSettings: { salonProfile: 'barbershop', slotStepMin: 15 } })
  fnbTenant = await db.tenant.create({ code: `sln-fnb-${stamp}`, name: 'Warung', businessType: 'fnb' })
  store = await makeLocation(salonTenant.id, 'SLN_A')
  store2 = await makeLocation(salonTenant.id, 'SLN_B')
  fnbStore = await makeLocation(fnbTenant.id, 'SLN_FNB')
  await makeUser('owner', 'super_admin', store.id)
  await makeUser('admin', 'admin', store.id)
  await makeUser('kasir', 'kasir', store2.id)
  await makeUser('stylist', 'user', store.id)
  await makeUser('fnb', 'admin', fnbStore.id)
  await makeUser('newOwner', 'super_admin', null)
  await db.tenant.create({ code: `sln-new-${stamp}`, name: 'Salon Baru', businessType: 'salon', ownerId: users.newOwner.id })
  category = await db.category.create({ name: `SLN_CAT_${stamp}`, tenantId: salonTenant.id })
  product = await db.product.create({ nameProduct: `SLN_SVC_${stamp}`, category: category.id, price: 50000, tipeProduk: 'salon_service', tenantId: salonTenant.id, status: 'active' })
  order = await db.order.create({ store: store.id, tenantId: salonTenant.id, orderNumber: `SLN-${stamp}`, totalPrice: 50000, status: 'paid' })
})

afterAll(async () => {
  await db.sequelize.transaction(async (t) => {
    await db.sequelize.query("SET LOCAL salon.ledger_maintenance = 'on'", { transaction: t })
    await db.sequelize.query('DELETE FROM salon_staff_commission WHERE "tenantId" = :id', { replacements: { id: salonTenant.id }, transaction: t })
  }).catch(() => {})
  await db.salon_appointment_item.destroy({ where: { tenantId: salonTenant?.id }, force: true }).catch(() => {})
  await db.salon_appointment.destroy({ where: { tenantId: salonTenant?.id }, force: true }).catch(() => {})
  await db.salon_staff_profile.destroy({ where: { tenantId: salonTenant?.id }, force: true }).catch(() => {})
  await db.order.destroy({ where: { id: order?.id }, force: true }).catch(() => {})
  await db.product.destroy({ where: { id: product?.id }, force: true }).catch(() => {})
  await db.category.destroy({ where: { id: category?.id }, force: true }).catch(() => {})
  await db.user.destroy({ where: { id: Object.values(users).map((u) => u.id) }, force: true }).catch(() => {})
  await db.location.destroy({ where: { id: [store?.id, store2?.id, fnbStore?.id] }, force: true }).catch(() => {})
  await db.tenant.destroy({ where: { code: [`sln-${stamp}`, `sln-fnb-${stamp}`, `sln-new-${stamp}`] }, force: true }).catch(() => {})
})

describe('GET /salon/context', () => {
  test('owner: all permissions, every outlet of the tenant, tenant settings with defaults', async () => {
    await db.salon_staff_profile.create({ tenantId: salonTenant.id, store: store.id, userId: users.owner.id, level: 'master' })
    const res = await ctx('owner')
    expect(res.status).toBe(200)
    expect(res.body.canonicalRole).toBe('owner')
    expect(res.body.permissions).toEqual([...SALON_PERMISSIONS])
    expect(res.body.stores.map((s) => s.id)).toEqual([String(store.id), String(store2.id)])
    expect(res.body.stores[0]).toEqual({
      id: String(store.id),
      name: store.name,
      address: '',
      phone: '081234567890',
      timezone: 'Asia/Jakarta',
      openTime: '10:00',
      closeTime: '21:00',
      active: true
    })
    expect(res.body.tenant).toEqual({
      id: String(salonTenant.id),
      name: 'Salon Juragan',
      businessType: 'salon',
      settings: { salonProfile: 'barbershop', slotStepMin: 15, depositDefault: 0, pointsPer: 10000 }
    })
    expect(res.body.user).toEqual({ id: String(users.owner.id), name: 'Salon owner', username: users.owner.userName })
    expect(res.body.staffUserId).toBe(String(users.owner.id))
    expect(res.body.onboardingRequired).toBe(false)
  })

  test('admin, kasir and stylist get their role permissions and only their own outlet', async () => {
    const admin = await ctx('admin')
    expect(admin.body.canonicalRole).toBe('admin')
    expect(admin.body.permissions).not.toContain('settings.manage')
    expect(admin.body.permissions).not.toContain('outlet.manage')
    expect(admin.body.stores.map((s) => s.id)).toEqual([String(store.id)])

    const kasir = await ctx('kasir')
    expect(kasir.body.permissions).toEqual([...SALON_ROLE_PERMISSIONS.kasir])
    expect(kasir.body.stores.map((s) => s.id)).toEqual([String(store2.id)])
    expect(kasir.body.staffUserId).toBeNull()

    const stylist = await ctx('stylist')
    expect(stylist.body.canonicalRole).toBe('staff')
    expect(stylist.body.permissions).toEqual(['appointment.read', 'commission.read'])
  })

  test('owner who has not created an outlet yet gets onboardingRequired', async () => {
    const res = await ctx('newOwner')
    expect(res.status).toBe(200)
    expect(res.body.stores).toEqual([])
    expect(res.body.onboardingRequired).toBe(true)
  })

  test('a non-salon tenant is refused with the contract error body', async () => {
    const res = await ctx('fnb')
    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ code: 'FORBIDDEN' })
    expect(typeof res.body.message).toBe('string')
  })

  test('no session → 401', async () => {
    const res = await request(app).get('/salon/context')
    expect(res.status).toBe(401)
  })
})

describe('salon schema (B26)', () => {
  test('a second blocking booking of the same staff minutes is refused by the DB', async () => {
    const a = await makeAppointment()
    await db.salon_appointment_item.create(item(a, users.stylist.id, '10:00', '11:00'))
    await expect(db.salon_appointment_item.create(item(a, users.stylist.id, '10:30', '11:30'))).rejects.toMatchObject({
      parent: expect.objectContaining({ code: '23P01' })
    })
    // touching ranges, another staff, or a non-blocking status are fine
    await db.salon_appointment_item.create(item(a, users.stylist.id, '11:00', '12:00'))
    await db.salon_appointment_item.create(item(a, users.admin.id, '10:30', '11:30'))
    await db.salon_appointment_item.create(item(a, users.stylist.id, '10:15', '10:45', 'cancelled'))
  })

  test('50 parallel bookings of the same slot → exactly one succeeds', async () => {
    const a = await makeAppointment()
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => db.salon_appointment_item.create(item(a, users.owner.id, '14:00', '15:00')))
    )
    const ok = results.filter((r) => r.status === 'fulfilled')
    const refused = results.filter((r) => r.status === 'rejected')
    expect(ok).toHaveLength(1)
    expect(refused.every((r) => r.reason?.parent?.code === '23P01')).toBe(true)
  })

  test('statuses outside the state machine are refused (CHECK)', async () => {
    const a = await makeAppointment()
    await expect(db.salon_appointment_item.create(item(a, users.kasir.id, '16:00', '17:00', 'done'))).rejects.toMatchObject({
      parent: expect.objectContaining({ code: '23514' })
    })
  })

  test('commission ledger is immutable; a reversal is a new negative row', async () => {
    const base = { tenantId: salonTenant.id, store: store.id, orderId: order.id, lineKey: 's1', staffId: users.stylist.id, kind: 'service', name: 'Potong rambut' }
    const earned = await db.salon_staff_commission.create({ ...base, amount: 10000, status: 'earned' })
    await expect(db.salon_staff_commission.update({ amount: 1 }, { where: { id: earned.id } })).rejects.toThrow(/immutable/)
    await expect(db.salon_staff_commission.destroy({ where: { id: earned.id } })).rejects.toThrow(/immutable/)
    const reversal = await db.salon_staff_commission.create({ ...base, amount: -10000, status: 'reversed', reversesId: earned.id })
    expect(reversal.amount).toBe(-10000)
    // a second reversal of the same row, or a positive reversal, is refused
    await expect(db.salon_staff_commission.create({ ...base, amount: -10000, status: 'reversed', reversesId: earned.id })).rejects.toBeTruthy()
    await expect(db.salon_staff_commission.create({ ...base, amount: 5, status: 'reversed', reversesId: earned.id })).rejects.toBeTruthy()
  })

  test('order_item.staffId and the salon settings columns exist on the shared tables', async () => {
    const [cols] = await db.sequelize.query(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name, column_name) IN (('order_item','staffId'),('tenant','salonSettings'),('location','salonSettings'),('attendance','idempotencyKey'),('shift_swap','idempotencyKey'))`)
    expect(cols).toHaveLength(5)
    // the public location view never exposes the salon owner-PIN hash
    const loc = await db.location.findByPk(store.id)
    await loc.update({ salonSettings: { openTime: '10:00', closeTime: '21:00', ownerPinHash: 'x' } })
    await loc.reload()
    expect(loc.salonSettings).toEqual({ openTime: '10:00', closeTime: '21:00', hasOwnerPin: true })
    expect(loc.getDataValue('salonSettings').ownerPinHash).toBe('x')
  })
})
