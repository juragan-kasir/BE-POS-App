'use strict'

// Owner/tenant hierarchy Phase 1 (expand): tenant.ownerId and
// tenant.businessType slots plus the platform_admin grant table.
//
// Additive only — both tenant columns stay nullable so every pre-hierarchy
// row remains valid; onboarding and the role resolver land in later tasks.
// ownerId is the tenant's owning user (SET NULL on user delete, so a
// retired owner never blocks cleanup). The platform_admin table records
// platform-level grants (userId → user, unique per user); revoked grants
// stay as tombstones through the paranoid deletedAt column. Replays safely:
// columns/tables/indexes are guarded and existing data is never touched.

module.exports = {
  async up(queryInterface, Sequelize) {
    const tenant = await queryInterface.describeTable('tenant')
    if (!tenant.ownerId) {
      await queryInterface.addColumn('tenant', 'ownerId', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'user', key: 'id' },
        onDelete: 'SET NULL'
      })
    }
    if (!tenant.businessType) {
      await queryInterface.addColumn('tenant', 'businessType', {
        type: Sequelize.STRING(20),
        allowNull: true
      })
    }
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS "ix_tenant_owner" ON "tenant" ("ownerId")'
    )

    const tables = await queryInterface.showAllTables()
    if (!tables.includes('platform_admin')) {
      await queryInterface.createTable('platform_admin', {
        id: {
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
          type: Sequelize.INTEGER
        },
        userId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: 'user', key: 'id' },
          onDelete: 'CASCADE'
        },
        grantedBy: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: 'user', key: 'id' },
          onDelete: 'SET NULL'
        },
        status: {
          type: Sequelize.STRING(20),
          allowNull: false,
          defaultValue: 'ACTIVE'
        },
        createdAt: { allowNull: false, type: Sequelize.DATE },
        updatedAt: { allowNull: false, type: Sequelize.DATE },
        deletedAt: { allowNull: true, type: Sequelize.DATE }
      })
    }
    await queryInterface.sequelize.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS "uq_platform_admin_user" ON "platform_admin" ("userId")'
    )
  },

  async down(queryInterface) {
    const tables = await queryInterface.showAllTables()
    if (tables.includes('platform_admin')) {
      await queryInterface.dropTable('platform_admin')
    }
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS "ix_tenant_owner"')
    const tenant = await queryInterface.describeTable('tenant')
    if (tenant.businessType) await queryInterface.removeColumn('tenant', 'businessType')
    if (tenant.ownerId) await queryInterface.removeColumn('tenant', 'ownerId')
  }
}
