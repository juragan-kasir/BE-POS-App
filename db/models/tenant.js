'use strict'

// AUTH-1 (DR-01): explicit tenant/organization entity — the top-level
// business isolation boundary. Stores are subordinate (location.tenantId);
// users attach via tenant_membership. Shared-DB multi-tenancy: isolation is
// enforced by server-side authorization (utils/authContext.js), not by
// separate databases.
module.exports = (sequelize, DataTypes) => {
  const Tenant = sequelize.define(
    'tenant',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      // Stable business-safe identifier (e.g. 'acme-id'). Unique so tenant
      // references are unambiguous; never reused after retirement.
      code: {
        type: DataTypes.STRING(50),
        allowNull: false,
        unique: true
      },
      name: {
        type: DataTypes.STRING(150),
        allowNull: false
      },
      // Lifecycle: 'active' | 'suspended'. Suspended tenants authorize
      // nothing (fail-safe); see resolveAuthorizationContext.
      status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'active'
      }
    },
    {
      paranoid: true,
      freezeTableName: true,
      modelName: 'tenant',
      tableName: 'tenant'
    }
  )

  Tenant.associate = (models) => {
    if (models.location) {
      Tenant.hasMany(models.location, { foreignKey: 'tenantId', as: 'stores' })
    }
    if (models.tenantMembership) {
      Tenant.hasMany(models.tenantMembership, {
        foreignKey: 'tenantId',
        as: 'memberships'
      })
    }
  }

  return Tenant
}
