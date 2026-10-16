const crypto = require('crypto')
const db = require('../../db/models')
const Order = db.order
const OrderItem = db.order_item
const OrderStatus = db.order_status
const Table = db.table
const Product = db.product
const Discount = db.discount
const { Op } = require('sequelize')
const { fetchActiveTaxRows, pickAppliedPpn } = require('../../utils/taxResolution')
const { createNotification } = require('../../utils/createNotification')
const { createAudit, redactAndAudit, AUDIT_ACTIONS } = require('../../utils/auditLog')
const {
  hasCapability,
  auditCapabilityDenial,
  denialBody
} = require('../../utils/financialCapabilities')
const { emitItemStatusUpdate, emitNewOrder } = require('../service/socket')
const batchService = require('../service/batchService')
const { adjustMemberPoints, maybeUpgradeMemberTier, computeEarnedPoints, awardEarnedPointsOnce, reverseEarnedPoints } = require('../service/loyaltyService')
const { incrementPromoUsage } = require('../service/promoUsageService')
const {
  enqueueAccountingJob,
  attemptJob,
  recordImmediateAttempt
} = require('../service/accountingOutboxService')
const {
  adjustIngredientStockBatch,
  resolveBomIngredientRequirements
} = require('../service/stockMutationService')
const { withDeadlockRetry } = require('../../utils/deadlockRetry')
const {
  FINANCIAL_STATES,
  TERMINAL_FULFILMENT,
  computeOrderFinancials,
  legacyPaymentStatusFor,
  financialError,
  retirePendingSplits
} = require('../service/orderFinancials')
const { normalizePaymentMethod, requiresTenderReference } = require('../service/canonicalPayment')
const { assertSettlementReferenceUnused } = require('../service/settlementReference')
const {
  counterOrderMismatches,
  customerOrderMismatches,
  idempotencyMismatchBody,
  existingOrderSummary
} = require('../service/orderIdempotency')
const { resolveAttributedRegister } = require('../service/settlementAttribution')

// DR-23 interim compatibility mapping for the elevated `order.void`
// capability (DR-12 memberships are not wired yet): legacy admin roles only.
// DR-23 §J: capability required to move an order to a financial status
// (interim legacy-role mapping lives in utils/financialCapabilities).
// Fulfilment-only transitions are not capability-gated here.
const STATUS_CAPABILITY = Object.freeze({
  paid: 'payment.collect',
  cancelled: 'order.cancel',
  void: 'order.void'
})
// An order created by createCustomerOrder (QR/BISA-MAKAN): it always writes
// source 'qr' and never sets createdBy, while createOrder (POS) always
// records the authenticated creator — and accepts a client-supplied source,
// including 'qr' — so source alone cannot identify the channel.
const isQrChannelOrder = (order) => order?.source === 'qr' && order?.createdBy == null

