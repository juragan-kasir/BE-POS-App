'use strict'
const { normalizePaymentMethod } = require('./canonicalPayment')

// DR-23 §K (BA §35.10): "Same key and same payload: the original result is
// replayed with no new effect. Same key and different payload: refused (409
// mismatch)." No request-hash column exists (adding one is subject to the
// production migration gate), so — as in the goods-receipt, stock-transfer
// and split-bill replays — a same-key request is compared against what the
// first request deterministically persisted: the order header, its lines
// and its initial ledger row.
//
// The original request itself is not stored, and some persisted fields change
// legitimately after creation. So the rule is evidence-based: a field is
// reported only when the persisted evidence proves the incoming request
// differs from the one that created the order; where the evidence is
// ambiguous the retry replays (the pre-DR-23 behaviour, and it never creates
// a second effect). Known post-create mutations and how they are handled:
//
//  - customerId: staff may attach a member later, but only into an empty
//    slot (updateOrderStatus never replaces or clears it). A retry naming a
//    member other than the stored one is refused; a retry naming no member
//    is ambiguous (original had none + later attach) and replays.
//  - QR paymentMethod: a non-split settlement overwrites the diner's intent
//    with the canonical tender (same value as its ledger row). Once that
//    evidence exists the original intent is unknown and is not compared;
//    split payments never touch it, so it stays compared until then.
//  - useTax: no longer an intent field (DR-24 D-01 removed the cashier tax
//    toggle, so pricing always uses the resolved outlet rate and a legacy
//    useTax=false retry is ignored). It is reported only when the persisted
//    evidence proves a 0 % order was a legacy tax waiver: the store's active
//    PPN rate is > 0 and its row set is unchanged since creation, so a taxed
//    request would not have persisted 0 %.
//
// Prices, totals and tax amounts are server-derived and not compared
// (except a stated `expectedTotal`, which must equal the committed total);
// names and notes are cosmetic and ignored.
const IDEMPOTENCY_MISMATCH_CODE = 'IDEMPOTENCY_MISMATCH'
const IDEMPOTENCY_MISMATCH_MESSAGE =
  'idempotencyKey already used with a different payload'

const present = (v) => v !== undefined && v !== null && v !== ''
const idOrNull = (v) => (present(v) ? String(Number(v)) : null)
const textOrNull = (v) => (present(v) && String(v).trim() !== '' ? String(v).trim() : null)
const codeOrNull = (v) => {
  const t = textOrNull(v)
  return t === null ? null : t.toUpperCase()
}
const intOrZero = (v) => (present(v) ? Number(v) : 0)

// Option / modifier selections are identified by name (the pricing resolver
// matches them by name); order and duplicates are not significant.
const selectionNames = (list) =>
  (Array.isArray(list) ? list : [])
    .map((entry) => (typeof entry === 'string' ? entry : entry && entry.name))
    .filter((name) => typeof name === 'string' && name.trim() !== '')
    .map((name) => name.trim())
    .sort()
    .join('|')

const lineIdentity = (item) =>
  present(item.bundleId)
    ? `b:${Number(item.bundleId)}`
    : `p:${Number(item.product ?? item.productId)}`

const lineKey = (item) =>
  `${lineIdentity(item)}:${Number(item.quantity)}:${selectionNames(item.options)}:${selectionNames(
    item.modifiers
  )}`

const sameMultiset = (a, b) => {
  if (a.length !== b.length) return false
  const x = [...a].sort()
  const y = [...b].sort()
  return x.every((key, i) => key === y[i])
}

const linesMatch = (storedItems, incomingItems) =>
  Array.isArray(storedItems) &&
  Array.isArray(incomingItems) &&
  sameMultiset(storedItems.map(lineKey), incomingItems.map(lineKey))

// An admin price override is persisted as the line's price, so every
// incoming override must be matched by a persisted line of the same key at
// exactly that price. (Lines without an override carry the catalog price of
// the moment and are not comparable.)
const overridesMatch = (storedItems, incomingItems) => {
  const pool = (storedItems || []).map((s) => ({ key: lineKey(s), price: Number(s.price) }))
  for (const item of incomingItems || []) {
    if (!present(item.priceOverride)) continue
    const at = pool.findIndex(
      (s) => s.key === lineKey(item) && s.price === Number(item.priceOverride)
    )
    if (at === -1) return false
    pool.splice(at, 1)
  }
  return true
}

