'use strict'
const db = require('../../db/models')
const { Op } = require('sequelize')

// Single authoritative path for mutating a member's point balance, mirroring
// stockMutationService.adjustProductStock exactly: lock the row first,
// apply the change as an atomic SQL delta (not a JS-computed
// read-then-write), so two concurrent redemptions/earns for the same
// member — two terminals redeeming the same member's points at once, or a
// redeem racing an earn — can never lose an update.
//
// Callers MUST already be inside a transaction and pass it in.

/**
 * @param {object} params
 * @param {number} params.memberId
 * @param {number} params.deltaPoints - signed; negative for redemption
 * @param {number} [params.deltaLifetimePoints=0] - only ever positive in
 *   practice (lifetime total never decreases on redemption)
 * @param {number|null} [params.referenceId] - member_point_history.transactionId
 * @param {string|null} [params.notes]
 * @param {number|null} [params.createdBy]
 * @param {import('sequelize').Transaction} params.transaction - required
 * @param {boolean} [params.floorAtZero=true]
 * @returns {Promise<{member:object, pointsBefore:number, pointsAfter:number}|null>}
 *   null if delta is a no-op or the member doesn't exist.
 */
async function adjustMemberPoints({
  memberId,
  deltaPoints,
  deltaLifetimePoints = 0,
  referenceId = null,
  notes = null,
  createdBy = null,
  transaction,
  floorAtZero = true
}) {
  if (!transaction) {
    throw new Error('adjustMemberPoints requires an explicit transaction')
  }
  const delta = Math.trunc(Number(deltaPoints)) || 0
  const lifetimeDelta = Math.trunc(Number(deltaLifetimePoints)) || 0
  if (delta === 0 && lifetimeDelta === 0) return null

  const member = await db.member.findByPk(memberId, {
    transaction,
    lock: transaction.LOCK.UPDATE
  })
  if (!member) return null

  const pointsBefore = Number(member.totalPoints) || 0
  const literal = floorAtZero
    ? `GREATEST("totalPoints" + (${delta}), 0)`
    : `"totalPoints" + (${delta})`
  const pointsAfter = floorAtZero
    ? Math.max(pointsBefore + delta, 0)
    : pointsBefore + delta

  const updateData = { totalPoints: db.sequelize.literal(literal) }
  if (lifetimeDelta !== 0) {
    updateData.lifetimePoints = db.sequelize.literal(
      `"lifetimePoints" + (${lifetimeDelta})`
    )
  }
  await member.update(updateData, { transaction })
  member.totalPoints = pointsAfter

  await db.member_point_history.create(
    {
      member: memberId,
      pointsChange: delta,
      pointsBefore,
      pointsAfter,
      transactionId: referenceId,
      notes,
      createdBy
    },
    { transaction }
  )

  return { member, pointsBefore, pointsAfter }
}

// Re-evaluates and (if warranted) applies a tier upgrade for an
// already-locked member instance, inside the same transaction as the point
// adjustment that triggered it. Never downgrades — matches the original
// inline logic in order.js exactly (only moves up if the new tier's
// minPoints exceeds the current tier's).
async function maybeUpgradeMemberTier({ member, transaction }) {
  const newTotal = Number(member.totalPoints) || 0
  let targetTier = await db.member_tier.findOne({
    where: {
      status: 'active',
      minPoints: { [Op.lte]: newTotal },
      maxPoints: { [Op.gte]: newTotal }
    },
    order: [['minPoints', 'DESC']],
    transaction
  })
  if (!targetTier) {
    targetTier = await db.member_tier.findOne({
      where: { status: 'active', minPoints: { [Op.lte]: newTotal } },
      order: [['minPoints', 'DESC']],
      transaction
    })
  }
  if (!targetTier) return
  const currentTierRow = member.tier
    ? await db.member_tier.findByPk(member.tier, { transaction })
    : null
  const currentMin = Number(currentTierRow?.minPoints ?? -1)
  if (Number(targetTier.minPoints) > currentMin) {
    await member.update({ tier: targetTier.id }, { transaction })
  }
}

