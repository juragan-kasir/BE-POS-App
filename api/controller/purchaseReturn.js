const db = require('../../db/models')
const { tenantStoreWhere, storesInCallerTenant } = require('../../utils/tenantScope')
const { Op } = require('sequelize')
const { createAudit } = require('../../utils/auditLog')
const { adjustProductStock } = require('../service/stockMutationService')
const {
  uploadToCloudinaryWithDedup
} = require('../../utils/cloudinaryStorage')
const {
  enqueueAccountingJob,
  attemptJob,
  recordImmediateAttempt
} = require('../service/accountingOutboxService')
const {
  calculatePurchaseOrderFulfillmentStatus
} = require('../service/purchaseOrderFulfillmentService')

const generateOrderNumber = (prefix) => {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const random = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, '0')
  return `${prefix}-${year}${month}${day}-${random}`
}

async function attachPriceInfo(json, poId) {
  if (!json.items || json.items.length === 0) return json
  const poItems = await db.purchase_order_item.findAll({
    where: { purchaseOrder: poId },
    attributes: ['ingredient', 'product', 'ingredientName', 'price']
  })
  const priceMap = {}
  poItems.forEach((pi) => {
    const price = parseFloat(pi.price) || 0
    if (pi.ingredient) priceMap[`ing-${pi.ingredient}`] = price
    if (pi.product) priceMap[`prod-${pi.product}`] = price
    if (pi.ingredientName) priceMap[`name-${pi.ingredientName}`] = price
  })
  json.items = json.items.map((item) => {
    const key = item.ingredient?.id
      ? `ing-${item.ingredient.id}`
      : item.product?.id
        ? `prod-${item.product.id}`
        : item.ingredientName
          ? `name-${item.ingredientName}`
          : null
    item.price = key ? priceMap[key] || 0 : 0
    item.subtotal = item.price * (parseFloat(item.qty) || 0)
    return item
  })
  json.totalAmount = json.items.reduce((s, i) => s + i.subtotal, 0)
  return json
}

