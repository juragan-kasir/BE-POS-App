'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// W3-5 (BE audit S-04, migration 20261119000005 / batch B23): the rest of
// tenantId wave 1 — stock_history, supplier, ingredient, ingredient_category,
// account, journal_entry, role, position, department, type_payment,
// tax_config — carries the tenant of its outlet(s), derived from persisted
// locations on every write.
const db = require('../db/models')
const migration = require('../db/migrations/20261119000005-master-ledger-tenant-id')
const { liftStoreTenantCheck, restoreStoreTenantCheck } = require('../test-helpers/storeTenantCheck')

const uniq = (k) => `mlt_${k}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
const TABLES = [
  'account', 'department', 'ingredient', 'ingredient_category', 'journal_entry', 'position', 'role',
  'stock_history', 'supplier', 'tax_config', 'type_payment'
]
const f = {}
const created = []

// One minimal valid row per model, at `store`.
const BUILDERS = {
  account: (store) => ({ store, code: uniq('9'), name: uniq('acc'), type: 'asset', normalBalance: 'debit' }),
  department: (store) => ({ store, name: uniq('dep') }),
  ingredient: (store) => ({ store, name: uniq('ing') }),
  ingredientCategory: (store) => ({ store, name: uniq('icat') }),
  journal_entry: (store) => ({ store, entryNumber: uniq('JE'), date: '2026-11-19' }),
  position: (store) => ({ store, name: uniq('pos') }),
  role: (store) => ({ store, name: uniq('role') }),
  stock_history: (store) => ({ store, referenceType: 'adjustment', quantityChange: 1, quantityAfter: 1 }),
  taxConfig: (store) => ({ store, name: uniq('tax') }),
  type_payment: (store) => ({ store, name: uniq('tp') })
}

const make = async (model, attrs) => {
  const row = await db[model].create(attrs)
  created.push([model, row.id])
  return row
}

beforeAll(async () => {
  f.tA = await db.tenant.create({ code: uniq('a').replace(/_/g, '-'), name: uniq('TA') })
  f.tB = await db.tenant.create({ code: uniq('b').replace(/_/g, '-'), name: uniq('TB') })
  f.a1 = await db.location.create({ name: uniq('A1'), status: 'active', tenantId: f.tA.id })
  f.a2 = await db.location.create({ name: uniq('A2'), status: 'active', tenantId: f.tA.id })
  f.b1 = await db.location.create({ name: uniq('B1'), status: 'active', tenantId: f.tB.id })
  f.free = await db.location.create({ tenantId: null, name: uniq('F'), status: 'active' })
})

afterAll(async () => {
  for (const [model, id] of created.reverse()) {
    await db[model].destroy({ where: { id }, force: true })
  }
  await db.location.destroy({ where: { id: [f.a1.id, f.a2.id, f.b1.id, f.free.id] }, force: true })
  await db.tenant.destroy({ where: { id: [f.tA.id, f.tB.id] }, force: true })
  await restoreStoreTenantCheck(db)
  await db.sequelize.close()
})

test('the eleven tables carry tenantId + index', async () => {
  const [cols] = await db.sequelize.query(
    `SELECT table_name FROM information_schema.columns WHERE column_name = 'tenantId' AND table_name IN (:tables) ORDER BY 1`,
    { replacements: { tables: TABLES } }
  )
  expect(cols.map((c) => c.table_name)).toEqual(TABLES)
  const [idx] = await db.sequelize.query(`SELECT indexname FROM pg_indexes WHERE indexname IN (:names)`, {
    replacements: { names: TABLES.map((t) => `ix_${t}_tenant`) }
  })
  expect(idx).toHaveLength(TABLES.length)
})

test.each(Object.keys(BUILDERS))('%s takes the outlet\'s tenant, follows a store change, ignores the caller', async (model) => {
  const row = await make(model, { ...BUILDERS[model](f.a1.id), tenantId: f.tB.id })
  expect(row.tenantId).toBe(f.tA.id)
  await row.update({ store: f.b1.id })
  expect((await db[model].findByPk(row.id)).tenantId).toBe(f.tB.id)
  // W3-z / Z2: a row on an outlet without a tenant is refused.
  await expect(make(model, BUILDERS[model](f.free.id))).rejects.toMatchObject({ code: 'STORE_TENANT_REQUIRED' })
})

describe('supplier (store = JSONB outlet set)', () => {
  test('one tenant → that tenant; mixed tenants or tenant-less → NULL; never refused', async () => {
    const one = await make('supplier', { name: uniq('s1'), store: [f.a1.id, f.a2.id] })
    const single = await make('supplier', { name: uniq('s2'), store: f.b1.id })
    const mixed = await make('supplier', { name: uniq('s3'), store: [f.a1.id, f.b1.id] })
    const free = await make('supplier', { name: uniq('s4'), store: [f.free.id] })
    expect([one.tenantId, single.tenantId, mixed.tenantId ?? null, free.tenantId ?? null]).toEqual([f.tA.id, f.tB.id, null, null])
    await db.supplier.update({ store: [f.b1.id] }, { where: { id: one.id } })
    expect((await db.supplier.findByPk(one.id)).tenantId).toBe(f.tB.id)
  })
})

test('the backfill follows the outlet(s), leaves shared / mixed rows NULL, and is replay-safe', async () => {
  await liftStoreTenantCheck(db)
  const insert = async (sql) => {
    const [[row]] = await db.sequelize.query(sql)
    return row.id
  }
  const roleA = await insert(`INSERT INTO role (name, store, "createdAt", "updatedAt") VALUES ('${uniq('r')}', ${f.a1.id}, NOW(), NOW()) RETURNING id`)
  const roleShared = await insert(`INSERT INTO role (name, store, "createdAt", "updatedAt") VALUES ('${uniq('r')}', NULL, NOW(), NOW()) RETURNING id`)
  const taxB = await insert(`INSERT INTO tax_config (name, store, "createdAt", "updatedAt") VALUES ('${uniq('t')}', ${f.b1.id}, NOW(), NOW()) RETURNING id`)
  const supA = await insert(`INSERT INTO supplier (name, store, "createdAt", "updatedAt") VALUES ('${uniq('s')}', '[${f.a1.id}, ${f.a2.id}]'::jsonb, NOW(), NOW()) RETURNING id`)
  const supMixed = await insert(`INSERT INTO supplier (name, store, "createdAt", "updatedAt") VALUES ('${uniq('s')}', '[${f.a1.id}, ${f.b1.id}]'::jsonb, NOW(), NOW()) RETURNING id`)
  const supNum = await insert(`INSERT INTO supplier (name, store, "createdAt", "updatedAt") VALUES ('${uniq('s')}', '${f.b1.id}'::jsonb, NOW(), NOW()) RETURNING id`)
  created.push(['role', roleA], ['role', roleShared], ['taxConfig', taxB], ['supplier', supA], ['supplier', supMixed], ['supplier', supNum])

  await migration.up(db.sequelize.getQueryInterface(), db.Sequelize)
  await migration.up(db.sequelize.getQueryInterface(), db.Sequelize)

  const tenantOf = async (model, id) => (await db[model].findByPk(id)).tenantId ?? null
  expect(await tenantOf('role', roleA)).toBe(f.tA.id)
  expect(await tenantOf('role', roleShared)).toBeNull()
  expect(await tenantOf('taxConfig', taxB)).toBe(f.tB.id)
  expect(await tenantOf('supplier', supA)).toBe(f.tA.id)
  expect(await tenantOf('supplier', supMixed)).toBeNull()
  expect(await tenantOf('supplier', supNum)).toBe(f.tB.id)
})
