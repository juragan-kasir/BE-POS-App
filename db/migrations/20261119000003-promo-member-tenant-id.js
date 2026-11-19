'use strict'

// W3-3 (BE audit S-04 / S-05, FIXING-PLAN W3): discount, member and
// member_tier carry their tenant; discount codes are unique per tenant
// instead of global. (promo_campaign already has tenantId — AUTH-1.)
//
// 1. <table>.tenantId — nullable INTEGER FK tenant (ON DELETE RESTRICT:
//    tenants are soft-deleted) + index ix_<table>_tenant.
// 2. Backfill from the row's outlet: tenantId = location.tenantId of `store`.
//    Rows without an outlet (store NULL: shared rows, mapped by W3-y) or on a
//    tenant-less outlet stay NULL. Nothing is guessed.
// 3. discount_code_key (global UNIQUE) → uq_discount_tenant_code (tenantId,
//    code) + uq_discount_tenantless_code (code) WHERE tenantId IS NULL.
//    Soft-deleted rows stay in both (same as the old constraint).
//
// Guarded and replay-safe. down() refuses (no DDL) while two tenants share a
// discount code, because the global constraint could not be restored.
const TABLES = ['discount', 'member', 'member_tier']
const TENANT_CODE = 'uq_discount_tenant_code'
const TENANTLESS_CODE = 'uq_discount_tenantless_code'

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
      await queryInterface.sequelize.query(`
        UPDATE "${table}" t
           SET "tenantId" = l."tenantId"
          FROM location l
         WHERE l.id = t.store
           AND l."tenantId" IS NOT NULL
           AND t."tenantId" IS NULL`)
    }

    await queryInterface.sequelize.query('ALTER TABLE "discount" DROP CONSTRAINT IF EXISTS "discount_code_key"')
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS "discount_code_key"')
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "${TENANT_CODE}" ON "discount" ("tenantId", code) WHERE code IS NOT NULL AND "tenantId" IS NOT NULL`
    )
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "${TENANTLESS_CODE}" ON "discount" (code) WHERE code IS NOT NULL AND "tenantId" IS NULL`
    )
  },

  async down(queryInterface) {
    const [[dup]] = await queryInterface.sequelize.query(
      `SELECT COUNT(*)::int AS n FROM (SELECT code FROM discount WHERE code IS NOT NULL GROUP BY code HAVING COUNT(*) > 1) d`
    )
    if (dup.n > 0) {
      throw new Error(`promo-member-tenant-id down: ${dup.n} discount code(s) are used by more than one tenant; the global unique cannot be restored`)
    }
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "${TENANT_CODE}"`)
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "${TENANTLESS_CODE}"`)
    await queryInterface.sequelize.query('ALTER TABLE "discount" ADD CONSTRAINT "discount_code_key" UNIQUE (code)')
    for (const table of [...TABLES].reverse()) {
      await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "ix_${table}_tenant"`)
      const columns = await queryInterface.describeTable(table)
      if (columns.tenantId) await queryInterface.removeColumn(table, 'tenantId')
    }
  }
}
