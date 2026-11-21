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
      },
      // Owner/tenant hierarchy Phase 1: the tenant's owning user. Nullable
      // so pre-hierarchy tenants stay valid; onboarding assigns it in a
      // later task. SET NULL on user delete — a retired owner never blocks
      // account cleanup.
      ownerId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'user', key: 'id' },
        onDelete: 'SET NULL'
      },
      // Vertical profile of the tenant, set at onboarding (later task).
      // STRING (not ENUM) so the vocabulary can grow without a type
      // migration; app-side validation keeps the current set closed.
      businessType: {
        type: DataTypes.STRING(20),
        allowNull: true,
        validate: { isIn: [['fnb', 'retail', 'laundry', 'salon']] }
      },
      // Salon-only tenant settings (B26): { salonProfile, slotStepMin,
      // depositDefault, pointsPer }. Null for other business types.
      salonSettings: {
        type: DataTypes.JSONB,
        allowNull: true
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
    if (models.user) {
      Tenant.belongsTo(models.user, { foreignKey: 'ownerId', as: 'owner' })
    }
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
