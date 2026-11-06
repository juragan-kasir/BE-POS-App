'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// Harness recheck 2026-11-06: under zod 4, `X.partial()` keeps every
// `.default()` of X, so an edit that omitted a field was parsed WITH the
// default and written. Deactivating a cashier with `{ id, status }` blanked
// its fullName, phone, gender, address and birthplace and reset userType to
// 'user'; 24 other update schemas injected values the same way.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const schemas = require('../api/validation/schemas')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const uniq = (k) =>
  `pud_${k}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`

// Not a partial edit: closing a register with no note records an empty note.
const ALLOWED_DEFAULTS = new Set(['updateCashRegisterSchema'])

describe('update schemas never invent values for omitted fields', () => {
  const updateSchemas = Object.entries(schemas).filter(
    ([name, s]) =>
      /^(update|edit)/i.test(name) && s && typeof s.safeParse === 'function'
  )

  test('there are update schemas to check', () => {
    expect(updateSchemas.length).toBeGreaterThan(30)
  })

  test.each(updateSchemas.map(([name]) => name))('%s', (name) => {
    const s = schemas[name]
    const attempts = [{}, { id: 1 }]
    const parsed = attempts
      .map((body) => [body, s.safeParse(body)])
      .find(([, r]) => r.success)
    if (!parsed) return // needs more than an id to parse at all; nothing to compare
    const [body, r] = parsed
    const invented = Object.entries(r.data)
      .filter(([k, v]) => v !== undefined && !(k in body))
      .map(([k]) => k)
    if (ALLOWED_DEFAULTS.has(name)) return
    expect(invented).toEqual([])
  })

  test('a partial user edit keeps only what was sent', () => {
    const r = schemas.updateUserSchema.safeParse({ id: 5, status: 'inactive' })
    expect(r.success).toBe(true)
    const sent = Object.fromEntries(
      Object.entries(r.data).filter(([, v]) => v !== undefined)
    )
    expect(sent).toEqual({ id: 5, status: 'inactive' })
  })

  test('partialUpdate keeps passthrough on the base schema', () => {
    const r = schemas.updateLocationSchema.safeParse({
      locationId: 'loc-1',
      coordinates: [1, 2]
    })
    expect(r.success).toBe(true)
    expect(r.data.coordinates).toEqual([1, 2])
    expect(r.data.mainBranch).toBeUndefined()
  })
})

describe('PUT /employee/edit-employee with a partial body', () => {
  const ids = { stores: [], users: [] }
  let adminToken
  let kasir

  beforeAll(async () => {
    const store = await db.location.create({
      name: uniq('S'),
      status: 'active'
    })
    ids.stores.push(store.id)
    const admin = await db.user.create({
      userName: uniq('admin'),
      email: `${uniq('admin')}@test.com`,
      roleType: 'admin',
      userType: 'admin',
      status: 'active',
      store: store.id
    })
    kasir = await db.user.create({
      userName: uniq('kasir'),
      email: `${uniq('kasir')}@test.com`,
      roleType: 'kasir',
      userType: 'user',
      status: 'active',
      store: store.id,
      fullName: 'Kasir Satu Toko',
      phoneNumber: '081234567890',
      address: 'Jl. Kaliurang 5'
    })
    ids.users.push(admin.id, kasir.id)
    adminToken = await signSessionToken(
      {
        id: admin.id,
        userName: admin.userName,
        roleType: 'admin',
        store: store.id
      },
      JWT_SECRET
    )
  })

  afterAll(async () => {
    await db.authorizationContextSession.destroy({
      where: { userId: ids.users }
    })
    await db.user.destroy({ where: { id: ids.users }, force: true })
    await db.location.destroy({ where: { id: ids.stores }, force: true })
  })

  test('deactivating a cashier keeps its name, phone and address', async () => {
    const res = await request(app)
      .put('/employee/edit-employee')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ id: kasir.id, status: 'inactive' })
    expect(res.status).toBeLessThan(300)
    const row = await db.user.findByPk(kasir.id)
    expect(row.status).toBe('inactive')
    expect(row.fullName).toBe('Kasir Satu Toko')
    expect(row.phoneNumber).toBe('081234567890')
    expect(row.address).toBe('Jl. Kaliurang 5')
    expect(row.userType).toBe('user')
  })
})
