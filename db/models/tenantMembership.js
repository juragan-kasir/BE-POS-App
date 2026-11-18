'use strict'

// AUTH-1 (DR-01/DR-03): explicit User ↔ Tenant membership. One user may
// belong to many tenants with a different role per tenant; exactly one role
// per membership (no stacking). Status vocabulary is DR-03: ACTIVE /
// DEACTIVATED / RETIRED. Only ACTIVE memberships authorize anything —
// deactivation preserves the role and subordinate store assignments (they go
// ineffective, they are not deleted), and rewrites no historical records.
// owner/admin/kasir: owner hierarchy vocabulary (spec 2026-11-16). Storable
// so onboarding can create an owner membership; they only become EFFECTIVE in
// the resolver with AUTHZ_OWNER_V2 on (utils/authContext.js).
const TARGET_ROLES = Object.freeze([
  'platform_admin',
  'tenant_admin',
  'store_admin',
  'cashier',
  'staff',
  'owner',
  'admin',
  'kasir'
])

const MEMBERSHIP_STATUS = Object.freeze(['ACTIVE', 'DEACTIVATED', 'RETIRED'])

module.exports = (sequelize, DataTypes) => {
  const TenantMembership = sequelize.define(
    'tenantMembership',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: 'user', key: 'id' }
      },
      tenantId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: 'tenant', key: 'id' }
      },
      // Target DR-02 vocabulary. Validated app-side (STRING, not ENUM, so
      // the vocabulary can evolve without a type migration).
      role: {
        type: DataTypes.STRING(30),
        allowNull: false,
        validate: {
          isIn: [TARGET_ROLES]
        }
      },
      status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'ACTIVE',
        validate: {
          isIn: [MEMBERSHIP_STATUS]
        }
      },
      // T-03B (DR-03 Q8): DB-clock instant of the most recent DEACTIVATED →
      // ACTIVE transition. NULL = no reactivation freshness constraint.
      reactivatedAt: {
        type: DataTypes.DATE,
        allowNull: true,
        defaultValue: null
      }
    },
    {
      paranoid: true,
      freezeTableName: true,
      modelName: 'tenantMembership',
      tableName: 'tenant_membership',
      indexes: [
        {
          unique: true,
          name: 'uq_tenant_membership_user_tenant',
          fields: ['userId', 'tenantId']
        }
      ]
    }
  )

  TenantMembership.associate = (models) => {
    if (models.user) {
      TenantMembership.belongsTo(models.user, { foreignKey: 'userId', as: 'user' })
    }
    if (models.tenant) {
      TenantMembership.belongsTo(models.tenant, { foreignKey: 'tenantId', as: 'tenant' })
    }
  }

  return TenantMembership
}

module.exports.TARGET_ROLES = TARGET_ROLES
module.exports.MEMBERSHIP_STATUS = MEMBERSHIP_STATUS
