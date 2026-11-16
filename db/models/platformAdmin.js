'use strict'

// Owner/tenant hierarchy Phase 1 (expand): platform-level administrator
// grants. A grant points at a user (userId), never at a tenant — platform
// admins sit above the tenant hierarchy. Unique per user; REVOKED grants
// remain as paranoid tombstones so grant/revoke history is auditable and a
// re-grant is a new decision, not an implicit resurrection.
const PLATFORM_ADMIN_STATUS = Object.freeze(['ACTIVE', 'REVOKED'])

module.exports = (sequelize, DataTypes) => {
  const PlatformAdmin = sequelize.define(
    'platformAdmin',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      userId: {
        allowNull: false,
        type: DataTypes.INTEGER,
        references: { model: 'user', key: 'id' }
      },
      grantedBy: {
        allowNull: true,
        type: DataTypes.INTEGER,
        references: { model: 'user', key: 'id' }
      },
      status: {
        allowNull: false,
        type: DataTypes.STRING(20),
        defaultValue: 'ACTIVE',
        validate: { isIn: [PLATFORM_ADMIN_STATUS] }
      }
    },
    {
      paranoid: true,
      freezeTableName: true,
      modelName: 'platformAdmin',
      tableName: 'platform_admin',
      indexes: [{ unique: true, name: 'uq_platform_admin_user', fields: ['userId'] }]
    }
  )

  PlatformAdmin.associate = (models) => {
    if (models.user) {
      PlatformAdmin.belongsTo(models.user, { foreignKey: 'userId', as: 'user' })
    }
  }

  return PlatformAdmin
}