// DR-16: the single approved earning formula — sum of product.point x
// quantity over the given items. Items may carry `product` or `productId`
// (both shapes occur in order flows). Pure read; callers own locking.
async function computeEarnedPoints(items, transaction) {
  const list = Array.isArray(items) ? items : []
  const productIds = [...new Set(list.map((i) => i.product || i.productId).filter(Boolean))]
  if (productIds.length === 0) return 0
  const products = await db.product.findAll({
    where: { id: productIds },
    attributes: ['id', 'point'],
    transaction
  })
  const pointMap = Object.fromEntries(
    products.map((p) => [p.id, Number(p.point) || 0])
  )
  return list.reduce((sum, item) => {
    const pid = item.product || item.productId
    return sum + (pointMap[pid] || 0) * Number(item.quantity)
  }, 0)
}

// DR-16: award earned points exactly once per order. The member_point_history
// rows written by prior awards are the durable guard — checked inside the
// caller's transaction (which must already hold the order row lock), so two
// concurrent completions (settlement retry, split-pay vs status update)
// cannot both award. Notes prefix 'Earned ' is the award marker (the only
// writer of such rows); 'Restored '/'Reversed ' rows never match it.
async function awardEarnedPointsOnce({
  orderId,
  orderNumber,
  memberId,
  items,
  userId = null,
  transaction
}) {
  if (!memberId) return null
  const prior = await db.member_point_history.findOne({
    where: {
      member: memberId,
      transactionId: String(orderId),
      notes: { [Op.like]: 'Earned %' }
    },
    transaction
  })
  if (prior) return { alreadyAwarded: true }
  const pointsEarned = await computeEarnedPoints(items, transaction)
  if (!(pointsEarned > 0)) return null
  const result = await adjustMemberPoints({
    memberId,
    deltaPoints: pointsEarned,
    deltaLifetimePoints: pointsEarned,
    referenceId: orderId,
    notes: `Earned ${pointsEarned} points from order ${orderNumber}`,
    createdBy: userId,
    transaction
  })
  if (result) {
    await maybeUpgradeMemberTier({ member: result.member, transaction })
  }
  return result
}

// DR-16: reverse previously earned points for a cancelled/voided/refunded
// purchase. Totals are derived from the ledger in-transaction (earned minus
// prior reversals for this order), so the call is a safe no-op when nothing
// was earned and can never reverse more than the original award across
// multiple partial refunds. `items` are the reversed units in the same
// shape as computeEarnedPoints — the same approved formula applied to the
// returned portion, so no new rounding policy is introduced.
async function reverseEarnedPoints({
  orderId,
  orderNumber,
  memberId,
  items,
  userId = null,
  transaction,
  reason
}) {
  if (!memberId) return null
  const rows = await db.member_point_history.findAll({
    where: { member: memberId, transactionId: String(orderId) },
    transaction
  })
  const earned = rows
    .filter((r) => String(r.notes || '').startsWith('Earned '))
    .reduce((s, r) => s + Number(r.pointsChange), 0)
  const reversed = rows
    .filter((r) => String(r.notes || '').startsWith('Reversed '))
    .reduce((s, r) => s + Math.abs(Number(r.pointsChange)), 0)
  const remaining = earned - reversed
  if (!(remaining > 0)) return null
  const computed = await computeEarnedPoints(items, transaction)
  const amount = Math.min(Math.trunc(Number(computed)) || 0, Math.trunc(remaining))
  if (!(amount > 0)) return null
  return adjustMemberPoints({
    memberId,
    deltaPoints: -amount,
    deltaLifetimePoints: -amount,
    referenceId: orderId,
    notes: `Reversed ${amount} earned points from order ${orderNumber} (${reason})`,
    createdBy: userId,
    transaction
  })
}

module.exports = { adjustMemberPoints, maybeUpgradeMemberTier, computeEarnedPoints, awardEarnedPointsOnce, reverseEarnedPoints }