const initialSettlement = (order) =>
  [...(order.transactions || [])]
    .filter((row) => Number(row.amount) > 0)
    .sort((a, b) => Number(a.id) - Number(b.id))[0] || null

const canonicalMethod = (value) => {
  try {
    return normalizePaymentMethod(value)
  } catch {
    return undefined // unrecognized: can never equal a persisted tender
  }
}

// Member slot: filled at creation or later by a staff attach into an empty
// slot — never replaced or cleared. A named member that differs from the
// stored one is therefore a different request (including naming one while
// the slot is still empty); naming none is not evidence either way.
const memberMismatch = (order, body) => {
  const want = idOrNull(body.customerId)
  return want !== null && want !== idOrNull(order.customerId)
}

// A non-split settlement writes the canonical tender to order.paymentMethod
// together with a ledger row of the same tender (splitBillId null), in one
// transaction. When such a row matches the stored value, the stored value is
// settlement-derived and the diner's original intent is no longer known.
// Contradictory or missing evidence (e.g. a canonical value with no matching
// row) keeps the comparison on.
const intentOverwrittenBySettlement = (order) => {
  const stored = canonicalMethod(order.paymentMethod)
  if (!stored) return false
  return (order.transactions || []).some(
    (row) =>
      Number(row.amount) > 0 &&
      (row.splitBillId === null || row.splitBillId === undefined) &&
      canonicalMethod(row.typePayment) === stored
  )
}

/**
 * Counter sale (POST /order/create). `validateCashTender` is the create
 * path's own tender validator, so the cash comparison uses exactly the
 * normalization the first request went through. `activeTaxRate` is the
 * store's current PPN rate (or null when unknown) and
 * `activeTaxSetUnchangedSinceCreation` is true when every active PPN row
 * was last changed no later than the order's creation; both are consulted
 * only to recognise a legacy tax-waived 0 % order (with the cashier toggle
 * removed by DR-24 D-01, a taxed request would never persist 0 %).
 * `requestedDiscountResolvedAtCreation` is true when the requested
 * discountId names a discount of this store that already existed when the
 * order was created (so it would have been applied).
 * Returns the list of mismatching fields (empty = same intent).
 */