const purchaseReturnController = {
  async getAll(req, res) {
    try {
      const {
        page = 1,
        limit = 10,
        status,
        startDate,
        endDate,
        search,
        supplier
      } = req.query

      // HIGH-9: was `req.cookies.store` (client-controlled cookie) with a
      // fail-open `{}` fallback — a store admin could list every store's
      // returns. The tenant is always the pinned req.storeId
      // (validateStoreAccess resolved the JWT store for non-super, or the
      // client-selected store / null for super_admin).
      const effectiveStore = req.storeId ?? req.user?.store
      if (!effectiveStore && req.user?.roleType !== 'super_admin') {
        return res.status(403).json({
          success: false,
          message: 'Store assignment required'
        })
      }

      const where = {}
      if (effectiveStore) where.store = effectiveStore
      if (status) where.status = status
      if (search) {
        where[Op.or] = [
          { returnNumber: { [Op.iLike]: `%${search}%` } },
          { reason: { [Op.iLike]: `%${search}%` } }
        ]
      }
      if (supplier) {
        const matchingPOItems = await db.purchase_order_item.findAll({
          where: { supplier: Number(supplier) },
          attributes: ['purchaseOrder'],
          raw: true
        })
        const poIds = matchingPOItems.map((item) => item.purchaseOrder)
        where.purchaseOrder = { [Op.in]: poIds }
      }
      if (startDate || endDate) {
        where.createdAt = {}
        if (startDate) where.createdAt[Op.gte] = new Date(startDate)
        if (endDate) where.createdAt[Op.lte] = new Date(endDate + 'T23:59:59')
      }

      const offset = (parseInt(page) - 1) * parseInt(limit)

      const statsWhere = effectiveStore ? { store: effectiveStore } : {}
      const [pendingCount, approvedCount, rejectedCount] = await Promise.all([
        db.purchase_return.count({
          where: { ...statsWhere, status: 'pending' }
        }),
        db.purchase_return.count({
          where: { ...statsWhere, status: 'approved' }
        }),
        db.purchase_return.count({
          where: { ...statsWhere, status: 'rejected' }
        })
      ])
      const stats = {
        pending: pendingCount,
        approved: approvedCount,
        rejected: rejectedCount
      }

      const { count, rows } = await db.purchase_return.findAndCountAll({
        where,
        distinct: true,
        include: [
          {
            model: db.purchase_return_item,
            as: 'items',
            include: [
              {
                model: db.product,
                as: 'productData',
                attributes: ['id', 'nameProduct']
              },
              {
                model: db.ingredient,
                as: 'ingredientData',
                attributes: ['id', 'name']
              }
            ]
          },
          { model: db.location, as: 'storeData', attributes: ['id', 'name'] }
        ],
        order: [['updatedAt', 'DESC']],
        limit: parseInt(limit),
        offset
      })

      const transformed = rows.map((r) => {
        const json = r.toJSON()
        if (json.createdByUser) {
          json.returnedBy = {
            id: json.createdByUser.id,
            name: json.createdByUser.fullName
          }
        } else if (json.returnedBy) {
          json.returnedBy = { name: json.returnedBy }
        }
        if (json.items) {
          json.items = json.items.map((item) => {
            if (item.productData) {
              item.product = {
                id: item.productData.id,
                name: item.productData.nameProduct
              }
            }
            delete item.productData
            if (item.ingredientData) {
              item.ingredient = {
                id: item.ingredientData.id,
                name: item.ingredientData.name
              }
            }
            delete item.ingredientData
            item.purchaseReturn = {
              id: item.purchaseReturn,
              name: json.returnNumber
            }
            return item
          })
        }
        return json
      })

      return res.status(200).json({
        success: true,
        message: 'Success',
        data: transformed,
        stats,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / parseInt(limit))
        }
      })
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async getById(req, res) {
    try {
      const { id } = req.params
      // HIGH-9: was `req.storeId || req.cookies.store` — the cookie is a
      // client-controlled value; tenant comes from the pinned req.storeId only.
      const store = req.storeId ?? req.user?.store
      const userRole = req.user?.roleType
      if (!store && userRole !== 'super_admin') {
        return res.status(403).json({
          success: false,
          message: 'Store assignment required'
        })
      }

      const where = { id }
      Object.assign(where, await tenantStoreWhere(req))

      const ret = await db.purchase_return.findOne({
        where,
        include: [
          {
            model: db.purchase_return_item,
            as: 'items',
            include: [
              {
                model: db.product,
                as: 'productData',
                attributes: ['id', 'nameProduct']
              },
              {
                model: db.ingredient,
                as: 'ingredientData',
                attributes: ['id', 'name']
              }
            ]
          },
          { model: db.location, as: 'storeData', attributes: ['id', 'name'] }
        ]
      })

      if (!ret) {
        return res
          .status(404)
          .json({ success: false, message: 'Purchase return not found' })
      }

      const result = ret.toJSON()
      if (result.createdByUser) {
        result.returnedBy = {
          id: result.createdByUser.id,
          name: result.createdByUser.fullName
        }
      } else if (result.returnedBy) {
        result.returnedBy = { name: result.returnedBy }
      }
      if (result.items) {
        result.items = result.items.map((item) => {
          if (item.productData) {
            item.product = {
              id: item.productData.id,
              name: item.productData.nameProduct
            }
          }
          delete item.productData
          if (item.ingredientData) {
            item.ingredient = {
              id: item.ingredientData.id,
              name: item.ingredientData.name
            }
          }
          delete item.ingredientData
          item.purchaseReturn = {
            id: item.purchaseReturn,
            name: result.returnNumber
          }
          return item
        })
      }

      const enriched = await attachPriceInfo(result, result.purchaseOrder)

      // ponytail: attach PO orderNumber for display
      if (enriched.purchaseOrder) {
        const po = await db.purchase_order.findByPk(enriched.purchaseOrder, {
          attributes: ['id', 'orderNumber']
        })
        enriched.purchaseOrder = po
          ? { id: po.id, orderNumber: po.orderNumber }
          : { id: enriched.purchaseOrder, orderNumber: null }
      }

      return res
        .status(200)
        .json({ success: true, message: 'Success', data: enriched })
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async approve(req, res) {
    try {
      const { id } = req.params
      const { resolution = 'credit' } = req.body
      // HIGH-9: cookie store removed — tenant comes from req.storeId only.
      const store = req.storeId ?? req.user?.store
      const userRole = req.user?.roleType
      if (!store && userRole !== 'super_admin') {
        return res.status(403).json({
          success: false,
          message: 'Store assignment required'
        })
      }

      if (!['credit', 'replacement'].includes(resolution)) {
        return res.status(400).json({
          success: false,
          message: 'Resolution must be credit or replacement'
        })
      }

      const where = { id }
      Object.assign(where, await tenantStoreWhere(req))

      // Batch 32-A (PR-02): approval must be atomic. The status used to be
      // read unlocked and flipped before any financial work, so two
      // concurrent approvals could both pass the pending check and double
      // every effect. The transaction now opens first; the return row is
      // locked (FOR UPDATE) and its status re-checked inside, so exactly
      // one approval wins and losers see the terminal state.
      const t = await db.sequelize.transaction()
      let returnTotal = 0
      let journalJob = null
      try {
        const ret = await db.purchase_return.findOne({
          where,
          lock: t.LOCK.UPDATE,
          transaction: t
        })
        if (!ret) {
          await t.rollback()
          return res
            .status(404)
            .json({ success: false, message: 'Purchase return not found' })
        }

        if (ret.status !== 'pending') {
          await t.rollback()
          return res.status(400).json({
            success: false,
            message: 'Only pending returns can be approved'
          })
        }

        const retItems = await db.purchase_return_item.findAll({
          where: { purchaseReturn: ret.id },
          lock: t.LOCK.UPDATE,
          transaction: t
        })

        if (ret.purchaseOrder) {
          const po = await db.purchase_order.findByPk(ret.purchaseOrder, {
            lock: t.LOCK.UPDATE,
            transaction: t
          })
          const poItems = await db.purchase_order_item.findAll({
            where: { purchaseOrder: ret.purchaseOrder },
            lock: t.LOCK.UPDATE,
            transaction: t
          })
          const poItemMap = {}
          poItems.forEach((pi) => {
            if (pi.ingredient) poItemMap[`ing-${pi.ingredient}`] = pi
            if (pi.product) poItemMap[`prod-${pi.product}`] = pi
            if (pi.ingredientName) poItemMap[`name-${pi.ingredientName}`] = pi
          })

          returnTotal = 0
          const resolvedItems = retItems.map((item) => {
            const key = item.ingredient
              ? `ing-${item.ingredient}`
              : item.product
                ? `prod-${item.product}`
                : item.ingredientName
                  ? `name-${item.ingredientName}`
                  : null
            const poItem = key ? poItemMap[key] : null
            const qty = Number(item.qty) || 0
            const price = poItem ? Number(poItem.price) || 0 : 0
            returnTotal += price * qty
            return { item, poItem, key, qty, price }
          })

          // Returned goods are always credited against the PO bill.
          // For replacement, the new PO re-adds the same cost, so the net
          // effect stays neutral while remaining fully traceable.
          //
          // Batch 32-B (PR-06): the credit covers the returned base value
          // plus its proportional share of PO tax. The forward purchase
          // model posts PO tax separately (Dr Input Tax 1250 / Cr AP, see
          // postPurchaseJournal F22-B2-01), so a base-only credit would
          // leave the returned goods' tax standing in both finalAmount
          // and the ledger. The share mirrors the forward pro-rata basis
          // (tax × base/totalAmount), capped at the PO's total tax.
          // Landed/additionalCost treatment is intentionally unchanged
          // (separately scoped).
          const poTaxAmount = Number(po?.taxAmount) || 0
          const poTotalForTax = Number(po?.totalAmount) || 0
          const returnTax =
            poTaxAmount > 0 && poTotalForTax > 0 && returnTotal > 0
              ? Math.min(
                  Math.round((poTaxAmount * returnTotal) / poTotalForTax),
                  poTaxAmount
                )
              : 0
          if (returnTotal > 0) {
            await db.purchase_order.update(
              {
                finalAmount: db.sequelize.literal(
                  `GREATEST("purchase_order"."finalAmount" - ${returnTotal + returnTax}, 0)`
                )
              },
              { where: { id: ret.purchaseOrder }, transaction: t }
            )
          }

          // receivedQuantity is intentionally NOT reduced: the returned qty
          // stays consumed so those units cannot be received again on this PO
          // (prevents double benefit / double receiving).

          // Durable inside the same transaction as the return/PO/stock rows
          // above — a posting failure below is retried, not silently
          // discarded (same pattern as purchasePayment.js / goodsReceipt.js).
          if (returnTotal > 0) {
            journalJob = await enqueueAccountingJob({
              jobType: 'purchase_return_journal',
              store: ret.store,
              referenceType: 'purchase_return',
              referenceId: id,
              payload: {
                store: ret.store,
                purchaseReturnId: id,
                returnNumber: ret.returnNumber,
                amount: returnTotal,
                taxAmount: returnTax,
                date: new Date().toISOString(),
                createdBy: req.user?.id
              },
              transaction: t
            })
          }

          // Status flips only after every financial effect above has been
          // written inside this same transaction — never before, so a
          // concurrent approval can only ever observe pending (and proceed)
          // or an already-terminal state (and refuse).
          await ret.update({ status: 'approved', resolution }, { transaction: t })

          // F22-B10-02: recompute the ORIGINAL PO's fulfillment status now
          // that this approved return counts against it. Applies for both
          // resolutions — a replacement PO (if any) is a separate,
          // unrelated record; only this original PO's status changes here.
          await calculatePurchaseOrderFulfillmentStatus({
            purchaseOrderId: ret.purchaseOrder,
            transaction: t
          })

          if (resolution === 'replacement') {
            const total = resolvedItems.reduce((s, r) => s + r.price * r.qty, 0)
            const supplier =
              resolvedItems.find((r) => r.poItem && r.poItem.supplier)?.poItem
                ?.supplier || null

            // Batch 32-B (PR-07): the replacement PO re-orders the same
            // goods under the same standing supplier purchase terms, so it
            // carries the original tax rate with canonical PO math
            // (taxableBase = total - discount; tax = round(base × rate);
            // final = base + tax + additionalCost — same formula as
            // calculatePoFinancials in purchaseOrder.js). The replacement
            // itself has no discount or landed cost of its own yet, so
            // both stay 0 here. Per-deal discount carryover is a product
            // decision and is intentionally not assumed.
            const replacementTaxRate = Math.min(100, Math.max(0, Number(po?.taxRate) || 0))
            const replacementTaxAmount = Math.round(total * (replacementTaxRate / 100))
            const replacementPO = await db.purchase_order.create(
              {
                store: ret.store || null,
                orderNumber: generateOrderNumber('RPL'),
                totalAmount: total,
                discount: 0,
                taxRate: replacementTaxRate,
                taxAmount: replacementTaxAmount,
                finalAmount: total + replacementTaxAmount,
                status: 'draft',
                orderDate: new Date(),
                notes: `Replacement PO for return ${ret.returnNumber}`,
                createdBy: req.user?.id || null,
                pic: po ? po.pic : null,
                dueDate: po ? po.dueDate : null,
                paymentMethod: po ? po.paymentMethod : 'cash',
                tenor: po ? po.tenor : 0,
                dpPercent: po ? po.dpPercent : 0,
                additionalCost: 0,
                overDeliveryTolerance: po ? po.overDeliveryTolerance : 10
              },
              { transaction: t }
            )

            const replacementItems = resolvedItems
              .filter((r) => r.qty > 0)
              .map((r) => ({
                purchaseOrder: replacementPO.id,
                product: r.item.product,
                ingredient: r.item.ingredient,
                ingredientName: r.item.ingredientName,
                supplier: r.poItem?.supplier || supplier,
                quantity: r.qty,
                unit: r.item.unit || r.poItem?.unit || 'pcs',
                price: r.price,
                total: r.price * r.qty,
                receivedQuantity: 0,
                conversionToBase: Number(r.poItem?.conversionToBase) || 1
              }))

            await db.purchase_order_item.bulkCreate(replacementItems, {
              transaction: t
            })
          }
        }

        await t.commit()

        if (journalJob) {
          const journalResult = await attemptJob(journalJob)
          await recordImmediateAttempt(journalJob, journalResult)
          if (!journalResult.ok) {
            console.error('Purchase return journal deferred to retry queue:', journalResult.error)
          }
        }

        await createAudit(
          req,
          'update',
          'purchase_return',
          id,
          'Approved purchase return: ' + id + ' (' + resolution + ')'
        )

        return res.status(200).json({
          success: true,
          message: 'Purchase return approved',
          data: ret
        })
      } catch (err) {
        await t.rollback()
        throw err
      }
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async reject(req, res) {
    try {
      const { id } = req.params
      // HIGH-9: cookie store removed — tenant comes from req.storeId only.
      const store = req.storeId ?? req.user?.store
      const userRole = req.user?.roleType
      if (!store && userRole !== 'super_admin') {
        return res.status(403).json({
          success: false,
          message: 'Store assignment required'
        })
      }

      const where = { id }
      Object.assign(where, await tenantStoreWhere(req))

      // Batch 32-A (PR-03): rejection must be atomic like approval. The
      // return used to be read unlocked and its status checked before any
      // transaction opened, so two concurrent rejects (or an approve/reject
      // race) could both pass the pending check and restore stock twice.
      // The transaction now opens first; the return row is locked
      // (FOR UPDATE) and re-checked inside, so exactly one terminal
      // transition wins.
      const transaction = await db.sequelize.transaction()
      try {
        const ret = await db.purchase_return.findOne({
          where,
          lock: transaction.LOCK.UPDATE,
          transaction
        })

        if (!ret) {
          await transaction.rollback()
          return res
            .status(404)
            .json({ success: false, message: 'Purchase return not found' })
        }

        if (ret.status !== 'pending') {
          await transaction.rollback()
          return res.status(400).json({
            success: false,
            message: 'Only pending returns can be rejected'
          })
        }

        const retItems = await db.purchase_return_item.findAll({
          where: { purchaseReturn: ret.id },
          lock: transaction.LOCK.UPDATE,
          transaction
        })

        // Batch 14: create() deducts item.qty * poItem.conversionToBase (the
        // Batch 13 fix) — the reversal here must undo that exact same
        // base-unit amount, not the raw purchase-unit qty, or the forward
        // and reverse deltas no longer cancel. Mirrors create()'s own
        // poItemMap lookup.
        const rejectPoItems = ret.purchaseOrder
          ? await db.purchase_order_item.findAll({
              where: { purchaseOrder: ret.purchaseOrder },
              lock: transaction.LOCK.UPDATE,
              transaction
            })
          : []
        const rejectPoItemMap = {}
        rejectPoItems.forEach((pi) => {
          const key = pi.ingredient
            ? `ing-${pi.ingredient}`
            : pi.product
              ? `prod-${pi.product}`
              : pi.ingredientName
                ? `name-${pi.ingredientName}`
                : null
          if (key) rejectPoItemMap[key] = Number(pi.conversionToBase) || 1
        })

        // Reverse stock: add back what was deducted on creation. Product
        // restoration uses the shared, locked, atomic-delta helper; the
        // ingredient path below uses a locked read plus an atomic SQL
        // increment (never an absolute oldStock + qty write, which loses
        // concurrent updates). Quantities here are the validated integers
        // persisted at create time (PR-04), so no truncation occurs.
        for (const item of retItems) {
          const itemKey = item.ingredient
            ? `ing-${item.ingredient}`
            : item.product
              ? `prod-${item.product}`
              : item.ingredientName
                ? `name-${item.ingredientName}`
                : null
          const rejectConversion = (itemKey && rejectPoItemMap[itemKey]) || 1
          const qty = (Number(item.qty) || 0) * rejectConversion
          if (item.product) {
            await adjustProductStock({
              productId: item.product,
              store: ret.store || null,
              deltaQty: qty,
              referenceType: 'adjustment',
              referenceId: ret.id,
              notes: `Purchase return rejected: ${ret.reason}`,
              createdBy: req.user?.id || null,
              transaction
            })
          }

          // Resolve the same stock identity create-time deduction used:
          // prefer the persisted ingredient FK, falling back to the exact
          // name+store match (create uses exact match, not fuzzy).
          const ingredient = item.ingredient
            ? await db.ingredient.findByPk(item.ingredient, {
                lock: transaction.LOCK.UPDATE,
                transaction
              })
            : item.ingredientName
              ? await db.ingredient.findOne({
                  where: {
                    name: item.ingredientName,
                    store: ret.store
                  },
                  lock: transaction.LOCK.UPDATE,
                  transaction
                })
              : null
          if (ingredient) {
            const oldStock = Number(ingredient.stock) || 0
            await ingredient.update(
              { stock: db.sequelize.literal(`stock + (${qty})`) },
              { transaction }
            )

            await db.stock_history.create(
              {
                ingredient: ingredient.id,
                ingredientName: ingredient.name,
                store: ret.store,
                referenceType: 'adjustment',
                quantityBefore: oldStock,
                quantityChange: qty,
                quantityAfter: oldStock + qty,
                unit: item.unit || ingredient.unit || 'pcs',
                notes: `Purchase return rejected: ${ret.reason}`,
                createdBy: req.user?.id || null
              },
              { transaction }
            )
          }
        }

        await ret.update({ status: 'rejected' }, { transaction })
        await transaction.commit()

        await createAudit(
          req,
          'update',
          'purchase_return',
          id,
          'Rejected purchase return: ' + id
        )

        return res.status(200).json({
          success: true,
          message: 'Purchase return rejected',
          data: ret
        })
      } catch (err) {
        await transaction.rollback()
        throw err
      }
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

      // HIGH-9: this was `where = { purchaseOrder: poId }` with no tenant
      // filter — a store A admin could list store B's returns by guessing
      // the other store's purchase-order id. Scope to the pinned store.
      const userRole = req.user?.roleType
      const store = req.storeId ?? req.user?.store
      if (!store && userRole !== 'super_admin') {
        return res.status(403).json({
          success: false,
          message: 'Store assignment required'
        })
      }
      const where = { purchaseOrder: poId }
      Object.assign(where, await tenantStoreWhere(req))

      const returns = await db.purchase_return.findAll({
        where,
        include: [
          {
            model: db.purchase_return_item,
            as: 'items',
            include: [
              {
                model: db.product,
                as: 'productData',
                attributes: ['id', 'nameProduct']
              },
              {
                model: db.ingredient,
                as: 'ingredientData',
                attributes: ['id', 'name']
              }
            ]
          },
          { model: db.location, as: 'storeData', attributes: ['id', 'name'] }
        ],
        order: [['createdAt', 'DESC']]
      })

      const transformed = returns.map((r) => {
        const json = r.toJSON()
        if (json.createdByUser) {
          json.returnedBy = {
            id: json.createdByUser.id,
            name: json.createdByUser.fullName
          }
        } else if (json.returnedBy) {
          json.returnedBy = { name: json.returnedBy }
        }
        if (json.items) {
          json.items = json.items.map((item) => {
            if (item.productData) {
              item.product = {
                id: item.productData.id,
                name: item.productData.nameProduct
              }
            }
            delete item.productData
            if (item.ingredientData) {
              item.ingredient = {
                id: item.ingredientData.id,
                name: item.ingredientData.name
              }
            }
            delete item.ingredientData
            item.purchaseReturn = {
              id: item.purchaseReturn,
              name: json.returnNumber
            }
            return item
          })
        }
        return json
      })

      const enriched = await Promise.all(
        transformed.map((r) => attachPriceInfo(r, parseInt(poId)))
      )

      return res.status(200).json({ success: true, data: enriched })
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async create(req, res) {
    try {
      // ponytail: FormData wraps payload in req.body.data
      if (typeof req.body?.data === 'string') {
        try {
          const unwrapped = JSON.parse(req.body.data)
          req.body = { ...req.body, ...unwrapped }
          delete req.body.data
        } catch {}
      }
      const { purchaseOrder: poId, items, reason, returnedBy } = req.body
      const createdBy = req.user?.id || null

      if (!poId) {
        return res.status(400).json({
          success: false,
          message: 'Purchase order ID is required'
        })
      }

      const po = await db.purchase_order.findByPk(poId)
      if (!po) {
        return res.status(404).json({
          success: false,
          message: 'Purchase order not found'
        })
      }

      // HIGH-9: was `req.storeId || req.cookies.store || po.store` — the
      // cookie is client-controlled and could push a non-super admin onto a
      // foreign store. Tenant now comes only from the pinned req.storeId; for
      // super_admin acting without a selected store context the PO's own
      // store is the legitimate tenant anchor (the PO is data itself).
      const store = req.storeId ?? po.store

      // The return is always written against the caller's own tenant. A
      // non-super admin may only return from a purchase order that belongs
      // to their own store.
      // Wave 4: a store-bound owner may only return from its own tenant's PO
      // (a global super admin keeps unrestricted access).
      if (req.user?.roleType === 'super_admin' && !(await storesInCallerTenant(req, [po.store]))) {
        return res.status(403).json({
          success: false,
          message: 'Anda hanya dapat mengelola retur di toko Anda'
        })
      }
      if (req.user?.roleType !== 'super_admin') {
        if (!store || Number(po.store) !== Number(store)) {
          return res.status(403).json({
            success: false,
            message: 'Anda hanya dapat mengelola retur di toko Anda'
          })
        }
      }

      if (po.status !== 'received' && po.status !== 'ordered') {
        return res.status(400).json({
          success: false,
          message: 'Only received or ordered purchase orders can be returned'
        })
      }

      if (!items || items.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'At least one item is required'
        })
      }

      // F22-B10-06: this validation used to run entirely before any
      // transaction opened — a plain, unlocked read of receivedQuantity
      // and existing returns, checked, and only THEN (much later) did a
      // transaction begin for the actual writes. Two concurrent return
      // requests for the same PO item could both read the same
      // pre-commit state, both individually pass the returnable-quantity
      // check, and jointly return more than was actually received. The
      // transaction now opens here, with a row lock on the PO items being
      // validated, and stays open through the actual writes below — the
      // second concurrent request's locked read blocks until the first
      // commits, then sees the now-current receivedQuantity/returned
      // total. Same lock idiom already used for the analogous Goods
      // Receipt over-delivery race (goodsReceipt.js) and elsewhere
      // (purchaseOrder.js, batchService.js, stockMutationService.js,
      // promoUsageService.js, loyaltyService.js).
      const t = await db.sequelize.transaction()
      try {
        // Fetch PO items to validate return qty against receivedQty
        const poItems = await db.purchase_order_item.findAll({
          where: { purchaseOrder: poId },
          lock: t.LOCK.UPDATE,
          transaction: t
        })

        // Fetch existing return items to compute already-returned qty
        // Note: rejected returns are excluded because they restore stock
        const existingReturns = await db.purchase_return.findAll({
          where: { purchaseOrder: poId, status: { [Op.ne]: 'rejected' } },
          include: [{ model: db.purchase_return_item, as: 'items' }],
          transaction: t
        })

      // F22-B10-03: a PO can legitimately have two separate line items for
      // the SAME product/ingredient from different suppliers (see
      // purchaseOrder.js's own duplicate-item guard, which keys on
      // product+supplier, not product alone). A Purchase Return item has
      // no supplier of its own to disambiguate which line it's against, so
      // the only correct, non-invented interpretation of "how much is
      // available to return" is the TRUE combined receivedQuantity across
      // every PO item sharing that identity key — aggregated here, not
      // silently overwritten by whichever line happens to be last.
      const poItemMap = {}
      poItems.forEach((pi) => {
        const key = pi.ingredient
          ? `ing-${pi.ingredient}`
          : pi.product
            ? `prod-${pi.product}`
            : pi.ingredientName
              ? `name-${pi.ingredientName}`
              : null
        if (key) {
          const existing = poItemMap[key]
          poItemMap[key] = {
            receivedQty:
              (existing?.receivedQty || 0) + (Number(pi.receivedQuantity) || 0),
            alreadyReturned: 0,
            conversionToBase: existing
              ? existing.conversionToBase
              : Number(pi.conversionToBase) || 1
          }
        }
      })

      existingReturns.forEach((ret) => {
        ;(ret.items || []).forEach((ri) => {
          const key = ri.ingredient
            ? `ing-${ri.ingredient}`
            : ri.product
              ? `prod-${ri.product}`
              : ri.ingredientName
                ? `name-${ri.ingredientName}`
                : null
          if (key && poItemMap[key]) {
            poItemMap[key].alreadyReturned += Number(ri.qty) || 0
          }
        })
      })

      // Validate each return item.
      // Batch 32-A: every item must (a) carry a well-formed integer
      // quantity (PR-04: fractional quantities are rejected, never
      // truncated — purchase returns are integer-only while production
      // stock columns remain integer), and (b) resolve to a PO line of
      // this purchase order (PR-01: unmatched items previously bypassed
      // the guard yet still deducted stock). All checks run before any
      // write; any failure rolls the transaction back with nothing
      // committed.
      const errors = []
      const unmatchedErrors = []
      const qtyErrors = []
      items.forEach((item, index) => {
        const key = item.ingredient
          ? `ing-${item.ingredient}`
          : item.productId
            ? `prod-${item.productId}`
            : item.ingredientName
              ? `name-${item.ingredientName}`
              : null
        const name = item.ingredient
          ? `ingredient #${item.ingredient}`
          : item.productId
            ? `product #${item.productId}`
            : item.ingredientName
              ? `"${item.ingredientName}"`
              : `item #${index + 1}`
        const qtyNum = Number(item.qty)
        if (!Number.isFinite(qtyNum)) {
          qtyErrors.push(`${name}: quantity must be a valid number`)
          return
        }
        if (!Number.isInteger(qtyNum)) {
          qtyErrors.push(
            `${name}: fractional return quantity is currently unsupported (integer only)`
          )
          return
        }
        if (qtyNum <= 0) {
          qtyErrors.push(`${name}: quantity must be greater than zero`)
          return
        }
        if (!key || !poItemMap[key]) {
          unmatchedErrors.push(
            `${name}: item is not part of purchase order ${poId}`
          )
          return
        }
        const info = poItemMap[key]
        const baseQty = qtyNum * (Number(info.conversionToBase) || 1)
        if (!Number.isInteger(baseQty)) {
          qtyErrors.push(
            `${name}: converted base-unit quantity is fractional and currently unsupported`
          )
          return
        }
        const available = info.receivedQty - info.alreadyReturned
        if (qtyNum > available) {
          errors.push(
            `${name}: max ${available} (received ${info.receivedQty}, already returned ${info.alreadyReturned})`
          )
        }
      })

      if (unmatchedErrors.length > 0) {
        await t.rollback()
        return res.status(400).json({
          success: false,
          message: `Return item is not part of the purchase order: ${unmatchedErrors.join('; ')}`
        })
      }

      if (qtyErrors.length > 0) {
        await t.rollback()
        return res.status(422).json({
          success: false,
          message: `Invalid return quantity: ${qtyErrors.join('; ')}`
        })
      }

      if (errors.length > 0) {
        await t.rollback()
        return res.status(400).json({
          success: false,
          message: `Return quantity exceeds available: ${errors.join('; ')}`
        })
      }

      const date = new Date()
      const rand = Math.random().toString(36).substring(2, 6).toUpperCase()
      // returnNumber has a bare (non-store-scoped) global unique
      // constraint, so it must be collision-resistant across every store
      // in the deployment, not just within one store's daily count. The
      // previous format (date + 4-char random, no time-of-day) gave only
      // ~1.68M combinations PER CALENDAR DAY shared by every store —
      // meaningful collision odds at realistic multi-tenant volume. The
      // millisecond-timestamp tail adds ~1M more distinct values on top
      // of that, matching the collision-resistance already proven safe
      // for order.orderNumber and sales_return.returnNumber.
      const returnNumber = `PR-${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}-${Date.now().toString().slice(-6)}${rand}`

      // Upload documentation files to Cloudinary
      let documentation = null
      const files = Array.isArray(req.files) ? req.files : []
      if (files.length > 0) {
        const urls = []
        for (const f of files) {
          try {
            const { url } = await uploadToCloudinaryWithDedup(
              f.path,
              'pos-app/purchase-return'
            )
            if (url) urls.push(url)
          } catch (uploadErr) {
            console.error('Upload failed:', uploadErr.message)
          } finally {
            try { require('fs').unlinkSync(f.path) } catch {}
          }
        }
        if (urls.length > 0) documentation = JSON.stringify(urls)
      }

      const ret = await db.purchase_return.create(
          {
            purchaseOrder: po.id,
            store,
            returnNumber,
            status: 'pending',
            reason: reason || null,
            returnedBy: returnedBy || null,
            documentation,
            createdBy
          },
          { transaction: t }
        )

        const retItems = items.map((item) => ({
          purchaseReturn: ret.id,
          product: item.productId || null,
          ingredient: item.ingredient || null,
          ingredientName: item.ingredientName || null,
          // Batch 32-A (PR-04): quantities passed validation above as
          // mathematically integer — persist the canonical Number form so
          // values like "2.0000" never reach the INTEGER column as text.
          qty: Number(item.qty),
          unit: item.unit || 'pcs',
          notes: item.notes || null
        }))
        await db.purchase_return_item.bulkCreate(retItems, { transaction: t })

        for (const item of items) {
          // Batch 13: item.qty is authored in the PO's purchase unit (it is
          // validated above against receivedQuantity, itself a purchase-
          // unit accumulator) — convert to base stock unit before mutating
          // stock, the same way Goods Receipt converts qtyReceived into
          // qtyStock. Without this, returning e.g. "1 BOX" (conversionToBase
          // 12) only removed 1 unit of base stock instead of the 12 that
          // were actually added when that box was received.
          const itemKey = item.ingredient
            ? `ing-${item.ingredient}`
            : item.productId
              ? `prod-${item.productId}`
              : item.ingredientName
                ? `name-${item.ingredientName}`
                : null
          const returnConversion =
            (itemKey && poItemMap[itemKey]?.conversionToBase) || 1

          if (item.productId) {
            // Batch 32-A (PR-09): locked read + sufficiency gate + exact
            // delta. The previous GREATEST(stock - qty, 0) clamp silently
            // shrank the mutation (and the history delta) when stock was
            // short; sales paths reject on insufficient stock instead, and
            // returns follow that convention — reject cleanly, mutate
            // exactly, keep before/change/after consistent.
            const product = await db.product.findByPk(item.productId, {
              lock: t.LOCK.UPDATE,
              transaction: t
            })
            if (product) {
              const oldStock = Number(product.stock) || 0
              // Validated integer-only above (PR-04), so this is exact.
              const qty = (Number(item.qty) || 0) * returnConversion
              if (oldStock < qty) {
                await t.rollback()
                return res.status(422).json({
                  success: false,
                  message: `Insufficient stock for product #${item.productId}: have ${oldStock}, need ${qty}`
                })
              }
              const newStock = oldStock - qty
              await product.update(
                { stock: db.sequelize.literal(`stock - ${qty}`) },
                { transaction: t }
              )

              // ponytail: atomic upsert + deduct per-store stock. A missing
              // row is seeded at the locked product baseline (not 0),
              // mirroring adjustProductStock: the store holds the goods the
              // base pool accounts for, and product_store_stock carries a
              // non-negative CHECK that a seed-at-0 + deduct would violate.
              if (store) {
                await db.sequelize.query(
                  `INSERT INTO product_store_stock (product, store, stock, "createdAt", "updatedAt")
                   VALUES ($1, $2, $3, NOW(), NOW())
                   ON CONFLICT (product, store) DO NOTHING`,
                  { bind: [item.productId, store, oldStock], transaction: t }
                )
                const storeRow = await db.product_store_stock.findOne({
                  where: { product: item.productId, store },
                  lock: t.LOCK.UPDATE,
                  transaction: t
                })
                const storeStock = Number(storeRow?.stock) || 0
                if (storeStock < qty) {
                  await t.rollback()
                  return res.status(422).json({
                    success: false,
                    message: `Insufficient store stock for product #${item.productId}: have ${storeStock}, need ${qty}`
                  })
                }
                await db.product_store_stock.update(
                  {
                    stock: db.sequelize.literal(`stock - ${qty}`)
                  },
                  { where: { product: item.productId, store }, transaction: t }
                )
              }

              await db.stock_history.create(
                {
                  product: item.productId,
                  store,
                  referenceType: 'purchase_return',
                  referenceId: ret.id,
                  quantityBefore: oldStock,
                  quantityChange: -qty,
                  quantityAfter: newStock,
                  unit: item.unit || 'pcs',
                  createdBy
                },
                { transaction: t }
              )
            }
          }
          if (item.ingredient || (!item.productId && item.ingredientName)) {
            const ingredient = item.ingredient
              ? await db.ingredient.findByPk(item.ingredient, {
                  lock: t.LOCK.UPDATE,
                  transaction: t
                })
              : await db.ingredient.findOne({
                  where: { name: item.ingredientName, store },
                  lock: t.LOCK.UPDATE,
                  transaction: t
                })
            if (ingredient) {
              const oldStock = Number(ingredient.stock) || 0
              const qty = (Number(item.qty) || 0) * returnConversion
              if (oldStock < qty) {
                await t.rollback()
                return res.status(422).json({
                  success: false,
                  message: `Insufficient stock for ingredient "${ingredient.name}": have ${oldStock}, need ${qty}`
                })
              }
              const newStock = oldStock - qty
              await ingredient.update(
                { stock: db.sequelize.literal(`stock - ${qty}`) },
                { transaction: t }
              )
              await db.stock_history.create(
                {
                  ingredient: ingredient.id,
                  ingredientName: ingredient.name,
                  store,
                  referenceType: 'purchase_return',
                  referenceId: ret.id,
                  quantityBefore: oldStock,
                  quantityChange: -qty,
                  quantityAfter: newStock,
                  unit: item.unit || ingredient.unit || 'pcs',
                  createdBy
                },
                { transaction: t }
              )
            }
          }
        }

        await t.commit()

        await createAudit(
          req,
          'create',
          'purchase_return',
          ret.id,
          'Created purchase return: ' + ret.id
        )

        return res.status(201).json({
          success: true,
          message: 'Purchase return created',
          data: ret
        })
      } catch (err) {
        await t.rollback()
        throw err
      }
    } catch (error) {
      console.error(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  }
}

module.exports = purchaseReturnController