// FND-001 (security): escape every untrusted string that is interpolated into
// the raw-HTML receipt template at the output boundary. The receipt endpoint
// returns text/html (not React-rendered), so browser-side escaping never
// applies here — values must be encoded server-side before interpolation.
const _escapeHtml = (value) =>
  String(value == null ? '' : value).replace(
    /[&<>"']/g,
    (ch) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[ch]
  )

// ponytail: validFrom/validUntil opsional — null berarti selalu berlaku
const isBundleWithinValidityPeriod = (bundle, now = new Date()) => {
  const validFrom = bundle.validFrom ? new Date(bundle.validFrom) : null
  const validUntil = bundle.validUntil ? new Date(bundle.validUntil) : null
  if (validFrom && isNaN(validFrom.getTime())) return true
  if (validUntil && isNaN(validUntil.getTime())) return true
  if (validFrom && validFrom > now) return false
  if (validUntil && validUntil < now) return false
  return true
}

let _productStoreExists = null
let _categoryStoreExists = null
let _orderPromoCampaignCol = null
let _orderSessionCol = null
let _orderRedeemedPointsCol = null
const hasTable = async (tableName) => {
  if (tableName === 'product_store') {
    if (_productStoreExists !== null) return _productStoreExists
  } else if (tableName === 'category_store') {
    if (_categoryStoreExists !== null) return _categoryStoreExists
  }
  try {
    await db.sequelize.query(`SELECT 1 FROM ${tableName} LIMIT 1`)
    if (tableName === 'product_store') _productStoreExists = true
    if (tableName === 'category_store') _categoryStoreExists = true
    return true
  } catch {
    if (tableName === 'product_store') _productStoreExists = false
    if (tableName === 'category_store') _categoryStoreExists = false
    return false
  }
}

const hasOrderColumn = async (colName) => {
  if (colName === 'promoCampaignId') {
    if (_orderPromoCampaignCol !== null) return _orderPromoCampaignCol
    try {
      const [results] = await db.sequelize.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'order' AND column_name = '${colName}' LIMIT 1`
      )
      _orderPromoCampaignCol = results.length > 0
      return _orderPromoCampaignCol
    } catch {
      _orderPromoCampaignCol = false
      return false
    }
  }
  if (colName === 'session') {
    if (_orderSessionCol !== null) return _orderSessionCol
    try {
      const [results] = await db.sequelize.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'order' AND column_name = 'session' LIMIT 1`
      )
      _orderSessionCol = results.length > 0
      return _orderSessionCol
    } catch {
      _orderSessionCol = false
      return false
    }
  }
  if (colName === 'redeemedPoints') {
    if (_orderRedeemedPointsCol !== null) return _orderRedeemedPointsCol
    try {
      const [results] = await db.sequelize.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'order' AND column_name = 'redeemedPoints' LIMIT 1`
      )
      _orderRedeemedPointsCol = results.length > 0
      return _orderRedeemedPointsCol
    } catch {
      _orderRedeemedPointsCol = false
      return false
    }
  }
  return true
}

const getOrderAttributes = async () => {
  const exclude = []
  if (!(await hasOrderColumn('promoCampaignId'))) {
    exclude.push('promoCampaignId')
  }
  if (!(await hasOrderColumn('session'))) {
    exclude.push('session')
  }
  if (!(await hasOrderColumn('redeemedPoints'))) {
    exclude.push('redeemedPoints')
  }
  if (exclude.length === 0) return undefined
  return { exclude }
}

const generateOrderNumber = () => {
  const date = new Date()
  const timestamp = date.getTime().toString().slice(-8)
  const random = Math.random().toString(36).substring(2, 6).toUpperCase()
  return `ORD${timestamp}${random}`
}

// F-04: the idempotent-replay recovery must only engage when the unique
// constraint that fired is one of the ORDER-header uniqueness indexes a
// same-intent replay can legitimately explain — the (store, idempotencyKey)
// partial index, plus the orderNumber/publicToken full-unique indexes (a
// same-key race loser can collide on any of them). Any OTHER constraint
// (an order_item or child-table unique, a future index) must NOT be misread
// as a replay: fail closed so a real failure is never masked as a 200.
//
// Note the index name is lowercase 'idempotencykey' — the migration declared
// the index unquoted, and PostgreSQL folds unquoted identifiers to lowercase.
const ORDER_REPLAY_UNIQUE_CONSTRAINTS = [
  'order_store_idempotencykey_unique',
  'order_orderNumber_key',
  'order_public_token_unique'
]
const isOrderReplayRelevantUniqueError = (error) =>
  error?.name === 'SequelizeUniqueConstraintError' &&
  ORDER_REPLAY_UNIQUE_CONSTRAINTS.includes(
    error?.parent?.constraint || error?.original?.constraint
  )

// F-IDEM-1 / DR-23 §K: same-key intent comparison lives in
// service/orderIdempotency.js (replayCounterOrder / replayCustomerOrder below).

// W3-2: client/server price-mismatch contract. items[].expectedPrice is an
// optional client echo of the final charged unit price for that line
// (outlet/base catalog + server-derived option/variant/modifier markup,
// before quantity/discount/tax/service). It is comparison-only: the server
// re-resolves every line and, when any supplied expectation differs, answers
// 409 BEFORE totals or any write so the client can show the fresh price and
// resubmit. Omission skips enforcement (legacy clients unaffected).
const PRICE_CHANGED_CODE = 'PRICE_CHANGED'
const PRICE_CHANGED_MESSAGE =
  'One or more item prices changed. Please review the updated prices and resubmit.'
const buildPriceMismatchBody = (mismatches) => ({
  code: PRICE_CHANGED_CODE,
  message: PRICE_CHANGED_MESSAGE,
  items: mismatches
})

// Normalizes a supplied expectedPrice: absent (undefined/null/'') means the
// line is not enrolled in mismatch enforcement. Present values must be
// finite integers >= 0 — anything else is a 400, never a 409.
const parseExpectedPrice = (value) => {
  if (value === undefined || value === null || value === '') return { present: false }
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    return { present: true, valid: false }
  }
  return { present: true, valid: true, value: n }
}

// Single source of truth for the "store row wins, else base stock" rule used
// by BOTH order validation (getEffectiveStock) and the public customer menu
// (batched lookup in getCustomerMenu) so the two paths can never drift.
// product_store_stock.stock is NOT NULL DEFAULT 0 — a present row is always
// authoritative, and an explicit zero is a real zero, never "missing".
const resolveEffectiveStock = (product, pssRow) => {
  const base =
    product && product.stock !== null && product.stock !== undefined
      ? Number(product.stock)
      : null
  return pssRow && pssRow.stock !== null && pssRow.stock !== undefined
    ? Number(pssRow.stock)
    : base
}

// Resolve effective stock for a product in a store. Uses the store-specific
// stock row (product_store_stock) when present, otherwise falls back to the
// base product stock. This matches how the cashier UI displays stock and how
// stock is deducted on sale (both base and per-store are kept in sync).
const getEffectiveStock = async (product, store) => {
  if (!product || !store) return null
  try {
    const pss = await db.product_store_stock.findOne({
      where: { product: product.id, store }
    })
    return resolveEffectiveStock(product, pss)
  } catch {
    // product_store_stock table may not exist; fall back to base stock
    return resolveEffectiveStock(product, null)
  }
}

// Batched per-store effective stock for a set of products — semantically
// identical to getEffectiveStock(product, store) but a single query, so the
// public customer menu does not run an N+1 per product. Returns
// Map<productId, effectiveStock>.
const getEffectiveStockMap = async (products, store) => {
  const productById = new Map(
    products.filter((p) => p && p.id != null).map((p) => [String(p.id), p])
  )
  const map = new Map()
  for (const [id] of productById) map.set(id, resolveEffectiveStock(productById.get(id), null))
  if (!map.size || !store) return map
  try {
    const rows = await db.product_store_stock.findAll({
      where: { product: Array.from(productById.keys()), store },
      attributes: ['product', 'stock']
    })
    for (const row of rows) {
      map.set(String(row.product), resolveEffectiveStock(productById.get(String(row.product)), row))
    }
  } catch {
    // product_store_stock table may not exist; every product falls back to base stock
  }
  return map
}

// W3-1 (DR-11): batched per-store effective catalog price lives in
// utils/outletPricing (single authoritative rule shared with checkout).
const {
  resolveCatalogBase,
  getEffectivePriceMap
} = require('../../utils/outletPricing')

// AUD-2 (security): store-tenancy guards for the public customer-order
// mutation surface. A product is orderable through a store when it is
// explicitly assigned to that store (product_store row) OR it has no
// product_store rows at all (unassigned/global) — the exact rule the
// customer menu applies (getCustomerMenu). A product assigned to a
// different store is treated exactly like a product this store does not
// have, so foreign and nonexistent products are indistinguishable.
const isProductOrderableAtStore = async (productId, store) => {
  if (!productId || !store) return false
  try {
    const rows = await db.product_store.findAll({
      where: { product: productId }
    })
    if (!rows.length) return true
    return rows.some((r) => Number(r.store) === Number(store))
  } catch {
    // product_store table may not exist yet; nothing is store-assigned, so
    // every product behaves like the legacy global product set.
    return true
  }
}

// A bundle is orderable through a store when its `store` column holds that
// store — either as a scalar value or as one element of a JSONB array
// (mirrors the scalar-or-array shape handled by arrayStoreScope). Bundles
// with no store assignment are NOT orderable, and a bundle assigned to a
// different store is treated exactly like a bundle this store does not
// have.
const isBundleOrderableAtStore = (bundle, store) => {
  if (!bundle || !store) return false
  const assigned = bundle.store
  if (assigned === null || assigned === undefined) return false
  if (Array.isArray(assigned)) {
    return assigned.some((s) => Number(s) === Number(store))
  }
  return Number(assigned) === Number(store)
}

// Compute the server-side unit price for an item, including the base product
// price plus any selected option/modifier markup. The FE only sends the chosen
// option/modifier names; prices are always re-derived from the product's stored
// data so the server never trusts client-sent amounts.
// W3-1 (DR-11): the catalog base is the outlet-resolved price — the outlet
// product_store_price row wins when present, otherwise product.price. Option/
// variant markup applies on top exactly as before. Callers may pass a
// pre-resolved catalogBase (from resolveCatalogBase) to avoid a second
// lookup; otherwise it is resolved here.
const getServerItemPrice = async (prod, item, store, catalogBase) => {
  const base = catalogBase !== undefined ? catalogBase : await resolveCatalogBase(prod, store)
  let extra = 0

  const optNames = (item.options || []).map((o) => o && o.name).filter(Boolean)
  if (optNames.length) {
    if (Array.isArray(prod.options)) {
      for (const group of prod.options) {
        const groupName = (group && group.name) || ''
        for (const opt of (group && group.options) || []) {
          if (!opt || !opt.name) continue
          if (
            optNames.includes(opt.name) ||
            optNames.includes(`${groupName} - ${opt.name}`)
          ) {
            extra += Number(opt.price) || 0
          }
        }
      }
    }
    // Legacy flat variant list (if exposed by the data source)
    if (Array.isArray(prod.variant)) {
      for (const v of prod.variant) {
        const vName = v && (v.nameVariant || v.name)
        if (vName && optNames.includes(vName)) {
          extra += Number(v.price) || 0
        }
      }
    }
  }

  const modNames = (item.modifiers || [])
    .map((m) => m && m.name)
    .filter(Boolean)
  if (modNames.length && Array.isArray(prod.modifiers)) {
    for (const m of prod.modifiers) {
      if (m && m.name && modNames.includes(m.name)) {
        extra += Number(m.price) || 0
      }
    }
  }

  return base + extra
}

// ponytail: sequential daily pickup/customer number per store (1, 2, 3...).
// Atomic upsert against order_daily_counter instead of MAX(customerNumber)+1
// — the old query had no lock and no unique constraint, so two concurrent
// orders at the same store on the same day could read the same MAX and both
// receive the same pickup number. INSERT..ON CONFLICT DO UPDATE is a single
// statement Postgres serializes per (store, date) row, so concurrent callers
// are queued, not raced. Pass the same transaction used to create the order
// so a rolled-back order (e.g. insufficient stock) doesn't burn a number.
const generateCustomerNumber = async (store, t) => {
  const counterDate = new Date().toISOString().slice(0, 10)
  const rows = await db.sequelize.query(
    `INSERT INTO order_daily_counter (store, "counterDate", "lastValue", "updatedAt")
     VALUES ($1, $2, 1, NOW())
     ON CONFLICT (store, "counterDate")
     DO UPDATE SET "lastValue" = order_daily_counter."lastValue" + 1, "updatedAt" = NOW()
     RETURNING "lastValue"`,
    {
      bind: [store, counterDate],
      transaction: t,
      type: db.sequelize.QueryTypes.SELECT
    }
  )
  return rows[0]?.lastValue || 1
}

// F-SMOKE-01: a store-scoped equality (`where: { store, ... }`) silently
// drops global (store: null) configs — GET /tax-config already matches
// store-or-global via Op.or (see taxConfigController.getAll), so the FE's
// displayed rate and this authoritative one diverged whenever a config
// applied globally instead of to one specific store. Mirror the same
// store-or-global match here so both sides resolve the same active rows.
const getActiveTaxRate = async (store) => {
  // W3-3 (DR-17): missing PPN configuration is an explicit setup error and
  // read failures propagate — never a silent numeric fallback. A 0 sum from
  // explicitly configured rows is valid and returned as 0. Row resolution
  // is shared with the read-only summary via fetchActiveTaxRows (P1); the
  // summation and error semantics below are unchanged.
  let taxConfigs
  try {
    taxConfigs = (await fetchActiveTaxRows(store)).ppn
  } catch (e) {
    console.error('Error fetching tax config:', e.message)
    throw e
  }
  if (taxConfigs.length === 0) {
    const e = new Error(
      `PPN tax configuration is missing for this outlet (store ${store}); configure an active PPN rate before selling`
    )
    e.statusCode = 400
    e.code = 'PPN_MISSING'
    throw e
  }
  // D3: one applied PPN row (outlet overrides global), never a sum.
  return Number(pickAppliedPpn(taxConfigs).rate)
}

const getServiceChargeRate = async (store) => {
  // W3-3 (DR-17): no configured service-charge rows means 0 (valid business
  // behavior, unchanged). A read failure is NOT converted into 0 — it
  // propagates to the existing 500 handling. Rows shared via
  // fetchActiveTaxRows (P1); summation semantics unchanged.
  let configs
  try {
    configs = (await fetchActiveTaxRows(store)).serviceCharge
  } catch (e) {
    console.error('Error fetching service charge config:', e.message)
    throw e
  }
  if (configs.length === 0) {
    return 0
  }
  return configs.reduce((sum, t) => sum + Number(t.rate), 0)
}

const evaluatePromoCampaign = async (items, store, customerId, subtotal) => {
  const now = new Date()
  const currentDay = now.getDay()
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`

  const campaigns = await db.promo_campaign.findAll({
    where: {
      status: 'active',
      startDate: { [Op.lte]: now },
      endDate: { [Op.gte]: now }
    },
    include: [
      {
        model: db.promo_rule,
        as: 'rules',
        where: { isActive: true },
        required: false
      },
      {
        model: db.promo_reward,
        as: 'rewards',
        where: { isActive: true },
        required: false
      }
    ],
    order: [['priority', 'DESC']]
  })

  let bestDiscount = 0
  let bestCampaignId = null
  let bestReward = null

  for (const campaign of campaigns) {
    if (store && campaign.store) {
      const storeArr = Array.isArray(campaign.store)
        ? campaign.store
        : [campaign.store]
      if (!storeArr.includes(Number(store))) continue
    }

    if (
      campaign.maxUsageTotal &&
      campaign.currentUsage >= campaign.maxUsageTotal
    )
      continue

    if (
      campaign.daysOfWeek &&
      campaign.daysOfWeek.length > 0 &&
      !campaign.daysOfWeek.includes(currentDay)
    )
      continue

    if (campaign.startTime && campaign.endTime) {
      if (currentTime < campaign.startTime || currentTime > campaign.endTime)
        continue
    }

    if (campaign.minPurchase && subtotal < campaign.minPurchase) continue

    if (campaign.maxUsagePerMember && customerId) {
      const memberUsage = await db.promo_usage.count({
        where: { campaignId: campaign.id, memberId: customerId }
      })
      if (memberUsage >= campaign.maxUsagePerMember) continue
    }

    let isEligible = true

    for (const rule of campaign.rules || []) {
      if (!rule.isActive) continue

      switch (rule.ruleType) {
        case 'buy_x_get_y': {
          const { buyProductId, buyQuantity } = rule.condition || {}
          const cartItem = items.find(
            (item) => (item.product || item.productId) === buyProductId
          )
          if (!cartItem || cartItem.quantity < buyQuantity) {
            isEligible = false
          }
          break
        }
        case 'spend_threshold': {
          if (subtotal < ((rule.condition && rule.condition.minSpend) || 0)) {
            isEligible = false
          }
          break
        }
        case 'member_tier': {
          if (customerId) {
            const member = await db.member.findByPk(customerId)
            if (
              !member ||
              member.tier !== (rule.condition && rule.condition.tierId)
            ) {
              isEligible = false
            }
          } else {
            isEligible = false
          }
          break
        }
        case 'birthday': {
          if (customerId) {
            const member = await db.member.findByPk(customerId)
            if (member) {
              const dob = new Date(member.dateOfBirth)
              if (
                now.getMonth() !== dob.getMonth() ||
                now.getDate() !== dob.getDate()
              ) {
                isEligible = false
              }
            } else {
              isEligible = false
            }
          } else {
            isEligible = false
          }
          break
        }
        case 'first_purchase': {
          if (customerId) {
            const orderCount = await Order.count({
              where: { customerId, status: { [Op.ne]: 'void' } }
            })
            if (orderCount > 0) {
              isEligible = false
            }
          } else {
            isEligible = false
          }
          break
        }
        case 'time': {
          if (campaign.startTime && campaign.endTime) {
            if (
              currentTime < campaign.startTime ||
              currentTime > campaign.endTime
            ) {
              isEligible = false
            }
          }
          break
        }
      }
      if (!isEligible) break
    }

    if (!isEligible) continue

    const reward = (campaign.rewards && campaign.rewards[0]) || null
    if (!reward) continue

    let discountAmount = 0

    switch (reward.rewardType) {
      case 'discount_percentage': {
        discountAmount = Math.round(subtotal * (reward.rewardValue / 100))
        if (reward.maxRewardValue && discountAmount > reward.maxRewardValue) {
          discountAmount = reward.maxRewardValue
        }
        break
      }
      case 'discount_fixed': {
        discountAmount = reward.rewardValue
        break
      }
      case 'buy_x_get_y': {
        const freeProductId = reward.productId
        const freeQty = reward.quantity || 1
        const targetItem = items.find(
          (item) => (item.product || item.productId) === freeProductId
        )
        if (targetItem) {
          discountAmount =
            (targetItem.unitPrice || targetItem.price || 0) * freeQty
        }
        break
      }
      case 'free_item': {
        const freeProductId = reward.productId
        const freeQty = reward.quantity || 1
        const freeProduct = freeProductId
          ? await Product.findByPk(freeProductId)
          : null
        if (freeProduct) {
          discountAmount = (freeProduct.price || 0) * freeQty
        }
        break
      }
    }

    if (discountAmount > bestDiscount) {
      bestDiscount = discountAmount
      bestCampaignId = campaign.id
      bestReward = reward
    }
  }

  return {
    discountAmount: bestDiscount,
    campaignId: bestCampaignId,
    reward: bestReward
  }
}

const calculateOrderTotals = (
  items,
  discountValue = 0,
  discountType = 'none',
  taxRate = 0,
  serviceChargeRate = 0
) => {
  let subTotal = 0
  let totalQuantity = 0

  items.forEach((item) => {
    subTotal += item.subtotal
    totalQuantity += item.quantity
  })

  let discountAmount = 0
  if (discountType === 'percent') {
    discountAmount = Math.round(subTotal * (discountValue / 100))
  } else if (discountType === 'nominal') {
    discountAmount = discountValue
  }
  if (discountAmount < 0) discountAmount = 0
  if (discountAmount > subTotal) discountAmount = subTotal

  const afterDiscount = subTotal - discountAmount
  const taxAmount = Math.round(afterDiscount * (taxRate / 100))
  const serviceChargeAmount = Math.round(
    afterDiscount * (serviceChargeRate / 100)
  )
  const totalPrice = Math.max(0, afterDiscount + taxAmount + serviceChargeAmount)

  return {
    subTotal,
    totalQuantity,
    discountAmount,
    taxAmount,
    serviceChargeAmount,
    totalPrice
  }
}

// ---- createOrder helpers ---------------------------------------------
// Split out of what used to be one ~780-line function so each concern
// (table check, discount resolution, item pricing/validation, totals) can
// be read and changed independently. All still module-private — only
// exports.createOrder below calls them.

const checkTableAvailable = async (tableId, store) => {
  if (!tableId) return { ok: true }
  const table = await Table.findOne({ where: { id: tableId, store } })
  if (table && ['occupied', 'reserved', 'maintenance'].includes(table.status)) {
    return {
      ok: false,
      code: table.status === 'occupied' ? 'TABLE_OCCUPIED' : 'TABLE_NOT_AVAILABLE',
      message:
        table.status === 'occupied'
          ? 'Table is already occupied'
          : 'Table is not available'
    }
  }
  return { ok: true }
}

// DR-16 / DR-01: a staff-supplied member identity resolves only inside the
// order's store — the rule counter points redemption already applies (a
// member of this store, or a store-less legacy member). A foreign or
// unknown id unlocks no tier discount, earns no points and is never
// persisted on the order. Returns { member } or { code, message }.
const MEMBER_SCOPE_ERRORS = {
  MEMBER_NOT_FOUND: 'Member not found',
  MEMBER_OUT_OF_SCOPE: 'Member does not belong to this store'
}
const resolveStoreScopedMember = async (customerId, store, transaction) => {
  const member = await db.member.findByPk(customerId, transaction ? { transaction } : {})
  let code = null
  if (!member) code = 'MEMBER_NOT_FOUND'
  else if (member.store !== null && Number(member.store) !== Number(store)) {
    code = 'MEMBER_OUT_OF_SCOPE'
  }
  return code ? { member: null, code, message: MEMBER_SCOPE_ERRORS[code] } : { member }
}

// Resolves which discount applies before promo campaigns are evaluated, in
// priority order: explicit discountId > promo code > member tier auto-discount
// > point redemption (on top, applied later in calculateFinalTotals).
const resolveOrderDiscount = async ({
  discountId,
  promoCode,
  customerId,
  redeemedPoints,
  store
}) => {
  let discountValue = 0
  let discountType = 'none'
  let appliedDiscountId = null
  let appliedDiscountMeta = null

  let member = null
  if (customerId) {
    const scoped = await resolveStoreScopedMember(customerId, store)
    if (!scoped.member) {
      const e = new Error(scoped.message)
      e.statusCode = scoped.code === 'MEMBER_NOT_FOUND' ? 404 : 403
      e.code = scoped.code
      throw e
    }
    member = scoped.member
  }

  if (discountId) {
    const discount = await Discount.findOne({ where: { id: discountId, store } })
    if (discount) {
      discountValue = discount.value
      discountType = discount.type
      appliedDiscountId = discount.id
      appliedDiscountMeta = discount
    }
  }

  if (promoCode && !appliedDiscountId) {
    const promoDiscount = await Discount.findOne({
      where: { code: promoCode.trim().toUpperCase(), store, status: 'active' }
    })
    if (promoDiscount) {
      const now = new Date()
      const startsOk =
        !promoDiscount.startDate || new Date(promoDiscount.startDate) <= now
      const endsOk =
        !promoDiscount.endDate || new Date(promoDiscount.endDate) >= now
      if (startsOk && endsOk) {
        discountValue = promoDiscount.value
        discountType = promoDiscount.type
        appliedDiscountId = promoDiscount.id
        appliedDiscountMeta = promoDiscount
      }
    }
  }

  if (!appliedDiscountId && member) {
    try {
      if (member.tier) {
        const tier = await db.member_tier.findByPk(member.tier)
        if (tier && tier.discountPercent > 0) {
          discountValue = tier.discountPercent
          discountType = 'percent'
        }
      }
    } catch (e) {
      console.error('Tier discount lookup error:', e.message)
    }
  }

  const POINT_VALUE = 1
  let redeemedPointsUsed = 0
  let pointDiscountAmount = 0
  if (redeemedPoints !== undefined && redeemedPoints !== null && redeemedPoints !== '') {
    const rp = Number(redeemedPoints)
    if (!Number.isFinite(rp) || !Number.isInteger(rp) || rp < 0) {
      const e = new Error('redeemedPoints must be a non-negative integer')
      e.statusCode = 400
      throw e
    }
    if (rp > 0) {
      if (!customerId) {
        const e = new Error('customerId is required when redeeming points')
        e.statusCode = 400
        throw e
      }
      // `member` is already resolved and store-scoped above.
      if ((member.totalPoints || 0) < rp) {
        const e = new Error('Insufficient point balance')
        e.statusCode = 400
        throw e
      }
      pointDiscountAmount = rp * POINT_VALUE
      redeemedPointsUsed = rp
    }
  }

  return {
    discountValue,
    discountType,
    appliedDiscountId,
    appliedDiscountMeta,
    redeemedPointsUsed,
    pointDiscountAmount
  }
}

const isAdminRoleForOrder = (user) =>
  user && (user.roleType === 'admin' || user.roleType === 'super_admin')

// Re-derives every item's price from the DB (never trusts client-sent
// amounts), loads + validates any referenced bundles, and checks stock for
// every line — bundle components and regular items alike, in one pass
// instead of three separate passes over the same items. Mutates `items` in
// place (basePrice/price/unitPrice/subtotal/_origSubtotal) and returns the
// bundleMap plus a Map of already-fetched regular-item products so the
// caller doesn't have to re-fetch them again for order-item creation.
// Supports explicit admin-only priceOverride (transient, per-order) —
const loadAndPriceOrderItems = async (items, store, user = null) => {
  items.forEach((item) => {
    item._origSubtotal = item.subtotal
    item._origPrice = item.price
  })

  const bundleMap = {}
  const productById = new Map()
  // W3-2: every line is resolved (never fail-fast) so one 409 can carry all
  // mismatches in original request order. Index identifies duplicate lines.
  const priceMismatches = []

  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    const qty = Number(item.quantity)
    if (!Number.isFinite(qty) || qty <= 0) {
      return { ok: false, code: 'INVALID_QUANTITY', message: `Quantity must be greater than 0` }
    }
    const hasPriceOverride = item.priceOverride !== undefined && item.priceOverride !== null
    if (item.bundleId) {
      if (hasPriceOverride) {
        return { ok: false, code: 'PRICE_OVERRIDE_NOT_ALLOWED', message: `Price override not supported for bundle items` }
      }
      const bundle = await db.product_bundle.findByPk(item.bundleId, {
        include: [
          {
            model: db.product_bundle_item,
            as: 'items',
            include: [{ model: Product, as: 'productData' }]
          }
        ]
      })
      if (!bundle) {
        return {
          ok: false,
          code: 'BUNDLE_NOT_FOUND',
          message: `Bundle not found: ${item.bundleName || item.bundleId}`
        }
      }
      if (
        !bundle.isAvailable ||
        bundle.status !== 'active' ||
        !isBundleWithinValidityPeriod(bundle) ||
        // Store ownership (same contract as the customer path): a bundle
        // assigned to a different store is unavailable here. Unassigned
        // bundles stay orderable on the authenticated POS path (legacy
        // global bundles) — only an explicit foreign assignment rejects.
        (bundle.store !== null &&
          bundle.store !== undefined &&
          !isBundleOrderableAtStore(bundle, store))
      ) {
        return { ok: false, code: 'BUNDLE_NOT_AVAILABLE', message: `Bundle "${bundle.name}" is not available` }
      }
      bundleMap[item.bundleId] = bundle

      const bundlePrice = Number(bundle.bundlePrice) || 0
      item.price = bundlePrice
      item.basePrice = bundlePrice
      item.unitPrice = bundlePrice
      item.subtotal = bundlePrice * qty
      // W3-2: bundles compare against bundlePrice (never outlet pricing);
      // identified by bundleId, never productId.
      const bundleExpected = parseExpectedPrice(item.expectedPrice)
      if (bundleExpected.present && !bundleExpected.valid) {
        return { ok: false, statusCode: 400, code: 'INVALID_EXPECTED_PRICE', message: `expectedPrice must be an integer >= 0` }
      }
      if (bundleExpected.present && bundleExpected.value !== bundlePrice) {
        priceMismatches.push({
          index,
          bundleId: item.bundleId,
          expectedPrice: bundleExpected.value,
          currentPrice: bundlePrice
        })
      }

      const bundleQty = qty
      for (const bi of bundle.items) {
        const prod = bi.productData
        if (!prod) {
          return {
            ok: false,
            code: 'BUNDLE_NOT_AVAILABLE',
            message: `Product in bundle "${bundle.name}" not found`
          }
        }
        // Store ownership for bundle components (same contract as the
        // customer path): a component assigned to a different store makes
        // the whole bundle unavailable here.
        if (!(await isProductOrderableAtStore(prod.id, store))) {
          return {
            ok: false,
            code: 'BUNDLE_NOT_AVAILABLE',
            message: `Bundle not available: ${item.bundleName || item.bundleId}`
          }
        }
        // F7: a make_to_order component's own stock is not authoritative —
        // its recipe ingredients are checked (and refused with
        // INGREDIENT_STOCK_CONFLICT) inside the sale transaction. Same rule
        // as the customer (QR) path.
        if (prod.inventoryMode === 'make_to_order') continue
        const needed = bi.quantity * bundleQty
        const avail = await getEffectiveStock(prod, store)
        if (avail !== null && avail < needed) {
          return {
            ok: false,
            code: 'INSUFFICIENT_STOCK',
            message: `Stok "${prod.nameProduct}" tidak mencukupi untuk bundle "${bundle.name}". Tersedia: ${avail}, dibutuhkan: ${needed}`
          }
        }
      }
      continue
    }

    // Regular item — fetched once here and reused for stock check and (via
    // the returned productById map) order-item creation, instead of the
    // same row being fetched three separate times across the request.
    const prod = await Product.findByPk(item.product || item.productId)
    if (!prod) {
      return {
        ok: false,
        code: 'PRODUCT_NOT_FOUND',
        message: `Product not found: ${item.productName || item.product || item.productId}`
      }
    }
    // Store ownership (same contract as the customer path): a product
    // assigned to a different store is treated exactly like an unknown
    // product — foreign and nonexistent products stay indistinguishable.
    // Products with no store assignment remain globally orderable.
    if (!(await isProductOrderableAtStore(prod.id, store))) {
      return {
        ok: false,
        code: 'PRODUCT_NOT_FOUND',
        message: `Product not found: ${item.productName || item.product || item.productId}`
      }
    }
    productById.set(prod.id, prod)

    let serverPrice
    // W3-1 (DR-11): authoritative catalog price is outlet-resolved; the same
    // value feeds basePrice, the override audit baseline, and the final price.
    const catalogPrice = await resolveCatalogBase(prod, store)
    if (hasPriceOverride) {
      if (!isAdminRoleForOrder(user)) {
        return { ok: false, statusCode: 403, code: 'FORBIDDEN', message: `Price override requires admin privileges` }
      }
      const overridePrice = Number(item.priceOverride)
      if (!Number.isFinite(overridePrice) || overridePrice < 0 || !Number.isInteger(overridePrice)) {
        return { ok: false, code: 'INVALID_PRICE_OVERRIDE', message: `Invalid priceOverride` }
      }
      serverPrice = overridePrice
      item._priceOverridden = true
      item._originalCatalogPrice = catalogPrice
      // W3-2: an applied admin override is exempt from expectedPrice
      // comparison — the override itself is server-controlled and audited.
    } else {
      serverPrice = await getServerItemPrice(prod, item, store, catalogPrice)
      item._priceOverridden = false
      // W3-2: compare the optional client echo against the exact value that
      // would become order_item.price (catalog + option markup).
      const expected = parseExpectedPrice(item.expectedPrice)
      if (expected.present && !expected.valid) {
        return { ok: false, statusCode: 400, code: 'INVALID_EXPECTED_PRICE', message: `expectedPrice must be an integer >= 0` }
      }
      if (expected.present && expected.value !== serverPrice) {
        priceMismatches.push({
          index,
          productId: item.product || item.productId,
          expectedPrice: expected.value,
          currentPrice: serverPrice
        })
      }
    }
    item.basePrice = catalogPrice
    item.price = serverPrice
    item.unitPrice = serverPrice
    item.subtotal = serverPrice * qty

    // F7: see the bundle branch — a make_to_order product is limited by its
    // recipe ingredients, never by its own (usually zero) product stock.
    const avail = prod.inventoryMode === 'make_to_order' ? null : await getEffectiveStock(prod, store)
    if (avail !== null && avail < qty) {
      return {
        ok: false,
        code: 'INSUFFICIENT_STOCK',
        message: `Stok "${prod.nameProduct}" tidak mencukupi. Tersedia: ${avail}, diminta: ${item.quantity}`
      }
    }
  }

  // W3-2: pre-transaction gate — every line already resolved above, so one
  // 409 carries all mismatches and no write can follow a stale expectation.
  if (priceMismatches.length) {
    return {
      ok: false,
      statusCode: 409,
      code: PRICE_CHANGED_CODE,
      message: PRICE_CHANGED_MESSAGE,
      mismatches: priceMismatches
    }
  }

  return { ok: true, bundleMap, productById }
}

// Evaluates promo campaigns against the priced items, applies whichever of
// (explicit/promo/tier discount) vs (promo campaign) is in effect, then
// layers the maximumDiscount cap and point-redemption discount on top.
const calculateFinalTotals = async ({
  items,
  store,
  customerId,
  discountValue,
  discountType,
  appliedDiscountId,
  appliedDiscountMeta,
  pointDiscountAmount,
  taxRate,
  serviceChargeRate
}) => {
  let rawSubTotal = 0
  items.forEach((item) => {
    rawSubTotal += item.subtotal
  })

  const campaignWithSubtotal = await evaluatePromoCampaign(
    items.map((item) => ({
      ...item,
      productId: item.product || item.productId,
      unitPrice: item.unitPrice ?? item.price ?? item.basePrice ?? 0
    })),
    store,
    customerId,
    rawSubTotal
  )

  let totals
  let promoDiscountAmount = 0
  let appliedCampaignId = null

  // Use campaign discount if no manual discount applied and campaign gives a better deal
  if (!appliedDiscountId && campaignWithSubtotal.discountAmount > 0) {
    promoDiscountAmount = campaignWithSubtotal.discountAmount
    appliedCampaignId = campaignWithSubtotal.campaignId
    totals = calculateOrderTotals(items, 0, 'none', taxRate, serviceChargeRate)
    totals.discountAmount = promoDiscountAmount
  } else if (
    appliedDiscountMeta &&
    appliedDiscountMeta.conditions &&
    appliedDiscountMeta.conditions.promoType
  ) {
    // Legacy: still support old discount.conditions for backward compat, but log deprecation
    console.warn(
      'DEPRECATED: discount.conditions.promoType detected. Migrate to promo_campaign.'
    )
    totals = calculateOrderTotals(items, 0, 'none', taxRate, serviceChargeRate)
  } else {
    totals = calculateOrderTotals(
      items,
      discountValue,
      discountType,
      taxRate,
      serviceChargeRate
    )
  }

  // Apply maximumDiscount cap for percent type
  if (discountType === 'percent' && appliedDiscountId) {
    const discountMeta = await Discount.findByPk(appliedDiscountId)
    if (
      discountMeta &&
      discountMeta.maximumDiscount > 0 &&
      totals.discountAmount > discountMeta.maximumDiscount
    ) {
      totals.discountAmount = discountMeta.maximumDiscount
      const afterDiscount = totals.subTotal - totals.discountAmount
      totals.taxAmount = Math.round(afterDiscount * (taxRate / 100))
      totals.serviceChargeAmount = Math.round(
        afterDiscount * (serviceChargeRate / 100)
      )
      totals.totalPrice =
        afterDiscount + totals.taxAmount + totals.serviceChargeAmount
    }
  }

  // Apply point redemption discount on top
  if (pointDiscountAmount > 0) {
    totals.discountAmount += pointDiscountAmount
    const afterDiscount = totals.subTotal - totals.discountAmount
    totals.taxAmount = Math.round(afterDiscount * (taxRate / 100))
    totals.serviceChargeAmount = Math.round(
      afterDiscount * (serviceChargeRate / 100)
    )
    totals.totalPrice = Math.max(
      0,
      afterDiscount + totals.taxAmount + totals.serviceChargeAmount
    )
  }

  // Final invariant guard: discount never exceeds subTotal, total never negative.
  // Covers promo / nominal huge discounts, point stacking, and any future path.
  if (totals.discountAmount < 0) totals.discountAmount = 0
  if (totals.discountAmount > totals.subTotal) totals.discountAmount = totals.subTotal
  const finalAfterDiscount = totals.subTotal - totals.discountAmount
  totals.taxAmount = Math.round(finalAfterDiscount * (taxRate / 100))
  totals.serviceChargeAmount = Math.round(
    finalAfterDiscount * (serviceChargeRate / 100)
  )
  totals.totalPrice = Math.max(0, finalAfterDiscount + totals.taxAmount + totals.serviceChargeAmount)

  return { totals, promoDiscountAmount, appliedCampaignId, campaignWithSubtotal }
}

// Fetches the full order shape (items + transactions) used both for a
// fresh 201 and for an idempotent replay, so the two response bodies match.
const fetchFullOrder = async (orderId) =>
  Order.findOne({
    where: { id: orderId },
    include: [
      { model: OrderItem, as: 'items' },
      { model: db.transaction, as: 'transactions' },
      { model: Table, as: 'table' }
    ]
  })

// Store a counter sale (or its quote) is authorized for: super_admin names
// it, everyone else is pinned to their own store and any supplied store
// must match it. Returns { store } or { status, body } to send as-is.
const resolveCounterStore = (req) => {
  const authorizedStore = req.user?.roleType === 'super_admin'
    ? (req.body.store !== undefined ? Number(req.body.store) : Number(req.query?.store))
    : req.storeId

  if (authorizedStore === null || !Number.isInteger(authorizedStore) || authorizedStore <= 0) {
    return { status: 400, body: { message: 'Invalid or missing store authorization' } }
  }

  if (req.user?.roleType !== 'super_admin') {
    const suppliedStores = [req.body?.store, req.body?.storeId, req.query?.store]
      .filter((v) => v !== undefined && v !== null && v !== '')
      .map((v) => Number(v))
    if (suppliedStores.some((v) => !Number.isInteger(v) || v !== Number(authorizedStore))) {
      return { status: 401, body: { message: 'Unauthorized store access' } }
    }
  }
  return { store: authorizedStore }
}

// One server resolver for what a counter sale charges (DR-11: the
// server-resolved price is the price of record; DR-17: displayed rate =
// charged rate). createOrder prices the sale it persists with it, and
// quoteOrder shows the cashier the same numbers before commitment.
// Read-only — it never writes. Refusals come back as { ok: false,
// status, body } for the caller to send unchanged; thrown errors carry
// their own statusCode/code.
const priceCounterOrder = async ({
  items,
  store,
  user,
  discountId,
  promoCode,
  customerId,
  redeemedPoints,
  useTax
}) => {
  const discount = await resolveOrderDiscount({
    discountId,
    promoCode,
    customerId,
    redeemedPoints,
    store
  })

  const pricing = await loadAndPriceOrderItems(items, store, user)
  if (!pricing.ok) {
    // W3-2: the price-mismatch conflict keeps its exact locked body and
    // must never collapse into the generic error shape.
    if (pricing.statusCode === 409 && pricing.mismatches) {
      return { ok: false, status: 409, body: buildPriceMismatchBody(pricing.mismatches) }
    }
    return {
      ok: false,
      status: pricing.statusCode || 400,
      body: { message: pricing.message, ...(pricing.code ? { code: pricing.code } : {}) }
    }
  }

  const useTaxFlag = useTax === undefined ? true : Boolean(useTax)
  const taxRate = useTaxFlag ? await getActiveTaxRate(store) : 0
  const serviceChargeRate = await getServiceChargeRate(store)

  const final = await calculateFinalTotals({
    items,
    store,
    customerId,
    discountValue: discount.discountValue,
    discountType: discount.discountType,
    appliedDiscountId: discount.appliedDiscountId,
    appliedDiscountMeta: discount.appliedDiscountMeta,
    pointDiscountAmount: discount.pointDiscountAmount,
    taxRate,
    serviceChargeRate
  })

  return { ok: true, discount, pricing, taxRate, serviceChargeRate, ...final }
}

// Which rule produced the order-level discount, in resolveOrderDiscount /
// calculateFinalTotals precedence: explicit discount or promo code, else a
// promo campaign, else the member's tier.
const discountSourceOf = (priced) => {
  if (priced.discount.appliedDiscountId) return 'discount'
  if (priced.appliedCampaignId) return 'campaign'
  if (Number(priced.discount.discountValue) > 0) return 'tier'
  return 'none'
}

// POST /order/quote — the server's answer to "what will this counter sale
// charge?" for the exact payload /order/create would receive. Read-only:
// no order, ledger, stock, loyalty or journal effect.
exports.quoteOrder = async (req, res) => {
  const scope = resolveCounterStore(req)
  if (!scope.store) return res.status(scope.status).json(scope.body)

  const { items, discountId, promoCode, customerId, redeemedPoints, useTax } = req.body
  try {
    const priced = await priceCounterOrder({
      items,
      store: scope.store,
      user: req.user,
      discountId,
      promoCode,
      customerId,
      redeemedPoints,
      useTax
    })
    if (!priced.ok) return res.status(priced.status).json(priced.body)

    const { totals, discount, taxRate, serviceChargeRate } = priced
    return res.status(200).json({
      data: {
        subTotal: totals.subTotal,
        discountAmount: totals.discountAmount,
        discountSource: discountSourceOf(priced),
        pointDiscountAmount: discount.pointDiscountAmount,
        redeemedPoints: discount.redeemedPointsUsed,
        taxRate,
        taxAmount: totals.taxAmount,
        serviceChargeRate,
        serviceChargeAmount: totals.serviceChargeAmount,
        totalPrice: totals.totalPrice,
        totalQuantity: totals.totalQuantity
      }
    })
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : 'Internal Server Error',
      ...(error.code ? { code: error.code } : {})
    })
  }
}