const counterOrderMismatches = (
  order,
  body,
  {
    validateCashTender,
    activeTaxRate = null,
    activeTaxSetUnchangedSinceCreation = false,
    requestedDiscountResolvedAtCreation = false
  } = {}
) => {
  const fields = []
  if (!linesMatch(order.items, body.items)) fields.push('items')
  else if (!overridesMatch(order.items, body.items)) fields.push('items.priceOverride')

  const method = canonicalMethod(body.paymentMethod || 'cash')
  if (method !== canonicalMethod(order.paymentMethod)) fields.push('paymentMethod')

  if (idOrNull(body.tableId) !== idOrNull(order.tableId)) fields.push('tableId')
  if (memberMismatch(order, body)) fields.push('customerId')
  if (codeOrNull(body.promoCode) !== codeOrNull(order.promoCode)) fields.push('promoCode')
  if ((textOrNull(body.source) || 'pos') !== (textOrNull(order.source) || 'pos')) {
    fields.push('source')
  }
  if (idOrNull(body.currencyId) !== idOrNull(order.currencyId)) fields.push('currencyId')
  if (codeOrNull(body.currencyCode) !== codeOrNull(order.currencyCode)) fields.push('currencyCode')
  if (
    (present(body.exchangeRate) ? Number(body.exchangeRate) : null) !==
    (present(order.exchangeRate) ? Number(order.exchangeRate) : null)
  ) {
    fields.push('exchangeRate')
  }

  // Points: a redemption is either honoured exactly or refused, so the
  // persisted count equals the requested one.
  if (
    order.redeemedPoints !== undefined &&
    intOrZero(body.redeemedPoints) !== intOrZero(order.redeemedPoints)
  ) {
    fields.push('redeemedPoints')
  }

  // Discount: an explicit discount that resolves wins and is persisted as
  // its id; one that does not resolve falls through to the promo code (or
  // nothing); the tier discount never sets discountId. So a persisted id
  // other than the requested one is explicable only if the requested
  // discount did not resolve when the order was created (the caller checks
  // that: `requestedDiscountResolvedAtCreation`), and a persisted id with no
  // requested discount only if a promo code produced it.
  const wantDiscount = idOrNull(body.discountId)
  const hadDiscount = idOrNull(order.discountId)
  if (hadDiscount !== wantDiscount) {
    if (wantDiscount !== null && requestedDiscountResolvedAtCreation) fields.push('discountId')
    else if (hadDiscount !== null && codeOrNull(body.promoCode) === null) fields.push('discountId')
  }

  // Tax mode (DR-24 D-01): the cashier tax toggle is removed, so a body
  // that still carries useTax is ignored — pricing always uses the resolved
  // outlet rate. The only tax mismatch left is the provable legacy waiver:
  // with the toggle gone a taxed request can no longer persist 0 %, so when
  // the store's active PPN rate is > 0 and its row set is unchanged since
  // creation the original must have been a tax waiver (old behaviour), and
  // a retry asking for tax is a different intent then. An edited rate
  // (updatedAt after creation) keeps such a retry a replay.
  const persistedRate = Number(order.taxRate) || 0
  if (
    body.useTax !== false &&
    persistedRate === 0 &&
    Number(activeTaxRate) > 0 &&
    activeTaxSetUnchangedSinceCreation
  ) {
    fields.push('useTax')
  }

  // A stated payable must equal the committed one: an identical first
  // request was only accepted when it did (TOTAL_CHANGED otherwise), so a
  // different value is a different request. Reported as a mismatch — never
  // as TOTAL_CHANGED, which means "nothing was written".
  if (present(body.expectedTotal) && Number(body.expectedTotal) !== Number(order.totalPrice)) {
    fields.push('expectedTotal')
  }

  // Tender detail on the initial ledger row.
  const settlement = initialSettlement(order)
  if (settlement && method) {
    if (method === 'CASH') {
      let expected = null
      try {
        expected = validateCashTender({
          paymentMethod: 'CASH',
          cashAmount: body.cashAmount,
          changeAmount: body.changeAmount,
          amountDue: Number(order.totalPrice)
        })
      } catch {
        expected = null
      }
      if (
        !expected ||
        Number(expected.cashReceived) !== Number(settlement.cashReceived) ||
        Number(expected.changeGiven) !== Number(settlement.changeGiven)
      ) {
        fields.push('cashAmount')
      }
    } else {
      if (present(body.cashAmount) || present(body.changeAmount)) fields.push('cashAmount')
      if (textOrNull(body.referenceNumber) !== textOrNull(settlement.referenceNumber)) {
        fields.push('referenceNumber')
      }
    }
  }
  return fields
}

/**
 * Public QR order (POST /order/customer-create). The store is already the
 * key's scope (derived from the table); the payment method is a stored
 * intent string, compared case-insensitively until a settlement overwrites
 * it (see intentOverwrittenBySettlement).
 */
const customerOrderMismatches = (order, body) => {
  const fields = []
  if (!linesMatch(order.items, body.items)) fields.push('items')
  if (idOrNull(body.tableId) !== idOrNull(order.tableId)) fields.push('tableId')
  if (memberMismatch(order, body)) fields.push('customerId')
  if (
    !intentOverwrittenBySettlement(order) &&
    codeOrNull(body.paymentMethod) !== codeOrNull(order.paymentMethod)
  ) {
    fields.push('paymentMethod')
  }
  if (idOrNull(body.splitCount) !== idOrNull(order.splitCount)) fields.push('splitCount')
  if (order.session !== undefined && textOrNull(body.session) !== textOrNull(order.session)) {
    fields.push('session')
  }
  return fields
}

const idempotencyMismatchBody = (fields, extra = {}) => ({
  message: IDEMPOTENCY_MISMATCH_MESSAGE,
  code: IDEMPOTENCY_MISMATCH_CODE,
  fields,
  ...extra
})

// For the authenticated, store-scoped counter path only: which order this
// key already created, so a client whose first response was lost (and whose
// cart changed since) can reconcile against the committed sale instead of
// selling it again. Never added on the public QR path.
const existingOrderSummary = (order) => ({
  existingOrder: {
    id: order.id,
    orderNumber: order.orderNumber,
    totalPrice: Number(order.totalPrice),
    paymentStatus: order.paymentStatus
  }
})

module.exports = {
  IDEMPOTENCY_MISMATCH_CODE,
  IDEMPOTENCY_MISMATCH_MESSAGE,
  counterOrderMismatches,
  customerOrderMismatches,
  idempotencyMismatchBody,
  existingOrderSummary,
  lineKey
}
