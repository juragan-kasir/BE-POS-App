const db = require('../../db/models')
const { Op } = require('sequelize')
const { createAudit } = require('../../utils/auditLog')
const { scalarStoreScope, tenantStoreWhere } = require('../../utils/tenantScope')
const { assertIntegerRupiah } = require('../../utils/moneyGuard')
const {
  getDaysUntilDue,
  getDaysOverdue,
  classifyDueDate
} = require('../../utils/businessDate')
const {
  enqueueAccountingJob,
  attemptJob,
  recordImmediateAttempt
} = require('../service/accountingOutboxService')

const purchasePaymentController = {
  async getById(req, res) {
    try {
      const { id } = req.params
      // Tenant condition lives in the query itself — a non-super-admin
      // requesting another store's payment id gets the same 404 as a
      // nonexistent id, never the record (IDOR fix: was findByPk(id) with
      // no store filter, relying only on validateStoreAccess upstream,
      // which never checks the fetched record's actual store).
      const payment = await db.purchase_payment.findOne({
        where: scalarStoreScope(req, { id }),
        include: [
          {
            model: db.purchase_order,
            as: 'purchaseOrderData',
            attributes: ['id', 'orderNumber', 'finalAmount', 'status']
          },
          {
            model: db.supplier,
            as: 'supplierData',
            attributes: ['id', 'name', 'phone']
          }
        ]
      })
      if (!payment) {
        return res
          .status(404)
          .json({ success: false, message: 'Payment not found' })
      }
      return res.status(200).json({ success: true, data: payment })
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async getByPO(req, res) {
    try {
      const { poId } = req.params
      const store = req.storeId || req.cookies.store
      const userRole = req.user?.roleType

      const where = { purchaseOrder: poId }
      Object.assign(where, await tenantStoreWhere(req))

      const payments = await db.purchase_payment.findAll({
        where,
        order: [['paymentDate', 'DESC']]
      })

      return res.status(200).json({
        success: true,
        data: payments
      })
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async getBySupplier(req, res) {
    try {
      const { supplierId } = req.params
      const store = req.storeId || req.cookies.store
      const userRole = req.user?.roleType

      const poiWhere = { supplier: Number(supplierId) }
      const supplierPOIds = await db.purchase_order_item.findAll({
        where: poiWhere,
        attributes: ['purchaseOrder'],
        group: ['purchaseOrder'],
        raw: true
      })
      const poIds = supplierPOIds.map((r) => r.purchaseOrder)

      if (poIds.length === 0) {
        return res.status(200).json({
          success: true,
          data: {
            purchaseOrders: [],
            summary: { totalOrdered: 0, totalPaid: 0, balance: 0 }
          }
        })
      }

      // F21-07: this previously had no status filter at all, unlike
      // apDashboard's identical-purpose query (`status: {notIn:
      // ['cancelled', 'draft']}`) — so a draft (not yet a real order) or
      // cancelled (voided) PO inflated this supplier's balance. The FE
      // labels this response's `balance` as "Saldo Utang" (outstanding
      // debt) and gates a Pay action on it being > 0, so the two endpoints
      // must agree on what counts as a real, payable order.
      const poWhere = {
        id: { [Op.in]: poIds },
        status: { [Op.notIn]: ['cancelled', 'draft'] }
      }
      Object.assign(poWhere, await tenantStoreWhere(req))

      const purchaseOrders = await db.purchase_order.findAll({
        where: poWhere,
        include: [{ model: db.purchase_payment, as: 'payments' }],
        order: [['createdAt', 'DESC']]
      })

      const totalOrdered = purchaseOrders.reduce(
        (sum, po) => sum + Number(po.finalAmount || 0),
        0
      )
      let totalPaid = 0
      for (const po of purchaseOrders) {
        if (po.payments) {
          totalPaid += po.payments.reduce(
            (s, p) => s + Number(p.amount || 0),
            0
          )
        }
      }

      return res.status(200).json({
        success: true,
        data: {
          purchaseOrders,
          summary: {
            totalOrdered,
            totalPaid,
            balance: totalOrdered - totalPaid
          }
        }
      })
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async record(req, res) {
    try {
      const store = req.storeId || req.cookies.store
      const {
        purchaseOrder,
        supplier,
        amount,
        paymentDate,
        paymentMethod,
        reference,
        notes,
        idempotencyKey
      } = req.body

      if (!purchaseOrder || !amount || amount <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Purchase order, supplier, and amount are required'
        })
      }

      // F-MON-1: reject fractional/non-finite amounts before persistence —
      // parseInt below would otherwise silently truncate (75000.9 → 75000).
      // No INT4 cap here: purchase_payment.amount is BIGINT.
      assertIntegerRupiah(amount, 'amount', { max: Number.MAX_SAFE_INTEGER })

      // A retried/duplicate submit with the same key returns the payment
      // already created instead of creating (or double-counting toward
      // the over-payment guard) a second one.
      if (idempotencyKey) {
        const existing = await db.purchase_payment.findOne({
          where: { purchaseOrder, idempotencyKey }
        })
        if (existing) {
          // F-IDEM-1: same key must mean the same money movement — a
          // different amount is a conflict, not a replay.
          if (Number(existing.amount) !== Number(amount)) {
            return res.status(409).json({
              success: false,
              message: 'idempotencyKey already used with a different payload'
            })
          }
          return res.status(200).json({
            success: true,
            message: 'Payment already recorded for this idempotency key',
            data: existing
          })
        }
      }

      let payment
      let po
      let effectiveSupplier
      let journalJob
      await db.sequelize.transaction(async (t) => {
        // Locked BEFORE the over-payment sum-check below — previously that
        // check and the insert were two separate unlocked statements, so
        // two concurrent payments on the same PO could each read the same
        // stale total, each pass the check, and jointly exceed
        // po.finalAmount. Locking the PO row here serializes concurrent
        // record() calls for the same PO against each other.
        //
        // IDOR fix: was findByPk(purchaseOrder) with no store filter — a
        // store A admin could record a real payment against a store B PO
        // (creating a real payment row, attributed to store B, that also
        // triggers a real accounting journal post below) purely by
        // supplying its id. scalarStoreScope confines this to the
        // caller's own store; a mismatched id now 404s exactly like a
        // nonexistent one, before the over-payment sum-check ever runs —
        // which also closes the sum-check's poisoning side effect: that
        // check sums every non-deleted payment against this PO with no
        // regard for who created them, so any future forged payment that
        // this fix prevents can no longer inflate `totalPaid` and falsely
        // block the PO's real owner from recording their own legitimate
        // payment.
        po = await db.purchase_order.findOne({
          where: scalarStoreScope(req, { id: purchaseOrder }),
          transaction: t,
          lock: t.LOCK.UPDATE
        })
        if (!po) {
          const err = new Error('Purchase order not found')
          err.statusCode = 404
          throw err
        }

        // Multi-supplier PO: supplier column no longer exists on
        // purchase_order. Derive from the first PO item when supplier is
        // not supplied explicitly.
        effectiveSupplier = supplier || null
        if (!effectiveSupplier) {
          const firstItem = await db.purchase_order_item.findOne({
            where: { purchaseOrder: purchaseOrder },
            transaction: t
          })
          effectiveSupplier = firstItem?.supplier || null
        }

        if (!effectiveSupplier) {
          const err = new Error('Supplier is required')
          err.statusCode = 400
          throw err
        }

        const existingPayments = await db.purchase_payment.sum('amount', {
          where: { purchaseOrder, deletedAt: null },
          transaction: t
        })
        const totalPaid = existingPayments || 0
        if (totalPaid + Number(amount) > Number(po.finalAmount)) {
          const err = new Error(
            `Over-payment not allowed. Total paid: ${totalPaid}, remaining: ${Number(po.finalAmount) - totalPaid}, attempting to pay: ${amount}`
          )
          err.statusCode = 400
          throw err
        }

        payment = await db.purchase_payment.create(
          {
            store: po.store || store || null,
            purchaseOrder,
            supplier: effectiveSupplier,
            amount: parseInt(amount),
            paymentDate: paymentDate || new Date(),
            paymentMethod: paymentMethod || 'cash',
            reference: reference || null,
            notes: notes || null,
            idempotencyKey: idempotencyKey || null,
            createdBy: req.user?.id || null
          },
          { transaction: t }
        )

        // Durable inside the same transaction as the payment row above — a
        // posting failure below is retried, not silently discarded.
        journalJob = await enqueueAccountingJob({
          jobType: 'purchase_payment_journal',
          store: po.store || store,
          referenceType: 'purchase_payment',
          referenceId: payment.id,
          payload: {
            store: po.store || store,
            paymentId: payment.id,
            poNumber: po.orderNumber,
            amount: payment.amount,
            date: new Date(payment.paymentDate || Date.now()).toISOString(),
            createdBy: req.user?.id
          },
          transaction: t
        })
      })

      const journalResult = await attemptJob(journalJob)
      await recordImmediateAttempt(journalJob, journalResult)
      if (!journalResult.ok) {
        console.error('Purchase payment journal deferred to retry queue:', journalResult.error)
      }

      await createAudit(
        req,
        'create',
        'purchase_payment',
        payment.id,
        'Recorded payment: ' + payment.id + ' for PO: ' + purchaseOrder
      )

      return res.status(201).json({
        success: true,
        message: 'Payment recorded successfully',
        data: payment
      })
    } catch (error) {
      // Two requests with the same idempotencyKey can both pass the
      // earlier findOne check and both attempt to create — the unique
      // index on (purchaseOrder, idempotencyKey) lets exactly one
      // succeed; return the winner's payment to the loser instead of a
      // confusing 500.
      const { idempotencyKey, purchaseOrder } = req.body
      const catchAmount = req.body?.amount
      if (error.name === 'SequelizeUniqueConstraintError' && idempotencyKey) {
        const existing = await db.purchase_payment.findOne({
          where: { purchaseOrder, idempotencyKey }
        })
        if (existing) {
          if (Number(existing.amount) !== Number(catchAmount)) {
            return res.status(409).json({
              success: false,
              message: 'idempotencyKey already used with a different payload'
            })
          }
          return res.status(200).json({
            success: true,
            message: 'Payment already recorded for this idempotency key',
            data: existing
          })
        }
      }
      if (error.statusCode) {
        return res
          .status(error.statusCode)
          .json({ success: false, message: error.message })
      }
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async delete(req, res) {
    try {
      const { id } = req.params
      // Same IDOR fix as getById: scope the fetch by store before allowing
      // a destroy, so a non-super-admin can never delete another store's
      // payment record even if they know/guess its id.
      const t = await db.sequelize.transaction()
      try {
        const payment = await db.purchase_payment.findOne({
          where: scalarStoreScope(req, { id }),
          lock: t.LOCK.UPDATE,
          transaction: t
        })
        if (!payment) {
          await t.rollback()
          return res
            .status(404)
            .json({ success: false, message: 'Payment not found' })
        }

        // F-PAY-2: deleting a payment with posted (or postable) accounting
        // effects would orphan a posted GL entry (Dr AP / Cr Cash) with no
        // reversal — posted effects are reversed, never deleted. Only a
        // payment with no journal entry and no outbox job can be deleted.
        const journalCount = await db.journal_entry.count({
          where: {
            sourceType: 'purchase_payment',
            referenceId: payment.id
          },
          transaction: t
        })
        const jobCount = await db.accounting_outbox.count({
          where: {
            referenceType: 'purchase_payment',
            referenceId: payment.id
          },
          transaction: t
        })
        if (journalCount > 0 || jobCount > 0) {
          await t.rollback()
          return res.status(400).json({
            success: false,
            message:
              'Payment with posted accounting effects cannot be deleted; reverse it instead'
          })
        }

        await payment.destroy({ transaction: t })
        await t.commit()
      } catch (err) {
        await t.rollback()
        throw err
      }

      await createAudit(
        req,
        'delete',
        'purchase_payment',
        id,
        'Deleted payment: ' + id
      )

      return res
        .status(200)
        .json({ success: true, message: 'Payment deleted successfully' })
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async apDashboard(req, res) {
    try {
      const store = req.storeId || req.cookies.store
      const userRole = req.user?.roleType

      const poWhere = { status: { [Op.notIn]: ['cancelled', 'draft'] } }
      Object.assign(poWhere, await tenantStoreWhere(req))

      const purchaseOrders = await db.purchase_order.findAll({
        where: poWhere,
        include: [
          {
            model: db.purchase_order_item,
            as: 'items',
            include: [
              {
                model: db.supplier,
                as: 'supplierData',
                attributes: ['id', 'name', 'phone']
              }
            ]
          },
          {
            model: db.purchase_payment,
            as: 'payments',
            attributes: ['id', 'amount', 'paymentDate', 'supplier']
          },
          {
            model: db.location,
            as: 'storeData',
            attributes: ['id', 'timezone']
          }
        ],
        order: [
          ['dueDate', 'ASC'],
          ['createdAt', 'DESC']
        ]
      })

      let totalOrdered = 0
      let totalPaid = 0
      const supplierMap = {}
      const outstandingPOs = []

      for (const po of purchaseOrders) {
        // Group items in this PO by supplier
        const itemsBySupplier = {}
        let totalItemsAmount = 0
        for (const item of po.items || []) {
          const sId = item.supplier
          if (!sId) continue
          if (!itemsBySupplier[sId]) {
            itemsBySupplier[sId] = {
              supplierId: sId,
              supplierName: item.supplierData?.name || 'Unknown',
              itemsAmount: 0
            }
          }
          itemsBySupplier[sId].itemsAmount += Number(item.total || 0)
          totalItemsAmount += Number(item.total || 0)
        }

        // Pro-rate PO finalAmount to each supplier based on item share
        // Use po.finalAmount directly so return adjustments are reflected
        const poFinalAmount = Number(po.finalAmount || 0)
        const supplierDetails = Object.values(itemsBySupplier).map((detail) => {
          const ratio =
            totalItemsAmount > 0 ? detail.itemsAmount / totalItemsAmount : 0
          const finalAmount = Math.round(poFinalAmount * ratio)
          return {
            ...detail,
            finalAmount
          }
        })

        // Group payments in this PO by supplier
        const paymentsBySupplier = {}
        for (const p of po.payments || []) {
          const sId = p.supplier
          if (!paymentsBySupplier[sId]) {
            paymentsBySupplier[sId] = 0
          }
          paymentsBySupplier[sId] += Number(p.amount || 0)
        }

        for (const detail of supplierDetails) {
          const supId = detail.supplierId
          const amount = detail.finalAmount
          const paid = paymentsBySupplier[supId] || 0
          const outstanding = amount - paid

          totalOrdered += amount
          totalPaid += paid

          if (!supplierMap[supId]) {
            supplierMap[supId] = {
              supplierId: supId,
              supplierName: detail.supplierName,
              totalPO: 0,
              totalPaid: 0,
              outstanding: 0,
              poCount: 0
            }
          }
          supplierMap[supId].totalPO += amount
          supplierMap[supId].totalPaid += paid
          supplierMap[supId].outstanding += outstanding
          supplierMap[supId].poCount += 1

          if (outstanding > 0) {
            // Phase 22 Batch 3 — store-timezone-aware classification. The
            // previous daysOverdue was UTC-instant-based and one-way
            // (clamped any not-yet-due PO to 0, indistinguishable from
            // "due today" — Batch 1 finding F22-B1-04). daysUntilDue is
            // the new bidirectional signal; daysOverdue is kept, now
            // derived from it, for existing consumers.
            const daysUntilDue = getDaysUntilDue(po.dueDate, po.storeData?.timezone)
            outstandingPOs.push({
              id: po.id,
              orderNumber: po.orderNumber,
              supplierId: supId,
              supplierName: detail.supplierName,
              finalAmount: amount,
              totalPaid: paid,
              outstanding,
              orderDate: po.orderDate,
              dueDate: po.dueDate,
              status: po.status,
              daysUntilDue,
              classification: classifyDueDate(daysUntilDue),
              daysOverdue: getDaysOverdue(daysUntilDue)
            })
          }
        }
      }

      return res.status(200).json({
        success: true,
        data: {
          summary: {
            totalOrdered,
            totalPaid,
            totalOutstanding: totalOrdered - totalPaid,
            outstandingPOCount: outstandingPOs.length,
            supplierCount: Object.keys(supplierMap).length
          },
          suppliers: Object.values(supplierMap).sort(
            (a, b) => b.outstanding - a.outstanding
          ),
          outstandingPOs
        }
      })
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async list(req, res) {
    try {
      // Store scope: req.storeId is authoritative (set by validateStoreAccess).
      // For non-super-admins it is always the caller's own store; for
      // super_admins it is the claimed store (query/body) or null (global view).
      // Fall back to the legacy `store` cookie only when req.storeId is absent,
      // so a non-super-admin can never enumerate another store's payments.
      const { store: cookieStore } = req.cookies
      const {
        page = 1,
        limit = 20,
        startDate,
        endDate,
        supplierId,
        search
      } = req.query

      const where = {}
      const effectiveStore = req.storeId || cookieStore
      if (effectiveStore) {
        where['$purchaseOrderData.store$'] = effectiveStore
      }
      if (supplierId) where.supplier = supplierId
      if (search) {
        where[Op.or] = [
          { '$purchaseOrderData.orderNumber$': { [Op.iLike]: `%${search}%` } },
          { '$supplierData.name$': { [Op.iLike]: `%${search}%` } }
        ]
      }
      if (startDate || endDate) {
        where.paymentDate = {}
        if (startDate) where.paymentDate[Op.gte] = startDate
        if (endDate) where.paymentDate[Op.lte] = endDate
      }

      const offset = (parseInt(page) - 1) * parseInt(limit)

      const { count, rows } = await db.purchase_payment.findAndCountAll({
        where,
        include: [
          {
            model: db.purchase_order,
            as: 'purchaseOrderData',
            attributes: ['id', 'orderNumber', 'finalAmount', 'status']
          },
          {
            model: db.supplier,
            as: 'supplierData',
            attributes: ['id', 'name']
          },
          {
            model: db.location,
            as: 'storeData',
            attributes: ['id', 'name']
          }
        ],
        order: [
          ['paymentDate', 'DESC'],
          ['createdAt', 'DESC']
        ],
        limit: parseInt(limit),
        offset
      })

      return res.status(200).json({
        success: true,
        data: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / parseInt(limit))
        }
      })
    } catch (error) {
      console.error(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  }
}

module.exports = purchasePaymentController
