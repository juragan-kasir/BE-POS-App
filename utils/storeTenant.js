'use strict'

// W3 (FIXING-PLAN K7): a row owned by one outlet (scalar `store` column)
// carries that outlet's tenant in `tenantId`. The tenant always comes from the
// persisted location.tenantId — never from the caller — and is re-derived on
// every write that sets the outlet, so no path (controller, import, raw model
// call, static Model.update) can store a row under the wrong tenant.
//
// A row without an outlet (store NULL: shared/master rows) keeps whatever
// tenantId was given to it (NULL by default); W3-y keeps those as platform
// rows.
//
// W3-z / Z2: a row owned by an EXISTING outlet that has no tenant (a draft
// outlet not yet assigned) is refused with 422 STORE_TENANT_REQUIRED before
// it reaches the database. Every operational outlet has a tenant, so this
// only stops writes against unassigned drafts; Z3 adds the same rule as a
// CHECK constraint. Like DR-28 (utils/valueTooLong.js) the refusal marks the
// request context, and storeTenantResponder turns the controller's generic
// 5xx for that request into the 422 — no controller has to know about it.
// Z3 (migration 20261124000001, batch B27): the same rule is a CHECK on the
// table, so an outlet id that matches no location (12 of these tables have no
// FK on `store`) is refused here too — 422 instead of a CHECK violation 500.
const userContext = require('./userContext')

const STORE_TENANT_REQUIRED = 'STORE_TENANT_REQUIRED'

class StoreTenantRequiredError extends Error {
  constructor({ model, storeId }) {
    super('Outlet ini belum terhubung ke tenant. Hubungkan outlet ke tenant dulu.')
    this.name = 'StoreTenantRequiredError'
    this.code = STORE_TENANT_REQUIRED
    this.statusCode = 422
    this.model = model
    this.storeId = storeId
  }
}

const refuseTenantless = (model, storeId) => {
  const found = { model, storeId }
  const store = userContext.getStore()
  if (store) store.storeTenantRequired = found
  throw new StoreTenantRequiredError(found)
}

const storeTenantBody = (found) => ({
  success: false,
  code: STORE_TENANT_REQUIRED,
  message: 'Outlet ini belum terhubung ke tenant. Hubungkan outlet ke tenant dulu.',
  storeId: found?.storeId ?? null
})

// Express middleware (mounted next to valueTooLongResponder): when this
// request was refused by refuseTenantless and the handler answered 5xx — or
// forwarded the error's 422 with its own body and no code — answer the
// standard 422 STORE_TENANT_REQUIRED body instead.
const storeTenantResponder = (req, res, next) => {
  const store = userContext.getStore()
  const json = res.json.bind(res)
  res.json = (body) => {
    const generic = res.statusCode >= 500 || (res.statusCode === 422 && !body?.code)
    if (generic && store?.storeTenantRequired) {
      res.status(422)
      return json(storeTenantBody(store.storeTenantRequired))
    }
    return json(body)
  }
  next()
}

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

  // Tenant of an outlet-owned row; refuses a tenant-less or unknown outlet.
  const tenantOrRefuse = (map, storeId) => {
    const tenantId = map.has(storeId) ? map.get(storeId) : null
    if (tenantId == null) refuseTenantless(Model.name, storeId)
    return tenantId
  }

  const deriveOne = async (instance, options = {}) => {
    if (!instance.isNewRecord && !instance.changed(storeField)) return
    const storeId = storeIdOf(instance.get(storeField))
    if (storeId == null) return
    const map = await tenantsForStores(sequelize, [storeId], options.transaction)
    instance.set('tenantId', tenantOrRefuse(map, storeId))
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
      if (storeId != null) instance.set('tenantId', tenantOrRefuse(map, storeId))
    }
    includeTenantField(options)
  }

  // Static Model.update({ store, ... }, { where }) — no instances involved.
  const deriveBulkUpdate = async (options = {}) => {
    const attrs = options.attributes
    if (!attrs || !Object.prototype.hasOwnProperty.call(attrs, storeField)) return
    const storeId = storeIdOf(attrs[storeField])
    if (storeId == null) return
    const map = await tenantsForStores(sequelize, [storeId], options.transaction)
    attrs.tenantId = tenantOrRefuse(map, storeId)
    includeTenantField(options)
  }

  Model.addHook('beforeCreate', deriveOne)
  Model.addHook('beforeUpdate', deriveOne)
  Model.addHook('beforeBulkCreate', deriveBulk)
  Model.addHook('beforeBulkUpdate', deriveBulkUpdate)
  return Model
}

