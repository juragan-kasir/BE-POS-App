'use strict'

// Member tiers per tenant (owner decision 2026-11-05, wave 4 by-id sweep).
//
// A tier belongs to the outlet that created it (`member_tier.store`). Rows
// with `store = null` are the shared defaults that existed before tiers
// were scoped: every outlet can see them, only a global super_admin can
// change them. A member is graded on its own outlet's ladder when that
// outlet has active tiers, otherwise on the shared defaults — so a tier
// one tenant creates can never change another tenant's members.
const { Op } = require('sequelize')
const { callerStoreIds, storeIdsCondition } = require('../../utils/tenantScope')

const ACTIVE_STATUS = { [Op.or]: ['active', 'true'] }

// WHERE for the tiers a caller may read: its own outlets' tiers plus the
// shared defaults. A global caller sees every tier.
async function visibleTierWhere(req, where = {}) {
  const ids = await callerStoreIds(req)
  if (ids === null) return { ...where }
  return {
    ...where,
    [Op.and]: [
      { [Op.or]: [{ store: null }, { store: storeIdsCondition(ids) }] }
    ]
  }
}

// A caller may change a tier of one of its own outlets. Shared defaults are
// read-only for everyone but a global caller.
async function canWriteTier(req, tier) {
  const ids = await callerStoreIds(req)
  if (ids === null) return true
  return tier.store != null && ids.includes(Number(tier.store))
}

// The outlet a new tier belongs to, or { error } when the caller may not
// create one there. A global caller without an outlet creates a shared one.
async function storeForNewTier(req) {
  const ids = await callerStoreIds(req)
  const requested = Number(req.storeId ?? req.user?.store)
  const store = Number.isInteger(requested) && requested > 0 ? requested : null
  if (ids === null) return { store }
  if (store == null || !ids.includes(store)) return { error: true }
  return { store }
}

// Active tiers that grade a member of `storeId`, highest minPoints first.
async function activeLadder(
  db,
  storeId,
  { transaction, status = ACTIVE_STATUS } = {}
) {
  const order = [['minPoints', 'DESC']]
  if (storeId != null) {
    const own = await db.member_tier.findAll({
      where: { status, store: storeId },
      order,
      transaction
    })
    if (own.length) return own
  }
  return db.member_tier.findAll({
    where: { status, store: null },
    order,
    transaction
  })
}

// The highest tier whose range holds the points. With `fallback` (the
// loyalty upgrade path), else the highest tier whose minimum is reached —
// the same choices the inline code always made.
function pickTier(ladder, points, { fallback = false } = {}) {
  const total = Number(points) || 0
  return (
    ladder.find(
      (t) => Number(t.minPoints) <= total && Number(t.maxPoints) >= total
    ) ||
    (fallback ? ladder.find((t) => Number(t.minPoints) <= total) : null) ||
    null
  )
}

module.exports = {
  ACTIVE_STATUS,
  visibleTierWhere,
  canWriteTier,
  storeForNewTier,
  activeLadder,
  pickTier
}
