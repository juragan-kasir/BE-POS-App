'use strict'
const { Op } = require('sequelize')
const { isSuperAdmin } = require('../../../utils/tenantScope')

/**
 * Returns the authoritative store for a report query:
 * - super_admin: explicitly requested store from req.storeId (if ?store was passed), or null (global)
 * - non-super_admin: req.storeId ?? req.user?.store ?? null
 * Client-controlled req.cookies.store, req.query.store, and req.body.store are NEVER used for tenant authorization.
 */
function getReportStore(req) {
  if (isSuperAdmin(req)) {
    return req.storeId !== undefined ? req.storeId : null
  }
  return req.storeId ?? req.user?.store ?? null
}

function assertReportStore(req) {
  const store = getReportStore(req)
  if (!store && !isSuperAdmin(req)) {
    const err = new Error('Store assignment required')
    err.statusCode = 403
    throw err
  }
  return store
}

/**
 * PGA-11: the outlet SET a report aggregates. validateStoreAccess puts a
 * multi-outlet owner's whole tenant roster in req.storeIds (and only the
 * first outlet in req.storeId), or exactly the picked outlet with ?store.
 * Reading the scalar showed a consolidated report of outlet 1 only.
 * [] = every outlet (the vendor's global view).
 */
function getReportStores(req) {
  const ids = Array.isArray(req.storeIds)
    ? req.storeIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : []
  if (ids.length > 0) return [...new Set(ids)]
  const one = getReportStore(req)
  return one ? [Number(one)] : []
}

// Sequelize WHERE fragment for a scalar `store` column.
function storeWhere(stores, column = 'store') {
  if (!stores || stores.length === 0) return {}
  return { [column]: stores.length === 1 ? stores[0] : { [Op.in]: stores } }
}

module.exports = { getReportStore, assertReportStore, getReportStores, storeWhere }
