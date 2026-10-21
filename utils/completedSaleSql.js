'use strict'

// One reporting definition of a completed sale, shared by the register
// (X/Z, close, reconciliation) and the daily / profit-per-product reports.
//
// A sale counts once it was settled, even if it was later refunded by a
// sales return: its gross figures stay on the sale and the refund is
// reported separately, exactly like its +/- ledger rows.
//
// The legacy paymentStatus enum (MC-2 pending) carries two states in
// 'partial': PARTIALLY_REFUNDED (an approved return on a paid sale) and
// PARTIALLY_PAID (an unfinished split bill). Only the first is a completed
// sale, so 'partial' counts only when an approved sales return explains it.
//
// `q` qualifies the order columns: 'o.' for an aliased "order", '' when the
// query reads "order" unaliased (the EXISTS then needs the table name).

function approvedReturnExistsSql(q = '') {
  const orderId = q ? `${q}"id"` : '"order"."id"'
  return `EXISTS (SELECT 1 FROM "sales_return" sr
    WHERE sr."order" = ${orderId} AND sr."status" = 'approved' AND sr."deletedAt" IS NULL)`
}

function completedSaleSql(q = '') {
  return `(${q}"status" NOT IN ('cancelled', 'void')
    AND (${q}"paymentStatus" IN ('paid', 'refunded')
      OR (${q}"paymentStatus" = 'partial' AND ${approvedReturnExistsSql(q)})))`
}

// Unsettled = not yet fully collected: 'unpaid', or 'partial' that is an
// unfinished split bill rather than a partial refund.
function unsettledSaleSql(q = '') {
  return `(${q}"paymentStatus" = 'unpaid'
    OR (${q}"paymentStatus" = 'partial' AND NOT ${approvedReturnExistsSql(q)}))`
}

module.exports = { completedSaleSql, unsettledSaleSql, approvedReturnExistsSql }
