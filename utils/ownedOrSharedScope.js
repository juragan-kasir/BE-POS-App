'use strict'

// Master data that is owned per outlet, with legacy shared rows (owner
// decision 2026-11-05, wave 4 by-id sweep: member tiers, supplier
// categories, departments, ingredient categories are per tenant).
//
// A row belongs to the outlet that created it (`store`). Rows with
// `store = null` are the shared defaults that existed before the data was
// scoped: every outlet can read them, only a global caller can change them.
const { Op } = require('sequelize')
const { callerStoreIds, storeIdsCondition } = require('./tenantScope')

// WHERE for the rows a caller may read: its own outlets' rows plus the
// shared ones. A global caller reads every row.
async function visibleWhere(req, where = {}, column = 'store') {
  const ids = await callerStoreIds(req)
  if (ids === null) return { ...where }
  return {
    ...where,
    [Op.and]: [
      ...(where[Op.and] || []),
      { [Op.or]: [{ [column]: null }, { [column]: storeIdsCondition(ids) }] }
    ]
  }
}

// WHERE for rows the caller owns (no shared rows). A global caller owns all.
async function ownedWhere(req, where = {}, column = 'store') {
  const ids = await callerStoreIds(req)
  if (ids === null) return { ...where }
  return { ...where, [column]: storeIdsCondition(ids) }
}

// A caller may change a row of one of its own outlets; shared rows only
// when it is global.
async function canWrite(req, row, column = 'store') {
  const ids = await callerStoreIds(req)
  if (ids === null) return true
  return row[column] != null && ids.includes(Number(row[column]))
}

// The outlet a new row belongs to, or { error } when the caller may not
// create one there. A global caller without an outlet creates a shared row.
async function storeForNew(req) {
  const ids = await callerStoreIds(req)
  const requested = Number(req.storeId ?? req.user?.store)
  const store = Number.isInteger(requested) && requested > 0 ? requested : null
  if (ids === null) return { store }
  if (store == null || !ids.includes(store)) return { error: true }
  return { store }
}

module.exports = { visibleWhere, ownedWhere, canWrite, storeForNew }
