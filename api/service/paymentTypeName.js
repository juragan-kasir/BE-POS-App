'use strict'

const { Op } = require('sequelize')
const db = require('../../db/models')
const { financialError } = require('./orderFinancials')
const { reportingBucket } = require('./canonicalPayment')

// E2E audit #6 (batch B8): which of the store's payment types was used —
// "GoPay" or "QRIS", both E_WALLET — kept as a name snapshot beside the
// canonical tender. Optional: without typePaymentId the payment is recorded
// exactly as before (name null). With one, the type must belong to the
// paying store (or be global), be active, and be the same tender as the
// payment; otherwise 422 before anything is written.
const resolvePaymentMethodName = async ({ typePaymentId, method, store, transaction }) => {
  if (typePaymentId === undefined || typePaymentId === null || typePaymentId === '') return null
  const id = Number(typePaymentId)
  if (!Number.isInteger(id) || id <= 0) {
    throw financialError(422, 'INVALID_PAYMENT_TYPE', 'typePaymentId must be a positive integer')
  }
  const paymentType = await db.type_payment.findOne({
    where: { id, status: 'active', [Op.or]: [{ store }, { store: null }] },
    attributes: ['id', 'name', 'type'],
    transaction
  })
  if (!paymentType) {
    throw financialError(
      422,
      'PAYMENT_TYPE_NOT_FOUND',
      'This payment type is not active for the store'
    )
  }
  if (reportingBucket(paymentType.type) !== method) {
    throw financialError(
      422,
      'PAYMENT_TYPE_MISMATCH',
      'This payment type does not match the payment method'
    )
  }
  return paymentType.name
}

module.exports = { resolvePaymentMethodName }
