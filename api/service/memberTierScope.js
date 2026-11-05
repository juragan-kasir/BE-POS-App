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
const {
  visibleWhere,
  canWrite,
  storeForNew
} = require('../../utils/ownedOrSharedScope')

const ACTIVE_STATUS = { [Op.or]: ['active', 'true'] }

// Read: own outlets' tiers + shared defaults. Write: own tiers only (shared
// ones for a global caller). See utils/ownedOrSharedScope.js.
const visibleTierWhere = (req, where = {}) => visibleWhere(req, where)
const canWriteTier = (req, tier) => canWrite(req, tier)
const storeForNewTier = (req) => storeForNew(req)

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
