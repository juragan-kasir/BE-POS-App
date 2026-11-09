const db = require('../../db/models')

// BA §35.10 (DR-23) — canonical financial aggregates and derived state.
//
// The payment ledger (`transaction` rows) is the financial source of truth:
// positive rows are settlements (money in), negative rows are refunds. Every
// caller MUST already hold the order row lock (FOR UPDATE) inside the same
// transaction, so the aggregates cannot go stale between the decision and
// the write that depends on it.
//
//   G  gross payable     order.totalPrice (server-resolved at creation)
//   V  reversed value    G when fulfilment is terminal (cancelled/void),
//                        else Σ approved sales-return refund value (≤ G)
//   P  net payable       G − V
//   C  collected         Σ settlements
//   R  refunded          Σ refunds
//   N  net collected     C − R
//   O  outstanding       P − C + R
//
// V and R are deliberately distinct: void reverses the full commercial value
// (V = G) but refunds only the money actually collected (R = C).

const FINANCIAL_STATES = Object.freeze({
  UNPAID: 'UNPAID',
  PARTIALLY_PAID: 'PARTIALLY_PAID',
  PAID: 'PAID',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
  REFUNDED: 'REFUNDED',
  INVALID: 'INVALID'
})

const TERMINAL_FULFILMENT = Object.freeze(['cancelled', 'void'])

// Persisted cache carrier (order.paymentStatus enum:
// unpaid|partial|partially_paid|partially_refunded|paid|refunded). The
// precise states are written for new rows; 'partial' remains readable for
// historical rows and is never produced again. The canonical state is always
// re-derived from the ledger, never read from this column.
const LEGACY_PAYMENT_STATUS = Object.freeze({
  UNPAID: 'unpaid',
  PARTIALLY_PAID: 'partially_paid',
  PAID: 'paid',
  PARTIALLY_REFUNDED: 'partially_refunded',
  REFUNDED: 'refunded'
})

function deriveFinancialState({ G, C, R, O, terminal }) {
  const N = C - R
  if (O < 0 || R > C || (R > 0 && O > 0)) return FINANCIAL_STATES.INVALID
  if (C === 0 && R === 0) {
    return G === 0 && !terminal ? FINANCIAL_STATES.PAID : FINANCIAL_STATES.UNPAID
  }
  if (R === 0) return O > 0 ? FINANCIAL_STATES.PARTIALLY_PAID : FINANCIAL_STATES.PAID
  return N === 0 ? FINANCIAL_STATES.REFUNDED : FINANCIAL_STATES.PARTIALLY_REFUNDED
}

async function computeOrderFinancials(order, transaction) {
  const rows = await db.transaction.findAll({
    where: { order: order.id },
    order: [['createdAt', 'ASC'], ['id', 'ASC']],
    transaction
  })
  const settlements = rows.filter((r) => Number(r.amount) > 0)
  const refunds = rows.filter((r) => Number(r.amount) < 0)
  const C = settlements.reduce((s, r) => s + Number(r.amount), 0)
  const R = refunds.reduce((s, r) => s + Math.abs(Number(r.amount)), 0)
  const G = Number(order.totalPrice) || 0
  const terminal = TERMINAL_FULFILMENT.includes(order.status)
  let V = G
  if (!terminal) {
    const returned =
      (await db.sales_return.sum('refundAmount', {
        where: { order: order.id, status: 'approved' },
        transaction
      })) || 0
    V = Math.min(G, Number(returned) || 0)
  }
  const P = G - V
  const N = C - R
  const O = P - C + R
  let state = deriveFinancialState({ G, C, R, O, terminal })
  // Legacy data (BA §35.10 I): a cached 'paid' that the ledger does not
  // support (paid with no / insufficient settlement rows) is UNRECONCILED.
  // It is never re-opened for collection or reversed automatically — the
  // cache claims money the ledger cannot explain. (A cached 'unpaid' with
  // ledger collections is the legacy split under-report; the ledger wins.)
  let unreconciled = false
  if (
    order.paymentStatus === 'paid' &&
    [FINANCIAL_STATES.UNPAID, FINANCIAL_STATES.PARTIALLY_PAID].includes(state)
  ) {
    state = FINANCIAL_STATES.INVALID
    unreconciled = true
  }
  return { G, V, P, C, R, N, O, state, terminal, unreconciled, settlements, refunds }
}

const legacyPaymentStatusFor = (state) => LEGACY_PAYMENT_STATUS[state] || null

const financialError = (statusCode, code, message, extra = {}) => {
  const err = new Error(message)
  err.statusCode = statusCode
  err.code = code
  err.extra = extra
  return err
}

// Pending splits must never survive as collection opportunities once the
// order is fully settled (SUPERSEDED), cancelled (CANCELLED) or voided
// (VOIDED). Interim representation until the split status enum is extended
// (migration contract MC-1): the same soft delete the existing split
// cancel() already uses, with the terminal reason recorded in the audit
// log AFTER commit by the caller (in-transaction audit writes are avoided:
// a failed audit INSERT would abort the financial transaction). Caller must
// hold the order lock; split rows are locked in id order.
async function retirePendingSplits(orderId, transaction) {
  const pending = await db.split_bill.findAll({
    where: { order: orderId, status: 'pending' },
    order: [['id', 'ASC']],
    lock: transaction.LOCK.UPDATE,
    transaction
  })
  for (const split of pending) {
    await split.destroy({ transaction })
  }
  return pending.map((s) => ({ id: s.id, splitNumber: s.splitNumber, amount: Number(s.amount) }))
}

module.exports = {
  FINANCIAL_STATES,
  TERMINAL_FULFILMENT,
  deriveFinancialState,
  computeOrderFinancials,
  legacyPaymentStatusFor,
  financialError,
  retirePendingSplits
}
