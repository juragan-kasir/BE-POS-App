const db = require('../../db/models')
const { tenantStoreWhere } = require('../../utils/tenantScope')
const { Op } = require('sequelize')
const { createAudit } = require('../../utils/auditLog')
const { assertIntegerRupiah } = require('../../utils/moneyGuard')

const accountsReceivableController = {
  async list(req, res) {
    try {
      const userRole = req.user?.roleType
      const {
        page = 1,
        limit = 10,
        status,
        customerId,
        startDate,
        endDate
      } = req.query

      const where = {}
      Object.assign(where, await tenantStoreWhere(req))
      if (status) where.status = status
      if (customerId) where.customerId = customerId
      if (startDate || endDate) {
        where.invoiceDate = {}
        if (startDate) where.invoiceDate[Op.gte] = startDate
        if (endDate) where.invoiceDate[Op.lte] = endDate
      }

      const offset = (parseInt(page) - 1) * parseInt(limit)

      const { count, rows } = await db.accounts_receivable.findAndCountAll({
        where,
        include: [
          {
            model: db.order,
            as: 'orderData',
            attributes: ['id', 'orderNumber', 'totalPrice', 'createdAt']
          },
          {
            model: db.ar_payment,
            as: 'payments',
            attributes: [
              'id',
              'amount',
              'paymentDate',
              'paymentMethod',
              'reference'
            ]
          }
        ],
        order: [['updatedAt', 'DESC']],
        limit: parseInt(limit),
        offset
      })

      // Compute aging and update overdue status
      const now = new Date()
      const enriched = rows.map((ar) => {
        const data = ar.toJSON()
        const due = new Date(data.dueDate)
        const diffDays = Math.floor((now - due) / (1000 * 60 * 60 * 24))
        let agingBucket
        if (diffDays <= 0) agingBucket = 'current'
        else if (diffDays > 90) agingBucket = '90+'
        else if (diffDays > 60) agingBucket = '61-90'
        else if (diffDays > 30) agingBucket = '31-60'
        else agingBucket = '0-30'
        data.agingBucket = agingBucket
        data.overdueDays = diffDays > 0 ? diffDays : 0
        return data
      })

      return res.status(200).json({
        success: true,
        data: enriched,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / parseInt(limit))
        }
      })
    } catch (error) {
      console.error('AR list error:', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async getById(req, res) {
    try {
      const { id } = req.params
      const where = { id }
      Object.assign(where, await tenantStoreWhere(req))
      const ar = await db.accounts_receivable.findOne({
        where,
        include: [
          {
            model: db.order,
            as: 'orderData',
            attributes: [
              'id',
              'orderNumber',
              'totalPrice',
              'createdAt',
              'paymentMethod',
              'cashierName'
            ]
          },
          { model: db.ar_payment, as: 'payments' }
        ]
      })

      if (!ar) {
        return res.status(404).json({ success: false, message: 'AR not found' })
      }

      const data = ar.toJSON()
      const due = new Date(data.dueDate)
      const diffDays = Math.floor((new Date() - due) / (1000 * 60 * 60 * 24))
      data.overdueDays = diffDays > 0 ? diffDays : 0

      return res.status(200).json({ success: true, data })
    } catch (error) {
      console.error('AR getById error:', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async create(req, res) {
    try {
      const store = req.storeId || req.user?.store || null
      const {
        orderId,
        customerId,
        customerName,
        totalAmount,
        dueDate,
        creditTerm,
        notes
      } = req.body

      if (!orderId || !totalAmount) {
        return res.status(400).json({
          success: false,
          message: 'Order and total amount are required'
        })
      }

      // HIGH-8: was `db.order.findByPk(orderId)` with no tenant guard —
      // any authenticated user could create an AR record referencing another
      // store's order (financial record fabrication + cross-tenant order
      // metadata disclosure via invoiceNo / customerName from the foreign order).
      //
      // Fix: verify the order belongs to the caller's store before creating
      // the AR row. Foreign orders return 403 before any DB write.
      // super_admin: intentional unrestricted access, no store constraint.
      const orderWhere = { id: orderId }
      Object.assign(orderWhere, await tenantStoreWhere(req))
      const order = await db.order.findOne({ where: orderWhere })
      if (!order) {
        // Return 403 for tenant callers (store ownership failed) so the
        // caller cannot enumerate foreign order IDs via 404 vs 403 diff.
        // For super_admin the record genuinely doesn't exist → 404.
        const status =
          req.user?.roleType !== 'super_admin' ? 403 : 404
        return res.status(status).json({
          success: false,
          message:
            req.user?.roleType !== 'super_admin'
              ? 'Order not found or does not belong to your store'
              : 'Order not found'
        })
      }

      const invoiceNo = `INV-${order.orderNumber || order.id}-${Date.now()}`
      const today = new Date()

      // N1: totalAmount is INTEGER money — reject fractional/non-finite
      // values here instead of silently truncating via parseInt below
      // (same canonical guard as recordPayment in this controller; this
      // handler's catch is a plain 500 so return 422 directly).
      let totalAmountNum
      try {
        totalAmountNum = assertIntegerRupiah(totalAmount, 'totalAmount')
      } catch (e) {
        return res.status(422).json({ success: false, message: e.message })
      }

      const ar = await db.accounts_receivable.create({
        store: store || null,
        orderId,
        customerId: customerId || null,
        customerName: customerName || order.customerName || null,
        invoiceNo,
        invoiceDate: today.toISOString().split('T')[0],
        dueDate: dueDate || null,
        creditTerm: creditTerm || null,
        totalAmount: totalAmountNum,
        paidAmount: 0,
        outstandingAmount: totalAmountNum,
        status: 'UNPAID',
        notes: notes || null,
        createdBy: req.user?.id || null
      })

      await createAudit(
        req,
        'create',
        'accounts_receivable',
        ar.id,
        `Created AR: ${invoiceNo} for order: ${orderId}`
      )

      return res
        .status(201)
        .json({ success: true, message: 'AR created successfully', data: ar })
    } catch (error) {
      console.error('AR create error:', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async recordPayment(req, res) {
    try {
      const { id } = req.params
      const { amount, paymentDate, paymentMethod, reference, notes } = req.body

      if (!amount || amount <= 0) {
        return res
          .status(400)
          .json({ success: false, message: 'Amount is required' })
      }

      // F-MON-1: ar_payment.amount is INT4 — reject fractional/non-finite
      // or out-of-range values here instead of silent DB rounding/overflow.
      // Direct 422 return (this handler's catch is a plain 500).
      try {
        assertIntegerRupiah(amount, 'amount')
      } catch (e) {
        return res.status(422).json({ success: false, message: e.message })
      }

      const amountNum = Number(amount)

      // F-01: the whole read-check-write runs inside ONE transaction with the
      // AR row locked (FOR UPDATE). Previously the AR was read outside any
      // transaction and each payment computed its new balance from that stale
      // snapshot — two concurrent payments both saw paidAmount=0 and both
      // overwrote paidAmount with their own value, so applied payments could
      // exceed the balance while the AR row showed far less was paid.
      const where = { id }
      Object.assign(where, await tenantStoreWhere(req))

      const t = await db.sequelize.transaction()
      let payment
      try {
        const ar = await db.accounts_receivable.findOne({
          where,
          transaction: t,
          lock: t.LOCK.UPDATE
        })
        if (!ar) {
          await t.rollback()
          return res
            .status(404)
            .json({ success: false, message: 'AR not found' })
        }

        if (ar.status === 'PAID') {
          await t.rollback()
          return res
            .status(400)
            .json({ success: false, message: 'AR is already fully paid' })
        }

        // Over-payment guard evaluated against the LOCKED, up-to-date balance.
        if (Number(ar.paidAmount) + amountNum > Number(ar.totalAmount)) {
          const remaining = Number(ar.totalAmount) - Number(ar.paidAmount)
          await t.rollback()
          return res.status(400).json({
            success: false,
            message: `Over-payment not allowed. Remaining: ${remaining}, attempting: ${amount}`
          })
        }

        // The reference column doubles as a client idempotency key — the
        // partial unique index (arId, reference) WHERE reference IS NOT NULL
        // means a retried/duplicate submission of the SAME reference can never
        // apply twice (see the SequelizeUniqueConstraintError replay below).
        payment = await db.ar_payment.create(
          {
            arId: ar.id,
            amount: amountNum,
            paymentDate: paymentDate || new Date(),
            paymentMethod: paymentMethod || 'cash',
            reference: reference || null,
            notes: notes || null,
            createdBy: req.user?.id || null
          },
          { transaction: t }
        )

        const newPaidAmount = Number(ar.paidAmount) + amountNum
        const newOutstanding = Number(ar.totalAmount) - newPaidAmount
        const newStatus = newOutstanding <= 0 ? 'PAID' : 'PARTIAL'

        // Defense-in-depth: the guarded UPDATE fails (no row affected) if the
        // balance moved since the locked read, aborting the whole payment
        // instead of committing an inconsistent AR + orphaned payment row.
        const [affected] = await db.accounts_receivable.update(
          {
            paidAmount: newPaidAmount,
            outstandingAmount: newOutstanding,
            status: newStatus
          },
          {
            where: { id, ...(where.store ? { store: where.store } : {}), outstandingAmount: { [Op.gte]: amountNum } },
            transaction: t
          }
        )
        if (affected === 0) {
          throw new Error('AR balance changed concurrently; payment aborted')
        }

        await t.commit()

        await createAudit(
          req,
          'create',
          'ar_payment',
          payment.id,
          `Recorded payment ${payment.id} for AR: ${ar.id}`
        )

        return res
          .status(201)
          .json({ success: true, message: 'Payment recorded', data: payment })
      } catch (err) {
        await t.rollback()
        // Idempotent replay: two concurrent submissions with the same
        // (arId, reference) — one wins, the other hits the partial unique
        // index and replays the winner instead of erroring.
        if (err.name === 'SequelizeUniqueConstraintError' && reference) {
          const existing = await db.ar_payment.findOne({
            where: { arId: Number(id), reference }
          })
          if (existing) {
            // F-IDEM-1: the reference doubles as the deduplication
            // identity — same reference must mean the same money
            // movement. A different amount is a conflict, not a replay.
            if (Number(existing.amount) !== Number(amount)) {
              return res.status(409).json({
                success: false,
                message: 'reference already used with a different payload'
              })
            }
            return res.status(200).json({
              success: true,
              message: 'Payment already recorded',
              data: existing
            })
          }
        }
        throw err
      }
    } catch (error) {
      console.error('AR payment error:', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async agingReport(req, res) {
    try {
      const userRole = req.user?.roleType

      const where = { status: { [Op.ne]: 'PAID' } }
      Object.assign(where, await tenantStoreWhere(req))

      const arList = await db.accounts_receivable.findAll({
        where,
        include: [
          {
            model: db.order,
            as: 'orderData',
            attributes: ['id', 'orderNumber']
          },
          {
            model: db.ar_payment,
            as: 'payments',
            attributes: ['id', 'amount', 'paymentDate']
          }
        ],
        order: [['dueDate', 'ASC']]
      })

      const now = new Date()
      const buckets = {
        '0-30': { label: '0-30 Hari', data: [], total: 0 },
        '31-60': { label: '31-60 Hari', data: [], total: 0 },
        '61-90': { label: '61-90 Hari', data: [], total: 0 },
        '90+': { label: '90+ Hari', data: [], total: 0 }
      }

      for (const ar of arList) {
        const data = ar.toJSON()
        const due = new Date(data.dueDate)
        const diffDays = Math.floor((now - due) / (1000 * 60 * 60 * 24))

        let bucket
        if (diffDays <= 0) bucket = 'current'
        else if (diffDays > 90) bucket = '90+'
        else if (diffDays > 60) bucket = '61-90'
        else if (diffDays > 30) bucket = '31-60'
        else bucket = '0-30'

        data.overdueDays = diffDays > 0 ? diffDays : 0
        if (!buckets[bucket])
          buckets[bucket] = { label: bucket, data: [], total: 0 }
        buckets[bucket].data.push(data)
        buckets[bucket].total += Number(data.outstandingAmount || 0)
      }

      const grandTotal = Object.values(buckets).reduce((s, b) => s + b.total, 0)

      return res.status(200).json({
        success: true,
        data: { buckets, grandTotal }
      })
    } catch (error) {
      console.error('AR aging error:', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async update(req, res) {
    try {
      const { id } = req.params
      const { dueDate, creditTerm, notes, status } = req.body

      const where = { id }
      Object.assign(where, await tenantStoreWhere(req))
      const ar = await db.accounts_receivable.findOne({ where })
      if (!ar) {
        return res.status(404).json({ success: false, message: 'AR not found' })
      }

      const updates = {}
      if (dueDate) updates.dueDate = dueDate
      if (creditTerm) updates.creditTerm = creditTerm
      if (notes !== undefined) updates.notes = notes
      if (status !== undefined && status !== null) {
        // F-PAY-2: AR status is server-derived from balances
        // (UNPAID/PARTIAL/PAID in recordPayment). A client-provided status
        // that contradicts the balances — e.g. marking an unpaid AR PAID,
        // or reopening a paid AR — must be rejected, never copied verbatim.
        const expectedStatus =
          Number(ar.outstandingAmount) <= 0
            ? 'PAID'
            : Number(ar.paidAmount) > 0
              ? 'PARTIAL'
              : 'UNPAID'
        if (status !== expectedStatus) {
          return res.status(422).json({
            success: false,
            message: `AR status is derived from balances (expected ${expectedStatus}) and cannot be set directly`
          })
        }
      }
      updates.modifiedBy = req.user?.id || null

      await ar.update(updates)
      await createAudit(
        req,
        'update',
        'accounts_receivable',
        id,
        `Updated AR: ${ar.invoiceNo}`
      )

      return res
        .status(200)
        .json({ success: true, message: 'AR updated', data: ar })
    } catch (error) {
      console.error('AR update error:', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async delete(req, res) {
    try {
      const { id } = req.params
      const where = { id }
      Object.assign(where, await tenantStoreWhere(req))

      const t = await db.sequelize.transaction()
      let deletedInvoiceNo = null
      try {
        const ar = await db.accounts_receivable.findOne({
          where,
          lock: t.LOCK.UPDATE,
          transaction: t
        })
        if (!ar) {
          await t.rollback()
          return res.status(404).json({ success: false, message: 'AR not found' })
        }

        // F-PAY-2: deleting a financially effective AR would orphan its
        // payment history (paid amounts lose their record). Only a
        // pristine UNPAID AR with no payments can be deleted.
        const paymentCount = await db.ar_payment.count({
          where: { arId: ar.id },
          transaction: t
        })
        if (paymentCount > 0 || Number(ar.paidAmount) > 0 || ar.status !== 'UNPAID') {
          await t.rollback()
          return res.status(400).json({
            success: false,
            message: 'AR with recorded payments cannot be deleted'
          })
        }

        await db.ar_payment.destroy({ where: { arId: id }, transaction: t })
        deletedInvoiceNo = ar.invoiceNo
        await ar.destroy({ transaction: t })
        await t.commit()
      } catch (err) {
        await t.rollback()
        throw err
      }

      await createAudit(
        req,
        'delete',
        'accounts_receivable',
        id,
        `Deleted AR: ${deletedInvoiceNo}`
      )

      return res.status(200).json({ success: true, message: 'AR deleted' })
    } catch (error) {
      console.error('AR delete error:', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  }
}

module.exports = accountsReceivableController