// DR-23 §K: a same-key request replays the original order (200, no new
// effect) unless the persisted evidence proves it carries a different intent;
// then it is refused with 409 IDEMPOTENCY_MISMATCH and the fields that differ
// (see orderIdempotency for the evidence rules). The active PPN rows are read
// only to disambiguate a 0 % order.
const replayCounterOrder = async (res, orderId, body, store) => {
  const fullOrder = await fetchFullOrder(orderId)
  let activeTaxRate = null
  let activeTaxSetUnchangedSinceCreation = false
  if (fullOrder && Number(fullOrder.taxRate) === 0 && body.useTax !== false) {
    // Same row set and D3 resolution as getActiveTaxRate (fetchActiveTaxRows
    // scope), with updatedAt as evidence the set is unchanged since the order.
    const rows = await db.taxConfig.findAll({
      where: { [Op.or]: [{ store }, { store: null }], type: 'ppn', status: 'active' },
      attributes: ['id', 'rate', 'store', 'updatedAt']
    })
    const applied = pickAppliedPpn(rows.map((row) => row.get({ plain: true })))
    activeTaxRate = applied ? Number(applied.rate) : 0
    activeTaxSetUnchangedSinceCreation =
      rows.length > 0 &&
      rows.every((row) => new Date(row.updatedAt) <= new Date(fullOrder.createdAt))
  }
  let requestedDiscountResolvedAtCreation = false
  if (fullOrder && body.discountId && String(body.discountId) !== String(fullOrder.discountId)) {
    const requested = await Discount.findOne({ where: { id: body.discountId, store } })
    requestedDiscountResolvedAtCreation = Boolean(
      requested && new Date(requested.createdAt) <= new Date(fullOrder.createdAt)
    )
  }
  const fields = fullOrder
    ? counterOrderMismatches(fullOrder, body, {
        validateCashTender,
        activeTaxRate,
        activeTaxSetUnchangedSinceCreation,
        requestedDiscountResolvedAtCreation
      })
    : ['order']
  if (fields.length) {
    return res
      .status(409)
      .json(idempotencyMismatchBody(fields, fullOrder ? existingOrderSummary(fullOrder) : {}))
  }
  return res.status(200).json({
    message: 'Order already exists for this idempotency key',
    data: fullOrder
  })
}

const replayCustomerOrder = async (res, orderId, body) => {
  const fullOrder = await fetchFullOrder(orderId)
  const fields = fullOrder ? customerOrderMismatches(fullOrder, body) : ['order']
  if (fields.length) return res.status(409).json(idempotencyMismatchBody(fields))
  return res.status(200).json({
    message: 'Order already exists for this idempotency key',
    data: fullOrder
  })
}

exports.createOrder = async (req, res) => {
  const scope = resolveCounterStore(req)
  if (!scope.store) return res.status(scope.status).json(scope.body)
  const authorizedStore = scope.store

  const {
    tableId,
    cashierId,
    cashierName,
    items,
    discountId,
    promoCode,
    customerId,
    customerName,
    customerPhone,
    notes,
    useTax,
    source,
    paymentMethod,
    currencyId,
    currencyCode,
    exchangeRate,
    redeemedPoints,
    idempotencyKey,
    cashAmount,
    changeAmount,
    referenceNumber,
    expectedTotal
  } = req.body

  // BA gap 005 (DR-23 §K): a counter sale is money-producing, so it needs
  // an idempotency key — a retry can then never create a second sale.
  // Refused before any lookup or write.
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
    return res.status(422).json({
      error: 'An idempotencyKey is required for a counter sale',
      code: 'IDEMPOTENCY_KEY_REQUIRED'
    })
  }

  try {
    // A retried/duplicate submit with the same key (e.g. a POS terminal
    // retrying after a network timeout, or a double-tap on "Pay") returns
    // the order already created instead of creating a second one. This is
    // a fast-path check only — the real guarantee is the unique index on
    // (store, idempotencyKey), enforced below if two such requests race.
     if (idempotencyKey) {
       const existing = await Order.findOne({ where: { store: authorizedStore, idempotencyKey } })
      if (existing) return replayCounterOrder(res, existing.id, req.body, authorizedStore)
    }

    const orderNumber = generateOrderNumber()

    const tableCheck = await checkTableAvailable(tableId, authorizedStore)
    if (!tableCheck.ok) {
      // A dine-in order occupies its table on success, so a same-key retry
      // whose winner committed after the fast path above (but before this
      // fresh table read) sees "occupied" here — replay it, not a 400.
      if (idempotencyKey) {
        const existing = await Order.findOne({ where: { store: authorizedStore, idempotencyKey } })
        if (existing) return replayCounterOrder(res, existing.id, req.body, authorizedStore)
      }
      return res.status(400).json({ message: tableCheck.message, code: tableCheck.code })
    }

    // DR-11 / DR-17: priced by the same resolver the quote endpoint uses,
    // so what the cashier was shown is what this sale charges.
    const priced = await priceCounterOrder({
      items,
      store: authorizedStore,
      user: req.user,
      discountId,
      promoCode,
      customerId,
      redeemedPoints,
      useTax
    })
    if (!priced.ok) return res.status(priced.status).json(priced.body)
    const {
      discount,
      taxRate,
      serviceChargeRate,
      totals,
      promoDiscountAmount,
      appliedCampaignId,
      campaignWithSubtotal
    } = priced
    const { discountValue, discountType, appliedDiscountId } = discount
    const { bundleMap, productById } = priced.pricing

    // DR-23 §M TOTAL_CHANGED (applies BA LOCK DR-17): a client that states
    // the payable it showed the customer (`expectedTotal`, e.g. its server
    // quote) is refused — before any write — when the server's payable now
    // differs (a discount, promo or campaign that stopped applying, a tax or
    // price change). The client re-quotes; nothing was charged. Omitting it
    // keeps the legacy behaviour.
    if (expectedTotal !== undefined && Number(expectedTotal) !== Number(totals.totalPrice)) {
      return res.status(409).json({
        code: 'TOTAL_CHANGED',
        message: 'The order total changed. Please review the updated total and resubmit.',
        expectedTotal: Number(expectedTotal),
        totalPrice: totals.totalPrice,
        subTotal: totals.subTotal,
        discountAmount: totals.discountAmount,
        taxAmount: totals.taxAmount,
        serviceChargeAmount: totals.serviceChargeAmount
      })
    }

    // F-PAY-1: a paid order must always carry its payment-ledger row.
    // paymentMethod is optional in the schema and recordOrderPayment skips
    // a falsy method — without normalization a missing method produced a
    // "paid" order with zero transaction rows. The established product
    // contract treats an absent method as cash exact tender (status notes,
    // paid-transition and split-bill `|| 'cash'` fallbacks), so normalize
    // once here and route through normal cash validation + persistence.
    // P1 (DR-PAY-ATTR-06): the persisted tender is always canonical; an
    // unknown method is refused with 422 before any write.
    const effectivePaymentMethod = normalizePaymentMethod(paymentMethod || 'cash')

    // Fails fast, before any DB write is attempted, if the cash tender
    // is physically impossible or malformed.
    const { cashReceived, changeGiven } = validateCashTender({
      paymentMethod: effectivePaymentMethod,
      cashAmount,
      changeAmount,
      amountDue: totals.totalPrice
    })

    const orderData = {
      orderNumber,
      store: authorizedStore,
      tableId,
      cashierId,
      cashierName,
      customerId,
      customerName,
      customerPhone,
      notes,
      paymentMethod: effectivePaymentMethod,
      source: source || 'pos',
      status: 'paid',
      paymentStatus: 'paid',
      subTotal: totals.subTotal,
      totalQuantity: totals.totalQuantity,
      discountType,
      discountValue,
      discountAmount: totals.discountAmount,
      discountId: appliedDiscountId,
      promoCode: promoCode || null,
      taxRate,
      taxAmount: totals.taxAmount,
      serviceChargeRate,
      serviceChargeAmount: totals.serviceChargeAmount,
      totalPrice: totals.totalPrice,
      currencyId: currencyId || null,
      currencyCode: currencyCode || null,
      exchangeRate: exchangeRate || null,
      idempotencyKey: idempotencyKey || null,
      publicToken: crypto.randomBytes(24).toString('hex'),
      createdBy: req.user?.id
    }
    if (await hasOrderColumn('promoCampaignId')) {
      orderData.promoCampaignId = appliedCampaignId
    }
    if (await hasOrderColumn('redeemedPoints')) {
      orderData.redeemedPoints = discount.redeemedPointsUsed || 0
    }
    // Order header, its items, the stock deduction, the payment-ledger
    // row, and the initial status row must all commit or all roll back
    // together. Previously the payment row and status row were written
    // AFTER this transaction had already committed — a failure there
    // (a transient DB blip, pool exhaustion under load) left a "paid"
    // order with stock already deducted but zero payment-ledger row and
    // no status history, permanently invisible to reconciliation, with no
    // way for a client retry to recover it (the idempotency check only
    // sees "order exists" and never re-attempts the missing steps).
    let accountingJobs = null
    // F7: wrapped in withDeadlockRetry — ingredient locking (in addition
    // to the existing product locking) raises the number of distinct rows
    // this transaction locks per order, which mechanically raises
    // deadlock probability even with correct lock ordering. A killed
    // transaction here is guaranteed by Postgres to have committed
    // nothing, so re-running this whole callback from scratch is safe.
    const order = await withDeadlockRetry(() =>
      db.sequelize.transaction(async (t) => {
      // Phase 39 — POS dine-in table claim. Authoritative (the pre-check
      // above is a fast path only): lock the table row first, re-check it,
      // and occupy it in this same transaction so the claim commits or
      // rolls back with the order. Released only by the Table Management
      // "Set Available" action — never by this order's own status changes.
      if (tableId) {
         const lockedTable = await Table.findOne({
           where: { id: tableId, store: authorizedStore },
           transaction: t,
          lock: t.LOCK.UPDATE
        })
        if (!lockedTable) {
          const err = new Error('Table not found')
          err.statusCode = 400
          err.code = 'TABLE_NOT_FOUND'
          throw err
        }
        if (lockedTable.status !== 'available') {
          // A concurrent same-key retry can lose this lock to its own
          // winner — replay that order instead of rejecting it.
          if (idempotencyKey) {
             const existingOrder = await Order.findOne({
               where: { store: authorizedStore, idempotencyKey },
               transaction: t
             })
            if (existingOrder) {
              const replayErr = new Error('Order already exists for this idempotency key')
              replayErr.idempotencyReplayOrderId = existingOrder.id
              throw replayErr
            }
          }
          const err = new Error(
            lockedTable.status === 'occupied'
              ? 'Table is already occupied'
              : 'Table is not available'
          )
          err.statusCode = 400
          err.code = lockedTable.status === 'occupied' ? 'TABLE_OCCUPIED' : 'TABLE_NOT_AVAILABLE'
          throw err
        }
        await lockedTable.update({ status: 'occupied' }, { transaction: t })
      }

      // P1 (DR-PAY-ATTR-02/03): every counter collection requires an open
      // register, resolved under a SHARE lock that serializes against
      // register close(). No open register -> 422 with zero side effects;
      // a register that closes mid-flight -> 409. Never NULL-and-continue.
       const openRegister = await resolveAttributedRegister(authorizedStore, t)
       orderData.cashRegisterId = openRegister.id

       orderData.customerNumber = await generateCustomerNumber(authorizedStore, t)
      const createdOrder = await Order.create(orderData, { transaction: t })

      await createOrderItems(
        createdOrder,
        items,
        bundleMap,
        productById,
        discountType,
        discountValue,
        t
      )

       await deductStockForOrder(
         createdOrder,
         items,
         bundleMap,
         authorizedStore,
         orderNumber,
         req.user?.id,
         t
       )

       const counterReference =
         effectivePaymentMethod === 'CASH'
           ? null
           : typeof referenceNumber === 'string' && referenceNumber.trim() !== ''
             ? referenceNumber.trim()
             : null
       // BA 004 (DR-23 §D): never the same reference twice per store+method.
       await assertSettlementReferenceUnused({
         store: authorizedStore,
         method: effectivePaymentMethod,
         reference: counterReference,
         transaction: t
       })
       await recordOrderPayment(
        createdOrder,
        effectivePaymentMethod,
        totals.totalPrice,
        req.user?.id,
        t,
        cashReceived,
        changeGiven,
        {
          cashRegisterId: openRegister.id,
          referenceNumber: counterReference
        }
      )
      await createInitialOrderStatus(
        createdOrder,
        cashierName,
        effectivePaymentMethod,
        req.user?.id,
        t
      )

      // Loyalty points and promo usage are now part of the same all-or-
      // nothing unit as the rest of the order — atomic and row-locked
      // (see applyRedeemedPoints/awardEarnedPoints/recordPromoUsageIfApplied
      // above), instead of unlocked and running after commit where a race
      // or failure had no effect on the order's own success/failure and no
      // durable trace of having gone wrong.
      await applyRedeemedPoints(
        createdOrder,
        customerId,
        discount.redeemedPointsUsed,
        orderNumber,
        t
      )
      await awardEarnedPoints(
        createdOrder,
        items,
        customerId,
        orderNumber,
        req.user?.id,
        t
      )
      await recordPromoUsageIfApplied(
        createdOrder,
        appliedCampaignId,
        customerId,
        promoDiscountAmount,
        campaignWithSubtotal,
        req.user?.id,
        t
      )

      accountingJobs = await enqueueOrderAccountingJobs(
        createdOrder,
        authorizedStore,
        orderNumber,
        totals,
        effectivePaymentMethod,
        req.user?.id,
        t
      )

      return createdOrder
      })
    )

    // The sale is committed from here on. No post-commit step (re-read,
    // notification, audit, realtime emit, immediate journal attempt) may turn
    // it into a failure response — a client told "failed" would re-sell an
    // order that exists. Failures are logged; an unposted journal stays
    // `pending` in the accounting outbox for the retry drain.
    let fullOrder = null
    try {
      fullOrder = await fetchFullOrder(order.id)
    } catch (postCommitError) {
      console.error(`createOrder: re-read failed for committed order ${order.id}:`, postCommitError)
    }
    try {
      createNotification({
        type: 'payment_received',
        store: authorizedStore,
        referenceId: order.id,
        referenceType: 'order',
        params: [orderNumber, totals.totalPrice],
        createdBy: req.user?.fullName || 'System'
      }).catch(console.error)
      createAudit(
        req,
        'create',
        'order',
        order.id,
        `Created order: ${orderNumber}`
      )
      // Price override audit — transient, per-order, admin-only override
      const overriddenItems = items.filter((i) => i._priceOverridden)
      if (overriddenItems.length) {
        createAudit(
          req,
          'update',
          'order',
          order.id,
          `Price override applied to ${overriddenItems.length} item(s)`,
          {
            items: overriddenItems.map((i) => ({
              product: i.product || i.productId,
              catalogPrice: i._originalCatalogPrice ?? i.basePrice
            }))
          },
          {
            items: overriddenItems.map((i) => ({
              product: i.product || i.productId,
              overriddenPrice: i.price,
              quantity: i.quantity
            }))
          }
        )
      }

      emitNewOrder(authorizedStore, fullOrder || order)
    } catch (postCommitError) {
      console.error(`createOrder: post-commit side effect failed for order ${order.id}:`, postCommitError)
    }
    try {
      await attemptOrderAccountingEntries(accountingJobs)
    } catch (postCommitError) {
      console.error(
        `createOrder: immediate journal attempt failed for order ${order.id}; left in the outbox:`,
        postCommitError
      )
    }

    return res.status(201).json({
      message: 'Order created successfully',
      data: fullOrder || order
    })
  } catch (error) {
    // Same-key retry that lost the table row lock to its own winner (see
    // the dine-in table claim above) — replay, same as the paths below.
    if (error.idempotencyReplayOrderId) {
      return replayCounterOrder(res, error.idempotencyReplayOrderId, req.body, authorizedStore)
    }
    // Two requests with the same idempotencyKey can both pass the earlier
    // findOne check and both attempt to create — the unique index on
    // (store, idempotencyKey) lets exactly one succeed; the loser lands
    // here. Rather than a raw 500, return the winner's order, same as the
    // fast-path replay above. Scoped (F-04) to that specific constraint only.
    if (isOrderReplayRelevantUniqueError(error) && idempotencyKey) {
      const existing = await Order.findOne({ where: { store: authorizedStore, idempotencyKey } })
      if (existing) return replayCounterOrder(res, existing.id, req.body, authorizedStore)
    }
    console.error('Error:', error)
    // An unexpected error never echoes its internal message (SQL, stack
    // context). Every write is in the transaction above and post-commit
    // failures are handled before this point, so this is almost always a
    // rolled-back request — but a connection lost at COMMIT can leave the
    // outcome unknown. The safe recovery is a retry with the SAME
    // idempotencyKey: it replays a committed sale or creates it once.
    if (!error.statusCode) {
      return res.status(500).json({ error: 'Internal Server Error', code: 'INTERNAL_ERROR' })
    }
    return res.status(error.statusCode).json({
      error: error.message,
      ...(error.code ? { code: error.code } : {})
    })
  }
}

// ---- createOrder helpers: persistence phase -----------------------------
// Order/pricing is decided above; everything here writes what was decided.

const createOrderItems = async (
  order,
  items,
  bundleMap,
  productById,
  discountType,
  discountValue,
  t
) => {
  for (const item of items) {
    const itemDiscountAmount = Math.max(
      0,
      (item._origSubtotal || 0) - (item.subtotal || 0)
    )
    if (item.bundleId && bundleMap[item.bundleId]) {
      const bundle = bundleMap[item.bundleId]
      // ponytail: HPP bundle = total harga komponen — kalau kosong, laporan
      // harian fallback ke harga jual sehingga food cost meleset
      const bundleCost = (bundle.items || []).reduce(
        (sum, bi) =>
          sum +
          Number(bi.productData?.costPrice ?? bi.productData?.price ?? 0) *
            Number(bi.quantity || 1),
        0
      )
      await OrderItem.create(
        {
          order: order.id,
          product: bundle.items[0]?.product || 0,
          productName: bundle.name,
          quantity: item.quantity,
          price: bundle.bundlePrice,
          bundleId: bundle.id,
          bundleName: bundle.name,
          discountType,
          discountValue,
          discountAmount: itemDiscountAmount,
          totalPrice: item.subtotal || bundle.bundlePrice * item.quantity,
          options: item.options || [],
          modifiers: item.modifiers || [],
          notes: item.notes,
          hppSnapshot: Math.round(bundleCost),
          status: 'pending'
        },
        { transaction: t }
      )
      continue
    }

    // Reuses the product already fetched in loadAndPriceOrderItems instead
    // of fetching the same row a third time.
    const product = productById.get(item.product || item.productId)
    const costPrice = product
      ? Number(product.costPrice || product.price || 0)
      : 0
    await OrderItem.create(
      {
        order: order.id,
        product: item.product || item.productId,
        productName: item.productName || product?.nameProduct,
        quantity: item.quantity,
        price: item.price ?? item.basePrice,
        discountType,
        discountValue,
        discountAmount: itemDiscountAmount,
        totalPrice: item.subtotal ?? item.totalPrice,
        options: item.options || [],
        modifiers: item.modifiers || [],
        notes: item.notes,
        hppSnapshot: costPrice,
        status: 'pending'
      },
      { transaction: t }
    )
  }
}


// Reduce stock & create stock history — wrapped in a transaction for
// atomicity. Locks every distinct product touched by the order (bundle
// components and regular items alike) in one query, in a stable order,
// instead of one findByPk+lock per line — the same fix already applied to
// checkout.js's equivalent loop.
// Takes the same transaction `t` that created the order and its items, so
// an insufficient-stock rejection here (see deductAndTrack below) rolls
// back the order + items too, instead of leaving a "paid" order behind
// with no stock ever deducted and no payment ever recorded for it.
const deductStockForOrder = async (
  order,
  items,
  bundleMap,
  store,
  orderNumber,
  userId,
  t
) => {
  {
    const productIdSet = new Set()
    for (const item of items) {
      if (item.bundleId && bundleMap[item.bundleId]) {
        for (const bi of bundleMap[item.bundleId].items) {
          productIdSet.add(bi.product)
        }
      } else {
        const pid = item.product || item.productId
        if (pid) productIdSet.add(pid)
      }
    }
    const productIds = [...productIdSet].sort((a, b) => a - b)
    const products = productIds.length
      ? await Product.findAll({
          where: { id: productIds },
          transaction: t,
          lock: t.LOCK.UPDATE
        })
      : []
    const productById = new Map(products.map((p) => [p.id, p]))

    const stockHistoryRows = []

    const deductAndTrack = async ({
      product,
      deductQty,
      referenceNote,
      sellName
    }) => {
      // F7: a make_to_order product's own finished-good stock is never
      // authoritative — ingredients are (resolved/deducted separately,
      // below). 'hybrid' and the default 'stocked' still deduct product
      // stock exactly as before. best_selling is still recorded for every
      // mode (it's a sales-count for reporting, not a stock signal).
      if (product.inventoryMode !== 'make_to_order') {
        const oldStock = Number(product.stock) || 0
        // Re-validate against the value just read under the row lock, not the
        // unlocked pre-check earlier in the request — two concurrent orders
        // can both pass that pre-check for the last unit, then both reach
        // here; without this, both would silently succeed (the old code
        // clamped to 0 instead of rejecting), selling more than was in stock.
        if (oldStock < deductQty) {
          const err = new Error(
            `Stok "${product.nameProduct || 'produk'}" tidak mencukupi. Tersedia: ${oldStock}, diminta: ${deductQty}`
          )
          err.statusCode = 400
          throw err
        }
        const newStock = oldStock - deductQty
        await product.update(
          { stock: db.sequelize.literal(`GREATEST(stock - ${deductQty}, 0)`) },
          { transaction: t }
        )
        // Keep the in-memory row consistent so a second reference to the
        // same product later in this loop (another line, or another
        // component of a different bundle) sees the already-decremented
        // stock.
        product.stock = newStock

        // Seed a missing shadow row at the just-locked product baseline
        // (same convention as adjustProductStock) — seeding at 0 would
        // leave the per-store stock permanently diverged from product.stock,
        // since every later mutation only tracks deltas.
        await db.sequelize.query(
          `INSERT INTO product_store_stock (product, store, stock, "createdAt", "updatedAt")
           VALUES ($1, $2, $3, NOW(), NOW())
           ON CONFLICT (product, store) DO NOTHING`,
          { bind: [product.id, store, oldStock], transaction: t }
        )
        await db.product_store_stock.update(
          { stock: db.sequelize.literal(`GREATEST(stock - ${deductQty}, 0)`) },
          { where: { product: product.id, store }, transaction: t }
        )

        // ponytail: FIFO - consume oldest batches first
        await batchService.deductFifo({
          productId: product.id,
          store,
          qty: deductQty,
          transaction: t
        })

        stockHistoryRows.push({
          product: product.id,
          store,
          referenceType: 'sale',
          referenceId: order.id,
          quantityBefore: oldStock,
          quantityChange: -deductQty,
          quantityAfter: newStock,
          unit: product.unit || 'pcs',
          notes: referenceNote,
          createdBy: userId
        })
      }

      // Race-safe upsert instead of findOne + conditional create/update,
      // which could double-insert under concurrent orders touching the
      // same product/store.
      await db.sequelize.query(
        `INSERT INTO best_selling ("productId", "nameProduct", image, store, "totalSelling", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         ON CONFLICT ("productId", store) WHERE "deletedAt" IS NULL
         DO UPDATE SET
           "totalSelling" = best_selling."totalSelling" + EXCLUDED."totalSelling",
           "nameProduct" = EXCLUDED."nameProduct",
           image = EXCLUDED.image,
           "updatedAt" = NOW()`,
        {
          bind: [
            product.id,
            sellName,
            product.image || null,
            store,
            deductQty
          ],
          transaction: t
        }
      )
    }

    for (const item of items) {
      if (item.bundleId && bundleMap[item.bundleId]) {
        // Bundle: deduct stock for each component product
        const bundle = bundleMap[item.bundleId]
        const bundleQty = Number(item.quantity) || 1
        for (const bi of bundle.items) {
          const product = productById.get(bi.product)
          if (!product) continue
          await deductAndTrack({
            product,
            deductQty: bi.quantity * bundleQty,
            referenceNote: `Penjualan bundle: ${bundle.name} (${orderNumber})`,
            sellName: product.nameProduct
          })
        }
        continue
      }

      // Regular product item
      const product = productById.get(item.product || item.productId)
      if (!product) continue

      await deductAndTrack({
        product,
        deductQty: Math.floor(Number(item.quantity)) || 0,
        referenceNote: `Penjualan: ${orderNumber}`,
        sellName: item.productName || product.nameProduct
      })
    }

    if (stockHistoryRows.length) {
      await db.stock_history.bulkCreate(stockHistoryRows, {
        transaction: t
      })
    }

    // F7: ingredient deduction — same transaction, after product stock
    // (global lock order: all product locks already acquired and released
    // their critical section above; ingredient locking, inside
    // adjustIngredientStockBatch, only starts now). Flat list mirrors the
    // exact same bundle-expansion shape as the product loop above, kept
    // deliberately separate so BOM resolution never entangles with the
    // already-proven product-deduction logic.
    const bomFlatItems = []
    for (const item of items) {
      if (item.bundleId && bundleMap[item.bundleId]) {
        const bundle = bundleMap[item.bundleId]
        const bundleQty = Number(item.quantity) || 1
        for (const bi of bundle.items) {
          bomFlatItems.push({
            productId: bi.product,
            quantity: bi.quantity * bundleQty
          })
        }
        continue
      }
      const pid = item.product || item.productId
      if (pid) {
        bomFlatItems.push({
          productId: pid,
          quantity: Math.floor(Number(item.quantity)) || 0
        })
      }
    }

    const bomRequirements = await resolveBomIngredientRequirements(
      bomFlatItems,
      store,
      productById,
      t
    )
    if (bomRequirements.length) {
      await adjustIngredientStockBatch({
        items: bomRequirements.map((r) => ({ ...r, qty: -r.qty })),
        store,
        referenceType: 'sale',
        referenceId: order.id,
        notes: `Penjualan: ${orderNumber}`,
        createdBy: userId,
        transaction: t
      })
    }
  }
}

