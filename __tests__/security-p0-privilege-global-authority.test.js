process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const fs = require('fs')
const os = require('os')
const path = require('path')

// Isolate backup file dir before app loads (same pattern as crit3 test).
if (!process.env.BACKUP_DIR) {
  process.env.BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-backups-'))
}

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const BACKUP_DIR = process.env.BACKUP_DIR

const PREFIX = `p0_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
let seq = 0
const unique = (key) => `${PREFIX}_${key}_${++seq}`.toLowerCase()
const sign = (claims) => signSessionToken(claims, JWT_SECRET)
const bearer = (token) => ({ Authorization: `Bearer ${token}` })

let storeA = null
let storeB = null
let roleSuper = null
let roleUser = null
let roleAdmin = null
const actors = {}
const createdUserIds = []
const createdRoleIds = []
const createdBackupIds = []

const makeUser = async (key, attrs) => {
  const name = unique(key)
  const row = await db.user.create({
    userName: name,
    email: `${name}@test.com`,
    password: 'Rahasia123!',
    fullName: name,
    userType: 'user',
    status: 'active',
    ...attrs
  })
  createdUserIds.push(row.id)
  return row
}

const snapshotUser = async (id) => {
  const row = await db.user.scope('withCredentials').findByPk(id, { paranoid: false })
  const { roleType, roleId, store, fullName, userType, status } = row.get({ plain: true })
  return { roleType, roleId, store, fullName, userType, status }
}

beforeAll(async () => {
  storeA = await db.location.create(await withTestTenant({ name: unique('STORE_A'), status: 'active' }))
  storeB = await db.location.create(await withTestTenant({ name: unique('STORE_B'), status: 'active' }))
  roleSuper = await db.role.create({ name: unique('ROLE_SUPER'), roleType: 'super_admin', store: null })
  roleUser = await db.role.create({ name: unique('ROLE_USER'), roleType: 'user', store: storeA.id })
  roleAdmin = await db.role.create({ name: unique('ROLE_ADMIN'), roleType: 'admin', store: storeA.id })
  createdRoleIds.push(roleSuper.id, roleUser.id, roleAdmin.id)

  actors.adminA = await makeUser('adminA', { roleType: 'admin', store: storeA.id })
  actors.superGlobal = await makeUser('superGlobal', { roleType: 'super_admin', userType: 'admin', store: null })
  actors.superBoundA = await makeUser('superBoundA', { roleType: 'super_admin', userType: 'admin', store: storeA.id })
  actors.superTargetA = await makeUser('superTargetA', { roleType: 'super_admin', roleId: null, store: storeA.id })
})

afterAll(async () => {
  const rows = await db.user.findAll({
    where: { id: createdUserIds },
    attributes: ['id'],
    paranoid: false
  })
  const ids = rows.map((r) => r.id)
  if (ids.length) {
    await db.notification.destroy({ where: { referenceType: 'employee', referenceId: ids }, force: true }).catch(() => {})
    await db.user.destroy({ where: { id: ids }, force: true }).catch(() => {})
  }
  if (createdRoleIds.length) {
    await db.role.destroy({ where: { id: createdRoleIds }, force: true }).catch(() => {})
  }
  if (createdBackupIds.length) {
    await db.db_backup.destroy({ where: { id: createdBackupIds }, force: true }).catch(() => {})
  }
  await db.location.destroy({ where: { id: [storeA?.id, storeB?.id].filter(Boolean) }, force: true }).catch(() => {})
  try {
    fs.rmSync(BACKUP_DIR, { recursive: true, force: true })
  } catch {}
})

const tokens = async () => ({
  adminA: await sign({ id: actors.adminA.id, roleType: 'admin', store: storeA.id }),
  superGlobal: await sign({ id: actors.superGlobal.id, roleType: 'super_admin', store: null }),
  superBoundA: await sign({ id: actors.superBoundA.id, roleType: 'super_admin', store: storeA.id })
})

// ---- P0-A: change-profile-user ----
describe('P0-A change-profile-user global gate', () => {
  test('store-bound super_admin cannot grant super_admin via roleType → 403, unchanged', async () => {
    const target = await makeUser('p0aTarget1', { roleType: 'user', store: storeA.id })
    const before = await snapshotUser(target.id)
    const res = await request(app)
      .put('/auth/change-profile-user')
      .set(bearer((await tokens()).superBoundA))
      .send({ id: target.id, roleType: 'super_admin', store: storeA.id })
    expect(res.status).toBe(403)
    expect(await snapshotUser(target.id)).toEqual(before)
  })

  test('store-bound super_admin cannot grant super_admin via roleId → 403, unchanged', async () => {
    const target = await makeUser('p0aTarget2', { roleType: 'user', store: storeA.id })
    const before = await snapshotUser(target.id)
    const res = await request(app)
      .put('/auth/change-profile-user')
      .set(bearer((await tokens()).superBoundA))
      .send({ id: target.id, roleId: roleSuper.id, store: storeA.id })
    expect(res.status).toBe(403)
    expect(await snapshotUser(target.id)).toEqual(before)
  })

  test('store-bound super_admin cannot edit existing super_admin → 403, unchanged', async () => {
    const before = await snapshotUser(actors.superTargetA.id)
    const res = await request(app)
      .put('/auth/change-profile-user')
      .set(bearer((await tokens()).superBoundA))
      .send({ id: actors.superTargetA.id, fullName: 'HIJACKED' })
    expect(res.status).toBe(403)
    expect(await snapshotUser(actors.superTargetA.id)).toEqual(before)
  })

  test('store-bound super_admin cannot move user cross-store → 403, unchanged', async () => {
    const target = await makeUser('p0aTarget3', { roleType: 'user', store: storeA.id })
    const before = await snapshotUser(target.id)
    const res = await request(app)
      .put('/auth/change-profile-user')
      .set(bearer((await tokens()).superBoundA))
      .send({ id: target.id, store: storeB.id })
    expect(res.status).toBe(403)
    expect(await snapshotUser(target.id)).toEqual(before)
  })

  test('unknown roleId → 400, no mutation', async () => {
    const target = await makeUser('p0aTarget4', { roleType: 'user', store: storeA.id })
    const before = await snapshotUser(target.id)
    const res = await request(app)
      .put('/auth/change-profile-user')
      .set(bearer((await tokens()).superBoundA))
      .send({ id: target.id, roleId: 2147480000 })
    expect(res.status).toBe(400)
    expect(await snapshotUser(target.id)).toEqual(before)
  })

  test('global super_admin can still grant super_admin → 200', async () => {
    const target = await makeUser('p0aTarget5', { roleType: 'user', store: storeB.id })
    const res = await request(app)
      .put('/auth/change-profile-user')
      .set(bearer((await tokens()).superGlobal))
      .send({ id: target.id, roleId: roleSuper.id, store: storeB.id })
    expect(res.status).toBe(200)
    await target.reload()
    expect(target.roleType).toBe('super_admin')
  })
})

// ---- P0-B: role management ----
describe('P0-B role management global gate', () => {
  test('store-bound super_admin cannot create super_admin role → 403, no row', async () => {
    const name = unique('norole')
    const res = await request(app)
      .post('/role/add-new-role')
      .set(bearer((await tokens()).superBoundA))
      .send({ name, roleType: 'super_admin', store: null })
    expect(res.status).toBe(403)
    expect(await db.role.count({ where: { name } })).toBe(0)
  })

  test('store-bound super_admin cannot edit role into super_admin → 403, unchanged', async () => {
    const role = await db.role.create({ name: unique('editme'), roleType: 'user', store: storeA.id })
    createdRoleIds.push(role.id)
    const before = role.get({ plain: true }).roleType
    const res = await request(app)
      .put(`/role/edit-role/${role.id}`)
      .set(bearer((await tokens()).superBoundA))
      .send({ name: role.name, roleType: 'super_admin' })
    expect(res.status).toBe(403)
    await role.reload()
    expect(role.roleType).toBe(before)
  })

  test('store-bound super_admin cannot assign super_admin via update-user-role → 403, unchanged', async () => {
    const target = await makeUser('p0bTarget1', { roleType: 'user', store: storeA.id })
    const before = await snapshotUser(target.id)
    const res = await request(app)
      .put('/role/update-user-role')
      .set(bearer((await tokens()).superBoundA))
      .send({ userId: target.id, roleId: roleSuper.id })
    expect(res.status).toBe(403)
    expect(await snapshotUser(target.id)).toEqual(before)
  })

  test('update-user-role unknown roleId → 400/404, no mutation', async () => {
    const target = await makeUser('p0bTarget2', { roleType: 'user', store: storeA.id })
    const before = await snapshotUser(target.id)
    const res = await request(app)
      .put('/role/update-user-role')
      .set(bearer((await tokens()).superBoundA))
      .send({ userId: target.id, roleId: 2147480000 })
    expect([400, 404]).toContain(res.status)
    expect(await snapshotUser(target.id)).toEqual(before)
  })

  test('global super_admin can still create and assign super_admin role → 200', async () => {
    const name = unique('globalrole')
    const res = await request(app)
      .post('/role/add-new-role')
      .set(bearer((await tokens()).superGlobal))
      .send({ name, roleType: 'super_admin', store: null })
    expect(res.status).toBe(200)
    const row = await db.role.findOne({ where: { name } })
    expect(row).not.toBeNull()
    expect(row.roleType).toBe('super_admin')
    createdRoleIds.push(row.id)
  })
})

// ---- P0-C: backup global gate ----
describe('P0-C backup platform-global gate', () => {
  test('store-bound super_admin cannot list backups → 403', async () => {
    const res = await request(app)
      .get('/backup/list')
      .set(bearer((await tokens()).superBoundA))
    expect(res.status).toBe(403)
  })

  test('store-bound super_admin cannot create backup → 403, no row created', async () => {
    const before = await db.db_backup.count()
    const res = await request(app)
      .post('/backup/create')
      .set(bearer((await tokens()).superBoundA))
      .send({})
    expect(res.status).toBe(403)
    expect(await db.db_backup.count()).toBe(before)
  })

  test('store-bound super_admin cannot download/restore/delete → 403, restore never executes', async () => {
    const filepath = path.join(BACKUP_DIR, `${unique('f')}.dump`)
    fs.writeFileSync(filepath, 'DUMMY')
    const rec = await db.db_backup.create({
      filename: path.basename(filepath),
      filepath,
      size: 5,
      format: 'custom',
      status: 'success',
      store: storeA.id
    })
    createdBackupIds.push(rec.id)
    const mtimeBefore = fs.statSync(filepath).mtimeMs

    const dl = await request(app).get(`/backup/download/${rec.id}`).set(bearer((await tokens()).superBoundA))
    expect(dl.status).toBe(403)

    const rs = await request(app).post(`/backup/restore/${rec.id}`).set(bearer((await tokens()).superBoundA))
    expect(rs.status).toBe(403)
    // restore must not touch the artifact or DB state
    expect(fs.statSync(filepath).mtimeMs).toBe(mtimeBefore)

    const del = await request(app).delete(`/backup/delete/${rec.id}`).set(bearer((await tokens()).superBoundA))
    expect(del.status).toBe(403)
    expect(await db.db_backup.findByPk(rec.id)).not.toBeNull()
  })

  test('global super_admin retains backup list access → 200', async () => {
    const res = await request(app)
      .get('/backup/list')
      .set(bearer((await tokens()).superGlobal))
    expect(res.status).toBe(200)
  })
})
