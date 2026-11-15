'use strict'

// Laundry promo evaluation. Mirrors FE-LAUNDRY `src/lib/laundry-promos.js`
// so the server total equals the cashier screen (BR-LDY promo rules):
// - a typed code applies only the campaign with that code (case-insensitive);
//   campaigns without a code are automatic;
// - the discount base is the subtotal of the eligible service lines — never
//   the turnaround surcharge;
// - non-stackable candidates → the single best (amount desc, priority asc,
//   id asc); all stackable → applied in priority order on what is left of
//   each line, allocated by largest remainder;
// - the total discount never exceeds the subtotal.

const db = require('../../db/models')
const { Op } = require('sequelize')
const { getStoreClock, DEFAULT_TIMEZONE } = require('../../utils/businessDate')
const { allocateProportionally } = require('./laundryPricing')

const parseExtra = (description) => {
  if (!description || typeof description !== 'string') return {}
  try {
    const value = JSON.parse(description)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

// Discount definition: campaign-level fields (what FE-LAUNDRY saves), else
// the first active percentage/fixed reward (F&B-style campaigns).
const discountRuleOf = (campaign) => {
  const value = Number(campaign.discountValue) || 0
  if (value > 0 && ['percentage', 'fixed'].includes(campaign.discountType)) {
    return {
      kind: campaign.discountType === 'percentage' ? 'percent' : 'fixed',
      value,
      cap: Number(campaign.maxDiscount) || 0
    }
  }
  const reward = (campaign.rewards || []).find(
    (r) => r.isActive !== false && ['discount_percentage', 'discount_fixed'].includes(r.rewardType)
  )
  if (!reward || !(Number(reward.rewardValue) > 0)) return null
  return {
    kind: reward.rewardType === 'discount_percentage' ? 'percent' : 'fixed',
    value: Number(reward.rewardValue),
    cap: Number(reward.maxRewardValue) || 0
  }
}

const amountFor = (rule, base) => {
  if (!rule || base <= 0) return 0
  if (rule.kind === 'percent') {
    const raw = Math.round((base * rule.value) / 100)
    const capped = rule.cap > 0 ? Math.min(raw, rule.cap) : raw
    return Math.max(0, Math.min(base, capped))
  }
  return Math.max(0, Math.min(base, Math.round(rule.value)))
}

const scopeLines = (campaign, lines) => {
  const ids = Array.isArray(campaign.applicableIds) ? campaign.applicableIds.map(Number) : []
  if (['specific_products', 'product'].includes(campaign.applicableTo) && ids.length) {
    return lines.filter((line) => ids.includes(Number(line.productId)))
  }
  return lines
}

const refusal = (code, message) => ({ code, message })

const checkEligibility = async (campaign, ctx) => {
  const storeIds = campaign.store == null ? [] : Array.isArray(campaign.store) ? campaign.store : [campaign.store]
  if (storeIds.length && !storeIds.map(Number).includes(Number(ctx.store))) {
    return { ok: false, reason: 'Tidak berlaku di outlet ini' }
  }
  const extra = parseExtra(campaign.description)
  const channels = Array.isArray(extra.channels) ? extra.channels : []
  if (channels.length && !channels.includes(ctx.orderType)) {
    return { ok: false, reason: 'Tidak berlaku untuk mode ini' }
  }
  if (Array.isArray(campaign.daysOfWeek) && campaign.daysOfWeek.length && !campaign.daysOfWeek.includes(ctx.clock.day)) {
    return { ok: false, reason: 'Tidak berlaku hari ini' }
  }
  if (campaign.startTime && campaign.endTime && (ctx.clock.time < campaign.startTime || ctx.clock.time > campaign.endTime)) {
    return { ok: false, reason: 'Di luar jam promo' }
  }
  const eligible = scopeLines(campaign, ctx.lines)
  if (!eligible.length) return { ok: false, reason: 'Layanan tidak cocok' }
  const base = eligible.reduce((sum, line) => sum + line.subtotal, 0)
  if (base < (Number(campaign.minPurchase) || 0)) {
    return { ok: false, reason: 'Belum mencapai minimum belanja' }
  }
  if (extra.memberOnly && !ctx.customerId) return { ok: false, reason: 'Khusus member' }
  if (campaign.maxUsageTotal && (Number(campaign.currentUsage) || 0) >= Number(campaign.maxUsageTotal)) {
    return { ok: false, reason: 'Kuota promo habis' }
  }
  if (campaign.maxUsagePerMember) {
    if (!ctx.customerId) return { ok: false, reason: 'Pelanggan diperlukan' }
    const used = await db.promo_usage.count({
      where: { campaignId: campaign.id, memberId: ctx.customerId },
      transaction: ctx.transaction
    })
    if (used >= Number(campaign.maxUsagePerMember)) {
      return { ok: false, reason: 'Batas pemakaian pelanggan tercapai' }
    }
  }
  const rule = discountRuleOf(campaign)
  const amount = amountFor(rule, base)
  if (amount <= 0) return { ok: false, reason: 'Promo tidak memberi potongan' }
  return { ok: true, rule, eligible, amount }
}

const byPriority = (a, b) =>
  (Number(a.campaign.priority) || 0) - (Number(b.campaign.priority) || 0) ||
  Number(a.campaign.id) - Number(b.campaign.id)

const chooseDiscounts = (candidates) => {
  if (!candidates.length) return []
  const nonStackable = candidates.filter((c) => !c.campaign.isCombinable)
  if (nonStackable.length) {
    const best = [...nonStackable].sort((a, b) => b.amount - a.amount || byPriority(a, b))[0]
    const shares = allocateProportionally(best.amount, best.eligible.map((l) => l.subtotal))
    return [{ ...best, allocations: best.eligible.map((l, i) => ({ productId: l.productId, amount: shares[i] })) }]
  }
  const remaining = new Map()
  candidates.forEach((c) => c.eligible.forEach((l) => remaining.set(l.productId, (remaining.get(l.productId) ?? l.subtotal))))
  const selected = []
  for (const candidate of [...candidates].sort(byPriority)) {
    const eligible = candidate.eligible.filter((l) => (remaining.get(l.productId) || 0) > 0)
    if (!eligible.length) continue
    const weights = eligible.map((l) => remaining.get(l.productId) || 0)
    const base = weights.reduce((sum, w) => sum + w, 0)
    const amount = amountFor(candidate.rule, base)
    if (amount <= 0) continue
    const shares = allocateProportionally(amount, weights)
    const allocations = eligible.map((l, i) => ({ productId: l.productId, amount: shares[i] }))
    allocations.forEach((a) => remaining.set(a.productId, Math.max(0, (remaining.get(a.productId) || 0) - a.amount)))
    selected.push({ ...candidate, amount, allocations })
  }
  return selected
}

/**
 * @param {object} args
 * @param {number} args.store outlet id
 * @param {number|null} args.tenantId outlet tenant
 * @param {Array<{productId:number, subtotal:number}>} args.lines
 * @returns {Promise<{discounts:Array, discountAmount:number, error:null|{code:string,message:string}}>}
 */
const evaluateLaundryPromos = async ({
  store,
  tenantId,
  lines,
  customerId = null,
  promoCode = null,
  orderType = 'full',
  timezone = DEFAULT_TIMEZONE,
  now = new Date(),
  transaction
}) => {
  const subtotal = lines.reduce((sum, l) => sum + l.subtotal, 0)
  // one line per service so allocations stay unambiguous
  const merged = []
  lines.forEach((l) => {
    const found = merged.find((m) => m.productId === l.productId)
    if (found) found.subtotal += l.subtotal
    else merged.push({ productId: l.productId, subtotal: l.subtotal })
  })
  const campaigns = await db.promo_campaign.findAll({
    where: {
      status: 'active',
      tenantId: tenantId ?? null,
      startDate: { [Op.lte]: now },
      endDate: { [Op.gte]: now }
    },
    include: [{ model: db.promo_reward, as: 'rewards', required: false }],
    transaction
  })
  const ctx = { store, orderType, customerId, lines: merged, clock: getStoreClock(timezone, now), transaction }
  const code = String(promoCode || '').trim().toLowerCase()
  const isCode = (c) => String(c.code || '').trim() !== ''
  const candidates = []
  let error = null

  if (code) {
    const matching = campaigns.filter((c) => String(c.code || '').trim().toLowerCase() === code)
    if (!matching.length) {
      error = refusal('PROMO_NOT_FOUND', 'Kode promo tidak ditemukan')
    } else {
      const verdict = await checkEligibility(matching[0], ctx)
      if (verdict.ok) candidates.push({ campaign: matching[0], ...verdict })
      else error = refusal('PROMO_NOT_ELIGIBLE', verdict.reason)
    }
  }
  for (const campaign of campaigns.filter((c) => !isCode(c))) {
    const verdict = await checkEligibility(campaign, ctx)
    if (verdict.ok) candidates.push({ campaign, ...verdict })
  }

  const chosen = chooseDiscounts(candidates)
  let left = subtotal
  const discounts = []
  for (const d of chosen) {
    const amount = Math.min(left, d.amount)
    if (amount <= 0) continue
    left -= amount
    discounts.push({
      campaignId: d.campaign.id,
      name: d.campaign.name,
      code: d.campaign.code || null,
      amount,
      allocations: d.allocations
    })
  }
  return {
    discounts,
    discountAmount: discounts.reduce((sum, d) => sum + d.amount, 0),
    error
  }
}

module.exports = { evaluateLaundryPromos, amountFor, chooseDiscounts }
