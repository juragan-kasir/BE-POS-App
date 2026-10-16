const db = require('../../db/models')
const { financialError } = require('./orderFinancials')

// BA gap 004 (DR-23 §D, §M): a non-cash settlement reference — the external
// transaction reference of a CARD, BANK_TRANSFER, E_WALLET or QRIS payment —
// is unique per store and method across successful settlements. A reuse is
// refused with DUPLICATE_REFERENCE and no effect. OTHER carries a free
// description, not an external reference, and is not checked. Refund rows
// (negative amounts) and soft-deleted rows do not count.
//
// The elevated, audited override the BA allows is not implemented yet: it
// needs the elevated-confirmation mechanism of DR-12 Q31, still undecided.
const UNIQUE_REFERENCE_METHODS = Object.freeze(['CARD', 'BANK_TRANSFER', 'E_WALLET', 'QRIS'])

// Legacy rows may hold the inbound alias instead of the canonical value.
const STORED_VALUES = Object.freeze({
  CARD: ['CARD', 'debit', 'credit', 'Kartu Kredit'],
  BANK_TRANSFER: ['BANK_TRANSFER', 'transfer'],
  E_WALLET: ['E_WALLET', 'e-wallet', 'E-Wallet', 'ewallet'],
  QRIS: ['QRIS', 'qris']
})

// Must run inside the settlement transaction, before the ledger row is
// written. The advisory lock serializes concurrent settlements carrying the
// same store/method/reference until the first one commits or rolls back.
const assertSettlementReferenceUnused = async ({ store, method, reference, transaction }) => {
  const ref = typeof reference === 'string' ? reference.trim() : ''
  if (!ref || !UNIQUE_REFERENCE_METHODS.includes(method) || store == null) return

  const key = `settlement-ref:${store}:${method}:${ref.toLowerCase()}`
  await db.sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', {
    replacements: { key },
    transaction
  })

  const [rows] = await db.sequelize.query(
    `SELECT t.id
       FROM "transaction" t
       JOIN "order" o ON o.id = t."order"
      WHERE o.store = :store
        AND t."typePayment" IN (:methods)
        AND lower(btrim(t."referenceNumber")) = :ref
        AND t.amount > 0
        AND t."deletedAt" IS NULL
      LIMIT 1`,
    {
      replacements: { store, methods: STORED_VALUES[method], ref: ref.toLowerCase() },
      transaction
    }
  )
  if (rows.length > 0) {
    throw financialError(
      409,
      'DUPLICATE_REFERENCE',
      `This ${method} reference was already used for another payment at this store`
    )
  }
}

module.exports = { UNIQUE_REFERENCE_METHODS, assertSettlementReferenceUnused }
