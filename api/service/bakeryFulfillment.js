'use strict'

const PAYMENT_REQUIRED = 'PAYMENT_REQUIRED'
const FULFILLMENT_STATUSES = new Set(['PICKED_UP', 'DELIVERED'])

function assertFullyPaidForFulfillment(toStatus, paid, total) {
  if (!FULFILLMENT_STATUSES.has(toStatus)) return
  const outstanding = Math.max(0, Number(total || 0) - Number(paid || 0))
  if (outstanding > 0) {
    const err = new Error('Pesanan harus lunas sebelum diserahkan ke pelanggan')
    err.statusCode = 409
    err.code = PAYMENT_REQUIRED
    throw err
  }
}

module.exports = { assertFullyPaidForFulfillment }