// Cash tender invariant (F2). If explicit cash values are supplied, they
// must satisfy: cashReceived >= amountDue, changeGiven >= 0, and
// cashReceived - changeGiven === amountDue exactly. Omitting both is the
// backward-compatible exact-tender fallback. Supplying only one, or
// supplying either for a non-cash payment, is rejected. This intentionally
// throws a plain Error with .statusCode = 422 rather than using a Zod
// refine, because amountDue (totals.totalPrice) isn't known until the
// controller has already computed discounts/tax/service-charge, and
// because every ZodError in this codebase resolves to 400 regardless of
// content (see api/middleware/validate.js) — this invariant must be 422.
function validateCashTender({ paymentMethod, cashAmount, changeAmount, amountDue }) {
  const isCash = paymentMethod === 'CASH'
  const hasCash = cashAmount !== undefined && cashAmount !== null
  const hasChange = changeAmount !== undefined && changeAmount !== null

  if (!isCash) {
    if (hasCash || hasChange) {
      const e = new Error('cashAmount/changeAmount are only valid for cash payments')
      e.statusCode = 422
      throw e
    }
    return { cashReceived: null, changeGiven: 0 }
  }

  if (!hasCash && !hasChange) {
    // Backward-compatible exact-tender fallback — explicitly allowed.
    return { cashReceived: amountDue, changeGiven: 0 }
  }

  if (!hasCash || !hasChange) {
    const e = new Error('Both cashAmount and changeAmount are required when either is supplied')
    e.statusCode = 422
    throw e
  }

  const cashReceived = Number(cashAmount)
  const changeGiven = Number(changeAmount)

  if (!Number.isFinite(cashReceived) || !Number.isFinite(changeGiven)) {
    const e = new Error('cashAmount/changeAmount must be numeric')
    e.statusCode = 422
    throw e
  }
  // F-MON-1: rupiah is integer — a fractional tender that happens to be
  // arithmetically exact (e.g. due+0.5 tendered, 0.5 change) would pass
  // the equality check below and then corrupt the BIGINT ledger write.
  // Reject before persistence/math; never floor/truncate.
  if (!Number.isInteger(cashReceived) || !Number.isInteger(changeGiven)) {
    const e = new Error('cashAmount/changeAmount must be integer rupiah amounts')
    e.statusCode = 422
    throw e
  }
  if (changeGiven < 0) {
    const e = new Error('changeGiven cannot be negative')
    e.statusCode = 422
    throw e
  }
  if (cashReceived < amountDue) {
    const e = new Error('cashAmount is less than the amount due')
    e.statusCode = 422
    throw e
  }
  if (cashReceived - changeGiven !== amountDue) {
    const e = new Error('cashAmount minus changeAmount must exactly equal the amount due')
    e.statusCode = 422
    throw e
  }

  return { cashReceived, changeGiven }
}

const recordOrderPayment = async (
  order,
  paymentMethod,
  totalPrice,
  userId,
  transaction,
  cashReceived,
  changeGiven,
  attribution = {}
) => {
  if (!paymentMethod) return
  await db.transaction.create(
    {
      order: order.id,
      typePayment: paymentMethod,
      amount: totalPrice,
      cashReceived: cashReceived ?? null,
      changeGiven: changeGiven ?? 0,
      createdBy: userId,
      cashRegisterId: attribution.cashRegisterId ?? null,
      splitBillId: attribution.splitBillId ?? null,
      referenceNumber: attribution.referenceNumber ?? null
    },
    { transaction }
  )
}

// DR-04: builds the complete settlement tender for an update-status paid
// transition. The request must carry a payment method when the order does
// not already hold one (QR orders are created method-less); cash detail is
// validated with the same server-side validateCashTender as order create.
// P1 attribution (DR-PAY-ATTR-01..03): the tender is canonicalized (422 on
// unknown), and drawer attribution ALWAYS resolves the currently open
// register under a SHARE lock that serializes against register close — the
// order header's cashRegisterId is legacy context and is never inherited as
// financial ownership (it would retroactively reattribute earlier split
// collections). Any failure throws 4xx inside the caller's transaction, so
// the order is never left paid-but-unattributed.
// DR-23 (BA §35.10): amountDue is the CURRENT outstanding amount recomputed
// from the ledger under the order lock — never the order's gross total.
const resolvePaidSettlement = async ({
  bodyMethod,
  cashAmount,
  changeAmount,
  referenceNumber,
  lockedOrder,
  effectiveStore,
  amountDue,
  t
}) => {
  const method = normalizePaymentMethod(bodyMethod || lockedOrder.paymentMethod || null)
  if (!method) {
    const err = new Error('paymentMethod is required to settle an order to paid')
    err.statusCode = 422
    throw err
  }
  const { cashReceived, changeGiven } = validateCashTender({
    paymentMethod: method,
    cashAmount: cashAmount ?? null,
    changeAmount: changeAmount ?? null,
    amountDue
  })
  const register = await resolveAttributedRegister(effectiveStore, t)

  // DR-23 §D / §M: a manually confirmed non-cash settlement (every tender
  // but CASH and POINTS) carries its reference, as a split payment and a
  // void refund already do. Enforced here, not in updateOrderStatusSchema:
  // the tender may come from the order itself and is canonical only after
  // normalizePaymentMethod. Whitespace-only counts as missing; the stored
  // reference is trimmed. Thrown inside the settlement transaction, so the
  // refusal writes nothing.
  const reference = typeof referenceNumber === 'string' ? referenceNumber.trim() : ''
  if (requiresTenderReference(method) && reference === '') {
    throw financialError(
      422,
      'REFERENCE_REQUIRED',
      `referenceNumber is required for ${method} settlement`
    )
  }

  return {
    method,
    cashReceived,
    changeGiven,
    registerId: register.id,
    referenceNumber: method === 'CASH' || reference === '' ? null : reference,
    amountDue
  }
}

// DR-04 P2-1: a `points` settlement redeems the order's full payable total
// (1 point = Rp1) from the member already attached to the order — never a
// client-supplied member or amount. Runs inside the caller's transaction,
// after the existing-settlement skip and before any settlement mutation: the
// member row is locked first and sufficiency is checked under that lock, so
// two settlements racing on one balance cannot both pass, and a shortfall
// fails (422) instead of being clamped to zero by adjustMemberPoints.
const redeemSettlementPoints = async ({ lockedOrder, effectiveStore, userId, amount, t }) => {
  // DR-23: the points tender covers the settlement amount (current
  // outstanding), not the order's gross total.
  const pointsRequired = Number(amount) || 0
  const member = lockedOrder.customerId
    ? await db.member.findByPk(lockedOrder.customerId, {
        transaction: t,
        lock: t.LOCK.UPDATE
      })
    : null
  if (!member) {
    const err = new Error('Order has no attached member; points settlement requires a member')
    err.statusCode = 422
    throw err
  }
  if (member.store !== null && Number(member.store) !== Number(effectiveStore)) {
    const err = new Error('Member does not belong to this store')
    err.statusCode = 422
    throw err
  }
  if ((Number(member.totalPoints) || 0) < pointsRequired) {
    const err = new Error('Insufficient point balance')
    err.statusCode = 422
    throw err
  }
  await adjustMemberPoints({
    memberId: member.id,
    deltaPoints: -pointsRequired,
    referenceId: lockedOrder.id,
    notes: `Redeemed ${pointsRequired} points to settle order ${lockedOrder.orderNumber}`,
    createdBy: userId || null,
    transaction: t
  })
}

const createInitialOrderStatus = async (
  order,
  cashierName,
  paymentMethod,
  userId,
  transaction
) => {
  await OrderStatus.create(
    {
      order: order.id,
      status: 'paid',
      createdBy: userId,
      notes: `Paid by ${cashierName} via ${paymentMethod || 'cash'}`
    },
    { transaction }
  )
}

// Loyalty points, promo usage, and accounting posting used to run AFTER
// the order's own transaction had already committed, each wrapped in its
// own try/catch(console.error) — a failure there (a race on the member row,
// a transient DB blip) left a paid, stock-deducted order with a silently
// missing/wrong points balance, promo usage count, or GL entry, with
// nothing recording that it had ever gone wrong. All four now run INSIDE
// the order's own transaction (passed in as `t` by the caller) using
// atomic, row-locked helpers (loyaltyService/promoUsageService — the same
// lock-then-atomic-delta pattern already used for stock in
// stockMutationService), and the accounting entries are additionally
// enqueued to a durable outbox (accountingOutboxService) in the same
// transaction so a posting failure is retried instead of discarded.

const applyRedeemedPoints = async (
  order,
  customerId,
  redeemedPointsUsed,
  orderNumber,
  transaction
) => {
  if (!(redeemedPointsUsed > 0 && customerId)) return
  await adjustMemberPoints({
    memberId: customerId,
    deltaPoints: -redeemedPointsUsed,
    referenceId: order.id,
    notes: `Redeemed ${redeemedPointsUsed} points for order ${orderNumber}`,
    transaction
  })
}

const awardEarnedPoints = async (
  order,
  items,
  customerId,
  orderNumber,
  userId,
  transaction
) => {
  if (!customerId) return
  // Approved formula lives in loyaltyService; this wrapper preserves the
  // counter-creation call shape (atomic paid-at-creation award).
  const pointsEarned = await computeEarnedPoints(items, transaction)
  if (pointsEarned <= 0) return

  const result = await adjustMemberPoints({
    memberId: customerId,
    deltaPoints: pointsEarned,
    deltaLifetimePoints: pointsEarned,
    referenceId: order.id,
    notes: `Earned ${pointsEarned} points from order ${orderNumber}`,
    createdBy: userId,
    transaction
  })
  if (result) {
    await maybeUpgradeMemberTier({ member: result.member, transaction })
  }
}

const recordPromoUsageIfApplied = async (
  order,
  appliedCampaignId,
  customerId,
  promoDiscountAmount,
  campaignWithSubtotal,
  userId,
  transaction
) => {
  if (!appliedCampaignId) return
  const result = await incrementPromoUsage({
    campaignId: appliedCampaignId,
    orderId: order.id,
    memberId: customerId || null,
    discountApplied: promoDiscountAmount,
    freeItemsGiven: campaignWithSubtotal.reward
      ? [
          {
            productId: campaignWithSubtotal.reward.productId,
            quantity: campaignWithSubtotal.reward.quantity
          }
        ]
      : null,
    createdBy: userId,
    transaction,
    // The discount was already computed and applied to this order's totals
    // before checkout reached this point — a per-member cap collision here
    // is a bookkeeping edge case, not a reason to refuse recording that the
    // (already-honored) discount happened. Only maxUsageTotal, the actual
    // "no more discounted orders allowed at all" cap, is worth knowing
    // about below; skip the extra query for the per-member cap.
    enforcePerMemberLimit: false
  })
  if (result.limitReached) {
    console.error(
      `Promo usage for campaign ${appliedCampaignId} not recorded on order ${order.id}: maxUsageTotal reached`
    )
  }
}

// Enqueues the two journal-posting jobs INSIDE the caller's transaction —
// call this before the transaction commits. Returns the outbox rows so the
// caller can attempt immediate posting after commit and reconcile the
// outcome against them (see attemptOrderAccountingEntries below).
const enqueueOrderAccountingJobs = async (
  order,
  store,
  orderNumber,
  totals,
  paymentMethod,
  userId,
  transaction
) => {
  const date = new Date().toISOString()
  const orderJournalJob = await enqueueAccountingJob({
    jobType: 'order_journal',
    store,
    referenceType: 'order',
    referenceId: order.id,
    payload: {
      store,
      orderId: order.id,
      orderNumber,
      subTotal: totals.subTotal,
      discountAmount: totals.discountAmount,
      taxAmount: totals.taxAmount,
      serviceChargeAmount: totals.serviceChargeAmount,
      totalPrice: totals.totalPrice,
      date,
      paymentMethod,
      createdBy: userId
    },
    transaction
  })
  const cogsJournalJob = await enqueueAccountingJob({
    jobType: 'order_cogs_journal',
    store,
    referenceType: 'order',
    referenceId: order.id,
    payload: { store, orderId: order.id, orderNumber, date, createdBy: userId },
    transaction
  })
  return { orderJournalJob, cogsJournalJob }
}

// Best-effort immediate posting attempt, called AFTER the transaction has
// committed (so it never rolls back an otherwise-valid paid order). Whether
// this succeeds or fails, the outcome is written back to the outbox rows
// enqueued above — success marks them posted immediately so the scheduler
// never redundantly reprocesses them; failure leaves them pending for it.
const attemptOrderAccountingEntries = async ({ orderJournalJob, cogsJournalJob }) => {
  const orderResult = await attemptJob(orderJournalJob)
  await recordImmediateAttempt(orderJournalJob, orderResult)
  if (!orderResult.ok) {
    console.error('Accounting posting deferred to retry queue:', orderResult.error)
  }
  const cogsResult = await attemptJob(cogsJournalJob)
  await recordImmediateAttempt(cogsJournalJob, cogsResult)
  if (!cogsResult.ok) {
    console.error('COGS accounting posting deferred to retry queue:', cogsResult.error)
  }
}

exports.getOrdersByStore = async (req, res) => {
  const { store, status, date, table, startDate, endDate, page, limit, cashRegisterId, window } =
    req.query

  try {
    const reqStore =
      req.user?.roleType === 'super_admin'
        ? req.storeId || store || null
        : req.storeId || req.user?.store || null
    if (!reqStore && req.user?.roleType !== 'super_admin') {
      return res.status(403).json({
        message: 'Store assignment required'
      })
    }
    const where = {}
    if (reqStore) where.store = reqStore
    if (status) where.status = status
    if (req.query.source) where.source = req.query.source
    if (req.query.paymentStatus) where.paymentStatus = req.query.paymentStatus
    if (cashRegisterId) {
      // Phase 39 Batch 4: register-window querying for
      // /cash-register/history/detail. The register lifecycle timestamps
      // (openedAt..closedAt) are the source of truth — NOT the opening
      // calendar date. Exact timestamp bounds on order.createdAt (the
      // authoritative system-generated timestamp, same convention as the
      // cash-register report/reconciliation queries), applied in SQL so no
      // historical order is loaded into memory for JS-side filtering.
      // An open register has no closedAt yet: the window runs to now,
      // mirroring getZReport's `closedAt || new Date()`.
      // The register owns its store scope (same-store requirement as
      // getZReport: non-super-admin callers get 403 on a foreign
      // register); calendar-date params are superseded when this filter
      // is present. Pagination, ordering, and response shape are unchanged.
      const register = await db.cashRegister.findByPk(cashRegisterId)
      if (!register) {
        return res.status(404).json({
          message: 'Cash register not found'
        })
      }
      if (
        req.user?.roleType !== 'super_admin' &&
        reqStore &&
        Number(register.store) !== Number(reqStore)
      ) {
        return res.status(403).json({
          message: 'Anda hanya dapat mengakses data di toko Anda'
        })
      }
      where.store = register.store
      const endAt = register.closedAt || new Date()
      if (window === 'outside') {
        // Phase 39 Batch 4 follow-up: the "outside register period"
        // history on /cash-register/history/detail. Population mirrors the
        // reconciliation OUTSIDE_WINDOW bucket exactly (same store +
        // opener attribution + paid/refunded + not cancelled/void, only the
        // time predicate inverted) so the listed rows match the bucket's
        // count/total 1:1. Explicit status/paymentStatus query params still
        // narrow further when provided; otherwise the bucket membership is
        // the default. Same SQL-side filtering, pagination, and shape.
        where.createdBy = register.user
        // Sequelize cannot express OR across two comparisons on one column
        // with a plain object — use an explicit OR group.
        where.createdAt = {
          [Op.or]: [
            { [Op.lt]: register.openedAt },
            { [Op.gt]: endAt }
          ]
        }
        if (!status) where.status = { [Op.notIn]: ['cancelled', 'void'] }
        if (!req.query.paymentStatus) where.paymentStatus = { [Op.in]: ['paid', 'refunded'] }
      } else {
        where.createdAt = {
          [Op.gte]: register.openedAt,
          [Op.lte]: endAt
        }
      }
    } else {
      if (date) {
        where.createdAt = {
          [require('sequelize').Op.gte]: new Date(date + ' 00:00:00'),
          [require('sequelize').Op.lte]: new Date(date + ' 23:59:59')
        }
      }
    if (startDate && endDate) {
      where.createdAt = {
        [require('sequelize').Op.gte]: new Date(startDate + ' 00:00:00'),
        [require('sequelize').Op.lte]: new Date(endDate + ' 23:59:59')
      }
    }
    }
    if (table) {
      where.tableId = table
    }

    const pageNum = parseInt(page) || 1
    const limitNum = parseInt(limit) || 50
    const offset = (pageNum - 1) * limitNum

    const queryOptions = {
      where,
      include: [
        {
          model: OrderItem,
          as: 'items'
        },
        {
          model: Table,
          as: 'table'
        }
      ],
      // Phase 39 Batch 5: `items` is a hasMany, so without `distinct: true`
      // Sequelize's generated COUNT joins order_item and counts one row per
      // item instead of per order, inflating pagination.total whenever an
      // order has more than one item (rows themselves are unaffected —
      // Sequelize already hydrates one Order instance per distinct id).
      // Same pattern as goodsReceipt.js, product.js, purchaseOrder.js,
      // pos.js, purchaseReturn.js.
      distinct: true,
      order: [['createdAt', 'DESC']],
      limit: limitNum,
      offset
    }

    const orderAttributes = await getOrderAttributes()
    if (orderAttributes) queryOptions.attributes = orderAttributes

    const { count: total, rows: orders } =
      await Order.findAndCountAll(queryOptions)

    return res.status(200).json({
      message: 'Success',
      data: orders,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(total / limitNum)
      }
    })
  } catch (error) {
    console.error('Error:', error)
    return res.status(500).json({
      error: 'Internal Server Error'
    })
  }
}

exports.getOrderById = async (req, res) => {
  const { id } = req.params

  try {
    const orderAttributes = await getOrderAttributes()
    const reqStore =
      req.user?.roleType === 'super_admin'
        ? req.storeId || null
        : req.storeId || req.user?.store || null
    if (!reqStore && req.user?.roleType !== 'super_admin') {
      return res.status(403).json({
        message: 'Store assignment required'
      })
    }
    const order = await Order.findOne({
      where: { id, ...(reqStore ? { store: reqStore } : {}) },
      include: [
        { model: OrderItem, as: 'items' },
        { model: OrderStatus, as: 'statusHistory' },
        { model: Table, as: 'table' }
      ],
      ...(orderAttributes ? { attributes: orderAttributes } : {})
    })

    if (!order) {
      return res.status(404).json({
        message: 'Order not found'
      })
    }

    return res.status(200).json({
      message: 'Success',
      data: order
    })
  } catch (error) {
    console.error('Error:', error)
    return res.status(500).json({
      error: 'Internal Server Error'
    })
  }
}

