'use strict'
module.exports = (sequelize, DataTypes) => {
  const Location = sequelize.define(
    'location',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      store: {
        type: DataTypes.INTEGER
      },
      // AUTH-1 (DR-01): tenant ownership. Nullable as a safe first stage so
      // existing rows stay valid without backfill; a store belongs to exactly
      // one tenant once assigned. Tenant ownership is authoritative persisted
      // state — never inferred from JWT. (Follow-up stage: NOT NULL after
      // production backfill decides real tenant boundaries.)
      tenantId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'tenant', key: 'id' }
      },
      image: {
        type: DataTypes.STRING(2048)
      },
      name: {
        type: DataTypes.STRING
      },
      address: {
        type: DataTypes.STRING
      },
      detailLocation: {
        type: DataTypes.STRING
      },
      city: {
        type: DataTypes.STRING
      },
      province: {
        type: DataTypes.STRING
      },
      district: {
        type: DataTypes.STRING
      },
      village: {
        type: DataTypes.STRING
      },
      postalCode: {
        type: DataTypes.STRING
      },
      latitude: {
        type: DataTypes.FLOAT
      },
      longitude: {
        type: DataTypes.FLOAT
      },
      mainBranch: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
      },
      description: {
        type: DataTypes.TEXT
      },
      openingHours: {
        type: DataTypes.JSONB
      },
      managerName: {
        type: DataTypes.STRING
      },
      email: {
        type: DataTypes.STRING
      },
      category: {
        type: DataTypes.STRING
      },
      phoneNumber: {
        type: DataTypes.STRING
      },
      status: {
        type: DataTypes.STRING(20),
        defaultValue: 'active'
      },
      createdBy: {
        type: DataTypes.INTEGER
      },
      modifiedBy: {
        type: DataTypes.INTEGER
      },
      socialMedia: {
        type: DataTypes.JSONB
      },
      dailyTarget: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      // Cash-out movements above this amount require approval before
      // becoming financially effective. Null means "use the built-in
      // default" (500000), applied in application code, not here.
      cashOutApprovalThreshold: {
        type: DataTypes.INTEGER,
        allowNull: true
      },
      // Absolute variance at register close within this amount auto-
      // approves; beyond it, a manager decision is required. Null means
      // "use the built-in default" (25000).
      cashVarianceThreshold: {
        type: DataTypes.INTEGER,
        allowNull: true
      },
      // Max concurrently-active parked carts for this store. Null means
      // "use the built-in default" (20), applied in application code.
      // 0/negative are treated as misconfiguration and also fall back to
      // the default — see api/controller/parkedCart.js.
      maxActiveParkedCarts: {
        type: DataTypes.INTEGER,
        allowNull: true
      },
      // Minutes a parked cart stays active before it is (lazily)
      // considered expired. Null means "use the built-in default" (120).
      parkedCartTtlMinutes: {
        type: DataTypes.INTEGER,
        allowNull: true
      },
      // Phase 22 Batch 3 — IANA timezone identifier (e.g. "Asia/Jakarta"),
      // authoritative for every business-date calculation scoped to this
      // store (due dates, H-4 classification, ...). NOT a fixed UTC
      // offset and NOT "WIB"/"WITA"/"WIT" — see utils/businessDate.js.
      timezone: {
        type: DataTypes.STRING(50),
        defaultValue: 'Asia/Jakarta'
      }
    },
    {
      paranoid: true,
      freezeTableName: true,
      modelName: 'location',
      tableName: 'location'
    }
  )

  Location.associate = (models) => {
    // AUTH-1 (DR-01): store → tenant ownership.
    if (models.tenant) {
      Location.belongsTo(models.tenant, { foreignKey: 'tenantId', as: 'tenant' })
    }
  }

  // AUTH-2: tenant ownership of a store that already has one is never
  // rewritten implicitly. Reassignment is an approved migration decision
  // (see scripts/tenant-backfill-preflight.js), so any write that would move
  // an owned store to a different tenant must opt in explicitly through
  // `allowTenantReassignment`. First-time assignment (null -> tenant) and
  // writes that do not touch tenantId at all stay unblocked: null is the
  // explicitly non-operational migration state until the cutover gate.
  const collectWhereIds = (where, into = []) => {
    if (!where || typeof where !== 'object') return into
    const keys = [...Object.keys(where), ...Object.getOwnPropertySymbols(where)]
    for (const key of keys) {
      const value = where[key]
      // Sequelize wraps a paranoid model's filter in `Op.and`, a symbol key,
      // so the primary key filter is one level down.
      if (typeof key !== 'string' || Array.isArray(value)) {
        collectWhereIds(value, into)
        continue
      }
      if (key === 'id' || key === Location.primaryKeyAttribute) {
        for (const candidate of Array.isArray(value) ? value : [value]) {
          const id = Number(candidate)
          if (Number.isSafeInteger(id) && id > 0) into.push(id)
        }
        continue
      }
      collectWhereIds(value, into)
    }
    return into
  }

  const isRejectedReassignment = async (id, nextTenantId) => {
    if (nextTenantId == null || nextTenantId === '') return false
    const rows = await Location.findAll({
      where: { id },
      attributes: ['id', 'tenantId'],
      paranoid: false
    })
    return rows.some(
      (row) =>
        row.tenantId != null &&
        row.tenantId !== '' &&
        Number(row.tenantId) !== Number(nextTenantId)
    )
  }

  const assertTenantReassignmentApproved = async (instance, options = {}) => {
    if (options.allowTenantReassignment === true) return
    if (instance.changed('tenantId') !== true) return
    const previous = instance.previous('tenantId')
    if (previous == null || previous === '') return
    if (await isRejectedReassignment(instance.get(Location.primaryKeyAttribute), instance.tenantId)) {
      throw new Error(
        'location rejected: store tenant ownership cannot be reassigned implicitly'
      )
    }
  }

  const assertBulkTenantReassignmentApproved = async (options = {}) => {
    if (options.allowTenantReassignment === true) return
    const attributes = options.attributes
    if (!attributes || !Object.prototype.hasOwnProperty.call(attributes, 'tenantId')) {
      return
    }
    const ids = [...new Set(collectWhereIds(options.where))]
    if (ids.length === 0) return
    if (await isRejectedReassignment(ids, attributes.tenantId)) {
      throw new Error(
        'location rejected: store tenant ownership cannot be reassigned implicitly'
      )
    }
  }

  Location.addHook('beforeUpdate', assertTenantReassignmentApproved)
  Location.addHook('beforeBulkUpdate', assertBulkTenantReassignmentApproved)

  return Location
}
