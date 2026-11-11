'use strict'

// sales_return_item.price is what the customer is refunded per unit, tax and
// service charge included. Revenue figures (net sales, profit) are tax
// exclusive, so a refund has to be brought back to the same base before it
// is subtracted; its tax share comes off the tax column instead.
//
// The ratio comes from the original order: the part of totalPrice that was
// revenue (subTotal - discountAmount) or tax (taxAmount). Callers must join
// order_item as `oi` and the order as `ro` on ro.id = oi."order".

const refundedSql = 'sri."qty" * sri."price"'

const refundNetOfTaxSql = () =>
  `ROUND(${refundedSql} * (ro."subTotal" - COALESCE(ro."discountAmount", 0)) / NULLIF(ro."totalPrice", 0))`

const refundTaxSql = () =>
  `ROUND(${refundedSql} * COALESCE(ro."taxAmount", 0) / NULLIF(ro."totalPrice", 0))`

const REFUND_ORDER_JOIN = 'JOIN "order" ro ON ro.id = oi."order"'

module.exports = { refundNetOfTaxSql, refundTaxSql, REFUND_ORDER_JOIN }
