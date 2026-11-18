'use strict'

// W3-5 (BE audit S-04, FIXING-PLAN W3): the rest of tenantId wave 1 —
// stock, supplier, accounting, roles/positions and outlet settings:
// stock_history, supplier, ingredient, ingredient_category, account,
// journal_entry, role, position, department, type_payment, tax_config.
//
// 1. <table>.tenantId — nullable INTEGER FK tenant (ON DELETE RESTRICT:
//    tenants are soft-deleted) + index ix_<table>_tenant.
// 2. Backfill, never guessed:
//      - scalar `store` tables: tenantId = location.tenantId of `store`;
//      - supplier (`store` JSONB: an array of ids, or one id): the tenant of
//        its outlets when they all belong to exactly ONE tenant.
//    Rows without an outlet (shared rows: global payment types, tax rates,
//    role templates — mapped explicitly by W3-y), on tenant-less outlets, or
//    spanning tenants stay NULL.
//
// Existing uniques are already per outlet (account_store_code*,
// journal_entry_store_*), so no index changes. Guarded and replay-safe;
// down() drops the columns and indexes.
const STORE_TABLES = [
  'stock_history',
  'ingredient',
  'ingredient_category',
  'account',
  'journal_entry',
  'role',
  'position',
  'department',
  'type_payment',
  'tax_config'
]
const TABLES = [...STORE_TABLES, 'supplier']

module.exports = {
  async up(queryInterface, Sequelize) {
    for (const table of TABLES) {
      const columns = await queryInterface.describeTable(table)
      if (!columns.tenantId) {
        await queryInterface.addColumn(table, 'tenantId', {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: 'tenant', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'RESTRICT'
        })
      }
      await queryInterface.sequelize.query(`CREATE INDEX IF NOT EXISTS "ix_${table}_tenant" ON "${table}" ("tenantId")`)
    }

    for (const table of STORE_TABLES) {
      await queryInterface.sequelize.query(`
        UPDATE "${table}" t
           SET "tenantId" = l."tenantId"
          FROM location l
         WHERE l.id = t.store
           AND l."tenantId" IS NOT NULL
           AND t."tenantId" IS NULL`)
    }

    await queryInterface.sequelize.query(`
      UPDATE supplier sp
         SET "tenantId" = owner.tenant_id
        FROM (
          SELECT s.id AS supplier_id, MIN(l."tenantId") AS tenant_id
            FROM supplier s
           CROSS JOIN LATERAL jsonb_array_elements_text(
                   CASE jsonb_typeof(s.store)
                     WHEN 'array' THEN s.store
                     WHEN 'number' THEN jsonb_build_array(s.store)
                     WHEN 'string' THEN jsonb_build_array(s.store)
                     ELSE '[]'::jsonb
                   END) AS e(store_id)
            LEFT JOIN location l ON l.id::text = e.store_id
           GROUP BY s.id
          HAVING COUNT(DISTINCT l."tenantId") = 1
             AND COUNT(*) FILTER (WHERE l."tenantId" IS NULL) = 0
        ) owner
       WHERE sp.id = owner.supplier_id AND sp."tenantId" IS NULL`)
  },

  async down(queryInterface) {
    for (const table of [...TABLES].reverse()) {
      await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "ix_${table}_tenant"`)
      const columns = await queryInterface.describeTable(table)
      if (columns.tenantId) await queryInterface.removeColumn(table, 'tenantId')
    }
  }
}
