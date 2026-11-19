'use strict'
module.exports = (sequelize, DataTypes) => {
  const ProductBundle = sequelize.define(
    'product_bundle',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      store: {
        type: DataTypes.JSONB
      },
      name: {
        allowNull: false,
        type: DataTypes.STRING
      },
      // Unique per tenant (uq_product_bundle_tenant_sku), or globally among
      // tenant-less rows (uq_product_bundle_tenantless_sku) — migration
      // 20261119000002.
      sku: {
        type: DataTypes.STRING
      },
      // Owning tenant, derived from the outlets in `store` (see
      // resolveStoresTenant); NULL for bundles without outlets or on
      // tenant-less outlets.
      tenantId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'tenant', key: 'id' }
      },
      description: {
        type: DataTypes.TEXT
      },
      image: {
        type: DataTypes.STRING(2048)
      },
      bundlePrice: {
        allowNull: false,
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      originalPrice: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      discountAmount: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      discountPercentage: {
        type: DataTypes.DECIMAL(5, 2),
        defaultValue: 0
      },
      minQuantity: {
        type: DataTypes.INTEGER,
        defaultValue: 1
      },
      maxQuantity: {
        type: DataTypes.INTEGER
      },
      isAvailable: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
      },
      status: {
        type: DataTypes.STRING(20),
        defaultValue: 'active'
      },
      validFrom: {
        type: DataTypes.DATE
      },
      validUntil: {
        type: DataTypes.DATE
      },
      createdBy: {
        type: DataTypes.INTEGER
      },
      modifiedBy: {
        type: DataTypes.INTEGER
      }
    },
    {
      paranoid: true,
      freezeTableName: true,
      modelName: 'product_bundle',
      tableName: 'product_bundle'
    }
  )

  ProductBundle.associate = function (models) {
    ProductBundle.hasMany(models.product_bundle_item, {
      foreignKey: 'bundleId',
      as: 'items'
    })
  }

  // W3-2: `store` is JSONB — an array of outlet ids, or a single id (number or
  // numeric string). Returns the positive integer ids it names.
  const storeIdsOf = (store) => {
    const raw = Array.isArray(store) ? store : store == null || store === '' ? [] : [store]
    return [...new Set(raw.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))]
  }

  // W3-2: the tenant a bundle's outlets belong to — persisted location.tenantId,
  // never a caller-supplied value. { ok, tenantId, code, message }; tenantId is
  // null for no outlets or tenant-less outlets. An unknown outlet, a mix of
  // tenant-less and owned outlets, or outlets of two tenants is refused.
  const resolveStoresTenant = async (store, { transaction } = {}) => {
    const ids = storeIdsOf(store)
    if (ids.length === 0) return { ok: true, tenantId: null, code: null, message: null }
    const outlets = await sequelize.models.location.findAll({
      where: { id: ids },
      attributes: ['id', 'tenantId'],
      paranoid: false,
      transaction
    })
    if (outlets.length !== ids.length) {
      return { ok: false, tenantId: null, code: 'BUNDLE_STORE_UNKNOWN', message: 'Toko bundle tidak ditemukan' }
    }
    const tenants = [...new Set(outlets.map((l) => l.tenantId ?? null))]
    if (tenants.length > 1) {
      return {
        ok: false,
        tenantId: null,
        code: 'BUNDLE_STORE_CROSS_TENANT',
        message: 'Bundle tidak boleh mencakup toko dari tenant yang berbeda'
      }
    }
    return { ok: true, tenantId: tenants[0], code: null, message: null }
  }

  // Defense in depth: every write that sets `store` re-derives tenantId, so a
  // path that skips the controller check can neither store a cross-tenant
  // bundle nor keep a stale tenant.
  const deriveTenant = async (instance, options) => {
    if (!instance.isNewRecord && !instance.changed('store')) return
    const result = await resolveStoresTenant(instance.store, options)
    if (!result.ok) {
      const error = new Error(result.message)
      error.code = result.code
      error.statusCode = 400
      throw error
    }
    instance.tenantId = result.tenantId
  }
  ProductBundle.addHook('beforeCreate', deriveTenant)
  ProductBundle.addHook('beforeUpdate', deriveTenant)

  ProductBundle.storeIdsOf = storeIdsOf
  ProductBundle.resolveStoresTenant = resolveStoresTenant

  return ProductBundle
}
