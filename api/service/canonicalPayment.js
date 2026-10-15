'use strict'

const { financialError } = require('./orderFinancials')

// PAYMENT P1 Register & Settlement Attribution — canonical payment-method
// write boundary (DR-PAY-ATTR-06).
//
// Deterministic, side-effect free. Maps every locked legacy alias to one of
// the seven canonical tenders; anything else on a NEW write is refused with
// 422 (never stored, never silently classified as CASH). Historical rows are
// untouched — normalization happens at write boundaries only; reads of
// legacy rows keep their stored values.

const CANONICAL_PAYMENT_METHODS = Object.freeze([
  'CASH',
  'CARD',
  'BANK_TRANSFER',
  'E_WALLET',
  'QRIS',
  'POINTS',
  'OTHER'
])

const CANONICAL_SET = new Set(CANONICAL_PAYMENT_METHODS)

// P1 §21: deterministic canonical method ordering for payment
// breakdowns. Total-descending remains the primary display order;
// this index is the tiebreak (and the standalone canonical sequence).
// UNRECONCILED (reporting-only bucket for unmappable legacy tenders)
// always sorts last and is never a writable tender.
const CANONICAL_METHOD_ORDER = Object.freeze({
  CASH: 0,
  CARD: 1,
  BANK_TRANSFER: 2,
  E_WALLET: 3,
  QRIS: 4,
  POINTS: 5,
  OTHER: 6,
  UNRECONCILED: 7
})

// Lowercase lookup keys. Canonical inputs fold to themselves through the
// same lowercase path, so normalization is idempotent.
const ALIAS_TO_CANONICAL = Object.freeze({
  cash: 'CASH',
  tunai: 'CASH',
  banknote: 'CASH',
  debit: 'CARD',
  credit: 'CARD',
  'kartu kredit': 'CARD',
  transfer: 'BANK_TRANSFER',
  'e-wallet': 'E_WALLET',
  ewallet: 'E_WALLET',
  qris: 'QRIS',
  points: 'POINTS',
  other: 'OTHER'
})

// DR-23 §D (BA §35.10): manually confirmed tenders that must carry a
// reference — CARD, BANK_TRANSFER, E_WALLET and QRIS (external transaction
// reference, entered by hand while the gateway is FUTURE, DR-19) and OTHER
// (its description). CASH needs none; POINTS is an internal loyalty entry.
// Same set the split payment and void refund paths already require a
// reference for (every tender except CASH and POINTS).
const REFERENCE_REQUIRED_METHODS = Object.freeze([
  'CARD',
  'BANK_TRANSFER',
  'E_WALLET',
  'QRIS',
  'OTHER'
])

// `method` is a canonical value (the output of normalizePaymentMethod).
const requiresTenderReference = (method) => REFERENCE_REQUIRED_METHODS.includes(method)

function normalizePaymentMethod(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    throw financialError(
      422,
      'INVALID_PAYMENT_METHOD',
      'Payment method must be a recognized tender'
    )
  }
  const trimmed = value.trim()
  if (trimmed === '') return null
  // BLOCKER-1: already-canonical values are accepted unchanged (identity
  // mapping). The alias map below only covers legacy spellings, so without
  // this check canonical CARD / BANK_TRANSFER / E_WALLET fell through to
  // a 422 and broke void planning, remainder settlement and return
  // approval flows that legitimately pass canonical tenders back through.
  if (CANONICAL_SET.has(trimmed)) return trimmed
  const canonical = ALIAS_TO_CANONICAL[trimmed.toLowerCase()]
  if (!canonical || !CANONICAL_SET.has(canonical)) {
    throw financialError(
      422,
      'INVALID_PAYMENT_METHOD',
      `Unknown payment method '${trimmed}'. Use one of: ${CANONICAL_PAYMENT_METHODS.join(', ')}`
    )
  }
  return canonical
}

// Reporting-side classification of one stored tender (dashboards and
// register breakdowns). Never throws: a tender the locked map cannot
// resolve — or an empty one — is reported in the explicit UNRECONCILED
// bucket, never folded into another tender. Stored values are untouched.
function reportingBucket(value) {
  try {
    return normalizePaymentMethod(value) || 'UNRECONCILED'
  } catch {
    return 'UNRECONCILED'
  }
}

// Cash-flow (arus kas) tender buckets over aggregated payment rows shaped
// like `{ typePayment, total }` (the transaction GROUP BY both cash-flow
// readers run). Single taxonomy shared by the cash-flow controller
// (report.js getCashFlow) and the export definition
// (reportDefs/cashFlow.js) so the two can never diverge again:
// CASH → tunai; QRIS/E_WALLET → qris; BANK_TRANSFER → transfer;
// CARD/OTHER/POINTS/UNRECONCILED → lainnya. Every row lands in exactly one
// bucket, so tender totals are preserved and only CASH feeds Tunai.
function bucketCashFlowTenders(paymentRows) {
  const buckets = { tunai: 0, qris: 0, transfer: 0, lainnya: 0 }
  for (const row of paymentRows || []) {
    const amount = Number(row.total || 0)
    switch (reportingBucket(row.typePayment)) {
      case 'CASH':
        buckets.tunai += amount
        break
      case 'QRIS':
      case 'E_WALLET':
        buckets.qris += amount
        break
      case 'BANK_TRANSFER':
        buckets.transfer += amount
        break
      default:
        buckets.lainnya += amount
    }
  }
  return buckets
}

module.exports = {
  CANONICAL_PAYMENT_METHODS,
  CANONICAL_METHOD_ORDER,
  REFERENCE_REQUIRED_METHODS,
  requiresTenderReference,
  normalizePaymentMethod,
  reportingBucket,
  bucketCashFlowTenders
}