// Reduce stock exactly once when an order transitions to paid. Shared by
// updateOrderStatus (status -> 'paid') and splitBill.pay (last split paid)
// — split-bill previously never called any stock-deduction path at all, so
// an order completed by splitting its payment across several people never
// had its stock deducted, ever.
const deductStockForPaidOrder = async (
  orderId,
  effectiveStore,
  orderNumber,
  changedBy,
  t
) => {
  const items = await OrderItem.findAll({
    where: { order: orderId },
    transaction: t
  })
  if (items.length === 0) return

  // Flatten bundle order_items into their component products so the
  // deferred paid-transition path deducts every component exactly as the
  // immediate-POS path does. The order_item row for a bundle only ever
  // carries its FIRST component's product (pre-existing F5-era
  // limitation), so the bundle's components are expanded from the CURRENT
  // product_bundle config — an accepted edit-window skew: if the bundle
  // composition changed after the order was taken, deduction reflects the
  // bundle as it reads today, never a snapshot. When a bundle can no
  // longer be resolved to any component, the legacy single-product
  // deduction of item.product is preserved.
  const flatItems = []
  for (const item of items) {
    if (item.bundleId) {
      const bundle = await db.product_bundle.findByPk(item.bundleId, {
        include: [
          {
            model: db.product_bundle_item,
            as: 'items',
            include: [{ model: Product, as: 'productData' }]
          }
        ],
        transaction: t
      })
      const bundleQty = Number(item.quantity) || 1
      const members = (bundle && bundle.items) || []
      if (!members.length) {
        flatItems.push({
          product: item.product,
          productId: item.product,
          quantity: Number(item.quantity) || 0,
          productName: item.productName,
          referenceNote: `Penjualan: ${orderNumber}`
        })
        continue
      }
      for (const bi of members) {
        flatItems.push({
          product: bi.product,
          productId: bi.product,
          quantity: (Number(bi.quantity) || 1) * bundleQty,
          productName: bi.productData?.nameProduct || item.productName,
          referenceNote: `Penjualan bundle: ${bundle.name} (${orderNumber})`
        })
      }
      continue
    }
    flatItems.push({
      product: item.product,
      productId: item.product,
      quantity: Number(item.quantity) || 0,
      productName: item.productName,
      referenceNote: `Penjualan: ${orderNumber}`
    })
  }

  // Lock every distinct product once, in a stable order, instead of one
  // findByPk+lock per item.
  const productIds = [
    ...new Set(flatItems.map((it) => it.product).filter(Boolean))
  ].sort((a, b) => a - b)
  const products = await Product.findAll({
    where: { id: productIds },
    transaction: t,
    lock: t.LOCK.UPDATE
  })
  const productById = new Map(products.map((p) => [p.id, p]))

  const stockHistoryRows = []

  for (const item of flatItems) {
    const product = productById.get(item.product)
    if (!product) continue

    if (product.inventoryMode !== 'make_to_order') {
      const oldStock = Number(product.stock) || 0
      const qty = Math.floor(Number(item.quantity)) || 0
      const newStock = Math.max(oldStock - qty, 0)
      await product.update(
        {
          stock: db.sequelize.literal(`GREATEST(stock - ${qty}, 0)`)
        },
        { transaction: t }
      )
      product.stock = newStock

      // ponytail: atomic upsert + deduct per-store stock
      await db.sequelize.query(
        `INSERT INTO product_store_stock (product, store, stock, "createdAt", "updatedAt")
         VALUES ($1, $2, 0, NOW(), NOW())
         ON CONFLICT (product, store) DO NOTHING`,
        { bind: [item.product, effectiveStore], transaction: t }
      )
      await db.product_store_stock.update(
        {
          stock: db.sequelize.literal(`GREATEST(stock - ${qty}, 0)`)
        },
        {
          where: { product: item.product, store: effectiveStore },
          transaction: t
        }
      )

      // ponytail: FIFO - consume oldest batches first
      await batchService.deductFifo({
        productId: product.id,
        store: effectiveStore,
        qty,
        transaction: t
      })

      stockHistoryRows.push({
        product: product.id,
        store: effectiveStore,
        referenceType: 'sale',
        referenceId: orderId,
        quantityBefore: oldStock,
        quantityChange: -qty,
        quantityAfter: newStock,
        unit: product.unit || 'pcs',
        notes: item.referenceNote,
        createdBy: changedBy
      })
    }

    const sellName = item.productName || product.nameProduct
    await db.sequelize.query(
      `INSERT INTO best_selling ("productId", "nameProduct", image, store, "totalSelling", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT ("productId", store) WHERE "deletedAt" IS NULL
       DO UPDATE SET
         "totalSelling" = best_selling."totalSelling" + EXCLUDED."totalSelling",
         "nameProduct" = EXCLUDED."nameProduct",
         image = EXCLUDED.image,
         "updatedAt" = NOW()`,
      {
        bind: [
          product.id,
          sellName,
          product.image || null,
          effectiveStore,
          Number(item.quantity) || 0
        ],
        transaction: t
      }
    )
  }

  if (stockHistoryRows.length) {
    await db.stock_history.bulkCreate(stockHistoryRows, {
      transaction: t
    })
  }

  // F7: ingredient deduction, same transaction, after product stock. Uses
  // the SAME flattened/expanded item list as the product loop above, so a
  // BOM-having bundle component reached through this deferred path has its
  // ingredients resolved exactly like the immediate path does — each
  // component, not just the first one the order_item row happens to carry.
  const bomRequirements = await resolveBomIngredientRequirements(
    flatItems,
    effectiveStore,
    productById,
    t
  )
  if (bomRequirements.length) {
    await adjustIngredientStockBatch({
      items: bomRequirements.map((r) => ({ ...r, qty: -r.qty })),
      store: effectiveStore,
      referenceType: 'sale',
      referenceId: orderId,
      notes: `Penjualan: ${orderNumber}`,
      createdBy: changedBy,
      transaction: t
    })
  }
}
exports.deductStockForPaidOrder = deductStockForPaidOrder
// P1: split-bill settlement reuses the same server-side cash-tender
// invariant (exact change math, integer rupiah) instead of duplicating it.
exports.validateCashTender = validateCashTender
// F5: additive exports only — both functions are unchanged, already used
// by this file's own two order-completion paths (immediate pay,
// updateOrderStatus's paid-transition). splitBill.js's completion branch
// reuses these directly instead of calling accountingService or the
// outbox a second, parallel way.
exports.enqueueOrderAccountingJobs = enqueueOrderAccountingJobs
exports.attemptOrderAccountingEntries = attemptOrderAccountingEntries

exports.updateOrderStatus = async (req, res) => {
  const { id, status, changedBy, changedByName, notes, reason } = req.body
  const store =
    req.user?.roleType === 'super_admin'
      ? req.storeId || req.body.store || null
      : req.storeId || req.user?.store || null

  // DR-23 §J / DR-08: settling, cancelling and voiding are capability-
  // controlled (void elevated). Staff hold none of them by default.
  // Refused before any read or mutation; the denial is audited (DR-20),
  // outside any transaction.
  const requiredCapability = STATUS_CAPABILITY[status]
  if (requiredCapability && !hasCapability(req.user, requiredCapability)) {
    if (status === 'void') {
      await redactAndAudit(req, {
        action: AUDIT_ACTIONS.VOID,
        entity: 'order',
        entityId: id,
        description: `Void of order ${id} denied: elevated capability (order.void) required`,
        newValues: { result: 'DENIED', roleType: req.user?.roleType || null }
      })
      return res.status(403).json({
        error: 'Voiding an order requires an elevated capability (order.void)',
        code: 'FORBIDDEN'
      })
    }
    await auditCapabilityDenial(req, {
      capability: requiredCapability,
      entity: 'order',
      entityId: id,
      action: status === 'paid' ? AUDIT_ACTIONS.PAYMENT : AUDIT_ACTIONS.UPDATE
    })
    return res.status(403).json(denialBody(requiredCapability))
  }

  // Split rows retired by this transition; audited after commit.
  let retiredSplits = []
  let retiredSplitReason = null

  try {
    const statusAttrs = await getOrderAttributes()
    const order = await Order.findOne({
      where: { id, ...(store ? { store } : {}) },
      ...(statusAttrs ? { attributes: statusAttrs } : {})
    })

    if (!order) {
      return res.status(404).json({
        message: 'Order not found'
      })
    }

    const sentCustomerId = req.body.customerId

    // Used outside the transaction below (accounting posting, which is
    // already dedup-guarded by referenceId). The guards that actually
    // decide whether to mutate stock use a fresh, row-locked read taken
    // inside the transaction instead — see lockedOrder below.
    const effectiveStore = store || order.store || null

    // Reduce stock exactly once when an order transitions to paid. Orders that
    // were already paid & deducted at creation (paymentStatus 'paid') are skipped.
    const deductPaidOrderStock = (t) =>
      deductStockForPaidOrder(id, effectiveStore, order.orderNumber, changedBy, t)

    // Restore stock when an order is cancelled/voided.
    const reverseOrderStock = async (t) => {
      // F-REV1: reversal is driven by the immutable stock_history 'sale'
      // snapshot written when the order was paid — NOT by re-reading the
      // bundle config and NOT by the order_item rows (a bundle's order_item
      // carries only its first component's product). A bundle sale deducts
      // FG stock for EVERY component (see the flatItems expansion in
      // deductStockForPaidOrder / deductStockForOrder), so the reversal
      // restores exactly the products and quantities the 'sale' rows
      // recorded — even if the bundle configuration has since changed.
      const saleHistory = await db.stock_history.findAll({
        where: { referenceType: 'sale', referenceId: id },
        transaction: t
      })

      // Finished-good restore: every product the sale dipped goes back by
      // the exact recorded quantity. Ingredient rows (ingredient set) are
      // the BOM consumption trail, handled separately below — a
      // make_to_order product has no FG 'sale' row, so it never receives a
      // FG restore here.
      const fgRestore = new Map()
      for (const row of saleHistory) {
        if (row.ingredient != null) continue
        const productId = Number(row.product)
        if (!productId) continue
        const change = Number(row.quantityChange) || 0
        if (!(change < 0)) continue
        fgRestore.set(productId, (fgRestore.get(productId) || 0) - change)
      }

      // best_selling was incremented for every flat sale product — including
      // single make_to_order lines, which never touch FG stock and so have
      // no FG 'sale' row. Their increment is recovered from the immutable
      // non-bundle order lines (a non-bundle line's product/quantity is
      // exact), so their best_selling is decremented too. Bundle-owned
      // make_to_order components have no immutable product-level quantity
      // anywhere (their order_item line is the bundle's first component
      // only) — same pre-existing attribution limit, out of F-REV1 scope.
      const bsDecrement = new Map(fgRestore)
      const nonBundleLines = await OrderItem.findAll({
        where: { order: id, bundleId: null },
        transaction: t
      })
      for (const line of nonBundleLines) {
        const productId = Number(line.product)
        if (!productId) continue
        if (fgRestore.has(productId)) continue
        const qty = Math.floor(Number(line.quantity)) || 0
        if (!(qty > 0)) continue
        bsDecrement.set(productId, (bsDecrement.get(productId) || 0) + qty)
      }

      const productIds = [
        ...new Set([...fgRestore.keys(), ...bsDecrement.keys()])
      ].sort((a, b) => a - b)
      const products = productIds.length
        ? await Product.findAll({
            where: { id: productIds },
            transaction: t,
            lock: t.LOCK.UPDATE
          })
        : []
      const productById = new Map(products.map((p) => [p.id, p]))

      for (const [productId, restoreQty] of fgRestore) {
        const product = productById.get(productId)
        if (!product) continue
        const oldStock = Number(product.stock) || 0
        const newStock = oldStock + restoreQty
        await product.update(
          { stock: db.sequelize.literal(`stock + ${restoreQty}`) },
          { transaction: t }
        )

        // Same seed-at-baseline convention as the sale path above: a
        // missing shadow row starts from the just-locked global stock so
        // the restore lands the per-store stock on the same value.
        await db.sequelize.query(
          `INSERT INTO product_store_stock (product, store, stock, "createdAt", "updatedAt")
           VALUES ($1, $2, $3, NOW(), NOW())
           ON CONFLICT (product, store) DO NOTHING`,
          { bind: [productId, effectiveStore, oldStock], transaction: t }
        )
        await db.product_store_stock.update(
          { stock: db.sequelize.literal(`stock + ${restoreQty}`) },
          { where: { product: productId, store: effectiveStore }, transaction: t }
        )

        await db.stock_history.create(
          {
            product: productId,
            store: effectiveStore,
            referenceType: 'sale_reversal',
            referenceId: order.id,
            quantityBefore: oldStock,
            quantityChange: restoreQty,
            quantityAfter: newStock,
            unit: product.unit || 'pcs',
            notes: `Pembatalan: ${order.orderNumber}`,
            createdBy: changedBy
          },
          { transaction: t }
        )
      }

      // best_selling: undo exactly what the sale incremented for the same
      // (productId, store) rows (the table's unique key), floored at zero.
      for (const [productId, decQty] of bsDecrement) {
        const product = productById.get(productId)
        if (!product) continue
        const findBs = await db.best_selling.findOne({
          where: { productId, store: effectiveStore },
          transaction: t
        })
        if (findBs) {
          await db.best_selling.update(
            {
              totalSelling: Math.max(
                0,
                Number(findBs.totalSelling) - decQty
              )
            },
            {
              where: { productId, store: effectiveStore },
              transaction: t
            }
          )
        }
      }

      // F7: ingredient reversal — reverses the EXACT immutable deduction
      // snapshot recorded in stock_history at sale time, never re-reads
      // bom_header/bom_line (the production-order cancellation precedent
      // this deliberately avoids repeating: re-exploding the *current*
      // BOM would restore the wrong quantity if the recipe changed after
      // the sale). Grouped by (product, ingredient) exactly as it was
      // originally recorded, so a future partial-return feature retains
      // the same attribution this reversal already relies on.
      const saleIngredientHistory = await db.stock_history.findAll({
        where: {
          referenceType: 'sale',
          referenceId: order.id,
          ingredient: { [Op.ne]: null }
        },
        transaction: t
      })
      if (saleIngredientHistory.length) {
        const byProductIngredient = new Map()
        for (const row of saleIngredientHistory) {
          const key = `${row.product}:${row.ingredient}`
          const existing = byProductIngredient.get(key)
          if (existing) {
            existing.qty += Number(row.quantityChange)
          } else {
            byProductIngredient.set(key, {
              productId: row.product,
              ingredientId: row.ingredient,
              ingredientName: row.ingredientName,
              qty: Number(row.quantityChange)
            })
          }
        }
        await adjustIngredientStockBatch({
          items: Array.from(byProductIngredient.values()).map((r) => ({
            ...r,
            qty: -r.qty // original rows are negative (deduction); reversal restores the exact inverse
          })),
          store: effectiveStore,
          referenceType: 'sale_reversal',
          referenceId: order.id,
          notes: `Pembatalan: ${order.orderNumber}`,
          createdBy: changedBy,
          transaction: t
        })
      }
    }

    // Perform the whole status transition atomically.
    let orderJournalJob, cogsJournalJob, reversalJob
    // F7: wrapped in withDeadlockRetry — this transaction may now also
    // lock ingredient rows (via deductPaidOrderStock's ingredient step,
    // or reverseOrderStock's reversal step), raising the number of
    // distinct rows locked. A killed transaction here is guaranteed by
    // Postgres to have committed nothing, so re-running this whole
    // callback from scratch is safe.
    await withDeadlockRetry(() =>
      db.sequelize.transaction(async (t) => {
      retiredSplits = []
      retiredSplitReason = null
      // Re-read the order under a row lock and derive oldStatus/
      // oldPaymentStatus from THIS fresh read, shadowing the stale
      // pre-transaction values above. Two concurrent status-change requests
      // for the same order (a double-tap, or a client retry after a
      // timeout) previously both read the order before either had
      // committed, so both saw paymentStatus !== 'paid' and both deducted
      // stock — a real double-deduction, not just a duplicate-payment risk
      // (which was already guarded by a fresh existingTxn check below).
      const lockedOrder = await Order.findByPk(id, {
        transaction: t,
        lock: t.LOCK.UPDATE,
        ...(statusAttrs ? { attributes: statusAttrs } : {})
      })
      const oldStatus = lockedOrder.status
      const oldPaymentStatus = lockedOrder.paymentStatus
      // DR-16 / DR-01: the order update below attaches `customerId` on ANY
      // status change when the order has no member yet, so a supplied
      // member must resolve inside this order's store before anything is
      // written — on every transition, not only on settlement.
      if (
        sentCustomerId !== undefined &&
        sentCustomerId !== null &&
        (lockedOrder.customerId === null || lockedOrder.customerId === undefined)
      ) {
        const scoped = await resolveStoreScopedMember(sentCustomerId, lockedOrder.store, t)
        if (!scoped.member) throw financialError(422, scoped.code, scoped.message)
      }
      // DR-23 (BA §35.10): every financial decision below is taken on the
      // aggregates recomputed from the ledger under THIS order lock — never
      // on a pre-lock read, a cached paymentStatus, or the order's gross
      // total.
      const fin = await computeOrderFinancials(lockedOrder, t)
      const isSettlement = status === 'paid'
      const wasTerminal = TERMINAL_FULFILMENT.includes(oldStatus)

      // F-03 (preserved) + DR-23: a cancelled/voided order, or one whose
      // money was (partly) refunded, is never settleable again — re-marking
      // it paid would re-deduct stock on top of the reversal. Rejected
      // before any mutation; the whole transaction rolls back.
      if (
        isSettlement &&
        (wasTerminal ||
          [
            FINANCIAL_STATES.REFUNDED,
            FINANCIAL_STATES.PARTIALLY_REFUNDED,
            FINANCIAL_STATES.INVALID
          ].includes(fin.state))
      ) {
        throw financialError(
          409,
          'ORDER_NOT_SETTLEABLE',
          'Cannot re-mark a cancelled, voided or refunded order as paid. Create a new order to sell again.'
        )
      }

      // BA §35.10 / DR-23 terminal guard (P0 terminal-state bypass close,
      // second path): a terminal fulfilment state never leaves via ordinary
      // status update. Settlement-of-terminal is refused above (preserved
      // ORDER_NOT_SETTLEABLE); cancel/void idempotence and cross-terminal
      // refusal are handled below. Any other backward move
      // (cancelled/void → pending/confirmed/preparing/ready/served) is
      // refused here — terminal wins. Paid progression is untouched.
      if (
        wasTerminal &&
        ['pending', 'confirmed', 'preparing', 'ready', 'served'].includes(status)
      ) {
        throw financialError(
          409,
          'INVALID_TRANSITION',
          `Order is already ${oldStatus}; it cannot become ${status}`
        )
      }

      // DR-23 P0-1: a settlement settles exactly the CURRENT outstanding
      // amount. A request without an explicit amount is a legacy client
      // claiming the order's full total (G); once anything was collected
      // (O < G) that claim is stale and refused. Never derive "paid" from
      // the mere existence of a ledger row.
      let paidTender = null
      let settleAmount = 0
      let zeroPayableCompletion = false
      if (isSettlement) {
        let requested = fin.G
        const rawAmount = req.body.amount
        if (rawAmount !== undefined && rawAmount !== null && rawAmount !== '') {
          requested = Number(rawAmount)
          if (!Number.isInteger(requested) || requested <= 0) {
            throw financialError(422, 'INVALID_AMOUNT', 'amount must be a positive integer rupiah amount')
          }
        }
        if (
          fin.G === 0 &&
          fin.C === 0 &&
          fin.state === FINANCIAL_STATES.PAID &&
          oldPaymentStatus !== 'paid'
        ) {
          // Zero-payable order: completes without a tender (INV-PAY-09).
          zeroPayableCompletion = true
        } else if (fin.O <= 0 || requested !== fin.O) {
          // DR-23 §K/§M: a retry whose first attempt already settled (its
          // response lost) lands here with O = 0. The ledger-derived state
          // lets the client tell "already settled" from "amount stale"
          // without parsing the message; nothing is changed either way.
          throw financialError(
            409,
            'OUTSTANDING_CHANGED',
            `Settlement amount ${requested} does not equal the current outstanding amount ${fin.O}`,
            { outstanding: fin.O, financialState: fin.state, netPayable: fin.P, collected: fin.C }
          )
        }
        if (!zeroPayableCompletion) {
          settleAmount = fin.O

          // DR-16: member attachment is idempotent only under these conditions:
          //  • no existing member on the order → any valid supplied ID attaches
          //  • same existing member → idempotent (no-op, points still awarded once)
          //  • different existing member → 409, never silently replace attribution
          const orderHasExistingMember = lockedOrder.customerId !== null && lockedOrder.customerId !== undefined
          if (sentCustomerId !== undefined) {
            if (orderHasExistingMember && Number(sentCustomerId) !== Number(lockedOrder.customerId)) {
              // Different existing member: refuse and never silently replace
              throw financialError(409, 'MEMBER_MISMATCH', 'Cannot attach a different member ID to an already-attached order')
            }
            // A newly attached member was already store-scoped right after
            // the order lock (see below the lockedOrder read).
            // Either (a) no existing member → attach the supplied member,
            // or (b) same existing member → idempotent (fall through, points awarded once)
          }

          // DR-04: complete tender — method, server-validated cash detail
          // against the outstanding amount, and drawer attribution.
          paidTender = await resolvePaidSettlement({
            bodyMethod: req.body.paymentMethod,
            cashAmount: req.body.cashAmount,
            changeAmount: req.body.changeAmount,
            referenceNumber: req.body.referenceNumber,
            lockedOrder,
            effectiveStore,
            amountDue: settleAmount,
            t
          })
          // DR-04 P2-1: points redemption is part of the same settlement
          // unit and covers exactly the settlement amount.
          if (paidTender.method === 'POINTS') {
            await redeemSettlementPoints({
              lockedOrder,
              effectiveStore,
              userId: changedBy || req.user?.id,
              amount: settleAmount,
              t
            })
          }
          // DR-16: earned points land at successful payment, exactly once
          // per order. The helper checks the durable ledger history inside
          // this transaction (order row already UPDATE-locked above), so a
          // retried or concurrent settlement cannot award twice; refused
          // settlements never reach here.
          // Staff attachment: the award follows the effective member — the
          // newly attached ID when supplied at settlement, otherwise the
          // order's existing member. Using lockedOrder.customerId alone
          // would skip the award for first-time attachments (anonymous
          // order + customerId at settlement).
          const effectiveMemberId =
            sentCustomerId !== undefined ? sentCustomerId : lockedOrder.customerId
          const settleItems = await db.order_item.findAll({
            where: { order: id },
            transaction: t
          })
          await awardEarnedPointsOnce({
            orderId: id,
            orderNumber: lockedOrder.orderNumber,
            memberId: effectiveMemberId,
            items: settleItems,
            userId: changedBy || req.user?.id,
            transaction: t
          })
        }
      }

      // DR-23 P0-3 / DR-08: cancel ends an order before payment; void ends a
      // (part-)paid order with a full, traceable refund. Repeating the same
      // terminal command stays a no-op; switching between terminal states
      // is refused.
      let isCancelling = false
      if (['cancelled', 'void'].includes(status)) {
        if (!wasTerminal && fin.state === FINANCIAL_STATES.INVALID) {
          // Unreconciled legacy money state (BA §35.10 I): never reversed
          // automatically; requires manual reconciliation first.
          throw financialError(
            409,
            'ORDER_UNRECONCILED',
            'This order has an unreconciled payment record; it requires manual reconciliation before it can be cancelled or voided'
          )
        }
        if (wasTerminal) {
          if (oldStatus !== status) {
            throw financialError(
              409,
              'INVALID_TRANSITION',
              `Order is already ${oldStatus}; it cannot become ${status}`
            )
          }
        } else if (status === 'cancelled') {
          if (fin.N > 0) {
            throw financialError(
              409,
              'CANCEL_REQUIRES_VOID',
              'This order has collected money; void it (with a refund) instead of cancelling it'
            )
          }
          isCancelling = true
        } else {
          if (
            fin.N <= 0 ||
            ![FINANCIAL_STATES.PAID, FINANCIAL_STATES.PARTIALLY_PAID].includes(fin.state)
          ) {
            throw financialError(
              409,
              'VOID_NOT_APPLICABLE',
              fin.N <= 0
                ? 'Nothing was collected on this order; cancel it instead of voiding it'
                : 'A partially refunded order cannot be voided; return the remaining lines instead'
            )
          }
          isCancelling = true
        }
      }
      const isVoiding = isCancelling && status === 'void'

      // Void always requires a meaningful reason (Phase 31 RBAC-1 control,
      // now on the elevated void path). Validated before any mutation.
      const cancelReason = typeof reason === 'string' ? reason.trim() : ''
      if (isVoiding && !cancelReason) {
        throw financialError(
          422,
          'REASON_REQUIRED',
          'Voiding an order requires a reason. Provide a non-empty reason (max 255 characters).'
        )
      }

      // DR-23 P0-3 void refund plan: refund exactly what was collected
      // (R = C here; void is only allowed from PAID/PARTIALLY_PAID with no
      // prior refund), allocated LIFO against the original settlements,
      // each refunded in its original tender. Every precondition is checked
      // before the first write.
      let voidPlan = []
      let refundRegisterId = null
      if (isVoiding) {
        // P1 (DR-PAY-ATTR-06): refund rows are new ledger writes, so their
        // tender is canonicalized. A legacy settlement row whose tender
        // cannot be mapped refuses the void (422) instead of persisting an
        // unclassified refund — fail-safe over silent misclassification.
        voidPlan = [...fin.settlements].reverse().map((row) => ({
          row,
          amount: Number(row.amount),
          method: normalizePaymentMethod(row.typePayment)
        }))
        const cashParts = voidPlan.filter((p) => p.method === 'CASH')
        const externalParts = voidPlan.filter((p) => !['CASH', 'POINTS'].includes(p.method))
        const pointParts = voidPlan.filter((p) => p.method === 'POINTS')
        const refundReference =
          typeof req.body.refundReference === 'string' ? req.body.refundReference.trim() : ''
        if (externalParts.length && !refundReference) {
          throw financialError(
            422,
            'REFERENCE_REQUIRED',
            'A refund reference is required for the non-cash portion of this void'
          )
        }
        voidPlan.forEach((p) => {
          p.reference = ['CASH', 'POINTS'].includes(p.method) ? null : refundReference
        })
        if (pointParts.length && !lockedOrder.customerId) {
          throw financialError(
            409,
            'POINTS_REFUND_UNAVAILABLE',
            'The points portion cannot be restored: the order has no attached member'
          )
        }
          // P1 (DR-PAY-ATTR-02/03): the refunding register is the store's
          // open register, share-locked so a concurrent close()
          // serializes against this refund (DR-13). MC-4 interim guard
          // below is preserved as fail-safe: cash is never moved out of
          // a closed/original register.
          if (cashParts.length) {
          const openRegister = await db.cashRegister.findOne({
            where: { store: lockedOrder.store, status: 'open' },
            lock: t.LOCK.SHARE,
            transaction: t
          })
          if (!openRegister) {
            throw financialError(
              422,
              'REGISTER_REQUIRED',
              'A cash refund requires an open cash register for this store'
            )
          }
          // Drawer attribution is order-level, so the refund is allowed
          // only when that attribution is the refunding register — either
          // already, or because every cash collection happened inside
          // this register's open window (one open register per store,
          // DB-enforced). Never move cash out of a closed/original
          // register.
          // P1 (DR-PAY-ATTR-02/§21): when EVERY voided settlement row
          // already carries its own per-record register, the refund rows
          // attribute to the refunding register explicitly — no silent
          // cross-register move can occur, so refunding from any open
          // register is allowed (e.g. sale on closed R1, refund on R2).
          // Legacy rows without per-record registers keep the strict
          // same-register/window rule below.
          const fullyAttributed = voidPlan.every((p) => p.row.cashRegisterId != null)
          if (lockedOrder.cashRegisterId == null) {
            const openedAt = new Date(openRegister.openedAt || openRegister.createdAt)
            const insideWindow = cashParts.every((p) => new Date(p.row.createdAt) >= openedAt)
            if (!insideWindow && !fullyAttributed) {
              throw financialError(
                409,
                'REFUND_REGISTER_ATTRIBUTION_UNAVAILABLE',
                'This cash refund cannot be attributed to the refunding register yet; the collection predates the open register'
              )
            }
            refundRegisterId = openRegister.id
          } else if (Number(lockedOrder.cashRegisterId) !== Number(openRegister.id)) {
            if (!fullyAttributed) {
              throw financialError(
                409,
                'REFUND_REGISTER_ATTRIBUTION_UNAVAILABLE',
                'This cash refund cannot be attributed to the refunding register: the sale belongs to another (closed) register'
              )
            }
            refundRegisterId = openRegister.id
          } else {
            refundRegisterId = openRegister.id
          }
          } else {
            // Non-cash/points-only void needs no register to proceed, but
            // when one is open its refund rows still carry it for shift
            // audit. Absence stays NULL — never a refusal, never a guess.
            const opportunistic = await db.cashRegister.findOne({
              where: { store: lockedOrder.store, status: 'open' },
              lock: t.LOCK.SHARE,
              transaction: t
            })
            if (opportunistic) refundRegisterId = opportunistic.id
          }
        }

      await order.update(
        {
          status,
          ...(paidTender
            ? { paymentMethod: paidTender.method, cashRegisterId: paidTender.registerId }
            : {}),
          ...(sentCustomerId !== undefined && lockedOrder.customerId === null
            ? { customerId: sentCustomerId }
            : {}),
          ...(refundRegisterId ? { cashRegisterId: refundRegisterId } : {})
        },
        { transaction: t }
      )

      if (isCancelling) {
        await redactAndAudit(req, {
          action: AUDIT_ACTIONS.VOID,
          entity: 'order',
          entityId: id,
          description: `Order ${order.orderNumber || id} ${status} (was ${oldStatus})${cancelReason ? `. Reason: ${cancelReason}` : ''}`,
          oldValues: { status: oldStatus, paymentStatus: oldPaymentStatus },
          newValues: {
            status,
            // Derived end state (BA §35.10 C): void → REFUNDED, cancel
            // (nothing net-collected) → UNPAID.
            paymentStatus: isVoiding ? 'refunded' : 'unpaid',
            refunded: isVoiding ? fin.N : 0,
            reason: cancelReason || null
          },
          transaction: t
        })
      }

      await OrderStatus.create(
        {
          order: id,
          status,
          createdBy: changedBy,
          notes: notes || (changedByName ? `By ${changedByName}` : null)
        },
        { transaction: t }
      )

      // Settlement: record exactly the outstanding amount, retire every
      // pending split (it can no longer be a collection opportunity), and
      // deduct stock exactly once on the transition to PAID.
      if (isSettlement) {
        if (paidTender) {
          // BA 004 (DR-23 §D): never the same reference twice per store+method.
          await assertSettlementReferenceUnused({
            store: lockedOrder.store,
            method: paidTender.method,
            reference: paidTender.referenceNumber,
            transaction: t
          })
          await recordOrderPayment(
            lockedOrder,
            paidTender.method,
            settleAmount,
            req.user?.id,
            t,
            paidTender.cashReceived,
            paidTender.changeGiven,
            {
              cashRegisterId: paidTender.registerId,
              referenceNumber: paidTender.referenceNumber
            }
          )
        }
        retiredSplits = await retirePendingSplits(id, t)
        retiredSplitReason = 'SUPERSEDED'

        // Stock is deducted only when the order first reaches PAID
        // (counter orders were deducted at creation).
        if (oldPaymentStatus !== 'paid') {
          await deductPaidOrderStock(t)
        }
      }

      if (isCancelling) {
        const approvedReturn = await db.sales_return.findOne({
          where: { order: id, status: 'approved' },
          transaction: t
        })
        if (approvedReturn) {
          const err = new Error(
            'Cannot void/cancel this order because it has an approved sales return. Process a separate return reversal first.'
          )
          err.statusCode = 400
          throw err
        }
        // Only reverse stock that was actually deducted: every deduction
        // path deducts exactly when the order reaches PAID, so a never-
        // fully-paid order (e.g. PARTIALLY_PAID) has nothing to give back.
        if (oldPaymentStatus === 'paid') {
          await reverseOrderStock(t)
        }

        // DR-23 void refund: one refund row per original settlement (LIFO),
        // in its original (now canonical) tender, attributed to the
        // executing actor and the refunding register (P1 DR-PAY-ATTR-02).
        if (isVoiding) {
          for (const part of voidPlan) {
            await db.transaction.create(
              {
                order: id,
                typePayment: part.method,
                amount: -Math.abs(part.amount),
                referenceNumber: part.reference,
                notes: `Void refund of settlement #${part.row.id} for order ${order.orderNumber}`,
                createdBy: req.user?.id || null,
                cashRegisterId: refundRegisterId
              },
              { transaction: t }
            )
            if (part.method === 'POINTS') {
              await adjustMemberPoints({
                memberId: lockedOrder.customerId,
                deltaPoints: part.amount,
                referenceId: id,
                notes: `Restored ${part.amount} points: void of order ${order.orderNumber}`,
                createdBy: req.user?.id || null,
                transaction: t
              })
            }
          }
        }

        // DR-16: reverse previously earned points for the cancelled/voided
        // purchase. Derived from the durable ledger history in-transaction:
        // a cancel (allowed only with nothing collected) finds nothing
        // earned and is a safe no-op; a void reverses up to the original
        // award, never more. Existing redemption restoration above is
        // untouched — earned reversal and redemption restore are distinct
        // ledger entries.
        const cancelItems = await db.order_item.findAll({
          where: { order: id },
          transaction: t
        })
        await reverseEarnedPoints({
          orderId: id,
          orderNumber: lockedOrder.orderNumber,
          memberId: lockedOrder.customerId,
          items: cancelItems,
          userId: req.user?.id || null,
          transaction: t,
          reason: isVoiding ? 'void' : 'cancel'
        })

        retiredSplits = await retirePendingSplits(id, t)
        retiredSplitReason = isVoiding ? 'VOIDED' : 'CANCELLED'
      }

      // DR-23 state derivation: after a financial mutation the cached
      // paymentStatus is re-derived from the ledger, and the invariants
      // (C ≤ G, R ≤ C, O ≥ 0) are re-checked before commit.
      if (isSettlement || isCancelling) {
        const finalFin = await computeOrderFinancials(
          { id, totalPrice: lockedOrder.totalPrice, status },
          t
        )
        if (finalFin.state === FINANCIAL_STATES.INVALID || finalFin.C > finalFin.G) {
          throw financialError(
            409,
            'FINANCIAL_INVARIANT_VIOLATION',
            'This transition would leave the order in an invalid financial state'
          )
        }
        await order.update(
          { paymentStatus: legacyPaymentStatusFor(finalFin.state) },
          { transaction: t }
        )
      }

      // QR orders only: a POS dine-in visit holds its table until staff
      // explicitly release it (Set Available) — its order's payment,
      // cancellation or void is not the diners leaving.
      if (
        order.tableId &&
        isQrChannelOrder(order) &&
        ['paid', 'cancelled', 'void'].includes(status)
      ) {
        await Table.update(
          { status: 'available' },
          { where: { id: order.tableId }, transaction: t }
        )
      }

      // Durable inside this same transaction — a posting failure after
      // commit below is retried, not silently discarded. Enqueued only by
      // the settlement that brings the order to PAID (exactly once).
      if (isSettlement) {
        const journalDate = new Date().toISOString()
        orderJournalJob = await enqueueAccountingJob({
          jobType: 'order_journal',
          store: effectiveStore,
          referenceType: 'order',
          referenceId: id,
          payload: {
            store: effectiveStore,
            orderId: id,
            orderNumber: order.orderNumber,
            subTotal: order.subTotal,
            discountAmount: order.discountAmount,
            taxAmount: order.taxAmount,
            serviceChargeAmount: order.serviceChargeAmount,
            totalPrice: order.totalPrice,
            date: journalDate,
            paymentMethod: order.paymentMethod,
            createdBy: changedBy || req.user?.id
          },
          transaction: t
        })
        cogsJournalJob = await enqueueAccountingJob({
          jobType: 'order_cogs_journal',
          store: effectiveStore,
          referenceType: 'order',
          referenceId: id,
          payload: {
            store: effectiveStore,
            orderId: id,
            orderNumber: order.orderNumber,
            date: journalDate,
            createdBy: changedBy || req.user?.id
          },
          transaction: t
        })
      }

      if (isCancelling) {
        reversalJob = await enqueueAccountingJob({
          jobType: 'reverse_order_journals',
          store: effectiveStore,
          referenceType: 'order',
          referenceId: id,
          payload: {
            store: effectiveStore,
            orderId: id,
            orderNumber: order.orderNumber,
            date: new Date().toISOString(),
            createdBy: changedBy || req.user?.id
          },
          transaction: t
        })
      }
      })
    )

    // Best-effort immediate posting for the common case — the outbox rows
    // enqueued above are the actual reliability guarantee; a failure here
    // just means the scheduler retries it instead of the entry appearing
    // instantly.
    if (orderJournalJob) {
      const r1 = await attemptJob(orderJournalJob)
      await recordImmediateAttempt(orderJournalJob, r1)
      if (!r1.ok) console.error('Accounting posting deferred to retry queue:', r1.error)
    }
    if (cogsJournalJob) {
      const r2 = await attemptJob(cogsJournalJob)
      await recordImmediateAttempt(cogsJournalJob, r2)
      if (!r2.ok) console.error('COGS accounting posting deferred to retry queue:', r2.error)
    }
    if (reversalJob) {
      const r3 = await attemptJob(reversalJob)
      await recordImmediateAttempt(reversalJob, r3)
      if (!r3.ok) console.error('Accounting reversal deferred to retry queue:', r3.error)
    }

    await createAudit(req, 'update', 'order', id, `Updated order status to ${status}`)
    // DR-23: terminal reason of each retired split, recorded after commit
    // (best effort — never inside the financial transaction).
    for (const split of retiredSplits) {
      await createAudit(
        req,
        'update',
        'split_bill',
        split.id,
        `Split ${split.splitNumber} ${retiredSplitReason} by order ${order.orderNumber || id} transition to ${status}`,
        { status: 'pending' },
        { status: retiredSplitReason, amount: split.amount }
      )
    }

    return res.status(200).json({
      message: 'Order status updated',
      data: order
    })
  } catch (error) {
    console.error('Error:', error)
    return res.status(error.statusCode || 500).json({
      error: error.message || 'Internal Server Error',
      ...(error.statusCode && error.code ? { code: error.code, ...(error.extra || {}) } : {})
    })
  }
}

