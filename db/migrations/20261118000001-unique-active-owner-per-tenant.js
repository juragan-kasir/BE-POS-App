'use strict'

// Owner hierarchy W2-c (spec 2026-11-16 invariant "exactly one ACTIVE owner
// per tenant", BE audit P1-6): a partial unique index so the database itself
// refuses a second ACTIVE `owner` membership in a tenant, whatever path
// writes it (service, raw SQL, concurrent onboarding/transfer).
//
// Scope is the canonical `owner` role only. Legacy `tenant_admin` rows are an
// alias that may legitimately be several per tenant until the backfill (W6)
// classifies them, so they are not constrained here.
//
// Fail closed, never guess: if a tenant already has more than one ACTIVE owner
// the migration refuses with the count and changes nothing (fix the data by an
// explicit, audited decision first). Guarded and replay-safe.
const INDEX = 'uq_tenant_membership_active_owner'

module.exports = {
  async up(queryInterface) {
    const [[dup]] = await queryInterface.sequelize.query(
      `SELECT COUNT(*)::int AS tenants FROM (
         SELECT "tenantId" FROM tenant_membership
          WHERE role = 'owner' AND status = 'ACTIVE' AND "deletedAt" IS NULL
          GROUP BY 1 HAVING COUNT(*) > 1) d`
    )
    if (dup.tenants > 0) {
      throw new Error(
        `${INDEX}: ${dup.tenants} tenant(s) already have more than one ACTIVE owner membership; resolve them before this migration`
      )
    }
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "${INDEX}" ON "tenant_membership" ("tenantId")
        WHERE role = 'owner' AND status = 'ACTIVE' AND "deletedAt" IS NULL`
    )
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "${INDEX}"`)
  }
}

module.exports.INDEX_NAME = INDEX
