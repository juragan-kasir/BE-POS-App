'use strict'

// W3-4 (BE audit S-04, FIXING-PLAN W3): money tables carry their tenant —
// order, transaction, shift, cash_register, cash_movement, expense.
//
// 1. <table>.tenantId — nullable INTEGER FK tenant (ON DELETE RESTRICT:
//    tenants are soft-deleted) + index ix_<table>_tenant.
// 2. Backfill, never guessed:
//      - outlet tables: tenantId = location.tenantId of `store`;
//      - transaction: tenantId = its order's tenantId (after the order
//        backfill).
//    Rows without an outlet or on a tenant-less outlet stay NULL.
//
// The UPDATEs are single statements: production holds 0 orders (read-only
// check 2026-11-19). A large table would need a batched backfill instead.
// Guarded and replay-safe; down() drops the columns and indexes.
const STORE_TABLES = ['order', 'shift', 'cash_register', 'cash_movement', 'expense']
const TABLES = [...STORE_TABLES, 'transaction']

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
      UPDATE "transaction" t
         SET "tenantId" = o."tenantId"
        FROM "order" o
       WHERE o.id = t."order"
         AND o."tenantId" IS NOT NULL
         AND t."tenantId" IS NULL`)
  },

  async down(queryInterface) {
    for (const table of [...TABLES].reverse()) {
      await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "ix_${table}_tenant"`)
      const columns = await queryInterface.describeTable(table)
      if (columns.tenantId) await queryInterface.removeColumn(table, 'tenantId')
    }
  }
}