exports.updateOrderItemStatus = async (req, res) => {
  const { id, itemId, itemStatus } = req.body

  try {
    // HIGH-3: was OrderItem.findOne({ where: { id: itemId, order: id } })
    // with no store ownership check — any authenticated user could flip the
    // status of another tenant's order item (integer IDOR) and cascade-flip
    // the parent order status too.
    //
    // Fix: verify the parent order belongs to the caller's store BEFORE
    // touching any item row. No mutation occurs until ownership is confirmed.
    // super_admin is unrestricted (intentional global access).
    const orderWhere = { id }
    const userStore = req.storeId ?? req.user?.store
    if (req.user?.roleType !== 'super_admin') {
      if (!userStore) {
        return res.status(403).json({
          message: 'Store assignment required'
        })
      }
      orderWhere.store = userStore
    }
    const parentOrder = await Order.findOne({ where: orderWhere })
    if (!parentOrder) {
      // 404 rather than 403 — same-as-missing to avoid revealing existence
      // of foreign orders to an attacker probing sequential IDs.
      return res.status(404).json({
        message: 'Order not found'
      })
    }

    const item = await OrderItem.findOne({ where: { id: itemId, order: id } })

    if (!item) {
      return res.status(404).json({
        message: 'Item not found'
      })
    }

    await item.update({ status: itemStatus })

    const orderAttrs = await getOrderAttributes()
    const order = await Order.findByPk(
      id,
      orderAttrs ? { attributes: orderAttrs } : undefined
    )
    if (order) {
      emitItemStatusUpdate(order.store, id, item)
    }

    const allItems = await OrderItem.findAll({ where: { order: id } })
    const allSameStatus = allItems.every((i) => i.status === itemStatus)

    // BA §35.10 / DR-23 terminal guard (P0 terminal-state bypass close):
    // once fulfilment is terminal (cancelled/void), ordinary kitchen cascade
    // never resurrects it. Terminal wins — header update is a no-op.
    // The WHERE ... NOT IN guard is atomic: it also covers the race where
    // cancel/void commits between our reads and this write, without
    // introducing a new locking model. Paid progression is untouched.
    if (allSameStatus && !TERMINAL_FULFILMENT.includes(parentOrder.status)) {
      const statusMap = {
        pending: 'pending',
        preparing: 'preparing',
        ready: 'ready',
        served: 'served'
      }
      const nextStatus = statusMap[itemStatus]
      if (nextStatus) {
        // Re-check the fresh header read (post-item-update) before writing;
        // the conditional WHERE makes terminal-wins atomic even if
        // cancel/void landed after this read.
        const freshStatus = order?.status ?? parentOrder.status
        if (!TERMINAL_FULFILMENT.includes(freshStatus)) {
          await Order.update(
            { status: nextStatus },
            { where: { id, status: { [Op.notIn]: [...TERMINAL_FULFILMENT] } } }
          )
        }
      }
    }

    return res.status(200).json({
      message: 'Item status updated',
      data: item
    })
  } catch (error) {
    console.error('Error:', error)
    return res.status(500).json({
      error: 'Internal Server Error'
    })
  }
}

exports.getKitchenOrders = async (req, res) => {
  // HIGH-2: was `const { store } = req.query` then `whereClause = store ? { store } : {}`
  // — a non-super admin hitting the endpoint WITHOUT a store query got the
  // kitchen queue of EVERY store (fail-open). The filter must come from the
  // pinned req.storeId (validateStoreAccess: JWT store for non-super, or the
  // client-selected store / null-global for super_admin).
  const store = req.storeId ?? req.user?.store
  if (!store && req.user?.roleType !== 'super_admin') {
    return res.status(403).json({
      success: false,
      message: 'Store assignment required'
    })
  }

  try {
    // ponytail: order-level status is 'paid' at POS — kitchen cares about item status only
    // QR orders should only appear in kitchen after being accepted (status != pending/cancelled/void)
    const whereClause = store ? { store } : {}
    whereClause[Op.or] = [
      { source: { [Op.ne]: 'qr' } },
      { source: { [Op.is]: null } },
      { status: { [Op.notIn]: ['pending', 'cancelled', 'void'] } }
    ]
    const orderAttributes = await getOrderAttributes()
    const orders = await Order.findAll({
      where: whereClause,
      include: [
        {
          model: OrderItem,
          as: 'items',
          where: {
            status: {
              [Op.in]: ['pending', 'preparing', 'ready']
            }
          }
        },
        {
          model: Table,
          as: 'table'
        }
      ],
      order: [['createdAt', 'DESC']],
      ...(orderAttributes ? { attributes: orderAttributes } : {})
    })

    return res.status(200).json({
      message: 'Success',
      data: orders
    })
  } catch (error) {
    console.error('Error:', error)
    return res.status(500).json({
      error: 'Internal Server Error'
    })
  }
}

// ——— Public customer menu (no auth) ———
const CUSTOMER_MENU_PRODUCT_ATTRIBUTES = [
  'id',
  'nameProduct',
  'category',
  'description',
  'price',
  'image',
  'images',
  'isAvailable',
  'stock',
  'options',
  'modifiers',
  'composition',
  'estimationTime',
  'inventoryMode'
]

const CUSTOMER_MENU_CATEGORY_ATTRIBUTES = [
  'id',
  'name',
  'value',
  'image',
  'status'
]

exports.getCustomerMenu = async (req, res) => {
  const { store } = req.query

  try {
    if (!store) {
      return res.status(400).json({ message: 'store is required' })
    }

    const Op = require('sequelize').Op
    const storeId = Number(store)
    if (isNaN(storeId)) {
      return res.status(400).json({ message: 'Invalid store value' })
    }

    const productWhere = { status: 'active' }
    const categoryWhere = { status: 'active' }

    if (await hasTable('product_store')) {
      const productStoreSub = db.sequelize.literal(
        `EXISTS (SELECT 1 FROM product_store WHERE product = "product".id AND store = ${storeId} AND "deletedAt" IS NULL)`
      )
      const productUnassignedSub = db.sequelize.literal(
        `NOT EXISTS (SELECT 1 FROM product_store WHERE product = "product".id AND "deletedAt" IS NULL)`
      )
      productWhere[Op.or] = [productStoreSub, productUnassignedSub]
    }

    if (await hasTable('category_store')) {
      const categoryStoreSub = db.sequelize.literal(
        `EXISTS (SELECT 1 FROM category_store WHERE category = "category".id AND store = ${storeId} AND "deletedAt" IS NULL)`
      )
      const categoryUnassignedSub = db.sequelize.literal(
        `NOT EXISTS (SELECT 1 FROM category_store WHERE category = "category".id AND "deletedAt" IS NULL)`
      )
      categoryWhere[Op.or] = [categoryStoreSub, categoryUnassignedSub]
    }

    const products = await db.product.findAll({
      where: productWhere,
      attributes: CUSTOMER_MENU_PRODUCT_ATTRIBUTES,
      include: [
        { model: db.category, as: 'categoryData', attributes: ['name'] }
      ],
      order: [
        ['categoryData', 'name', 'ASC'],
        ['nameProduct', 'ASC']
      ]
    })

    const categories = await db.category.findAll({
      where: categoryWhere,
      attributes: CUSTOMER_MENU_CATEGORY_ATTRIBUTES,
      order: [['name', 'ASC']]
    })

    const customerProducts = products.map((p) => {
      const plain = p.get({ plain: true })
      const dto = {}
      for (const key of CUSTOMER_MENU_PRODUCT_ATTRIBUTES) {
        dto[key] = plain[key]
      }
      dto.categoryData = plain.categoryData || null
      return dto
    })

    // F4-03: expose the authoritative per-store effective stock using the SAME
    // resolution rule as order validation (getEffectiveStock — store row wins,
    // including zero; otherwise base stock), batched in a single query so the
    // public menu avoids an N+1. Raw `stock` stays backward-compatible.
    const effectiveStockById = await getEffectiveStockMap(products, storeId)
    for (const dto of customerProducts) {
      dto.effectiveStock = effectiveStockById.get(String(dto.id)) ?? null
    }

    // W3-1 (DR-11): expose the effective catalog price with the SAME
    // resolution rule as checkout (outlet row wins, otherwise base price),
    // batched in a single query so the public menu avoids an N+1. Raw
    // `price` stays backward-compatible.
    const effectivePriceById = await getEffectivePriceMap(products, storeId)
    for (const dto of customerProducts) {
      dto.effectivePrice = effectivePriceById.get(String(dto.id)) ?? null
    }

    const customerCategories = categories.map((c) => {
      const plain = c.get({ plain: true })
      const dto = {}
      for (const key of CUSTOMER_MENU_CATEGORY_ATTRIBUTES) {
        dto[key] = plain[key]
      }
      return dto
    })

    return res.status(200).json({
      message: 'Success',
      data: { products: customerProducts, categories: customerCategories }
    })
  } catch (error) {
    console.error('Error:', error)
    return res.status(500).json({ error: 'Internal Server Error' })
  }
}

