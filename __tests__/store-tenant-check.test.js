'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// W3-z / Z3 (batch B27, migration 20261124000001): the database refuses a
// row owned by an outlet without a tenant on the 18 attachStoreTenant tables,
// whatever path writes it — here raw SQL, which skips every model hook.
const db = require('../db/models')
const migration = require('../db/migrations/20261124000001-store-tenant-check')
const { withTestTenant } = require('../test-helpers/fixtures')

const uniq = (k) => `stc_${k}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
const q = (sql, replacements) => db.sequelize.query(sql, { replacements })
const f = {}

beforeAll(async () => {
  f.owned = await db.location.create(await withTestTenant({ name: uniq('OWNED'), status: 'active' }))
  f.draft = await db.location.create({ name: uniq('DRAFT'), status: 'draft', tenantId: null })
})

afterAll(async () => {
  await q(`DELETE FROM department WHERE name LIKE 'stc_%'`)
  await db.location.destroy({ where: { id: [f.owned.id, f.draft.id] }, force: true })
  await db.sequelize.close()
})

const insertDepartment = (store, tenantId) =>
  q(
    `INSERT INTO department (name, store, "tenantId", "createdAt", "updatedAt")
     VALUES (:name, :store, :tenantId, NOW(), NOW()) RETURNING id`,
    { name: uniq('DEP'), store, tenantId }
  )

describe('ck_<table>_store_tenant', () => {
  test('every outlet-owned table has the validated CHECK', async () => {
    const [rows] = await q(
      `SELECT conrelid::regclass::text AS tbl, convalidated, pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE contype = 'c' AND conname LIKE 'ck\\_%\\_store\\_tenant'`
    )
    const byTable = new Map(rows.map((r) => [r.tbl.replace(/"/g, ''), r]))
    for (const table of migration.TABLES) {
      const row = byTable.get(table)
      expect(row).toBeDefined()
      expect(row.convalidated).toBe(true)
      expect(row.def).toMatch(/store IS NULL\) OR \("tenantId" IS NOT NULL/)
    }
  })

  // A new model with a scalar outlet and a nullable tenant must be added to
  // the CHECK (and attachStoreTenant) or excluded here on purpose.
  const EXCLUDED = {
    auditLog: 'not business data; 10 UAT rows have a store and no tenant (W3-z discovery)',
    laundry_order: 'tenant set by the laundry service, no attachStoreTenant hook yet',
    laundry_turnaround: 'tenant set by the laundry service, no attachStoreTenant hook yet',
    location: 'the outlet itself'
  }

  test('the 18 tables are every model with a scalar store and a nullable tenantId, minus the exclusions', () => {
    const tables = Object.keys(db)
      .filter((name) => !EXCLUDED[name])
      .filter((name) => db[name]?.rawAttributes?.store?.type?.key === 'INTEGER')
      .filter((name) => db[name].rawAttributes.tenantId && db[name].rawAttributes.tenantId.allowNull !== false)
      .map((name) => db[name].getTableName())
    expect([...new Set(tables)].sort()).toEqual([...migration.TABLES].sort())
  })

  test('raw SQL with an outlet and no tenant is refused by the database', async () => {
    await expect(insertDepartment(f.owned.id, null)).rejects.toMatchObject({
      original: expect.objectContaining({ constraint: 'ck_department_store_tenant' })
    })
  })

  test('an outlet with its tenant, and a row without an outlet, are accepted', async () => {
    await expect(insertDepartment(f.owned.id, f.owned.tenantId)).resolves.toBeDefined()
    await expect(insertDepartment(null, null)).resolves.toBeDefined()
  })

  test('replay is a no-op and down/up restores the constraints', async () => {
    const qi = db.sequelize.getQueryInterface()
    await migration.up(qi)
    await migration.down(qi)
    const [[gone]] = await q(`SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conname LIKE 'ck\\_%\\_store\\_tenant'`)
    expect(gone.n).toBe(0)
    await migration.up(qi)
    const [[back]] = await q(`SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conname LIKE 'ck\\_%\\_store\\_tenant'`)
    expect(back.n).toBe(migration.TABLES.length)
  })

  test('up refuses, changing nothing, while a tenant-less outlet row remains', async () => {
    const qi = db.sequelize.getQueryInterface()
    await migration.down(qi)
    try {
      const [[row]] = await insertDepartment(f.draft.id, null)
      await expect(migration.up(qi)).rejects.toThrow(/department=1/)
      const [[none]] = await q(`SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conname LIKE 'ck\\_%\\_store\\_tenant'`)
      expect(none.n).toBe(0)
      await q('DELETE FROM department WHERE id = :id', { id: row.id })
    } finally {
      await migration.up(qi)
    }
  })
})
