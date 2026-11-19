'use strict'

// W3-2 (BE audit S-04 / S-05, FIXING-PLAN W3): category and product_bundle
// carry their tenant; bundle SKUs are unique per tenant instead of global.
//
// 1. category.tenantId / product_bundle.tenantId — nullable INTEGER FK tenant
//    (ON DELETE RESTRICT: tenants are soft-deleted) + index.
// 2. Backfill, never guessed. A row takes a tenant only when every outlet it
//    is assigned to belongs to exactly ONE tenant:
//      - category: live category_store rows → location.tenantId;
//      - product_bundle: the outlet ids in its `store` JSONB (an array, or a
//        single number/string) → location.tenantId.
//    Rows without outlets, on tenant-less outlets, or spanning tenants stay
//    NULL.
// 3. product_bundle_sku_key (global UNIQUE) and its duplicate partial index
//    product_bundle_sku (SCHEMA-CLEANUP §6) → uq_product_bundle_tenant_sku
//    (tenantId, sku) + uq_product_bundle_tenantless_sku (sku) WHERE tenantId
//    IS NULL. Category has no DB unique (names are checked per outlet set in
//    the app), so only the column + index are added there.
//
// Guarded and replay-safe. down() refuses (no DDL) while two tenants share a
// bundle SKU, because the global constraint could not be restored.
const TENANT_SKU = 'uq_product_bundle_tenant_sku'
const TENANTLESS_SKU = 'uq_product_bundle_tenantless_sku'

const addTenantColumn = async (queryInterface, Sequelize, table) => {
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

module.exports = {
  async up(queryInterface, Sequelize) {
    await addTenantColumn(queryInterface, Sequelize, 'category')
    await addTenantColumn(queryInterface, Sequelize, 'product_bundle')

    await queryInterface.sequelize.query(`
      UPDATE category c
         SET "tenantId" = owner.tenant_id
        FROM (
          SELECT cs.category AS category_id, MIN(l."tenantId") AS tenant_id
            FROM category_store cs
            JOIN location l ON l.id = cs.store
           WHERE cs."deletedAt" IS NULL
           GROUP BY cs.category
          HAVING COUNT(DISTINCT l."tenantId") = 1
             AND COUNT(*) FILTER (WHERE l."tenantId" IS NULL) = 0
        ) owner
       WHERE c.id = owner.category_id AND c."tenantId" IS NULL`)

    await queryInterface.sequelize.query(`
      UPDATE product_bundle b
         SET "tenantId" = owner.tenant_id
        FROM (
          SELECT pb.id AS bundle_id, MIN(l."tenantId") AS tenant_id
            FROM product_bundle pb
           CROSS JOIN LATERAL jsonb_array_elements_text(
                   CASE jsonb_typeof(pb.store)
                     WHEN 'array' THEN pb.store
                     WHEN 'number' THEN jsonb_build_array(pb.store)
                     WHEN 'string' THEN jsonb_build_array(pb.store)
                     ELSE '[]'::jsonb
                   END) AS s(store_id)
            LEFT JOIN location l ON l.id::text = s.store_id
           GROUP BY pb.id
          HAVING COUNT(DISTINCT l."tenantId") = 1
             AND COUNT(*) FILTER (WHERE l."tenantId" IS NULL) = 0
        ) owner
       WHERE b.id = owner.bundle_id AND b."tenantId" IS NULL`)

    await queryInterface.sequelize.query('ALTER TABLE "product_bundle" DROP CONSTRAINT IF EXISTS "product_bundle_sku_key"')
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS "product_bundle_sku_key"')
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS "product_bundle_sku"')
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "${TENANT_SKU}" ON "product_bundle" ("tenantId", sku) WHERE sku IS NOT NULL AND "tenantId" IS NOT NULL`
    )
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "${TENANTLESS_SKU}" ON "product_bundle" (sku) WHERE sku IS NOT NULL AND "tenantId" IS NULL`
    )
  },

  async down(queryInterface) {
    const [[dup]] = await queryInterface.sequelize.query(
      `SELECT COUNT(*)::int AS n FROM (SELECT sku FROM product_bundle WHERE sku IS NOT NULL GROUP BY sku HAVING COUNT(*) > 1) d`
    )
    if (dup.n > 0) {
      throw new Error(`category-bundle-tenant-id down: ${dup.n} bundle SKU(s) are used by more than one tenant; the global unique cannot be restored`)
    }
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "${TENANT_SKU}"`)
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "${TENANTLESS_SKU}"`)
    await queryInterface.sequelize.query('ALTER TABLE "product_bundle" ADD CONSTRAINT "product_bundle_sku_key" UNIQUE (sku)')
    for (const table of ['product_bundle', 'category']) {
      await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "ix_${table}_tenant"`)
      const columns = await queryInterface.describeTable(table)
      if (columns.tenantId) await queryInterface.removeColumn(table, 'tenantId')
    }
  }
}