exports.createCustomerOrder = async (req, res) => {
  const {
    store: bodyStore,
    tableId,
    items,
    customerName,
    notes,
    customerId,
    paymentMethod,
    splitCount,
    session,
    idempotencyKey
  } = req.body

  // N-5: authoritative store — set inside the try from the server-resolved
  // table (or body for table-less). Declared here so the idempotency catch
  // block can still read it.
  let store = null

  try {
    if (!bodyStore || !items || !items.length) {
      return res.status(400).json({ message: 'store and items are required' })
    }

    // N-5 (security): public, unauthenticated QR-order endpoint — the client-
    // supplied `store` is not trusted as tenant authority. A valid table
    // belonging to the claimed store (the physical QR/table is the
    // server-authoritative capability) is required, and the authoritative
    // store for persistence + realtime derivation is taken from the table row
    // itself. An attacker thus cannot direct a row or emission into a store
    // without presenting a real table of that store. The deployed customer QR
    // (order-app) always encodes both table and store.
    if (tableId === undefined || tableId === null || tableId === '') {
      return res.status(400).json({ message: 'tableId is required' })
    }
    const table = await db.table.findOne({
      where: { id: tableId, store: bodyStore }
    })
    if (!table) {
      return res.status(400).json({ message: 'Table not found' })
    }
    store = Number(table.store) || Number(bodyStore)

    for (const item of items) {
      const qty = item && item.quantity
      if (!Number.isInteger(qty) || qty <= 0) {
        return res.status(400).json({
          message: 'quantity must be a positive integer for every item'
        })
      }
    }

    // Public, unauthenticated endpoint on a QR-ordering flow — flaky mobile
    // networks make client retries routine. Same replay pattern as
    // createOrder: a retried submit with the same key returns the order
    // already created instead of creating a second one.
    if (idempotencyKey) {
      const existingOrder = await Order.findOne({ where: { store, idempotencyKey } })
      if (existingOrder) return replayCustomerOrder(res, existingOrder.id, req.body)
    }

    const orderNumber =
      'CUST-' +
      Date.now().toString().slice(-8) +
      Math.random().toString(36).slice(2, 6).toUpperCase()

    if (
      table &&
      ['occupied', 'reserved', 'maintenance'].includes(table.status)
    ) {
      return res.status(400).json({
        message:
          table.status === 'occupied'
            ? 'Table is already occupied'
            : 'Table is not available'
      })
    }

    let member = null
    if (customerId) {
      // AUD-3 (security): never resolve a customerId across stores. A
      // foreign or unknown customerId is indistinguishable and rejected —
      // no existence side-channel for other stores' members.
      member = await db.member.findOne({
        where: { id: customerId, store }
      })
      if (!member) {
        return res.status(400).json({ message: 'Customer not found' })
      }
    }
    // DR-16: free-text customerName never establishes member identity and
    // unlocks no tier discount or loyalty benefits. It stays a plain order
    // label (receipt display, kitchen ticket). Member attachment for QR
    // orders happens only through an explicitly supplied customerId today;
    // verified staff-attach at settlement is the approved follow-up
    // mechanism, not free-text matching.

    let discountValue = 0
    let discountType = 'none'

    if (member && member.tier) {
      const tier = await db.member_tier.findByPk(member.tier)
      if (tier && tier.discountPercent > 0) {
        discountValue = tier.discountPercent
        discountType = 'percent'
      }
    }

    // Pre-load bundles
    const bundleMap = {}
    for (const item of items) {
      if (item.bundleId) {
        const bundle = await db.product_bundle.findByPk(item.bundleId, {
          include: [
            {
              model: db.product_bundle_item,
              as: 'items',
              include: [{ model: Product, as: 'productData' }]
            }
          ]
        })
        if (
          !bundle ||
          !bundle.isAvailable ||
          bundle.status !== 'active' ||
          !isBundleWithinValidityPeriod(bundle) ||
          // AUD-2 (security): a bundle assigned to a different store (or
          // not assigned at all) is unavailable for this store — foreign
          // and nonexistent bundles stay indistinguishable.
          !(await isBundleOrderableAtStore(bundle, store))
        ) {
          return res.status(400).json({
            message: `Bundle not available: ${item.bundleName || item.bundleId}`
          })
        }
        bundleMap[item.bundleId] = bundle
      }
    }

    // ===== SERVER-SIDE PRICE VALIDATION =====
    // Re-calculate all prices from DB. Never trust FE-sent prices.
    // Price override is never allowed on the public, unauthenticated
    // customer ordering path — it is an admin-only POS capability.
    // W3-2: optional per-line expectedPrice is compared against the exact
    // server-resolved unit price; every line resolves so one 409 carries all
    // mismatches in original request order, before any write below.
    const priceMismatches = []
    for (let index = 0; index < items.length; index++) {
      const item = items[index]
      if (item.priceOverride !== undefined && item.priceOverride !== null) {
        return res.status(403).json({ message: 'Price override not allowed for customer orders' })
      }
      const expected = parseExpectedPrice(item.expectedPrice)
      if (expected.present && !expected.valid) {
        return res.status(400).json({ message: 'expectedPrice must be an integer >= 0' })
      }
      if (item.bundleId && bundleMap[item.bundleId]) {
        const bundle = bundleMap[item.bundleId]
        const serverPrice = Number(bundle.bundlePrice) || 0
        item.price = serverPrice
        item.subtotal = serverPrice * Number(item.quantity)
        if (expected.present && expected.value !== serverPrice) {
          priceMismatches.push({
            index,
            bundleId: item.bundleId,
            expectedPrice: expected.value,
            currentPrice: serverPrice
          })
        }
      } else if (item.productId) {
        const prod = await Product.findByPk(item.productId)
        if (
          !prod ||
          // AUD-2 (security): a product assigned to a different store (or
          // not assigned to this store while other rows exist) is treated
          // exactly like an unknown product — foreign and nonexistent
          // products stay indistinguishable.
          !(await isProductOrderableAtStore(prod.id, store))
        ) {
          return res.status(400).json({
            message: `Product not found: ${item.productName || item.productId}`
          })
        }
        // W3-1 (DR-11): same outlet-resolved catalog price as the counter
        // path; override stays prohibited here.
        const catalogPrice = await resolveCatalogBase(prod, store)
        const serverPrice = await getServerItemPrice(prod, item, store, catalogPrice)
        item.basePrice = catalogPrice
        item.price = serverPrice
        item.subtotal = serverPrice * Number(item.quantity)
        if (expected.present && expected.value !== serverPrice) {
          priceMismatches.push({
            index,
            productId: item.productId,
            expectedPrice: expected.value,
            currentPrice: serverPrice
          })
        }
      }
    }

    // W3-2: pre-transaction gate — no stock check, total, or write below may
    // run on a stale client expectation.
    if (priceMismatches.length) {
      return res.status(409).json(buildPriceMismatchBody(priceMismatches))
    }

    // Validate bundle component stock
    for (const item of items) {
      if (item.bundleId && bundleMap[item.bundleId]) {
        const bundle = bundleMap[item.bundleId]
        const bundleQty = Number(item.quantity) || 1
        for (const bi of bundle.items) {
          const prod = bi.productData
          if (!prod) {
            return res
              .status(400)
              .json({ message: `Product in bundle "${bundle.name}" not found` })
          }
          // AUD-2 (security): a bundle component owned by a different store
          // makes the whole bundle unavailable here — components cannot
          // smuggle store-2 inventory into a store-1 order.
          if (!(await isProductOrderableAtStore(prod.id, store))) {
            return res.status(400).json({
              message: `Bundle not available: ${item.bundleName || item.bundleId}`
            })
          }
          // F7: a make_to_order product's finished-good stock is not
          // authoritative — ingredients (resolved at deduction time) are.
          // Skip the finished-good availability pre-check for that mode.
          if (prod.inventoryMode === 'make_to_order') continue
          const needed = bi.quantity * bundleQty
          const avail = await getEffectiveStock(prod, store)
          if (avail !== null && avail < needed) {
            return res.status(400).json({
              message: `Stok "${prod.nameProduct}" tidak mencukupi untuk bundle "${bundle.name}". Tersedia: ${avail}, dibutuhkan: ${needed}`
            })
          }
        }
      }
    }

    // Validate regular product stock
    for (const item of items) {
      if (item.bundleId) continue
      const prod = item.productId
        ? await Product.findByPk(item.productId)
        : null
      if (!prod) {
        return res.status(400).json({
          message: `Product not found: ${item.productName || item.productId}`
        })
      }
      // F7: a make_to_order product's finished-good stock is not
      // authoritative — ingredients (resolved at deduction time) are.
      // Skip the finished-good availability pre-check for that mode.
      if (prod.inventoryMode === 'make_to_order') continue
      const avail = await getEffectiveStock(prod, store)
      if (avail !== null && avail < Number(item.quantity)) {
        return res.status(400).json({
          message: `Stok "${prod.nameProduct}" tidak mencukupi. Tersedia: ${avail}, diminta: ${item.quantity}`
        })
      }
    }

    // Build items & subtotal
    let subTotal = 0
    let totalQuantity = 0
    const orderItems = []
    for (const item of items) {
      if (item.bundleId && bundleMap[item.bundleId]) {
        const bundle = bundleMap[item.bundleId]
        const subtotal = bundle.bundlePrice * item.quantity
        subTotal += subtotal
        totalQuantity += item.quantity
        // ponytail: HPP bundle = total harga komponen — kalau kosong, laporan
        // harian fallback ke harga jual sehingga food cost meleset
        const bundleCost = (bundle.items || []).reduce(
          (sum, bi) =>
            sum +
            Number(bi.productData?.costPrice ?? bi.productData?.price ?? 0) *
              Number(bi.quantity || 1),
          0
        )
        orderItems.push({
          product: bundle.items[0]?.product || 0,
          productName: bundle.name,
          quantity: item.quantity,
          price: bundle.bundlePrice,
          bundleId: bundle.id,
          bundleName: bundle.name,
          totalPrice: subtotal,
          hppSnapshot: Math.round(bundleCost),
          notes: item.notes || null,
          options: item.options || [],
          modifiers: item.modifiers || [],
          status: 'pending'
        })
      } else {
        const subtotal = item.price * item.quantity
        subTotal += subtotal
        totalQuantity += item.quantity
        const prod = item.productId
          ? await Product.findByPk(item.productId)
          : null
        const costPrice = prod ? Number(prod.costPrice || prod.price || 0) : 0
        orderItems.push({
          product: item.productId,
          productName: item.productName || prod?.nameProduct || 'Item',
          quantity: item.quantity,
          price: item.price,
          totalPrice: subtotal,
          hppSnapshot: costPrice,
          notes: item.notes || null,
          options: item.options || [],
          modifiers: item.modifiers || [],
          status: 'pending'
        })
      }
    }

    // Evaluate promo campaigns
    const campaignResult = await evaluatePromoCampaign(
      items.map((item) => ({
        ...item,
        productId: item.productId || item.product,
        unitPrice: item.price ?? 0,
        subtotal: item.price * item.quantity
      })),
      store,
      member ? member.id : null,
      subTotal
    )

    let discountAmount = 0
    let appliedCampaignId = null
    if (campaignResult.discountAmount > 0) {
      discountAmount = campaignResult.discountAmount
      appliedCampaignId = campaignResult.campaignId
      discountType = 'nominal'
    } else if (discountType === 'percent') {
      discountAmount = Math.round(subTotal * (discountValue / 100))
    }

    const afterDiscount = subTotal - discountAmount
    const taxRate = await getActiveTaxRate(store)
    const taxAmount = Math.round(afterDiscount * (taxRate / 100))
    const totalPrice = afterDiscount + taxAmount

    const qrOrderData = {
      orderNumber,
      store,
      tableId: tableId || null,
      customerId: member ? member.id : null,
      cashierId: null,
      cashierName: customerName || 'Customer',
      customerName: customerName || null,
      notes,
      source: 'qr',
      status: 'pending',
      subTotal,
      totalQuantity,
      discountType,
      discountValue,
      discountAmount,
      taxRate,
      taxAmount,
      serviceChargeAmount: 0,
      totalPrice,
      paymentMethod: paymentMethod || null,
      // AUD-1 (security): a public, unauthenticated QR request can never
      // self-authorize a paid state. Server-side paymentStatus is fixed to
      // 'unpaid' regardless of any client-supplied paymentMethod/status
      // fields; the declared paymentMethod is stored only as intent and is
      // consumed when the cashier authoritatively marks the order paid
      // (see the order-status transition in updateOrderStatus).
      paymentStatus: 'unpaid',
      splitCount: splitCount || null,
      idempotencyKey: idempotencyKey || null,
      publicToken: crypto.randomBytes(24).toString('hex')
    }
    if (await hasOrderColumn('promoCampaignId')) {
      qrOrderData.promoCampaignId = appliedCampaignId
    }
    if (await hasOrderColumn('session')) {
      qrOrderData.session = session || null
    }
    // Public QR orders are always created unpaid. Stock deduction, ledger
    // and accounting entries happen exactly once, later, when the cashier
    // marks the order paid through the authorized order-status transition
    // (see updateOrderStatus) — the same unit that currently handles paid
    // transitions for plain, immediate-POS and non-instant orders.
    const deductStock = false

    // Order header, its items, and (when paid immediately) the stock
    // deduction all commit or roll back together — previously the order +
    // items + payment record + accounting entries were all written before
    // stock deduction even ran in its own separate transaction, so an
    // insufficient-stock rejection there left a "paid" order with a real
    // payment record behind, despite no stock ever having been deducted.
    let accountingJobs = null
    // F7: wrapped in withDeadlockRetry — this path now reuses
    // deductStockForOrder, so it locks ingredient rows (in addition to the
    // existing product locking), which raises the number of distinct rows
    // this transaction locks per order and with it the mechanical deadlock
    // probability even with correct lock ordering. A killed transaction is
    // guaranteed by Postgres to have committed nothing, so re-running the
    // whole callback from scratch is safe — order/stock/ledger all commit
    // or all roll back together, and retry cannot duplicate anything.
    const order = await withDeadlockRetry(() =>
      db.sequelize.transaction(async (t) => {
      // F-05: re-read the table row UNDER A ROW LOCK inside the same
      // transaction that creates the booking, and re-check its status from
      // that fresh, locked value. The earlier status check above is a fast,
      // friendly 400 pre-check only — this is the authoritative one: a
      // concurrent table-status mutation (operator update, queue seat
      // activation) now serializes against the booking instead of racing it.
      const lockedTable = await db.table.findOne({
        where: { id: tableId, store },
        transaction: t,
        lock: t.LOCK.UPDATE
      })
      if (!lockedTable) {
        const err = new Error('Table not found')
        err.statusCode = 400
        throw err
      }
      if (['occupied', 'reserved', 'maintenance'].includes(lockedTable.status)) {
        // Phase 39 — since a successful QR order now occupies its table (see
        // below), a genuinely concurrent RETRY with the SAME idempotencyKey
        // targeting the SAME table can lose this exact row lock race to its
        // own winning request: it wakes up to find the table it is about to
        // be rejected for is occupied by the order it is itself retrying.
        // That is not a conflict — replay the winner's order instead of
        // rejecting, matching the existing (store, idempotencyKey) replay
        // semantics used elsewhere in this function.
        if (idempotencyKey) {
          const existingOrder = await Order.findOne({
            where: { store, idempotencyKey },
            transaction: t
          })
          if (existingOrder) {
            const replayErr = new Error('Order already exists for this idempotency key')
            replayErr.idempotencyReplayOrderId = existingOrder.id
            throw replayErr
          }
        }
        const err = new Error(
          lockedTable.status === 'occupied'
            ? 'Table is already occupied'
            : 'Table is not available'
        )
        err.statusCode = 400
        throw err
      }

      // Phase 39 — QR/BISA-MAKAN table occupancy: a QR order that clears the
      // authoritative locked check above is the moment the table actually
      // becomes occupied. Update the same locked row, in the same
      // transaction, so this commits or rolls back atomically with the
      // order itself — a concurrent request on this table serializes on the
      // row lock above and re-reads this status once it commits.
      await lockedTable.update({ status: 'occupied' }, { transaction: t })

      qrOrderData.customerNumber = await generateCustomerNumber(store, t)
      const createdOrder = await db.order.create(qrOrderData, { transaction: t })

      for (const item of orderItems) {
        await db.order_item.create(
          { ...item, order: createdOrder.id },
          { transaction: t }
        )
      }

      if (deductStock) {
        // F7 (Phase 3.1): reuse the same F7-aware deduction unit as the
        // immediate-POS path instead of the previous inline copy — product
        // deduction, inventoryMode semantics, BOM ingredient deduction,
        // best_selling, bundle expansion, product+ingredient locking, and
        // tenancy checks are all handled identically here.
        await deductStockForOrder(
          createdOrder,
          items,
          bundleMap,
          store,
          orderNumber,
          req.user?.id,
          t
        )
      }

      // Committed atomically with the order/items/stock-deduction above —
      // previously this ran after the transaction had already committed,
      // so a failure here left a "paid" order with deducted stock and no
      // payment-ledger row, permanently invisible to reconciliation (a
      // client retry only sees "order exists" via the idempotency check
      // and never re-attempts this step).
      if (deductStock) {
        await db.transaction.create(
          {
            order: createdOrder.id,
            typePayment: paymentMethod || 'cash',
            amount: Number(createdOrder.totalPrice) || 0,
            createdBy: req.user?.id
          },
          { transaction: t }
        )
      }

      // Promo usage and point earning are now atomic and part of the same
      // all-or-nothing unit as the order/stock/payment above — previously
      // these ran unlocked, after commit, in a duplicate copy of the same
      // logic createOrder already had fixed (see
      // applyRedeemedPoints/awardEarnedPoints/recordPromoUsageIfApplied
      // above; this path reuses the same atomic services directly instead
      // of re-duplicating the fix a second time). Conditions unchanged:
      // promo usage only if a campaign was applied, points only if there's
      // a member — neither is gated by `deductStock`, matching the
      // pre-existing behavior exactly.
      if (appliedCampaignId) {
        const promoResult = await incrementPromoUsage({
          campaignId: appliedCampaignId,
          orderId: createdOrder.id,
          memberId: member ? member.id : null,
          discountApplied: discountAmount,
          freeItemsGiven: campaignResult.reward
            ? [
                {
                  productId: campaignResult.reward.productId,
                  quantity: campaignResult.reward.quantity
                }
              ]
            : null,
          createdBy: req.user?.id,
          transaction: t,
          enforcePerMemberLimit: false
        })
        if (promoResult.limitReached) {
          console.error(
            `Promo usage for campaign ${appliedCampaignId} not recorded on order ${createdOrder.id}: maxUsageTotal reached`
          )
        }
      }

      // DR-16: QR orders are created unpaid, so placement awards nothing.
      // Earned points land at successful payment/settlement (see the
      // settlement hook in updateOrderStatus and the split-pay completion
      // hook), guarded durably against duplicate awards.
      if (deductStock) {
        accountingJobs = await enqueueOrderAccountingJobs(
          createdOrder,
          store,
          orderNumber,
          { subTotal, discountAmount, taxAmount, serviceChargeAmount: 0, totalPrice },
          paymentMethod,
          req.user?.id,
          t
        )
      }

      return createdOrder
      })
    )

    if (accountingJobs) {
      await attemptOrderAccountingEntries(accountingJobs)
    }

    const fullOrder = await db.order.findOne({
      where: { id: order.id },
      include: [
        { model: db.order_item, as: 'items' },
        { model: db.table, as: 'table' }
      ]
    })

    createNotification({
      type: 'order_created',
      store,
      referenceId: order.id,
      referenceType: 'order',
      params: [orderNumber],
      createdBy: customerName || 'Customer'
    }).catch(console.error)

    emitNewOrder(store, fullOrder)

    return res.status(201).json({
      message: 'Order created',
      data: fullOrder
    })
  } catch (error) {
    // Phase 39 — the table-occupancy row-lock race: this request's own
    // idempotencyKey retry lost the lock to its own winning request (see the
    // in-transaction check above), so replay that order the same way the
    // unique-constraint race below does.
    if (error.idempotencyReplayOrderId) {
      return replayCustomerOrder(res, error.idempotencyReplayOrderId, req.body)
    }
    // Two requests with the same idempotencyKey can both pass the earlier
    // findOne check and both attempt to create — the unique index on
    // (store, idempotencyKey) lets exactly one succeed; return the
    // winner's order to the loser instead of a raw 500. Scoped (F-04) to
    // that specific constraint only.
    if (isOrderReplayRelevantUniqueError(error) && idempotencyKey) {
      const existingOrder = await Order.findOne({ where: { store, idempotencyKey } })
      if (existingOrder) return replayCustomerOrder(res, existingOrder.id, req.body)
    }
    console.error('Error:', error)
    // Mirror createOrder: surface fail-closed stock/BOM errors (409) and
    // other explicitly-tagged statusCodes instead of collapsing to 500.
    return res.status(error.statusCode || 500).json({
      error: error.message || 'Internal Server Error',
      ...(error.code ? { code: error.code } : {})
    })
  }
}

// ——— Public customer member lookup by name ———
// SEC-005: this is an unauthenticated endpoint, so it must never act as a
// loyalty-balance disclosure or a member enumeration oracle.
//   * Strict store scoping — a member is only matched when it belongs to the
//     requested store (no `store IS NULL` global-member fallback that would let
//     any tenant read another tenant's global members).
//   * Minimal response — totalPoints / tier / discountPercent (redeemable
//     loyalty data) are never exposed to an unauthenticated caller; only a
//     membership confirmation and the member's identity are returned.
//   * Literal name match — % / _ / \ are escaped so an unauthenticated caller
//     cannot use the wildcard trick to enumerate member names.
exports.getCustomerMember = async (req, res) => {
  const { name, store } = req.query
  try {
    if (!name || !store) {
      return res.status(200).json({ data: null })
    }
    const storeId = Number(store)
    if (!Number.isInteger(storeId) || storeId <= 0) {
      return res.status(400).json({ message: 'Invalid store value' })
    }
    // Literal-match the name: escape the PostgreSQL LIKE wildcards so a name
    // value can never act as a pattern.
    const escapedName = name.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)
    const Op = require('sequelize').Op
    const member = await db.member.findOne({
      where: {
        name: { [Op.iLike]: escapedName },
        store: storeId,
        status: 'active'
      }
    })
    if (!member) return res.status(200).json({ data: null })

    return res.status(200).json({
      data: {
        isMember: true,
        id: member.id,
        name: member.name
      }
    })
  } catch (error) {
    console.error('Error:', error)
    return res.status(500).json({ error: 'Internal Server Error' })
  }
}

