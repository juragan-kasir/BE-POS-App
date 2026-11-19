'use strict'

// W3 (FIXING-PLAN K7): a row owned by one outlet (scalar `store` column)
// carries that outlet's tenant in `tenantId`. The tenant always comes from the
// persisted location.tenantId — never from the caller — and is re-derived on
// every write that sets the outlet, so no path (controller, import, raw model
// call, static Model.update) can store a row under the wrong tenant.
//
// A row without an outlet (store NULL: shared/master rows) keeps whatever
// tenantId was given to it (NULL by default); W3-y maps those explicitly.

const storeIdOf = (value) => {
  const n = Number(value)
  return value != null && value !== '' && Number.isSafeInteger(n) && n > 0 ? n : null
}

// Map<storeId, tenantId|null> for the given outlet ids (unknown ids absent).
const tenantsForStores = async (sequelize, storeIds, transaction) => {
  const ids = [...new Set(storeIds.map(storeIdOf).filter((n) => n != null))]
  if (ids.length === 0) return new Map()
  const rows = await sequelize.models.location.findAll({
    where: { id: ids },
    attributes: ['id', 'tenantId'],
    paranoid: false,
    transaction
  })
  return new Map(rows.map((row) => [Number(row.id), row.tenantId ?? null]))
}

const tenantForStore = async (sequelize, storeId, transaction) => {
  const id = storeIdOf(storeId)
  if (id == null) return null
  return (await tenantsForStores(sequelize, [id], transaction)).get(id) ?? null
}

// When a save is limited to `fields`, tenantId must be in the list or the
// derived value is silently dropped.
const includeTenantField = (options) => {
  if (Array.isArray(options?.fields) && !options.fields.includes('tenantId')) {
    options.fields.push('tenantId')
  }
}

const attachStoreTenant = (Model, { storeField = 'store' } = {}) => {
  const sequelize = Model.sequelize

  const deriveOne = async (instance, options = {}) => {
    if (!instance.isNewRecord && !instance.changed(storeField)) return
    const storeId = storeIdOf(instance.get(storeField))
    if (storeId == null) return
    instance.set('tenantId', await tenantForStore(sequelize, storeId, options.transaction))
    includeTenantField(options)
  }

  const deriveBulk = async (instances, options = {}) => {
    const map = await tenantsForStores(
      sequelize,
      instances.map((i) => i.get(storeField)),
      options.transaction
    )
    for (const instance of instances) {
      const storeId = storeIdOf(instance.get(storeField))
      if (storeId != null) instance.set('tenantId', map.get(storeId) ?? null)
    }
    includeTenantField(options)
  }

  // Static Model.update({ store, ... }, { where }) — no instances involved.
  const deriveBulkUpdate = async (options = {}) => {
    const attrs = options.attributes
    if (!attrs || !Object.prototype.hasOwnProperty.call(attrs, storeField)) return
    const storeId = storeIdOf(attrs[storeField])
    if (storeId == null) return
    attrs.tenantId = await tenantForStore(sequelize, storeId, options.transaction)
    includeTenantField(options)
  }

  Model.addHook('beforeCreate', deriveOne)
  Model.addHook('beforeUpdate', deriveOne)
  Model.addHook('beforeBulkCreate', deriveBulk)
  Model.addHook('beforeBulkUpdate', deriveBulkUpdate)
  return Model
}

module.exports = { attachStoreTenant, tenantForStore, tenantsForStores, storeIdOf }
