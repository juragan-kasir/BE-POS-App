'use strict'

// Salon money rules (SALON-BA BR-SLN-010…016), pure: no database here. Port of
// FE-SALON-App src/mocks/engine/money.ts, which is the reference
// implementation the FE was built against. Every amount is an integer rupiah.

class MoneyError extends Error {
  constructor(code, message, status = 409, details) {
    super(message)
    this.code = code
    this.status = status
    this.details = details
  }
}

/**
 * Split `total` over rows in proportion to `weights` (largest remainder):
 * the parts always add up to exactly `total`.
 */
const allocate = (total, weights) => {
  const sum = weights.reduce((a, b) => a + b, 0)
  if (sum <= 0 || total <= 0) return weights.map(() => 0)
  const exact = weights.map((w) => (total * w) / sum)
  const floors = exact.map(Math.floor)
  let rest = total - floors.reduce((a, b) => a + b, 0)
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
  for (const { i } of order) {
    if (rest <= 0) break
    floors[i] += 1
    rest -= 1
  }
  return floors
}

const discountAmount = (discount, subtotal) => {
  if (discount.type === 'percent') return Math.min(subtotal, Math.round((subtotal * discount.value) / 100))
  if (discount.type === 'amount') return Math.min(subtotal, discount.value)
  return 0
}

const exactCommission = (rule, net, qty) =>
  rule.type === 'percent' ? (net * rule.value) / 100 : Math.min(net, rule.value * qty)

/**
 * BR-SLN-012: commission from the line net after discount, floored per line;
 * the rounding rest goes to the last line with a rule, so
 * Σ commission = round(Σ exact).
 */
const commissionsFor = (lines) => {
  const exact = lines.map((l) => (l.rule ? exactCommission(l.rule, l.net, l.qty) : 0))
  const floors = exact.map((v) => Math.floor(v + 1e-9))
  const target = Math.round(exact.reduce((a, b) => a + b, 0))
  const withRule = lines.map((l, i) => (l.rule ? i : -1)).filter((i) => i >= 0)
  if (withRule.length) floors[withRule[withRule.length - 1]] += target - floors.reduce((a, b) => a + b, 0)
  return floors
}

/**
 * Contract `Quote` from loaded rows.
 *   services : [{ itemId, productId, name, staffId, price, rule }]
 *   products : [{ idx, productId, name, staffId, qty, price, rule }]
 *   tip      : { amount, staffId }   (staffId already defaulted)
 *   discount : contract Discount
 *   deposit  : held deposit of the booking (0 without one)
 *   pointsPer: rupiah per loyalty point
 */
const buildQuote = ({ services, products, tip, discount, deposit, pointsPer }) => {
  const raw = [
    ...services.map((s) => ({
      key: `svc:${s.itemId}`,
      kind: 'service',
      refId: String(s.productId),
      name: s.name,
      staffId: s.staffId == null ? null : String(s.staffId),
      qty: 1,
      unitPrice: s.price,
      gross: s.price,
      rule: s.rule
    })),
    ...products.map((p) => ({
      key: `prd:${p.idx}:${p.productId}`,
      kind: 'product',
      refId: String(p.productId),
      name: p.name,
      staffId: p.staffId == null ? null : String(p.staffId),
      qty: p.qty,
      unitPrice: p.price,
      gross: p.price * p.qty,
      // BR-SLN-014: product commission only with a selling staff.
      rule: p.staffId == null ? null : p.rule
    }))
  ]
  const subtotal = raw.reduce((s, l) => s + l.gross, 0)
  const discountTotal = discountAmount(discount, subtotal)
  const discounts = allocate(discountTotal, raw.map((l) => l.gross))
  const nets = raw.map((l, i) => l.gross - discounts[i])
  const commissions = commissionsFor(raw.map((l, i) => ({ net: nets[i], qty: l.qty, rule: l.rule })))
  const lines = raw.map(({ rule: _rule, ...l }, i) => ({
    ...l,
    discount: discounts[i],
    net: nets[i],
    commission: Math.max(0, commissions[i])
  }))

  // BR-SLN-013: the tip goes 100% to one staff, undiscounted, no points.
  const tipTotal = tip.amount
  if (tipTotal > 0) {
    if (tip.staffId == null) throw new MoneyError('VALIDATION_FAILED', 'Pilih staff penerima tip', 400, { field: 'tip.staffId' })
    lines.push({
      key: 'tip',
      kind: 'tip',
      refId: String(tip.staffId),
      name: 'Tip',
      staffId: String(tip.staffId),
      qty: 1,
      unitPrice: tipTotal,
      gross: tipTotal,
      discount: 0,
      net: tipTotal,
      commission: tipTotal
    })
  }
  const total = subtotal - discountTotal + tipTotal
  const depositPaid = Math.min(deposit, total)
  return {
    lines,
    subtotal,
    discountTotal,
    tipTotal,
    total,
    depositPaid,
    due: total - depositPaid,
    pointsEarned: Math.floor((subtotal - discountTotal) / pointsPer)
  }
}

/**
 * BR-SLN-010: Σ payments = due exactly, at most one cash row, cash tendered
 * ≥ amount (change computed here, never trusted from the client).
 */
const settlePayments = (payments, due) => {
  const sum = payments.reduce((s, p) => s + p.amount, 0)
  if (sum !== due) {
    throw new MoneyError('PAYMENT_MISMATCH', `Total bayar ${sum} tidak sama dengan tagihan ${due}`, 409, { sum, due })
  }
  if (payments.filter((p) => p.method === 'cash').length > 1) {
    throw new MoneyError('VALIDATION_FAILED', 'Tunai cukup satu baris', 400, { field: 'payments' })
  }
  return payments
    .filter((p) => p.amount > 0)
    .map((p) => {
      if (p.method === 'cash') {
        const tendered = p.tendered ?? p.amount
        if (tendered < p.amount) throw new MoneyError('PAYMENT_MISMATCH', 'Uang diterima kurang dari tagihan', 409)
        return { ...p, tendered, reference: null, change: tendered - p.amount }
      }
      return { ...p, tendered: null, change: 0 }
    })
}

/** BR-SLN-016: modal + tunai + deposit tunai − refund tunai. */
const expectedCash = ({ openingCash, cashSales, depositCash, refunds }) => openingCash + cashSales + depositCash - refunds

// Contract method ↔ canonical transaction.typePayment (DR-23).
const CANONICAL_METHOD = Object.freeze({ cash: 'CASH', qris: 'QRIS', transfer: 'BANK_TRANSFER', card: 'CARD' })
const CONTRACT_METHOD = Object.freeze(Object.fromEntries(Object.entries(CANONICAL_METHOD).map(([k, v]) => [v, k])))

module.exports = {
  MoneyError,
  allocate,
  discountAmount,
  commissionsFor,
  buildQuote,
  settlePayments,
  expectedCash,
  CANONICAL_METHOD,
  CONTRACT_METHOD
}