// ——— Public order tracking (no auth) ———
// Looked up by the opaque publicToken generated at order creation, not the
// raw sequential id — the id alone is guessable/enumerable and would let
// anyone read any store's orders with no credentials (see
// db/migrations/20260904000003-add-order-public-token.js).
exports.getCustomerOrder = async (req, res) => {
  const { token } = req.params
  if (!token) return res.status(404).json({ message: 'Order not found' })
  try {
    const order = await db.order.findOne({
      where: { publicToken: token },
      attributes: [
        'id',
        'orderNumber',
        'status',
        'totalPrice',
        'totalQuantity',
        'customerName',
        'createdAt',
        'tableId',
        'paymentMethod',
        'paymentStatus',
        'splitCount'
      ],
      include: [
        {
          model: db.order_item,
          as: 'items',
          attributes: [
            'id',
            'productName',
            'quantity',
            'price',
            'totalPrice',
            'status'
          ]
        },
        { model: db.table, as: 'table', attributes: ['name'] }
      ]
    })
    if (!order) return res.status(404).json({ message: 'Order not found' })
    return res.status(200).json({ data: order })
  } catch (error) {
    console.error('Error:', error)
    return res.status(500).json({ error: 'Internal Server Error' })
  }
}

// ——— Public customer review (no auth) ———
exports.createCustomerReview = async (req, res) => {
  const {
    name,
    userName,
    productId,
    store,
    storeId,
    rating,
    comment,
    orderId,
    deviceId
  } = req.body
  try {
    if (!productId || !rating) {
      return res
        .status(400)
        .json({ success: false, message: 'productId and rating are required' })
    }
    const product = await Product.findByPk(Number(productId))
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' })
    }
    const ratingNum = Number(rating)
    if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
      return res.status(400).json({
        success: false,
        message: 'rating must be an integer between 1 and 5'
      })
    }
    const reviewName = (name || userName || 'Anonim')
      .toString()
      .trim()
      .slice(0, 100)
    const storeNum = Number(store ?? storeId) || null
    // SEC-007 — store tenancy: a review may only attribute a product to a
    // store that actually sells it, using the exact membership rule the
    // customer menu applies (explicit product_store row OR global product).
    // Non-breaking: the official customer flow always sends a store, and
    // products reachable on a store's menu satisfy this check. Store-less
    // (legacy) submissions are still accepted as before.
    if (storeNum && !(await isProductOrderableAtStore(productId, storeNum))) {
      return res.status(400).json({
        success: false,
        message: 'Product is not available at this store'
      })
    }
    const commentText = (comment || '').toString().trim().slice(0, 2000)
    const device = (deviceId || '').toString().trim().slice(0, 64) || null
    // Optional same-device idempotency: one review per (productId, deviceId).
    // The unique index makes this race-safe; a repeated submission returns the
    // earlier review instead of creating a duplicate.
    if (device) {
      const existing = await db.product_review.findOne({
        where: { productId: Number(productId), deviceId: device }
      })
      if (existing) {
        return res.json({
          success: true,
          message: 'Review already submitted',
          data: existing
        })
      }
    }
    // Optional but verified order claim: if an orderId is supplied it must
    // exist, belong to the same store, and actually contain the reviewed
    // product. The official flow does not send one yet, so this never rejects
    // it — it only fails closed on fabricated/foreign order attributions.
    let orderIdNum = null
    if (orderId) {
      orderIdNum = Number(orderId)
      const claimedOrder = await Order.findByPk(orderIdNum)
      if (!claimedOrder || Number(claimedOrder.store) !== storeNum) {
        return res.status(400).json({
          success: false,
          message: 'Invalid order for this review'
        })
      }
      const inOrder = await db.order_item.findOne({
        where: { order: orderIdNum, product: Number(productId) }
      })
      if (!inOrder) {
        return res.status(400).json({
          success: false,
          message: 'This product is not part of the claimed order'
        })
      }
    }
    // Optional moderation gate: default keeps the existing auto-publish
    // behavior; set REVIEW_AUTO_PUBLISH=false to queue reviews as pending
    // (hidden from getProductReviews' published filter) instead.
    const status =
      process.env.REVIEW_AUTO_PUBLISH === 'false' ? 'pending' : 'published'
    try {
      const review = await db.product_review.create({
        productId: Number(productId),
        store: storeNum,
        userName: reviewName,
        rating: ratingNum,
        comment: commentText,
        orderId: orderIdNum,
        deviceId: device,
        status
      })
      return res.status(201).json({
        success: true,
        message: 'Review submitted',
        data: review
      })
    } catch (error) {
      if (error.name === 'SequelizeUniqueConstraintError' && device) {
        const winner = await db.product_review.findOne({
          where: { productId: Number(productId), deviceId: device }
        })
        if (winner) {
          return res.json({
            success: true,
            message: 'Review already submitted',
            data: winner
          })
        }
      }
      throw error
    }
  } catch (error) {
    console.error('Error:', error)
    return res.status(500).json({ success: false, error: 'Internal Server Error' })
  }
}

exports.getProductReviews = async (req, res) => {
  const { productId, store } = req.query
  try {
    if (!productId) {
      return res
        .status(400)
        .json({ success: false, message: 'productId is required' })
    }
    const where = { productId: Number(productId), status: 'published' }
    if (store) where.store = Number(store)
    const reviews = await db.product_review.findAll({
      where,
      order: [['createdAt', 'DESC']]
    })
    const totalReviews = reviews.length
    const averageRating = totalReviews
      ? reviews.reduce((sum, r) => sum + Number(r.rating), 0) / totalReviews
      : 0
    return res.status(200).json({
      success: true,
      message: 'Success',
      data: {
        productId: String(productId),
        reviews,
        averageRating: Number(averageRating.toFixed(1)),
        totalReviews
      }
    })
  } catch (error) {
    console.error('Error:', error)
    return res.status(500).json({ success: false, error: 'Internal Server Error' })
  }
}

// ——— Public customer order list (no auth) ———
exports.getCustomerOrders = async (req, res) => {
  const { store, tableId, session, page = 1, limit = 20 } = req.query
  try {
    if (!store) {
      return res.status(400).json({ message: 'store is required' })
    }
    const storeId = Number(store)
    if (isNaN(storeId)) {
      return res.status(400).json({ message: 'Invalid store value' })
    }

    if (!tableId) {
      return res.status(400).json({ message: 'tableId is required' })
    }
    const tableIdNum = Number(tableId)
    if (isNaN(tableIdNum)) {
      return res.status(400).json({ message: 'Invalid table value' })
    }
    const table = await db.table.findOne({
      where: { id: tableIdNum, store: storeId }
    })
    if (!table) {
      return res.status(400).json({ message: 'Table not found' })
    }

    const where = { store: storeId, source: 'qr', tableId: tableIdNum }
    if (session && (await hasOrderColumn('session'))) {
      where.session = session
    }

    const offset = (Number(page) - 1) * Number(limit)

    const { count, rows } = await db.order.findAndCountAll({
      where,
      attributes: [
        'id',
        'orderNumber',
        'status',
        'subTotal',
        'discountAmount',
        'taxRate',
        'taxAmount',
        'serviceChargeAmount',
        'totalPrice',
        'totalQuantity',
        'customerName',
        'paymentMethod',
        'paymentStatus',
        'notes',
        'source',
        'session',
        'createdAt',
        'tableId',
        'splitCount'
      ],
      include: [
        {
          model: db.order_item,
          as: 'items',
          // `product`/`bundleId`/`bundleName` are required by the BISA-MAKAN
          // reorder flow to identify what each historical line item actually
          // was — without them every reorder attempt fails closed (no
          // product/bundle can be resolved from this response).
          attributes: [
            'id',
            'product',
            'productName',
            'quantity',
            'price',
            'totalPrice',
            'notes',
            'options',
            'modifiers',
            'status',
            'bundleId',
            'bundleName'
          ]
        },
        { model: db.table, as: 'table', attributes: ['name'] }
      ],
      order: [['createdAt', 'DESC']],
      limit: Number(limit),
      offset
    })

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: rows,
      pagination: {
        total: count,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(count / Number(limit))
      }
    })
  } catch (error) {
    console.error('Error:', error)
    return res.status(500).json({ error: 'Internal Server Error' })
  }
}

// Same opaque-token requirement as getCustomerOrder above — this endpoint
// is intentionally unauthenticated (customers/staff open it without
// logging in) so the token, not the id, is what gates access to another
// store's receipt.
exports.getReceiptHTML = async (req, res) => {
  const { token } = req.params
  if (!token) return res.status(404).send('<h1>Order not found</h1>')

  try {
    const printAttrs = await getOrderAttributes()
    const order = await db.order.findOne({
      where: { publicToken: token },
      include: [
        { model: db.order_item, as: 'items' },
        { model: db.table, as: 'table' }
      ],
      ...(printAttrs ? { attributes: printAttrs } : {})
    })

    if (!order) {
      return res.status(404).send('<h1>Order not found</h1>')
    }

    const storeData = order.store
      ? await db.location.findByPk(order.store, {
          attributes: [
            'name',
            'address',
            'detailLocation',
            'city',
            'province',
            'district',
            'village',
            'postalCode',
            'phoneNumber',
            'email'
          ]
        })
      : null

    const setting = order.store
      ? await db.invoice_setting.findOne({ where: { store: order.store } })
      : null

    const showLogo = setting?.showLogo !== false
    const showStoreName = setting?.showStoreName !== false
    const showAddress = setting?.showAddress !== false
    const logoUrl = setting?.logo || null
    const footerText = setting?.footer || 'Terima kasih atas kunjungan Anda'

    const addressFieldsVisibility = setting?.addressFieldsVisibility
      ? typeof setting.addressFieldsVisibility === 'string'
        ? JSON.parse(setting.addressFieldsVisibility)
        : setting.addressFieldsVisibility
      : {}

    const formatPrice = (v) => 'Rp' + Number(v || 0).toLocaleString('id-ID')

    const date = new Date(order.createdAt).toLocaleString('id-ID', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })

    const itemsHtml = (order.items || [])
      .map(
        (item, i) => `
      <tr>
        <td style="padding:6px 4px;border-bottom:1px dashed #ccc">${i + 1}. ${_escapeHtml(item.productName || '-')}</td>
        <td style="text-align:center;padding:6px 4px;border-bottom:1px dashed #ccc">${_escapeHtml(item.quantity)}</td>
        <td style="text-align:right;padding:6px 4px;border-bottom:1px dashed #ccc">${formatPrice(item.price)}</td>
        <td style="text-align:right;padding:6px 4px;border-bottom:1px dashed #ccc">${formatPrice(item.totalPrice)}</td>
      </tr>`
      )
      .join('')

    const STATUS_LABELS = {
      paid: 'LUNAS',
      unpaid: 'BELUM DIBAYAR',
      partial: 'DP'
    }

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Invoice - ${_escapeHtml(order.orderNumber)}</title>
  <style>
    body { font-family: 'Courier New', monospace; font-size: 13px; margin: 0; padding: 20px; color: #000; }
    .receipt { max-width: 380px; margin: 0 auto; }
    .header { text-align: center; border-bottom: 2px solid #000; padding-bottom: 12px; margin-bottom: 12px; }
    .header h2 { margin: 4px 0; text-transform: uppercase; font-size: 16px; }
    .header p { margin: 2px 0; font-size: 11px; color: #555; }
    .info { border-bottom: 1px dashed #000; padding-bottom: 8px; margin-bottom: 8px; font-size: 11px; }
    .info div { display: flex; justify-content: space-between; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
    th { text-align: left; font-size: 10px; text-transform: uppercase; border-bottom: 1px solid #000; padding: 4px; }
    th.right { text-align: right; }
    th.center { text-align: center; }
    .totals { border-top: 1px dashed #000; padding-top: 8px; margin-top: 4px; font-size: 12px; }
    .totals > div { display: flex; justify-content: space-between; padding: 2px 0; }
    .totals .grand-total { font-weight: bold; font-size: 15px; border-top: 1px solid #000; padding-top: 6px; margin-top: 6px; }
    .footer { text-align: center; margin-top: 16px; font-size: 11px; color: #888; border-top: 1px dashed #ccc; padding-top: 12px; }
    .status-badge { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 10px; font-weight: bold; }
    .status-paid { background: #d4edda; color: #155724; }
    .status-unpaid { background: #fff3cd; color: #856404; }
      @media print { body { padding: 0; background: #fff; } .no-print { display: none; } }
      @media print { body { padding: 0; background: #fff; } .no-print { display: none; } }
  </style>
</head>
<body>
  <div class="receipt" style="max-width: 380px; margin: 0 auto; background: #fff; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); overflow: hidden;">
    <div class="header" style="background: linear-gradient(135deg, #1f2937 0%, #111827 100%); color: #fff; padding: 20px; text-align: center;">
      ${showLogo && logoUrl ? `<img src="${_escapeHtml(logoUrl)}" alt="Logo" style="max-height:60px; margin-bottom:8px;" />` : ''}
      ${showStoreName ? `<h2 style="margin:4px 0; text-transform:uppercase; font-size:16px; font-weight:bold;">${_escapeHtml(storeData?.name) || 'TOKO'}</h2>` : ''}
      ${
        showAddress && storeData
          ? `
        <p style="margin:2px 0; font-size:11px; color:#9ca3af;">${_escapeHtml(storeData.name)}</p>
        <p style="margin:2px 0; font-size:11px; color:#9ca3af;">${_escapeHtml(storeData.address) || ''}</p>
        ${storeData.detailLocation ? `<p style="margin:2px 0; font-size:11px; color:#9ca3af;">${_escapeHtml(storeData.detailLocation)}</p>` : ''}
        ${
          [
            addressFieldsVisibility.province !== false
              ? storeData.province
              : null,
            addressFieldsVisibility.city !== false ? storeData.city : null,
            addressFieldsVisibility.district !== false
              ? storeData.district
              : null,
            addressFieldsVisibility.village !== false ? storeData.village : null
          ].filter(Boolean).length > 0
            ? `<p style="margin:2px 0; font-size:11px; color:#9ca3af;">${[
                addressFieldsVisibility.province !== false
                  ? storeData.province
                  : null,
                addressFieldsVisibility.city !== false ? storeData.city : null,
                addressFieldsVisibility.district !== false
                  ? storeData.district
                  : null,
                addressFieldsVisibility.village !== false
                  ? storeData.village
                  : null
              ]
                .filter(Boolean)
                .map(_escapeHtml)
                .join(', ')}</p>`
            : ''
        }
        ${addressFieldsVisibility.postalCode !== false && storeData.postalCode ? `<p style="margin:2px 0; font-size:11px; color:#9ca3af;">Kode Pos: ${_escapeHtml(storeData.postalCode)}</p>` : ''}
        ${addressFieldsVisibility.phone !== false && storeData.phoneNumber ? `<p style="margin:2px 0; font-size:11px; color:#9ca3af;">Telp: ${_escapeHtml(storeData.phoneNumber)}</p>` : ''}
        ${addressFieldsVisibility.email !== false && storeData.email ? `<p style="margin:2px 0; font-size:11px; color:#9ca3af;">${_escapeHtml(storeData.email)}</p>` : ''}
      `
          : ''
      }
    </div>

    <div class="meta" style="display:flex; justify-content:space-between; padding:10px 16px; border-bottom:1px solid #eee; font-size:11px;">
      <div>
        <span class="label" style="color:#9ca3af; font-size:9px; font-weight:600;">Invoice</span>
        <strong>${_escapeHtml(order.orderNumber)}</strong>
      </div>
      <div style="text-align: right;">
        <span class="label" style="color:#9ca3af; font-size:9px; font-weight:600;">${_escapeHtml(date)}</span>
      </div>
    </div>

    <div class="member-info" style="display:flex; justify-content:space-between; padding:8px 16px; border-bottom:1px dashed #ccc; font-size:11px;">
      <div><span class="label" style="color:#9ca3af; font-size:9px; font-weight:600;">Kasir</span><span> ${_escapeHtml(order.cashierName || '-')}</span></div>
      ${order.customerName ? `<div><span class="label" style="color:#9ca3af; font-size:9px; font-weight:600;">Pelanggan</span><span> ${_escapeHtml(order.customerName)}</span></div>` : ''}
      ${order.table?.name ? `<div><span class="label" style="color:#9ca3af; font-size:9px; font-weight:600;">Meja</span><span> ${_escapeHtml(order.table.name)}</span></div>` : ''}
      <div style="margin-top:4px">
        <span class="status-badge ${_escapeHtml(order.paymentStatus === 'paid' ? 'status-paid' : 'status-unpaid')}" style="${_escapeHtml(order.paymentStatus === 'paid' ? 'background:#d4edda;color:#155724;' : 'background:#fff3cd;color:#856404;')} display:inline-block; padding:2px 8px; border-radius:4px; font-size:10px; font-weight:bold;">
          ${_escapeHtml(STATUS_LABELS[order.paymentStatus] || order.paymentStatus || 'BELUM DIBAYAR')}
        </span>
      </div>
    </div>

    <div class="table-container" style="padding:0 16px;">
      <table style="width:100%; border-collapse:collapse;">
        <thead>
          <tr style="border-bottom:1px solid #d1d5db;">
            <th style="text-align:left; font-size:10px; text-transform:uppercase; padding:8px 4px; color:#6b7280; font-weight:600;">Item</th><th class="center" style="text-align:center; font-size:10px; text-transform:uppercase; padding:8px 4px; color:#6b7280; font-weight:600; width:30px;">Qty</th><th class="right" style="text-align:right; font-size:10px; text-transform:uppercase; padding:8px 4px; color:#6b7280; font-weight:600;">Harga</th><th class="right" style="text-align:right; font-size:10px; text-transform:uppercase; padding:8px 4px; color:#6b7280; font-weight:600;">Total</th>
          </tr>
        </thead>
        <tbody>${itemsHtml}</tbody>
      </table>
    </div>

    <div class="totals" style="padding:12px 16px;">
      <div class="summary" style="background:#f9fafb; border-radius:8px; padding:12px;">
        ${order.subTotal !== undefined ? `<div style="display:flex; justify-content:space-between; padding:4px 0; font-size:12px;"><span>Subtotal</span><span>${formatPrice(order.subTotal)}</span></div>` : ''}
        ${order.discountAmount > 0 ? `<div style="display:flex; justify-content:space-between; padding:4px 0; font-size:12px;"><span>Diskon</span><span style="color:#c00">-${formatPrice(order.discountAmount)}</span></div>` : ''}
        ${order.serviceChargeAmount > 0 ? `<div style="display:flex; justify-content:space-between; padding:4px 0; font-size:12px;"><span>Biaya Layanan</span><span>${formatPrice(order.serviceChargeAmount)}</span></div>` : ''}
        ${order.taxAmount > 0 ? `<div style="display:flex; justify-content:space-between; padding:4px 0; font-size:12px;"><span>Pajak</span><span>${formatPrice(order.taxAmount)}</span></div>` : ''}
        <div class="grand-total" style="font-weight:bold; font-size:14px; border-top:1px solid #d1d5db; padding-top:8px; margin-top:4px; display:flex; justify-content:space-between;"><span>TOTAL</span><span>${formatPrice(order.totalPrice)}</span></div>
        <div style="display:flex; justify-content:space-between; padding:4px 0; font-size:12px;"><span>${_escapeHtml(order.paymentMethod || '-')}</span><span>${formatPrice(order.totalPrice)}</span></div>
      </div>
    </div>

    <div class="footer" style="padding:16px; text-align:center; font-size:11px; color:#9ca3af; border-top:1px dashed #e5e7eb;">
      <p class="footer-it" style="font-style:italic; margin:0 0 8px 0;">${_escapeHtml(footerText)}</p>
      <div class="social" style="display:flex; justify-content:center; gap:12px; margin-top:8px; padding-top:8px; border-top:1px dashed #e5e7eb; font-size:10px; color:#9ca3af;">
        ${
          storeData?.socialMedia
            ? Object.entries(storeData.socialMedia)
                .map(
                  ([platform, _url]) =>
                    `<img src="/icon/${_escapeHtml(platform)}.svg" alt="${_escapeHtml(platform)}" style="height:16px;width:auto;" />`
                )
                .join('')
            : ''
        }
      </div>
    </div>

    <div class="no-print" style="text-align:center;margin-top:20px">
      <button onclick="window.print()" style="padding:8px 24px;font-size:14px;cursor:pointer;border:1px solid #ccc;border-radius:6px;background:#fff">
        Cetak / Simpan PDF
      </button>
      <p style="font-size:11px;color:#999;margin-top:6px">Tekan tombol di atas, lalu pilih "Save as PDF"</p>
    </div>
  </div>
</body>
</html>`

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    return res.status(200).send(html)
  } catch (error) {
    console.error('Error generating receipt:', error)
    return res.status(500).send('<h1>Internal Server Error</h1>')
  }
}

exports.getCustomerTaxRate = async (req, res) => {
  const { store, channel } = req.query
  if (!store) {
    return res.status(400).json({ message: 'store is required' })
  }
  // W3-3 (DR-17): channel-aware rate resolution. An omitted channel keeps
  // the historical default (counter) shape; only an explicit qr channel
  // suppresses the service-charge signal. Anything else is refused rather
  // than guessed about.
  const resolvedChannel = channel === undefined || channel === null || channel === '' ? 'counter' : channel
  if (resolvedChannel !== 'counter' && resolvedChannel !== 'qr') {
    return res.status(400).json({ message: 'channel must be counter or qr' })
  }
  try {
    const rate = await getActiveTaxRate(Number(store))
    if (resolvedChannel === 'qr') {
      // QR never charges service charge, so it must not be communicated
      // as applicable. null (not 0) marks non-applicability explicitly.
      return res.status(200).json({ data: { rate, serviceChargeRate: null } })
    }
    const serviceChargeRate = await getServiceChargeRate(Number(store))
    return res.status(200).json({ data: { rate, serviceChargeRate } })
  } catch (error) {
    console.error('Error fetching customer tax rate:', error)
    // Surface explicitly-tagged errors (e.g. missing PPN setup → 400);
    // genuine read failures stay 500 through the existing handling.
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        message: error.message,
        ...(error.code ? { code: error.code } : {})
      })
    }
    return res.status(500).json({ error: 'Internal Server Error' })
  }
}
