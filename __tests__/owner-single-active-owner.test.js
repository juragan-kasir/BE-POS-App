'use strict'

process.env.NODE_ENV = 'test'

// W2-c (BE audit P1-6, migration 20261118000001 / batch B18): the database
// refuses a second ACTIVE `owner` membership in a tenant, whatever writes it.
const db = require('../db/models')
const migration = require('../db/migrations/20261118000001-unique-active-owner-per-tenant')
const {
  createTenantWithOwner,
  assertOwnerConsistency,
  transferTenantOwnership
} = require('../api/service/tenantOwnershipService')

const uniq = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
const created = { users: [], tenants: [] }
const mkUser = async () => {
  const u = await db.user.create({ userName: `sao_${uniq()}`, email: `sao_${uniq()}@test.com`, status: 'active', roleType: 'user' })
  created.users.push(u.id)
  return u
}

afterAll(async () => {
  const owned = await db.tenant.findAll({ where: { ownerId: created.users }, attributes: ['id'], paranoid: false })
  const tenantIds = [...new Set([...created.tenants, ...owned.map((t) => t.id)])]
  await db.tenantMembership.destroy({ where: { tenantId: tenantIds }, force: true })
  await db.auditLog.destroy({ where: { entity: 'tenant', entityId: tenantIds }, force: true, __auditMaintenance: true })
  await db.tenant.destroy({ where: { id: tenantIds }, force: true })
  await db.user.destroy({ where: { id: created.users }, force: true })
  await db.sequelize.close()
})

test('the partial unique index exists in the test DB', async () => {
  const [rows] = await db.sequelize.query(`SELECT indexdef FROM pg_indexes WHERE indexname = :n`, {
    replacements: { n: migration.INDEX_NAME }
  })
  expect(rows).toHaveLength(1)
  expect(rows[0].indexdef).toMatch(/UNIQUE/)
  expect(rows[0].indexdef).toMatch(/owner/)
})

test('a second ACTIVE owner is refused; DEACTIVATED owners and other roles are not', async () => {
  const a = await mkUser()
  const b = await mkUser()
  const c = await mkUser()
  const d = await mkUser()
  const { tenant } = await createTenantWithOwner(db, { userId: a.id, code: `sao-${uniq()}`, name: 'Single owner', businessType: 'fnb' })

  await expect(
    db.tenantMembership.create({ userId: b.id, tenantId: tenant.id, role: 'owner', status: 'ACTIVE' })
  ).rejects.toThrow()
  // Raw SQL is refused too: the invariant lives in the database.
  await expect(
    db.sequelize.query(
      `INSERT INTO tenant_membership ("userId", "tenantId", role, status, "createdAt", "updatedAt")
       VALUES (:u, :t, 'owner', 'ACTIVE', NOW(), NOW())`,
      { replacements: { u: b.id, t: tenant.id } }
    )
  ).rejects.toThrow()

  await db.tenantMembership.create({ userId: c.id, tenantId: tenant.id, role: 'owner', status: 'DEACTIVATED' })
  await db.tenantMembership.create({ userId: d.id, tenantId: tenant.id, role: 'tenant_admin', status: 'ACTIVE' })
  // tenant_admin is the legacy owner alias: assertOwnerConsistency counts it,
  // so this tenant is (correctly) reported inconsistent until the backfill.
  await expect(assertOwnerConsistency(db, tenant.id)).rejects.toMatchObject({ code: 'OWNER_INVARIANT' })
})

test('ownership transfer still works under the index (demote, then promote)', async () => {
  const a = await mkUser()
  const b = await mkUser()
  const { tenant } = await createTenantWithOwner(db, { userId: a.id, code: `sao-${uniq()}`, name: 'Transfer', businessType: 'fnb' })
  await db.tenantMembership.create({ userId: b.id, tenantId: tenant.id, role: 'admin', status: 'ACTIVE' })

  await transferTenantOwnership(db, { tenantId: tenant.id, fromUserId: a.id, toUserId: b.id })
  const { tenant: fresh, owner } = await assertOwnerConsistency(db, tenant.id)
  expect(fresh.ownerId).toBe(b.id)
  expect(owner.userId).toBe(b.id)
})

test('the migration refuses when a tenant already has two ACTIVE owners', async () => {
  const fakeQi = {
    sequelize: {
      query: async (sql) => {
        if (/HAVING COUNT/.test(sql)) return [[{ tenants: 2 }]]
        throw new Error('DDL must not run')
      }
    }
  }
  await expect(migration.up(fakeQi)).rejects.toThrow(/2 tenant\(s\) already have more than one ACTIVE owner/)
})
