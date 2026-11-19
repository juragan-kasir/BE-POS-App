'use strict'
module.exports = (sequelize, DataTypes) => {
  const category_store = sequelize.define(
    'category_store',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      category: {
        allowNull: false,
        type: DataTypes.INTEGER
      },
      store: {
        allowNull: false,
        type: DataTypes.INTEGER
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
      modelName: 'category_store',
      tableName: 'category_store',
      indexes: [
        {
          unique: true,
          fields: ['category', 'store']
        }
      ]
    }
  )

  category_store.associate = (models) => {
    category_store.belongsTo(models.category, {
      foreignKey: 'category',
      as: 'categoryData'
    })
    category_store.belongsTo(models.location, {
      foreignKey: 'store',
      as: 'storeData'
    })
  }

  // GAP-3: category_store IS the category's tenant boundary, mirroring
  // product_store.assertTenantConsistentAssignment. The persisted
  // location.tenantId values decide it — never a caller-supplied store id.
  // all-tenantless sets stay writable (pre-cutover staging); mixed
  // tenantless+owned and cross-tenant sets are rejected BEFORE any row is
  // written. W3-2: category.tenantId is adopted from these rows (adoptTenant).
  const reject = (code, message) => ({ ok: false, code, message, tenantId: null })

  const assertTenantConsistentAssignment = async ({
    category,
    storeIds,
    options = {}
  } = {}) => {
    const sequelizeInstance = options.sequelize || sequelize
    const models = sequelizeInstance.models
    const transaction = options.transaction

    const requested = (Array.isArray(storeIds) ? storeIds : [])
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value) && value > 0)
    const requestedIds = [...new Set(requested)]

    // category === null means "not persisted yet": only the incoming set exists.
    let persistedIds = []
    if (category != null) {
      const categoryId = Number(category)
      if (!Number.isSafeInteger(categoryId) || categoryId <= 0) {
        return reject('CATEGORY_STORE_CATEGORY_INVALID', 'category must be a positive integer')
      }
      const persisted = await models.category_store.findAll({
        where: { category: categoryId },
        attributes: ['store'],
        paranoid: false,
        transaction
      })
      persistedIds = persisted.map((row) => Number(row.store))
    }

    const allStoreIds = [
      ...new Set([...persistedIds, ...requestedIds])
    ].sort((left, right) => left - right)

    if (allStoreIds.length === 0) {
      return reject(
        'CATEGORY_STORE_UNASSIGNED',
        'category_store rejected: an assignment must name at least one store'
      )
    }

    const stores = await models.location.findAll({
      where: { id: allStoreIds },
      attributes: ['id', 'tenantId'],
      paranoid: false,
      transaction
    })
    const byId = new Map(stores.map((store) => [Number(store.id), store]))

    const missing = allStoreIds.filter((id) => !byId.has(id))
    if (missing.length > 0) {
      return reject(
        'CATEGORY_STORE_STORE_UNKNOWN',
        `category_store rejected: store does not exist (${missing.join(', ')})`
      )
    }

    const tenantIds = [
      ...new Set(allStoreIds.map((id) => byId.get(id).tenantId ?? null))
    ].sort((left, right) => (left === null ? -1 : right === null ? 1 : left - right))

    if (tenantIds.length > 1) {
      if (tenantIds.includes(null)) {
        return reject(
          'CATEGORY_STORE_TENANT_UNRESOLVED',
          'category_store rejected: a store without a tenant cannot be assigned alongside a tenant-owned store'
        )
      }
      return reject(
        'CATEGORY_STORE_CROSS_TENANT',
        `category_store rejected: cross-tenant assignment (${tenantIds.join(', ')})`
      )
    }

    return { ok: true, code: null, message: null, tenantId: tenantIds[0] ?? null }
  }

  const throwOnRejection = (result) => {
    if (!result.ok) throw new Error(result.message)
  }

  const guardSingle = async (instance, options) => {
    const result = await assertTenantConsistentAssignment({
      category: instance.category,
      storeIds: [instance.store],
      options
    })
    throwOnRejection(result)
  }

  const guardBulk = async (instances, options) => {
    const byCategory = new Map()
    for (const instance of instances) {
      const categoryId = Number(instance.category)
      if (!byCategory.has(categoryId)) byCategory.set(categoryId, [])
      byCategory.get(categoryId).push(instance.store)
    }
    for (const [categoryId, stores] of byCategory.entries()) {
      const result = await assertTenantConsistentAssignment({
        category: categoryId,
        storeIds: stores,
        options
      })
      throwOnRejection(result)
    }
  }

  category_store.addHook('beforeCreate', guardSingle)
  category_store.addHook('beforeUpdate', guardSingle)
  category_store.addHook('beforeBulkCreate', guardBulk)

  // W3-2: a category takes the tenant of its outlets the first time it is
  // assigned to one. The guard above already keeps every assignment inside
  // one tenant (soft-deleted rows included), so the tenant never changes
  // once set; tenant-less outlets leave it NULL.
  const adoptTenant = async (categoryIds, options = {}) => {
    const ids = [...new Set(categoryIds.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))]
    if (ids.length === 0) return
    await sequelize.query(
      `UPDATE category c
          SET "tenantId" = l."tenantId"
         FROM category_store cs
         JOIN location l ON l.id = cs.store
        WHERE cs.category = c.id
          AND cs."deletedAt" IS NULL
          AND c.id IN (:ids)
          AND c."tenantId" IS NULL
          AND l."tenantId" IS NOT NULL`,
      { replacements: { ids }, transaction: options.transaction }
    )
  }
  category_store.addHook('afterCreate', (instance, options) => adoptTenant([instance.category], options))
  category_store.addHook('afterUpdate', (instance, options) => adoptTenant([instance.category], options))
  category_store.addHook('afterBulkCreate', (instances, options) =>
    adoptTenant(instances.map((i) => i.category), options)
  )

  category_store.assertTenantConsistentAssignment = assertTenantConsistentAssignment

  return category_store
}
