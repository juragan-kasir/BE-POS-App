'use strict'
const db = require('../../db/models')

// Locks the campaign row, re-validates maxUsageTotal under that lock, and
// atomically increments currentUsage — closing the check-then-act race
// where two concurrent orders both read currentUsage below the limit and
// both incremented, letting a capped campaign be redeemed more times than
// intended (the unlocked `campaign.update({currentUsage: currentUsage+1})`
// this replaces could silently lose one side of that race).
//
// Callers MUST already be inside a transaction and pass it in.
//
// Returns:
//   { campaign, usage }        - recorded normally
//   { notFound: true }         - campaignId doesn't exist
//   { limitReached: true, campaign }       - maxUsageTotal already hit
//   { memberLimitReached: true, campaign } - maxUsagePerMember already hit
// Callers decide what a limit hit means for them: promo.js's standalone
// endpoint rejects the request outright (this mirrors what it already did,
// just now race-safe); order.js's checkout-embedded promo application
// treats it as "don't record usage" without failing the order, since the
// order's totals were already computed before this point and the whole
// point of putting stock/payment ahead of this in transaction ordering is
// that a promo-counter edge case must never roll back an otherwise-valid
// paid order.
async function incrementPromoUsage({
  campaignId,
  orderId = null,
  memberId = null,
  discountApplied = 0,
  freeItemsGiven = null,
  pointsMultiplier = 1,
  cashbackAmount = 0,
  createdBy = null,
  transaction,
  enforcePerMemberLimit = true
}) {
  if (!transaction) {
    throw new Error('incrementPromoUsage requires an explicit transaction')
  }
  // PGA-04: FOR NO KEY UPDATE, not FOR UPDATE. The checkout inserts the
  // order (order.promoCampaignId → promo_campaign FK) before it records the
  // usage, and that FK insert holds FOR KEY SHARE on this campaign row until
  // commit. FOR UPDATE conflicts with KEY SHARE, so two checkouts using one
  // campaign each held KEY SHARE and waited for the other's — a guaranteed
  // deadlock under load (audit 60-load: 428 deadlocks, 233 × 500). FOR NO
  // KEY UPDATE does not conflict with KEY SHARE but still conflicts with
  // itself, so concurrent increments stay serialized and the maxUsageTotal
  // re-check below stays race-safe. The UPDATE of currentUsage (a non-key
  // column) takes the same lock mode.
  const campaign = await db.promo_campaign.findByPk(campaignId, {
    transaction,
    lock: transaction.LOCK.NO_KEY_UPDATE
  })
  if (!campaign) return { notFound: true }

  const currentUsage = Number(campaign.currentUsage) || 0
  if (
    campaign.maxUsageTotal &&
    currentUsage >= Number(campaign.maxUsageTotal)
  ) {
    return { limitReached: true, campaign }
  }

  if (enforcePerMemberLimit && campaign.maxUsagePerMember && memberId) {
    const memberUsage = await db.promo_usage.count({
      where: { campaignId, memberId },
      transaction
    })
    if (memberUsage >= Number(campaign.maxUsagePerMember)) {
      return { memberLimitReached: true, campaign }
    }
  }

  const usage = await db.promo_usage.create(
    {
      store: campaign.store,
      campaignId,
      orderId,
      memberId,
      discountApplied: discountApplied || 0,
      freeItemsGiven,
      pointsMultiplier: pointsMultiplier || 1,
      cashbackAmount: cashbackAmount || 0,
      appliedAt: new Date(),
      createdBy
    },
    { transaction }
  )

  await campaign.update(
    { currentUsage: db.sequelize.literal('"currentUsage" + 1') },
    { transaction }
  )
  campaign.currentUsage = currentUsage + 1

  return { campaign, usage }
}

module.exports = { incrementPromoUsage }
