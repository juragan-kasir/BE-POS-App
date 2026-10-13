const db = require('../../db/models')
const { Op } = require('sequelize')
const { createAudit } = require('../../utils/auditLog')
const {
  deductStockForPaidOrder,
  enqueueOrderAccountingJobs,
  attemptOrderAccountingEntries,
  validateCashTender
} = require('./order')
const { scalarStoreScope } = require('../../utils/tenantScope')
const { withDeadlockRetry } = require('../../utils/deadlockRetry')
const { assertIntegerRupiah } = require('../../utils/moneyGuard')
const {
  FINANCIAL_STATES,
  computeOrderFinancials,
  legacyPaymentStatusFor,
  financialError,
  retirePendingSplits
} = require('../service/orderFinancials')
const { normalizePaymentMethod } = require('../service/canonicalPayment')
const { resolveAttributedRegister } = require('../service/settlementAttribution')
const { awardEarnedPointsOnce } = require('../service/loyaltyService')

// split_bill has no store column of its own — ownership is entirely
// inherited through order.store (a plain INTEGER, same shape scalarStoreScope
// already handles), so every entry point below that receives a raw order id
// or a split id first proves the parent order belongs to the caller's store
// before any lock/mutation happens.
//
// F5: every mutating operation (create/cancel/pay/merge) now locks the
// parent `order` row FIRST, unconditionally, before touching any
// split_bill row — uniform lock ordering, closing the previous
// split-before-order ordering in cancel() and the conditional (paid-only)
// order lock in pay(). This single lock is what serializes the amount
// invariant below against any concurrent create/cancel/pay/merge on the
// same order; no split_bill-level lock is ever acquired first.
//
// "Active" split amount is SUM(amount) with no status filter — cancelled
// splits are soft-deleted (paranoid: true) and the model has no
// 'cancelled' status value at all, so Sequelize's default scope already
// excludes them from every ORM query below. Raw SQL would need an
// explicit `AND "deletedAt" IS NULL`; none is used here.

const generateSplitNumber = () => {
  const date = new Date()
  const timestamp = date.getTime().toString().slice(-8)
  const random = Math.random().toString(36).substring(2, 6).toUpperCase()
  return `SPL${timestamp}${random}`
}

