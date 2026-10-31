process.env.NODE_ENV = 'test'

const harness = require('../scripts/rehearse-staging')
const { LOCAL_HOSTS } = require('../scripts/check-migration-preflight')

const DB = `cashier_app_member_scope_migration_${process.pid}`
const D05 = '20261012000001-d05-member-identity-uniqueness.js'
const MIGRATION = '20261031000001-member-phone-email-store-scoped.js'

let sequelize = null
const qi = () => sequelize.getQueryInterface()
const run = (file, dir) => require(`../db/migrations/${file}`)[dir](qi(), require('sequelize'))

const MEMBER_DDL = `CREATE TABLE "member" (
  id SERIAL PRIMARY KEY,
  store INTEGER,
  name VARCHAR(255) NOT NULL,
  "phoneNumber" VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  status VARCHAR(20) DEFAULT 'active',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ,
  "deletedAt" TIMESTAMPTZ
)`

const indexNames = async () => {
  const rows = await sequelize.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'member' AND indexname <> 'member_pkey'`,
    { type: sequelize.QueryTypes.SELECT }
  )
  return rows.map((r) => r.indexname).sort()
}

const insert = (store, name, phone, email = null) =>
  sequelize.query(
    `INSERT INTO "member" (store, name, "phoneNumber", email) VALUES (:store, :name, :phone, :email)`,
    { replacements: { store, name, phone, email } }
  )

const violated = async (promise) => {
  try {
    await promise
    return null
  } catch (e) {
    return e.parent?.constraint || e.original?.constraint || e.message
  }
}

beforeAll(async () => {
  const admin = harness.stagingConnection({ database: DB })
  if (!LOCAL_HOSTS.includes(String(admin.host || '').toLowerCase())) {
    throw new Error(`refusing member scope migration test against non-local host "${admin.host}"`)
  }
  await harness.createDatabase(admin, DB)
  sequelize = harness.newSequelize({ ...admin, database: DB })
})

afterAll(async () => {
  if (sequelize) await sequelize.close().catch(() => {})
  sequelize = null
  await harness.dropDatabase(harness.stagingConnection({ database: DB }), DB).catch(() => {})
})

beforeEach(async () => {
  await sequelize.query('DROP TABLE IF EXISTS "member" CASCADE')
  await sequelize.query(MEMBER_DDL)
  await run(D05, 'up')
})

describe('member phone/email store-scoped migration', () => {
  test('up replaces the global phone and email indexes with per-store buckets', async () => {
    await run(MIGRATION, 'up')
    expect(await indexNames()).toEqual(
      [
        'uq_member_global_email_ci',
        'uq_member_global_name_ci',
        'uq_member_global_phone_e164',
        'uq_member_store_email_ci',
        'uq_member_store_name_ci',
        'uq_member_store_phone_e164'
      ].sort()
    )
  })

  test('after up a phone and email may repeat across stores but not within one', async () => {
    await run(MIGRATION, 'up')
    await insert(1, 'Rina', '+6281300000001', 'rina@example.test')
    await insert(2, 'Rina', '+6281300000001', 'rina@example.test')
    expect(await violated(insert(1, 'Rina Dua', '+6281300000001'))).toBe(
      'uq_member_store_phone_e164'
    )
    expect(await violated(insert(1, 'Rina Tiga', '+6281300000009', 'RINA@example.test '))).toBe(
      'uq_member_store_email_ci'
    )
    await insert(null, 'Global', '+6281300000002')
    expect(await violated(insert(null, 'Global Dua', '+6281300000002'))).toBe(
      'uq_member_global_phone_e164'
    )
  })

  test('up keeps existing rows valid and is safe to run twice', async () => {
    await insert(1, 'A', '+6281300000003', 'a@example.test')
    await insert(2, 'B', '+6281300000004', 'b@example.test')
    await run(MIGRATION, 'up')
    await run(MIGRATION, 'up')
    expect((await indexNames()).length).toBe(6)
  })

  test('down aborts without DDL while a phone is shared across stores', async () => {
    await run(MIGRATION, 'up')
    await insert(1, 'Rina', '+6281300000005')
    await insert(2, 'Rina', '+6281300000005')
    await expect(run(MIGRATION, 'down')).rejects.toThrow(/down abort/)
    expect(await indexNames()).toContain('uq_member_store_phone_e164')
  })

  test('down restores the global indexes when no cross-store duplicate exists', async () => {
    await run(MIGRATION, 'up')
    await insert(1, 'Rina', '+6281300000006')
    await run(MIGRATION, 'down')
    expect(await indexNames()).toEqual(
      [
        'uq_member_email_ci',
        'uq_member_global_name_ci',
        'uq_member_phone_e164',
        'uq_member_store_name_ci'
      ].sort()
    )
  })
})