// A row assigned to SEVERAL outlets (JSONB `store`: an array of ids, or one
// id) carries their tenant when they all belong to the same one; a mixed set
// (platform-wide row created by a global super admin) or tenant-less outlets
// leave tenantId NULL. Nothing is refused here — the controllers already keep
// store-bound callers inside their tenant.
const storeIdsOfJson = (store) => {
  const raw = Array.isArray(store) ? store : store == null || store === '' ? [] : [store]
  return [...new Set(raw.map(storeIdOf).filter((n) => n != null))]
}

const tenantOfStoreSet = async (sequelize, store, transaction) => {
  const ids = storeIdsOfJson(store)
  if (ids.length === 0) return { known: false, tenantId: null }
  const map = await tenantsForStores(sequelize, ids, transaction)
  const tenants = new Set(ids.map((id) => (map.has(id) ? map.get(id) : null)))
  return { known: true, tenantId: tenants.size === 1 ? [...tenants][0] : null }
}

const attachStoresTenant = (Model, { storeField = 'store' } = {}) => {
  const sequelize = Model.sequelize
  const deriveOne = async (instance, options = {}) => {
    if (!instance.isNewRecord && !instance.changed(storeField)) return
    const result = await tenantOfStoreSet(sequelize, instance.get(storeField), options.transaction)
    if (!result.known) return
    instance.set('tenantId', result.tenantId)
    includeTenantField(options)
  }
  const deriveBulk = async (instances, options = {}) => {
    for (const instance of instances) await deriveOne(instance, options)
  }
  const deriveBulkUpdate = async (options = {}) => {
    const attrs = options.attributes
    if (!attrs || !Object.prototype.hasOwnProperty.call(attrs, storeField)) return
    const result = await tenantOfStoreSet(sequelize, attrs[storeField], options.transaction)
    if (!result.known) return
    attrs.tenantId = result.tenantId
    includeTenantField(options)
  }
  Model.addHook('beforeCreate', deriveOne)
  Model.addHook('beforeUpdate', deriveOne)
  Model.addHook('beforeBulkCreate', deriveBulk)
  Model.addHook('beforeBulkUpdate', deriveBulkUpdate)
  return Model
}

// A child row without its own outlet (e.g. transaction → order) carries its
// parent's tenant: re-derived from the persisted parent on create and when
// the parent link changes.
const attachParentTenant = (Model, { parent, foreignKey }) => {
  const sequelize = Model.sequelize

  const tenantsForParents = async (parentIds, transaction) => {
    const ids = [...new Set(parentIds.map(storeIdOf).filter((n) => n != null))]
    if (ids.length === 0) return new Map()
    const rows = await sequelize.models[parent].findAll({
      where: { id: ids },
      attributes: ['id', 'tenantId'],
      paranoid: false,
      transaction
    })
    return new Map(rows.map((row) => [Number(row.id), row.tenantId ?? null]))
  }

  const deriveOne = async (instance, options = {}) => {
    if (!instance.isNewRecord && !instance.changed(foreignKey)) return
    const parentId = storeIdOf(instance.get(foreignKey))
    if (parentId == null) return
    const map = await tenantsForParents([parentId], options.transaction)
    instance.set('tenantId', map.get(parentId) ?? null)
    includeTenantField(options)
  }

  const deriveBulk = async (instances, options = {}) => {
    const map = await tenantsForParents(instances.map((i) => i.get(foreignKey)), options.transaction)
    for (const instance of instances) {
      const parentId = storeIdOf(instance.get(foreignKey))
      if (parentId != null) instance.set('tenantId', map.get(parentId) ?? null)
    }
    includeTenantField(options)
  }

  const deriveBulkUpdate = async (options = {}) => {
    const attrs = options.attributes
    if (!attrs || !Object.prototype.hasOwnProperty.call(attrs, foreignKey)) return
    const parentId = storeIdOf(attrs[foreignKey])
    if (parentId == null) return
    attrs.tenantId = (await tenantsForParents([parentId], options.transaction)).get(parentId) ?? null
    includeTenantField(options)
  }

  Model.addHook('beforeCreate', deriveOne)
  Model.addHook('beforeUpdate', deriveOne)
  Model.addHook('beforeBulkCreate', deriveBulk)
  Model.addHook('beforeBulkUpdate', deriveBulkUpdate)
  return Model
}

module.exports = {
  attachStoreTenant,
  attachStoresTenant,
  attachParentTenant,
  tenantForStore,
  tenantsForStores,
  storeIdOf,
  STORE_TENANT_REQUIRED,
  StoreTenantRequiredError,
  storeTenantResponder,
  storeTenantBody
}