// Postgres JSONB / plain object comparisons are key-order sensitive —
// canonicalizing before comparing avoids false "different payload"
// mismatches. Same pattern established in F3/F4.
function canonicalJSON(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

// A single idempotencyKey covers an entire batch of splits (not one row
// per key, unlike F4's shape) — compare the ordered list of amounts.
function splitBillPayloadMatches(existingSplits, incomingItems) {
  const existing = existingSplits
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((s) => ({ amount: Number(s.amount) }))
  const incoming = incomingItems.map((i) => ({ amount: Number(i.amount) }))
  return canonicalJSON(existing) === canonicalJSON(incoming)
}

const splitBillController = {
  async create(req, res) {
    try {
      const { order, items, idempotencyKey } = req.body
      const createdBy = req.user?.id || null

      if (!order || !items || items.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Order and items are required'
        })
      }

      // F-MON-1: split amounts persist to an INT4 column — reject
      // fractional/non-finite/over-range values here (fail-fast, pre-tx)
      // instead of a raw DB out-of-range 500 or silent rounding.
      for (const item of items) {
        assertIntegerRupiah(item?.amount, 'split amount')
      }

      let splits
      try {
        splits = await withDeadlockRetry(() =>
          db.sequelize.transaction(async (t) => {
            // Order-first lock — the sole serialization point for both
            // the amount invariant below and create-retry idempotency.
            // IDOR fix (preserved): was findByPk(order) with no store
            // filter.
            const orderRow = await db.order.findOne({
              where: scalarStoreScope(req, { id: order }),
              lock: t.LOCK.UPDATE,
              transaction: t
            })
            if (!orderRow) {
              const e = new Error('Order not found')
              e.statusCode = 404
              throw e
            }

            // Idempotency check — inside the transaction, under the
            // order lock just acquired. A concurrent identical retry
            // blocks on that lock until this transaction commits, then
            // finds the rows this call is about to create — no DB
            // unique constraint is needed (see migration comment: one
            // key legitimately covers multiple rows here, which a
            // unique index on (order, idempotencyKey) cannot express).
            if (idempotencyKey) {
              const existing = await db.split_bill.findAll({
                where: { order, idempotencyKey },
                order: [['id', 'ASC']],
                transaction: t
              })
              if (existing.length > 0) {
                if (splitBillPayloadMatches(existing, items)) {
                  const replay = new Error('IDEMPOTENT_REPLAY')
                  replay.isIdempotentReplay = true
                  replay.existing = existing
                  throw replay
                }
                const e = new Error('idempotencyKey already used with a different payload')
                e.statusCode = 409
                throw e
              }
            }

            // DR-23 (BA §35.10 E): splits may be planned only while the
            // order is open for collection — UNPAID or PARTIALLY_PAID with
            // non-terminal fulfilment — judged on ledger aggregates
            // recomputed under the order lock just acquired.
            const fin = await computeOrderFinancials(orderRow, t)
            if (
              fin.terminal ||
              ![FINANCIAL_STATES.UNPAID, FINANCIAL_STATES.PARTIALLY_PAID].includes(fin.state)
            ) {
              throw financialError(409, 'ORDER_NOT_SPLITTABLE', 'Order is not eligible for split-bill payment')
            }

            // Σ PENDING splits + new ≤ current outstanding. Paid splits are
            // already inside the ledger (C), so they are not counted twice;
            // the ORM default (paranoid) scope excludes retired splits.
            const pendingSplitAmount =
              (await db.split_bill.sum('amount', {
                where: { order, status: 'pending' },
                transaction: t
              })) || 0
            const newSplitAmount = items.reduce((sum, i) => sum + Number(i.amount), 0)

            // Multiple creation rounds are intentionally allowed as long as
            // the planned amount never exceeds what is still outstanding.
            if (Number(pendingSplitAmount) + newSplitAmount > fin.O) {
              throw financialError(
                409,
                'SPLIT_EXCEEDS_OUTSTANDING',
                `New split total (${Number(pendingSplitAmount) + newSplitAmount}) would exceed the outstanding amount (${fin.O})`
              )
            }

            const createdSplits = []
            for (const item of items) {
              const created = await db.split_bill.create(
                {
                  order,
                  splitNumber: generateSplitNumber(),
                  amount: Number(item.amount),
                  status: 'pending',
                  createdBy,
                  idempotencyKey: idempotencyKey || null
                },
                { transaction: t }
              )
              createdSplits.push(created)
            }
            return createdSplits
          })
        )
      } catch (txError) {
        if (txError.isIdempotentReplay) {
          return res.status(200).json({
            success: true,
            message: 'Split bills already recorded',
            data: txError.existing
          })
        }
        throw txError
      }

      await createAudit(
        req,
        'create',
        'split_bill',
        splits[0]?.id,
        'Created split_bill for order: ' + order
      )

      return res.status(201).json({
        success: true,
        message: 'Success create split bills',
        data: splits
      })
    } catch (error) {
      console.log(error)
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Internal server error',
        ...(error.statusCode && error.code ? { code: error.code } : {})
      })
    }
  },

  async getByOrder(req, res) {
    try {
      const { orderId } = req.params

      // Same IDOR fix as create() — was an unscoped split_bill read keyed
      // only on orderId, leaking another store's split/payment amounts.
      const orderRow = await db.order.findOne({
        where: scalarStoreScope(req, { id: orderId })
      })
      if (!orderRow) {
        return res.status(404).json({ success: false, message: 'Order not found' })
      }

      const splits = await db.split_bill.findAll({
        where: { order: orderId },
        order: [['createdAt', 'DESC']]
      })

      const totalPaid = splits
        .filter((s) => s.status === 'paid')
        .reduce((sum, s) => sum + s.amount, 0)

      const totalPending = splits
        .filter((s) => s.status === 'pending')
        .reduce((sum, s) => sum + s.amount, 0)

      return res.status(200).json({
        success: true,
        message: 'Success get split bills',
        data: {
          splits,
          summary: {
            totalSplits: splits.length,
            totalPaid,
            totalPending
          }
        }
      })
    } catch (error) {
      console.log(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async pay(req, res) {
    try {
      const result = await withDeadlockRetry(() =>
        db.sequelize.transaction(async (t) => {
          const { id } = req.params
          const { paymentMethod: bodyMethod, cashAmount, changeAmount, referenceNumber } = req.body

          // P1 (DR-PAY-ATTR-06): the persisted tender is always canonical.
          // Absent method keeps the established exact-cash fallback; an
          // unknown method is refused with 422 before any mutation.
          const method = normalizePaymentMethod(bodyMethod || 'cash')

          // Peek (unlocked) purely to learn the parent order id, so the
          // order can be locked FIRST — uniform with create/cancel/merge.
          // paranoid:false so a retired (superseded/voided/cancelled)
          // split answers SPLIT_NOT_PAYABLE instead of a misleading 404.
          const peek = await db.split_bill.findByPk(id, { paranoid: false, transaction: t })
          if (!peek) {
            const e = new Error('Split bill not found')
            e.statusCode = 404
            throw e
          }

          // Order-first lock — the single serialization point for every
          // financial mutation on this order (settlement, split pay, cancel,
          // void). IDOR fix (preserved) via scalarStoreScope.
          const order = await db.order.findOne({
            where: scalarStoreScope(req, { id: peek.order }),
            lock: t.LOCK.UPDATE,
            transaction: t
          })
          if (!order) {
            const e = new Error('Split bill not found')
            e.statusCode = 404
            throw e
          }

          // Lock every live split row for this order, sorted (deterministic
          // lock order), then the target itself (it may already be retired).
          const allSplits = await db.split_bill.findAll({
            where: { order: order.id },
            order: [['id', 'ASC']],
            lock: t.LOCK.UPDATE,
            transaction: t
          })
          const split =
            allSplits.find((s) => s.id === Number(id)) ||
            (await db.split_bill.findOne({
              where: { id, order: order.id },
              paranoid: false,
              lock: t.LOCK.UPDATE,
              transaction: t
            }))
          if (!split) {
            const e = new Error('Split bill not found')
            e.statusCode = 404
            throw e
          }

          // DR-23 P0-2: re-validate under the lock against ledger
          // aggregates. A split is payable only while it is a live PENDING
          // split of an order still open for collection, and only up to the
          // current outstanding amount — never after the order was fully
          // settled, cancelled, voided or refunded.
          const fin = await computeOrderFinancials(order, t)
          if (split.status === 'paid') {
            throw financialError(409, 'SPLIT_NOT_PAYABLE', 'Split bill already paid')
          }
          if (
            split.deletedAt ||
            split.status !== 'pending' ||
            fin.terminal ||
            ![FINANCIAL_STATES.UNPAID, FINANCIAL_STATES.PARTIALLY_PAID].includes(fin.state) ||
            Number(split.amount) > fin.O
          ) {
            throw financialError(
              409,
              'SPLIT_NOT_PAYABLE',
              'This split is no longer payable: the order is not open for collection or the split exceeds the outstanding amount',
              { outstanding: fin.O }
            )
          }

          // P1 (DR-PAY-ATTR-01..03): every paid split is an attributable
          // settlement event. CASH carries server-validated tender detail
          // (change is derived, never trusted); non-CASH carries a required
          // reference and no drawer cash. The register is the currently
          // open one under a SHARE lock — never inherited, never guessed.
          // Everything below throws before the first mutation on failure.
          let splitCashReceived = null
          let splitChangeGiven = 0
          let splitReference = null
          if (method === 'CASH') {
            const tender = validateCashTender({
              paymentMethod: method,
              cashAmount: cashAmount ?? null,
              changeAmount: changeAmount ?? null,
              amountDue: Number(split.amount) || 0
            })
            splitCashReceived = tender.cashReceived
            splitChangeGiven = tender.changeGiven
          } else {
            const ref = typeof referenceNumber === 'string' ? referenceNumber.trim() : ''
            if (!ref) {
              throw financialError(
                422,
                'REFERENCE_REQUIRED',
                'A reference is required for a non-cash split payment'
              )
            }
            splitReference = ref
          }
          const splitRegister = await resolveAttributedRegister(order.store, t)

          await split.update({ status: 'paid', paymentMethod: method }, { transaction: t })

          // Every split payment is its own real payment, recorded on the
          // payment ledger as it happens (exactly split.amount).
          await db.transaction.create(
            {
              order: split.order,
              splitBillId: split.id,
              typePayment: method,
              amount: Number(split.amount) || 0,
              cashReceived: splitCashReceived,
              changeGiven: splitChangeGiven,
              referenceNumber: splitReference,
              cashRegisterId: splitRegister.id,
              notes: `Split bill payment: ${split.splitNumber}`,
              createdBy: req.user?.id || null
            },
            { transaction: t }
          )

          // Authoritative completion: recomputed from the ledger, still
          // under the order lock. PAID exactly when outstanding reaches 0.
          const after = await computeOrderFinancials(order, t)
          if (after.state === FINANCIAL_STATES.INVALID || after.C > after.G) {
            throw financialError(
              409,
              'FINANCIAL_INVARIANT_VIOLATION',
              'This payment would leave the order in an invalid financial state'
            )
          }

          let orderComplete = false
          let accountingJobs = null
          let retired = []

          if (after.state === FINANCIAL_STATES.PAID) {
            // Stock is deducted exactly once, on the transition to PAID.
            // DR-16 earned points land on the same transition, exactly once:
            // same durable history guard as the update-status settlement
            // hook, so whichever completion path runs first writes the award
            // row and the other sees it and skips. Partial split collections
            // award nothing.
            if (order.paymentStatus !== 'paid') {
              await deductStockForPaidOrder(
                order.id,
                order.store,
                order.orderNumber,
                req.user?.id || null,
                t
              )
              const completeItems = await db.order_item.findAll({
                where: { order: order.id },
                transaction: t
              })
              await awardEarnedPointsOnce({
                orderId: order.id,
                orderNumber: order.orderNumber,
                memberId: order.customerId,
                items: completeItems,
                userId: req.user?.id || null,
                transaction: t
              })
            }
            await order.update({ status: 'paid', paymentStatus: 'paid' }, { transaction: t })
            if (order.tableId) {
              await db.table.update(
                { status: 'available' },
                { where: { id: order.tableId }, transaction: t }
              )
            }
            // No pending split may outlive full settlement.
            retired = await retirePendingSplits(order.id, t)
            orderComplete = true

            // F5-3: durable accounting posting via order.js's outbox
            // helpers, committed in this same transaction.
            accountingJobs = await enqueueOrderAccountingJobs(
              order,
              order.store,
              order.orderNumber,
              {
                subTotal: order.subTotal,
                discountAmount: order.discountAmount,
                taxAmount: order.taxAmount,
                serviceChargeAmount: order.serviceChargeAmount,
                totalPrice: order.totalPrice
              },
              'split',
              req.user?.id || null,
              t
            )
          } else {
            // DR-23: partial collection is first-class — never hidden as
            // 'unpaid' (legacy carrier for PARTIALLY_PAID is 'partial').
            await order.update(
              { paymentStatus: legacyPaymentStatusFor(after.state) },
              { transaction: t }
            )
          }

          return { split, orderComplete, accountingJobs, retired, orderNumber: order.orderNumber }
        })
      )

      await createAudit(
        req,
        'update',
        'split_bill',
        result.split.id,
        'Updated split_bill: ' + result.split.id
      )
      for (const s of result.retired) {
        await createAudit(
          req,
          'update',
          'split_bill',
          s.id,
          `Split ${s.splitNumber} SUPERSEDED by full settlement of order ${result.orderNumber}`,
          { status: 'pending' },
          { status: 'SUPERSEDED', amount: s.amount }
        )
      }

      // Best-effort immediate attempt, after commit — never rolls back
      // an already-valid paid order on posting failure; the outbox row
      // committed above remains durably pending either way.
      if (result.accountingJobs) {
        await attemptOrderAccountingEntries(result.accountingJobs)
      }

      return res.status(200).json({
        success: true,
        message: 'Success pay split bill',
        data: {
          split: result.split,
          orderComplete: result.orderComplete
        }
      })
    } catch (error) {
      console.log(error)
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Internal server error',
        ...(error.statusCode && error.code ? { code: error.code, ...(error.extra || {}) } : {})
      })
    }
  },

  async cancel(req, res) {
    try {
      const cancelledSplit = await withDeadlockRetry(() =>
        db.sequelize.transaction(async (t) => {
          const { id } = req.params

          // Peek (unlocked) purely to learn the parent order id, so the
          // order can be locked FIRST — was split-before-order; now
          // uniform with create/pay/merge.
          const peek = await db.split_bill.findByPk(id, { transaction: t })
          if (!peek) {
            const e = new Error('Split bill not found')
            e.statusCode = 404
            throw e
          }

          // Order-first lock. Cancellation itself is unconditionally
          // allowed for a pending split (this lock never gates the
          // decision) — it exists purely to serialize this cancellation
          // against a concurrent pay()'s completion evaluation on a
          // sibling split. IDOR fix (preserved) via scalarStoreScope.
          const orderRow = await db.order.findOne({
            where: scalarStoreScope(req, { id: peek.order }),
            lock: t.LOCK.UPDATE,
            transaction: t
          })
          if (!orderRow) {
            const e = new Error('Split bill not found')
            e.statusCode = 404
            throw e
          }

          // Authoritative, locked re-read of the target split, now that
          // the order lock is held.
          const split = await db.split_bill.findOne({
            where: { id, order: orderRow.id },
            lock: t.LOCK.UPDATE,
            transaction: t
          })
          if (!split) {
            const e = new Error('Split bill not found')
            e.statusCode = 404
            throw e
          }

          // A paid split is a completed payment with its own ledger
          // entry — deleting it would silently erase that from
          // getByOrder's totals with no reversal of the order's
          // paymentStatus. Only a still-pending split can be cancelled.
          // Cancellation is allowed even if it leaves the active split
          // total below order.totalPrice — that temporary undercoverage
          // is intentional; a replacement split may be created later.
          if (split.status === 'paid') {
            const e = new Error('Cannot cancel a split bill that has already been paid')
            e.statusCode = 409
            throw e
          }

          await split.destroy({ transaction: t })
          return split
        })
      )

      await createAudit(
        req,
        'delete',
        'split_bill',
        cancelledSplit.id,
        'Deleted split_bill: ' + cancelledSplit.id
      )

      return res.status(200).json({
        success: true,
        message: 'Success cancel split bill'
      })
    } catch (error) {
      console.log(error)
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Internal server error'
      })
    }
  },

  async merge(req, res) {
    try {
      const newSplit = await withDeadlockRetry(() =>
        db.sequelize.transaction(async (t) => {
          const { order, splitIds } = req.body

          if (!splitIds || splitIds.length < 2) {
            const e = new Error('At least 2 split bills required to merge')
            e.statusCode = 400
            throw e
          }

          // Order-first lock — was an unlocked verify-only read; now
          // uniform with create/cancel/pay. IDOR fix (preserved): `order`
          // is client-supplied and must be proven to belong to the
          // caller's store before touching any split_bill row.
          const orderRow = await db.order.findOne({
            where: scalarStoreScope(req, { id: order }),
            lock: t.LOCK.UPDATE,
            transaction: t
          })
          if (!orderRow) {
            const e = new Error('Order not found')
            e.statusCode = 404
            throw e
          }

          // Sorted, locked read of exactly the rows being merged.
          const sortedIds = [...splitIds].sort((a, b) => a - b)
          const splits = await db.split_bill.findAll({
            where: {
              id: { [Op.in]: sortedIds },
              order: orderRow.id,
              status: 'pending'
            },
            order: [['id', 'ASC']],
            lock: t.LOCK.UPDATE,
            transaction: t
          })

          if (splits.length !== splitIds.length) {
            const e = new Error('Some split bills not found or already paid')
            e.statusCode = 400
            throw e
          }

          const totalAmount = splits.reduce((sum, s) => sum + s.amount, 0)

          await db.split_bill.destroy({
            where: { id: { [Op.in]: sortedIds } },
            transaction: t
          })

          const created = await db.split_bill.create(
            {
              order: orderRow.id,
              splitNumber: generateSplitNumber(),
              amount: totalAmount,
              status: 'pending'
            },
            { transaction: t }
          )

          return created
        })
      )

      await createAudit(
        req,
        'update',
        'split_bill',
        newSplit.id,
        'Merged split_bill: ' + newSplit.id
      )

      return res.status(201).json({
        success: true,
        message: 'Success merge split bills',
        data: newSplit
      })
    } catch (error) {
      console.log(error)
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Internal server error'
      })
    }
  }
}

module.exports = splitBillController
