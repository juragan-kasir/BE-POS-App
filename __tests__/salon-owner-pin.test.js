process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const bcrypt = require('bcrypt')
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { MAX_FAILURES } = require('../api/service/salonOwnerPin')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Salon owner PIN (BR-SLN-015): the owner sets / removes the per-outlet PIN a
// kasir types to get a refund approved; wrong PINs are counted and lock the
// outlet's PIN for a while. The refund route checks the PIN before it looks the
// order up, so an unknown order id shows whether the PIN passed (404) or not.

const TZ = 'Asia/Jakarta'
const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
const users = {}
const tokens = {}
const tenants = {}
const stores = {}
const createdUserIds = []
const MISSING_ORDER = 2147480000

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
const makeUser = async (key, roleType, storeId) => {
  users[key] = await db.user.create({
    userName: `spin_${key}_${stamp}`,
    fullName: `Salon ${key}`,
    email: `spin_${key}_${stamp}@test.com`,
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
const pinPath = (store = stores.a) => `/salon/stores/${store.id}/owner-pin`
const refundWith = (ownerPin) =>
  call('kasir', 'post', `/salon/orders/${MISSING_ORDER}/refund?store=${stores.a.id}`, { reason: 'Pelanggan komplain', ownerPin })
const raw = async (store = stores.a) => (await db.location.findByPk(store.id)).getDataValue('salonSettings')

beforeAll(async () => {
  tenants.salon = await db.tenant.create({ code: `spin-${stamp}`, name: 'Salon PIN', businessType: 'salon' })
  tenants.other = await db.tenant.create({ code: `spin-o-${stamp}`, name: 'Salon Lain', businessType: 'salon' })
  stores.a = await makeLocation(tenants.salon.id, 'SPIN_A')
  stores.other = await makeLocation(tenants.other.id, 'SPIN_O')
  await makeUser('owner', 'super_admin', stores.a.id)
  await makeUser('admin', 'admin', stores.a.id)
  await makeUser('kasir', 'kasir', stores.a.id)
  await makeUser('otherOwner', 'super_admin', stores.other.id)
})

afterAll(async () => {
  const tenantIds = Object.values(tenants).map((t) => t.id)
  await db.user.destroy({ where: { id: createdUserIds }, force: true })
  await db.location.destroy({ where: { tenantId: tenantIds }, force: true })
  await db.tenant.destroy({ where: { id: tenantIds }, force: true })
  await db.sequelize.close()
})

describe('set and remove the owner PIN', () => {
  test('without a PIN a kasir refund is OWNER_PIN_NOT_SET and the outlet says hasOwnerPin false', async () => {
    const ctx = await call('owner', 'get', '/salon/context')
    expect(ctx.status).toBe(200)
    expect(ctx.body.stores.find((s) => s.id === String(stores.a.id))).toMatchObject({ hasOwnerPin: false })
    const res = await refundWith('2580')
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('OWNER_PIN_NOT_SET')
  })

  test('only the owner sets it; admin and kasir get 403, another tenant 404', async () => {
    for (const who of ['admin', 'kasir']) {
      const res = await call(who, 'put', pinPath(), { pin: '2580' })
      expect(res.status).toBe(403)
      expect(res.body.code).toBe('FORBIDDEN')
    }
    const foreign = await call('otherOwner', 'put', pinPath(), { pin: '2580' })
    expect(foreign.status).toBe(404)
    expect(await raw()).not.toHaveProperty('ownerPinHash')
  })

  test.each(['123', '1234567', '12a4', '1111', '000000', '1234', '987654'])('refuses PIN %s', async (pin) => {
    const res = await call('owner', 'put', pinPath(), { pin })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('VALIDATION_FAILED')
  })

  test('the owner sets a PIN: stored as a bcrypt hash, the API shows only hasOwnerPin', async () => {
    const res = await call('owner', 'put', pinPath(), { pin: '2580' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: String(stores.a.id), hasOwnerPin: true })
    expect(JSON.stringify(res.body)).not.toMatch(/2580|ownerPinHash|\$2[aby]\$/)
    const settings = await raw()
    expect(await bcrypt.compare('2580', settings.ownerPinHash)).toBe(true)
    expect(settings).toMatchObject({ openTime: '09:00', closeTime: '21:00', ownerPinFailures: 0 })
    const ctx = await call('kasir', 'get', '/salon/context')
    expect(ctx.body.stores.find((s) => s.id === String(stores.a.id))).toMatchObject({ hasOwnerPin: true })
  })

  test('editing the outlet keeps the PIN', async () => {
    const res = await call('owner', 'patch', `/salon/stores/${stores.a.id}`, {
      name: `SPIN_A2_${stamp}`,
      address: 'Jl. Melati 1',
      phone: '',
      timezone: TZ,
      openTime: '10:00',
      closeTime: '20:00',
      active: true
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ openTime: '10:00', hasOwnerPin: true })
    expect(await bcrypt.compare('2580', (await raw()).ownerPinHash)).toBe(true)
  })
})

describe('kasir refund with the PIN', () => {
  test('the right PIN passes (the unknown order is then 404); a wrong one is 403 with attempts left', async () => {
    const ok = await refundWith('2580')
    expect(ok.status).toBe(404)
    const wrong = await refundWith('9999')
    expect(wrong.status).toBe(403)
    expect(wrong.body).toMatchObject({ code: 'OWNER_PIN_INVALID', details: { attemptsLeft: MAX_FAILURES - 1 } })
    // A right PIN resets the count.
    expect((await refundWith('2580')).status).toBe(404)
    expect((await raw()).ownerPinFailures).toBe(0)
  })

  test('no PIN typed asks for it without spending an attempt', async () => {
    const res = await refundWith(null)
    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ code: 'OWNER_PIN_INVALID', details: { attemptsLeft: MAX_FAILURES } })
    expect((await raw()).ownerPinFailures).toBe(0)
  })

  test(`${MAX_FAILURES} wrong PINs in parallel are all counted and lock the PIN, even the right one`, async () => {
    const results = await Promise.all(Array.from({ length: MAX_FAILURES }, () => refundWith('9999')))
    const statuses = results.map((r) => r.status).sort()
    expect(statuses).toEqual([...Array(MAX_FAILURES - 1).fill(403), 429])
    const locked = results.find((r) => r.status === 429)
    expect(locked.body.code).toBe('OWNER_PIN_LOCKED')
    expect(locked.body.details.retryAfterSec).toBeGreaterThan(0)

    const right = await refundWith('2580')
    expect(right.status).toBe(429)
    expect(right.body.code).toBe('OWNER_PIN_LOCKED')
    // The counters never leave the API.
    const loc = await db.location.findByPk(stores.a.id)
    expect(loc.salonSettings).not.toHaveProperty('ownerPinLockedUntil')
    expect(loc.salonSettings).not.toHaveProperty('ownerPinFailures')
  })

  test('the lock expires', async () => {
    const settings = await raw()
    await db.location.update(
      { salonSettings: { ...settings, ownerPinLockedUntil: new Date(Date.now() - 1000).toISOString() } },
      { where: { id: stores.a.id } }
    )
    const wrong = await refundWith('9999')
    expect(wrong.body).toMatchObject({ code: 'OWNER_PIN_INVALID', details: { attemptsLeft: MAX_FAILURES - 1 } })
    expect((await refundWith('2580')).status).toBe(404)
  })

  test('a new PIN from the owner lifts a lock and replaces the old PIN', async () => {
    await Promise.all(Array.from({ length: MAX_FAILURES }, () => refundWith('9999')))
    expect((await refundWith('2580')).status).toBe(429)
    const res = await call('owner', 'put', pinPath(), { pin: '7391' })
    expect(res.status).toBe(200)
    expect((await refundWith('2580')).body.code).toBe('OWNER_PIN_INVALID')
    expect((await refundWith('7391')).status).toBe(404)
  })

  test('the owner refunds without a PIN (pos.refund)', async () => {
    const res = await call('owner', 'post', `/salon/orders/${MISSING_ORDER}/refund?store=${stores.a.id}`, { reason: 'Pelanggan komplain', ownerPin: null })
    expect(res.status).toBe(404)
  })

  test('removing the PIN: only the owner; then a kasir refund is OWNER_PIN_NOT_SET again', async () => {
    expect((await call('admin', 'delete', pinPath())).status).toBe(403)
    expect((await call('otherOwner', 'delete', pinPath())).status).toBe(404)
    const res = await call('owner', 'delete', pinPath())
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ hasOwnerPin: false })
    const settings = await raw()
    for (const k of ['ownerPinHash', 'ownerPinSetAt', 'ownerPinFailures', 'ownerPinLockedUntil']) expect(settings).not.toHaveProperty(k)
    expect(settings).toMatchObject({ openTime: '10:00', closeTime: '20:00' })
    expect((await refundWith('7391')).body.code).toBe('OWNER_PIN_NOT_SET')
  })
})
