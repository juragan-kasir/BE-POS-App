'use strict'

// W3-6 (BE audit S-06, FIXING-PLAN K8): document numbers come from a counter
// per outlet, per document type, per business day — never from a timestamp +
// random suffix. The old generators drew from a small random space shared by
// EVERY outlet of every tenant (e.g. DLV-YYYYMMDD-NNNN = 10.000 values per
// day for the whole platform), so at multi-tenant volume two outlets
// collided on the global unique index and the second write failed with 500.
//
// Format: <PREFIX>-<storeId>-<YYMMDD>-<seq, at least 4 digits>
//   e.g. ORD-12-261119-0001. The outlet id makes the number globally unique
//   (existing global unique indexes keep holding), the date is the outlet's
//   own calendar date (location.timezone, PGA-29), and seq restarts daily.
//
// The upsert is one statement Postgres serializes per (store, type, date)
// row: concurrent callers queue, they never share a number. Pass the
// caller's transaction when the document is written inside one (a rolled
// back write then does not burn a number, and no second pool connection is
// taken); without a transaction the counter commits on its own and a failed
// write leaves a gap — acceptable, these are not fiscal invoice numbers.
const db = require('../db/models')
const { getStoreLocalDate } = require('./businessDate')
const { resolveStoreTimezone } = require('./storeTimezone')

const PREFIX = Object.freeze({
  order: 'ORD',
  customer_order: 'CUST',
  sales_return: 'SR',
  purchase_return: 'PR',
  stock_transfer: 'TRF',
  goods_request: 'PB',
  waiter_request: 'WR',
  delivery: 'DLV',
  business_trip: 'BT',
  purchase_order: 'PO',
  replacement_po: 'RPL'
})

const storeKey = (store) => {
  const n = Number(Array.isArray(store) ? store[0] : store)
  return Number.isSafeInteger(n) && n > 0 ? n : 0
}

// Counter types: every document prefix plus the customer queue, whose number
// stays short ("Q001") because it is called out and printed for the guest.
const COUNTER_TYPES = new Set([...Object.keys(PREFIX), 'queue'])

// Next value of the (outlet, type, outlet-local business day) counter.
const nextDailySequence = async (type, store, { transaction, now = new Date() } = {}) => {
  if (!COUNTER_TYPES.has(type)) throw new Error(`nextDailySequence: unknown counter type "${type}"`)
  const storeId = storeKey(store)
  // Same transaction for the timezone lookup: no second pool connection
  // while this one may wait on the counter row lock.
  const counterDate = getStoreLocalDate(await resolveStoreTimezone(storeId || null, { transaction }), now)
  const rows = await db.sequelize.query(
    `INSERT INTO document_counter (store, "docType", "counterDate", "lastValue", "updatedAt")
     VALUES ($1, $2, $3, 1, NOW())
     ON CONFLICT (store, "docType", "counterDate")
     DO UPDATE SET "lastValue" = document_counter."lastValue" + 1, "updatedAt" = NOW()
     RETURNING "lastValue"`,
    { bind: [storeId, type, counterDate], transaction, type: db.sequelize.QueryTypes.SELECT }
  )
  return { storeId, counterDate, seq: Number(rows[0].lastValue) }
}

const nextDocumentNumber = async (type, store, options = {}) => {
  const prefix = PREFIX[type]
  if (!prefix) throw new Error(`nextDocumentNumber: unknown document type "${type}"`)
  const { storeId, counterDate, seq } = await nextDailySequence(type, store, options)
  const yymmdd = counterDate.slice(2).replace(/-/g, '')
  return `${prefix}-${storeId}-${yymmdd}-${String(seq).padStart(4, '0')}`
}

// W3-6b: "Q001", "Q002", … restarting every business day per outlet. Unique
// per (storeId, businessDate) — uq_queue_store_day_number, batch B25.
const nextQueueNumber = async (store, options = {}) => {
  const { storeId, counterDate, seq } = await nextDailySequence('queue', store, options)
  return { queueNumber: `Q${String(seq).padStart(3, '0')}`, storeId, businessDate: counterDate }
}

module.exports = { nextDocumentNumber, nextDailySequence, nextQueueNumber, DOCUMENT_PREFIX: PREFIX }
