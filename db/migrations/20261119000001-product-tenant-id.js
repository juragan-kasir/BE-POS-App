'use strict'

// W3-1 (BE audit S-04 / S-05, FIXING-PLAN W3): product carries its tenant, and
// SKU uniqueness is per tenant instead of global.
//
// 1. product.tenantId — nullable INTEGER FK tenant (ON DELETE RESTRICT: tenants
//    are soft-deleted, a hard delete must never orphan a catalog) + index.
// 2. Backfill, never guessed: a product gets the tenant of its outlets only
//    when every outlet it is assigned to (product_store, live rows) belongs to
//    exactly ONE tenant. Products without outlets, on tenant-less outlets, or
//    spanning tenants (pre-PGA-02 data) stay NULL.
// 3. product_sku_key (global UNIQUE) → uq_product_tenant_sku (tenantId, sku)
//    + uq_product_tenantless_sku (sku) WHERE tenantId IS NULL, so tenant B may
//    use a SKU tenant A already uses, while tenant-less rows keep today's rule.
//    Soft-deleted rows stay in both indexes: a retired SKU is not reused inside
//    its tenant (same as the import's existing check).
//
// Guarded and replay-safe. down() refuses (no DDL) while two tenants share a
// SKU, because the global constraint could not be restored.
const TENANT_SKU = 'uq_product_tenant_sku'
const TENANTLESS_SKU = 'uq_product_tenantless_sku'

module.exports = {
  async up(queryInterface, Sequelize) {
    const product = await queryInterface.describeTable('product')
    if (!product.tenantId) {
      await queryInterface.addColumn('product', 'tenantId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'tenant', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      })
    }
    await queryInterface.sequelize.query('CREATE INDEX IF NOT EXISTS "ix_product_tenant" ON "product" ("tenantId")')

    await queryInterface.sequelize.query(`
      UPDATE product p
         SET "tenantId" = owner.tenant_id
        FROM (
          SELECT ps.product AS product_id, MIN(l."tenantId") AS tenant_id
            FROM product_store ps
            JOIN location l ON l.id = ps.store
           WHERE ps."deletedAt" IS NULL
           GROUP BY ps.product
          HAVING COUNT(DISTINCT l."tenantId") = 1
             AND COUNT(*) FILTER (WHERE l."tenantId" IS NULL) = 0
        ) owner
       WHERE p.id = owner.product_id AND p."tenantId" IS NULL`)

    await queryInterface.sequelize.query('ALTER TABLE "product" DROP CONSTRAINT IF EXISTS "product_sku_key"')
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS "product_sku_key"')
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "${TENANT_SKU}" ON "product" ("tenantId", sku) WHERE sku IS NOT NULL AND "tenantId" IS NOT NULL`
    )
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "${TENANTLESS_SKU}" ON "product" (sku) WHERE sku IS NOT NULL AND "tenantId" IS NULL`
    )
  },

  async down(queryInterface) {
    const [[dup]] = await queryInterface.sequelize.query(
      `SELECT COUNT(*)::int AS n FROM (SELECT sku FROM product WHERE sku IS NOT NULL GROUP BY sku HAVING COUNT(*) > 1) d`
    )
    if (dup.n > 0) {
      throw new Error(`product-tenant-id down: ${dup.n} SKU(s) are used by more than one tenant; the global unique cannot be restored`)
    }
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "${TENANT_SKU}"`)
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "${TENANTLESS_SKU}"`)
    await queryInterface.sequelize.query(
      'ALTER TABLE "product" ADD CONSTRAINT "product_sku_key" UNIQUE (sku)'
    )
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS "ix_product_tenant"')
    const product = await queryInterface.describeTable('product')
    if (product.tenantId) await queryInterface.removeColumn('product', 'tenantId')
  }
}
