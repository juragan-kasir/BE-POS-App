process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const { Op } = require('sequelize')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const PASSWORD = 'Rahasia123!'
const SENSITIVE = ['password', 'resetToken', 'resetTokenExpires', 'confirmPassword']

// P0-2 regression: /employee/add-employee and /employee/edit-employee let any
// admin hand out a super_admin role by roleId, fell back to `store: null`
// (a global account) when the store was omitted, left a same-store
// super_admin editable (password included), and trusted the destination
// store in multipart / `data`-wrapped bodies that validateStoreAccess never
// sees (it runs before multer and before validate() unwraps `data`).
//
// Every denial below is asserted at the database, not only by status code.

const PREFIX = `p02_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
let seq = 0
const unique = (key) => `${PREFIX}_${key}_${++seq}`.toLowerCase()
const sign = (claims) => signSessionToken(claims, JWT_SECRET)
const bearer = (token) => ({ Authorization: `Bearer ${token}` })

let storeA = null
let storeB = null
let roleSuper = null
let roleUser = null
const actors = {}
const createdUserIds = []

const makeUser = async (key, attrs) => {
  const name = unique(key)
  const row = await db.user.create({
    userName: name,
    email: `${name}@test.com`,
    password: PASSWORD,
    fullName: name,
    userType: 'user',
    status: 'active',
    ...attrs
  })
  createdUserIds.push(row.id)
  return row
}

beforeAll(async () => {
  storeA = await db.location.create(await withTestTenant({ name: unique('STORE_A'), status: 'active' }))
  // storeB is a FOREIGN business: its own tenant. A tenant admin may place
  // staff at any outlet of its own tenant (employee.js employeeWriteStore).
  const foreignTenant = await db.tenant.create({ code: unique('TENANT_B'), name: unique('TENANT_B') })
  storeB = await db.location.create({ name: unique('STORE_B'), status: 'active', tenantId: foreignTenant.id })
  roleSuper = await db.role.create({ name: unique('ROLE_SUPER'), roleType: 'super_admin', store: null })
  roleUser = await db.role.create({ name: unique('ROLE_USER'), roleType: 'user', store: storeA.id })

  // add-employee always writes userType 'user', so a real admin row is
  // reachable through edit-employee (self-edit included).
  actors.adminA = await makeUser('adminA', { roleType: 'admin', store: storeA.id })
  actors.superGlobal = await makeUser('superGlobal', { roleType: 'super_admin', userType: 'admin', store: null })
  actors.superBoundA = await makeUser('superBoundA', { roleType: 'super_admin', userType: 'admin', store: storeA.id })
})

afterAll(async () => {
  const rows = await db.user.findAll({
    where: { [Op.or]: [{ id: createdUserIds }, { userName: { [Op.like]: `${PREFIX}%` } }] },
    attributes: ['id'],
    paranoid: false
  })
  const ids = rows.map((r) => r.id)
  await db.notification.destroy({
    where: { referenceType: 'employee', referenceId: ids },
    force: true
  })
  await db.user.destroy({ where: { id: ids }, force: true })
  await db.role.destroy({ where: { id: [roleSuper?.id, roleUser?.id].filter(Boolean) }, force: true })
  await db.location.destroy({ where: { id: [storeA?.id, storeB?.id].filter(Boolean) }, force: true })
})

const tokens = async () => ({
  adminA: await sign({ id: actors.adminA.id, roleType: 'admin', store: storeA.id }),
  superGlobal: await sign({ id: actors.superGlobal.id, roleType: 'super_admin', store: null }),
  superBoundA: await sign({ id: actors.superBoundA.id, roleType: 'super_admin', store: storeA.id })
})

// ---- request shapes -------------------------------------------------------

const newEmployee = (extra = {}) => {
  const name = unique('emp')
  return {
    userName: name,
    email: `${name}@test.com`,
    password: PASSWORD,
    confirmPassword: PASSWORD,
    fullName: name,
    shift: '',
    ...extra
  }
}

// multipart can only carry strings; `undefined` fields are simply not sent
const asMultipart = (req, fields) => {
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) req = req.field(key, String(value))
  }
  return req
}

const SHAPES = {
  json: (req, body) => req.send(body),
  multipart: (req, body) => asMultipart(req, body),
  wrapped: (req, body) => req.send({ data: JSON.stringify(body) })
}

const add = (shape, token, body) =>
  SHAPES[shape](request(app).post('/employee/add-employee').set(bearer(token)), body)

const edit = (shape, token, body) =>
  SHAPES[shape](request(app).put('/employee/edit-employee').set(bearer(token)), body)

// ---- database probes ------------------------------------------------------

const findCreated = (userName) =>
  db.user.findOne({ where: { userName }, paranoid: false })

const expectNotCreated = async (userName) => {
  expect(await db.user.count({ where: { userName }, paranoid: false })).toBe(0)
}

const snapshot = async (id) => {
  const row = await db.user.scope('withCredentials').findByPk(id, { paranoid: false })
  const { roleType, roleId, store, fullName, password, userType, status } = row.get({ plain: true })
  return { roleType, roleId, store, fullName, password, userType, status }
}

const expectNoSecrets = (value) => {
  const text = JSON.stringify(value)
  for (const field of SENSITIVE) expect(text).not.toContain(`"${field}"`)
}

// ---------------------------------------------------------------------------

describe('P0-2 admin cannot grant super_admin on add-employee', () => {
  test.each([
    ['own store', 'json', () => ({ store: storeA.id })],
    ['omitted store', 'json', () => ({})],
    ['null store', 'json', () => ({ store: null })],
    ['"0" store', 'json', () => ({ store: '0' })],
    ['own store, multipart', 'multipart', () => ({ store: storeA.id })],
    ['omitted store, multipart', 'multipart', () => ({})],
    ['own store, data wrapper', 'wrapped', () => ({ store: storeA.id })],
    ['omitted store, data wrapper', 'wrapped', () => ({})]
  ])('%s → 403, no account created', async (_label, shape, extra) => {
    const body = newEmployee({ roleId: roleSuper.id, ...extra() })
    const res = await add(shape, (await tokens()).adminA, body)

    expect(res.status).toBe(403)
    await expectNotCreated(body.userName)
  })

  test('unknown roleId → 400, no silent fallback, no account created', async () => {
    const body = newEmployee({ roleId: 2147480000, store: storeA.id })
    const res = await add('json', (await tokens()).adminA, body)

    expect(res.status).toBe(400)
    await expectNotCreated(body.userName)
  })
})

describe('P0-2 admin cannot promote to super_admin on edit-employee', () => {
  test.each(['json', 'multipart', 'wrapped'])('self-promotion (%s) → 403, row unchanged', async (shape) => {
    const before = await snapshot(actors.adminA.id)
    const res = await edit(shape, (await tokens()).adminA, { id: actors.adminA.id, roleId: roleSuper.id })

    expect(res.status).toBe(403)
    expect(await snapshot(actors.adminA.id)).toEqual(before)
  })

  test.each(['json', 'multipart', 'wrapped'])('promoting another own-store employee (%s) → 403, row unchanged', async (shape) => {
    const target = await makeUser('promoteTarget', { roleType: 'user', store: storeA.id })
    const before = await snapshot(target.id)
    const res = await edit(shape, (await tokens()).adminA, { id: target.id, roleId: roleSuper.id })

    expect(res.status).toBe(403)
    expect(await snapshot(target.id)).toEqual(before)
  })

  test('unknown roleId → 400, row unchanged', async () => {
    const target = await makeUser('unknownRoleTarget', { roleType: 'user', store: storeA.id })
    const before = await snapshot(target.id)
    const res = await edit('json', (await tokens()).adminA, { id: target.id, roleId: 2147480000 })

    expect(res.status).toBe(400)
    expect(await snapshot(target.id)).toEqual(before)
  })
})

describe('P0-2 admin cannot edit an existing same-store super_admin', () => {
  let target = null
  beforeAll(async () => {
    target = await makeUser('superTargetA', { roleType: 'super_admin', roleId: null, store: storeA.id })
  })

  test.each([
    ['profile field', () => ({ fullName: 'HIJACKED' })],
    ['password', () => ({ password: 'Diambil123!', confirmPassword: 'Diambil123!' })],
    ['role (demotion)', () => ({ roleId: roleUser.id })]
  ])('%s change → 403, target unchanged', async (_label, extra) => {
    const before = await snapshot(target.id)
    const res = await edit('json', (await tokens()).adminA, { id: target.id, ...extra() })

    expect(res.status).toBe(403)
    expect(await snapshot(target.id)).toEqual(before)
  })

  test('the old password still logs in; the attacker-chosen one does not', async () => {
    await edit('json', (await tokens()).adminA, { id: target.id, password: 'Diambil123!', confirmPassword: 'Diambil123!' })

    const legit = await request(app).post('/auth/login').send({ userName: target.userName, password: PASSWORD })
    expect(legit.status).toBe(200)
    const hijack = await request(app).post('/auth/login').send({ userName: target.userName, password: 'Diambil123!' })
    expect(hijack.status).toBe(401)
  })
})

describe('P0-2 admin destination store is authorized after multer + validate', () => {
  test.each(['json', 'multipart', 'wrapped'])('add to a foreign store (%s) → 403, no account created', async (shape) => {
    const body = newEmployee({ roleId: roleUser.id, store: storeB.id })
    const res = await add(shape, (await tokens()).adminA, body)

    expect(res.status).toBe(403)
    await expectNotCreated(body.userName)
  })

  test.each(['json', 'multipart', 'wrapped'])('move an own-store employee to a foreign store (%s) → 403, row unchanged', async (shape) => {
    const target = await makeUser('moveTarget', { roleType: 'user', store: storeA.id })
    const before = await snapshot(target.id)
    const res = await edit(shape, (await tokens()).adminA, { id: target.id, store: storeB.id })

    expect(res.status).toBe(403)
    expect(await snapshot(target.id)).toEqual(before)
  })

  test('"0" store with a normal role is rejected by the single-store rule, no account created', async () => {
    const body = newEmployee({ roleId: roleUser.id, store: '0' })
    const res = await add('json', (await tokens()).adminA, body)

    expect(res.status).toBe(403)
    await expectNotCreated(body.userName)
  })
})

describe('P0-2 legitimate admin employee administration keeps working', () => {
  test.each([
    ['own store', 'json', () => ({ store: storeA.id })],
    ['omitted store', 'json', () => ({})],
    ['null store', 'json', () => ({ store: null })],
    ['own store, multipart', 'multipart', () => ({ store: storeA.id })],
    ['omitted store, data wrapper', 'wrapped', () => ({})]
  ])('add with %s → 200, persisted to the admin\'s own store', async (_label, shape, extra) => {
    const body = newEmployee({ roleId: roleUser.id, ...extra() })
    const res = await add(shape, (await tokens()).adminA, body)

    expect(res.status).toBe(200)
    expectNoSecrets(res.body)
    const row = await findCreated(body.userName)
    expect(row).not.toBeNull()
    expect(row.store).toBe(storeA.id)
    expect(row.roleType).toBe('user')
    expect(row.roleId).toBe(roleUser.id)
  })

  test.each([
    ['json', () => ({})],
    ['json', () => ({ store: storeA.id })],
    ['multipart', () => ({ store: storeA.id })]
  ])('edit an own-store employee (%s) → 200, stays in the own store', async (shape, extra) => {
    const target = await makeUser('legitEdit', { roleType: 'user', store: storeA.id })
    const res = await edit(shape, (await tokens()).adminA, { id: target.id, fullName: 'Renamed', roleId: roleUser.id, ...extra() })

    expect(res.status).toBe(200)
    expectNoSecrets(res.body)
    await target.reload()
    expect(target.fullName).toBe('Renamed')
    expect(target.store).toBe(storeA.id)
    expect(target.roleType).toBe('user')
  })
})

describe('P0-2 store-bound super_admin is held to its own store (fail closed)', () => {
  test('cannot grant super_admin → 403, no account created', async () => {
    const body = newEmployee({ roleId: roleSuper.id })
    const res = await add('json', (await tokens()).superBoundA, body)

    expect(res.status).toBe(403)
    await expectNotCreated(body.userName)
  })

  test('cannot add to a foreign store (multipart) → 403, no account created', async () => {
    const body = newEmployee({ roleId: roleUser.id, store: storeB.id })
    const res = await add('multipart', (await tokens()).superBoundA, body)

    expect(res.status).toBe(403)
    await expectNotCreated(body.userName)
  })

  test('omitted store persists to its own store, never global', async () => {
    const body = newEmployee({ roleId: roleUser.id })
    const res = await add('json', (await tokens()).superBoundA, body)

    expect(res.status).toBe(200)
    const row = await findCreated(body.userName)
    expect(row.store).toBe(storeA.id)
  })

  test('cannot edit an employee of another store → 404, row unchanged', async () => {
    const target = await makeUser('foreignForBound', { roleType: 'user', store: storeB.id })
    const before = await snapshot(target.id)
    const res = await edit('json', (await tokens()).superBoundA, { id: target.id, fullName: 'HIJACKED' })

    expect(res.status).toBe(404)
    expect(await snapshot(target.id)).toEqual(before)
  })

  test('cannot promote an own-store employee to super_admin → 403, row unchanged', async () => {
    const target = await makeUser('boundPromote', { roleType: 'user', store: storeA.id })
    const before = await snapshot(target.id)
    const res = await edit('json', (await tokens()).superBoundA, { id: target.id, roleId: roleSuper.id })

    expect(res.status).toBe(403)
    expect(await snapshot(target.id)).toEqual(before)
  })
})

describe('P0-2 global super_admin keeps platform employee administration', () => {
  test('creates a normal employee in another store', async () => {
    const body = newEmployee({ roleId: roleUser.id, store: storeB.id })
    const res = await add('json', (await tokens()).superGlobal, body)

    expect(res.status).toBe(200)
    const row = await findCreated(body.userName)
    expect(row.store).toBe(storeB.id)
  })

  test('creates a global super_admin (store omitted)', async () => {
    const body = newEmployee({ roleId: roleSuper.id })
    const res = await add('json', (await tokens()).superGlobal, body)

    expect(res.status).toBe(200)
    const row = await findCreated(body.userName)
    expect(row.roleType).toBe('super_admin')
    expect(row.store).toBeNull()
  })

  test('edits an employee in another store, including role and store', async () => {
    const target = await makeUser('globalEdit', { roleType: 'user', store: storeB.id })
    const res = await edit('multipart', (await tokens()).superGlobal, {
      id: target.id,
      fullName: 'Moved',
      roleId: roleSuper.id,
      store: storeA.id
    })

    expect(res.status).toBe(200)
    await target.reload()
    expect(target.fullName).toBe('Moved')
    expect(target.roleType).toBe('super_admin')
    expect(target.store).toBe(storeA.id)
  })

  test('edits an existing super_admin', async () => {
    const target = await makeUser('globalEditsSuper', { roleType: 'super_admin', store: storeA.id })
    const res = await edit('json', (await tokens()).superGlobal, { id: target.id, fullName: 'Edited' })

    expect(res.status).toBe(200)
    await target.reload()
    expect(target.fullName).toBe('Edited')
  })
})

describe('P0-2 change-profile-user roleId grant stays blocked', () => {
  test('admin granting the super_admin role by roleId → 403, row unchanged', async () => {
    const target = await makeUser('profileTarget', { roleType: 'user', store: storeA.id })
    const before = await snapshot(target.id)
    const res = await request(app)
      .put('/auth/change-profile-user')
      .set(bearer((await tokens()).adminA))
      .send({ id: target.id, roleId: roleSuper.id, store: storeA.id })

    expect(res.status).toBe(403)
    expect(await snapshot(target.id)).toEqual(before)
  })
})

describe('P0-2 invariant across the whole suite', () => {
  test('no account created by a store-confined actor is global or foreign', async () => {
    const leaked = await db.user.findAll({
      where: {
        createdBy: [actors.adminA.id, actors.superBoundA.id],
        [Op.or]: [{ store: null }, { store: { [Op.ne]: storeA.id } }, { roleType: 'super_admin' }]
      },
      attributes: ['id', 'userName', 'store', 'roleType'],
      paranoid: false
    })
    expect(leaked.map((r) => r.get({ plain: true }))).toEqual([])
  })
})
