'use strict'

const { financialError } = require('./orderFinancials')

// E2E audit #8 open bill (product owner, 2026-11-01): an unpaid order stays
// open for more rounds of items until it is paid. Stock and BOM are deducted
// once, when the bill is paid (the existing paid transition), never per round.

const OPEN_ORDER_STATUSES = Object.freeze(['pending', 'confirmed', 'preparing', 'ready', 'served'])

const isOpenForRounds = (order) =>
  order.paymentStatus === 'unpaid' && OPEN_ORDER_STATUSES.includes(order.status)

const assertOpenForRounds = (order) => {
  if (isOpenForRounds(order)) return
  throw financialError(
    409,
    'ORDER_NOT_OPEN',
    'Items can only be added to an unpaid order that is still open'
  )
}

const assertNothingCollected = ({ collected, activeSplits }) => {
  if (activeSplits > 0) {
    throw financialError(
      409,
      'ORDER_HAS_SPLITS',
      'This bill has been split; cancel the split before adding items'
    )
  }
  if (collected > 0) {
    throw financialError(
      409,
      'ORDER_PARTIALLY_PAID',
      'Part of this bill is already paid; items can no longer be added'
    )
  }
}

// A new round keeps the discount already on the order (QR campaign or none)
// and recomputes tax and service charge from the order's own stored rates,
// so the rate charged never changes between rounds.
const addRoundTotals = (order, addedItems) => {
  const addedSubtotal = addedItems.reduce((sum, item) => sum + Number(item.subtotal || 0), 0)
  const addedQuantity = addedItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0)
  const subTotal = Number(order.subTotal || 0) + addedSubtotal
  const discountAmount = Math.min(Number(order.discountAmount || 0), subTotal)
  const afterDiscount = subTotal - discountAmount
  const taxAmount = Math.round(afterDiscount * (Number(order.taxRate || 0) / 100))
  const serviceChargeAmount = Math.round(
    afterDiscount * (Number(order.serviceChargeRate || 0) / 100)
  )
  return {
    subTotal,
    totalQuantity: Number(order.totalQuantity || 0) + addedQuantity,
    discountAmount,
    taxAmount,
    serviceChargeAmount,
    totalPrice: afterDiscount + taxAmount + serviceChargeAmount
  }
}

// The QR app names a product line by `productId`, the cashier by `product`;
// the shared item schema turns a missing `product` into 0. One identity for
// pricing, persistence and the idempotent replay comparison.
const normalizeOrderLines = (items) =>
  (Array.isArray(items) ? items : []).map((item) =>
    item.bundleId ? item : { ...item, product: Number(item.product) || Number(item.productId) }
  )

module.exports = {
  OPEN_ORDER_STATUSES,
  normalizeOrderLines,
  isOpenForRounds,
  assertOpenForRounds,
  assertNothingCollected,
  addRoundTotals
}
