'use strict'

// W3-z / Z3 (BE audit README, FIXING-PLAN K7): the database itself refuses a
// row owned by an outlet but carrying no tenant, on every table whose model
// derives its tenant from a scalar `store` (utils/storeTenant
// attachStoreTenant). Z2 already refuses those writes in the model hooks with
// 422 STORE_TENANT_REQUIRED; this CHECK covers every other path (raw SQL,
// hooks: false, a future model without the hook).
//
//   CHECK (store IS NULL OR "tenantId" IS NOT NULL)
//
// store NULL rows are platform rows (W3-y: role, type_payment, tax_config) or
// tenant-wide masters and stay allowed. W3-7 (RLS) builds on this guarantee.
//
// Steps, per table:
// 1. Backfill once more from location.tenantId (rows written between the
//    W3 batches and Z2 could still be NULL). Never guessed: only rows whose
//    outlet has a tenant are filled.
// 2. Fail closed: if any row still has store set and tenantId NULL (outlet
//    without a tenant, or an outlet id that matches no location), refuse with
//    the per-table counts and change nothing. Fix the data by an explicit
//    decision first.
// 3. ADD CONSTRAINT … NOT VALID, then VALIDATE CONSTRAINT (the validation
//    takes a lighter lock than a plain ADD CONSTRAINT).
// Guarded and replay-safe; down() drops the constraints.
const TABLES = [
  'account',
  'cash_movement',
  'cash_register',
  'department',
  'discount',
  'expense',
  'ingredient',
  'ingredient_category',
  'journal_entry',
  'member',
  'member_tier',
  'order',
  'position',
  'role',
  'shift',
  'stock_history',
  'tax_config',
  'type_payment'
]

const constraintName = (table) => `ck_${table}_store_tenant`

module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql)

    for (const table of TABLES) {
      await q(`
        UPDATE "${table}" t
           SET "tenantId" = l."tenantId"
          FROM location l
         WHERE l.id = t.store
           AND l."tenantId" IS NOT NULL
           AND t."tenantId" IS NULL`)
    }

    const offenders = []
    for (const table of TABLES) {
      const [[row]] = await q(
        `SELECT COUNT(*)::int AS n FROM "${table}" WHERE store IS NOT NULL AND "tenantId" IS NULL`
      )
      if (row.n > 0) offenders.push(`${table}=${row.n}`)
    }
    if (offenders.length > 0) {
      throw new Error(
        `store tenant CHECK: rows owned by an outlet without a tenant (${offenders.join(', ')}); ` +
          'assign those outlets to a tenant (or remove the rows) before this migration'
      )
    }

    for (const table of TABLES) {
      const name = constraintName(table)
      const [existing] = await q(
        `SELECT 1 FROM pg_constraint WHERE conname = '${name}' AND conrelid = '"${table}"'::regclass`
      )
      if (existing.length === 0) {
        await q(
          `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" CHECK (store IS NULL OR "tenantId" IS NOT NULL) NOT VALID`
        )
      }
      await q(`ALTER TABLE "${table}" VALIDATE CONSTRAINT "${name}"`)
    }
  },

  async down(queryInterface) {
    for (const table of [...TABLES].reverse()) {
      await queryInterface.sequelize.query(
        `ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${constraintName(table)}"`
      )
    }
  }
}

module.exports.TABLES = TABLES
module.exports.constraintName = constraintName
