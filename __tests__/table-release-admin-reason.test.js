process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// DR-24 C-16 (BA §35.11): releasing a table ("Set Available") is an elevated
// store action — owner/admin role + mandatory reason + audit row (D-03: no
// MFA or second approver in the MVP). This locks the release contract:
// cashiers may operate orders but never free a table by hand, and the reason
// is persisted on the audit record.

const SUFFIX = Date.now()
let store = null
let table = null
let kasirToken = null
let adminToken = null
let superToken = null

const release = (body, token, tableId = table.id) =>
  request(app)
    .put(`/table/update-status/${tableId}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body)

beforeAll(async () => {
  store = await db.location.create({ name: `C16_STORE_${SUFFIX}`, status: 'active' })
  table = await db.table.create({
    store: store.id,
    name: `C16_TABLE_${SUFFIX}`,
    status: 'occupied'
  })

  await db.user.create({
    id: 9811,
    userName: 'c16_kasir',
    email: 'c16-9811@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: store.id,
    status: 'active'
  })
  await db.user.create({
    id: 9812,
    userName: 'c16_admin',
    email: 'c16-9812@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  await db.user.create({
    id: 9813,
    userName: 'c16_super',
    email: 'c16-9813@test.com',
    roleType: 'super_admin',
    userType: 'admin',
    store: null,
    status: 'active'
  })

  kasirToken = await signSessionToken(
    { id: 9811, userName: 'c16_kasir', roleType: 'kasir', store: store.id },
    JWT_SECRET
  )
  adminToken = await signSessionToken(
    { id: 9812, userName: 'c16_admin', roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  superToken = await signSessionToken(
    { id: 9813, userName: 'c16_super', roleType: 'super_admin', store: null },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.auditLog.destroy({
    where: { entity: 'table', entityId: table?.id },
    force: true,
    __auditMaintenance: true
  })
  await db.table.destroy({ where: { id: table?.id }, force: true })
  await db.authorizationContextSession.destroy({
    where: { userId: [9811, 9812, 9813] },
    force: true
  })
  await db.user.destroy({ where: { id: [9811, 9812, 9813] }, force: true })
  await db.location.destroy({ where: { id: store?.id } })
})

describe('C-16 table release — admin-only, reason required, audited', () => {
  test('kasir cannot release a table by hand (403), row unchanged', async () => {
    const res = await release({ status: 'available', reason: 'coba lepas' }, kasirToken)
    expect(res.status).toBe(403)
    expect((await db.table.findByPk(table.id)).status).toBe('occupied')
  })

  test('admin without a reason is refused (400) and the table stays occupied', async () => {
    const res = await release({ status: 'available' }, adminToken)
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('RELEASE_REASON_REQUIRED')
    expect((await db.table.findByPk(table.id)).status).toBe('occupied')
  })

  test('a blank reason is refused too (400)', async () => {
    const res = await release({ status: 'available', reason: '   ' }, adminToken)
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('RELEASE_REASON_REQUIRED')
  })

  test('admin with a reason releases the table and the audit row carries the reason', async () => {
    const res = await release(
      { status: 'available', reason: 'Diner selesai, meja dibersihkan' },
      adminToken
    )
    expect(res.status).toBe(200)
    expect((await db.table.findByPk(table.id)).status).toBe('available')

    const row = await db.auditLog.findOne({
      where: { entity: 'table', entityId: table.id, action: 'update' },
      order: [['createdAt', 'DESC']]
    })
    expect(row).not.toBeNull()
    expect(row.userId).toBe(9812)
    expect(String(row.reason)).toContain('meja dibersihkan')
    expect(row.newValues.status).toBe('available')
    expect(row.oldValues.status).toBe('occupied')
  })

  test('super_admin may also release, with a reason (D-03)', async () => {
    await table.update({ status: 'occupied' })
    const res = await release(
      { store: store.id, status: 'available', reason: 'reset oleh vendor' },
      superToken
    )
    expect(res.status).toBe(200)
    expect((await db.table.findByPk(table.id)).status).toBe('available')
  })

  test('non-release status changes still work for admin without a reason', async () => {
    const res = await release({ status: 'maintenance' }, adminToken)
    expect(res.status).toBe(200)
    expect((await db.table.findByPk(table.id)).status).toBe('maintenance')
  })
})
