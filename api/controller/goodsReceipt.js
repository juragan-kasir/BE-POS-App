const db = require('../../db/models')
const { Op } = require('sequelize')
const { createAudit } = require('../../utils/auditLog')
const { enrichAuditFields } = require('../../utils/auditFields')
const { resolveStoreId } = require('../../utils/tenantScope')
const {
  uploadToCloudinaryWithDedup
} = require('../../utils/cloudinaryStorage')
const batchService = require('../service/batchService')
const { adjustProductStock } = require('../service/stockMutationService')
const {
  ingredientBaseUnitCost,
  ingredientPurchaseUnitCost
} = require('../service/itemCostService')
const {
  enqueueAccountingJob,
  attemptJob,
  recordImmediateAttempt
} = require('../service/accountingOutboxService')
const {
  calculatePurchaseOrderFulfillmentStatus
} = require('../service/purchaseOrderFulfillmentService')
const { assertQuantityForUnit } = require('../../utils/unit')

const generateReceiptNo = () => {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const timestamp = Date.now()
  // Random suffix: a bare millisecond timestamp has no collision
  // resistance under concurrent creates (two receipts in the same
  // millisecond hit a unique-constraint 500 instead of the idempotency
  // replay). Same pattern as order.orderNumber / transferNumber.
  const random = Math.random().toString(36).substring(2, 6).toUpperCase()
  return `GR-${year}${month}${day}-${timestamp}-${random}`
}

// F-IDEM-1: a same-key retry must carry the same intent. Canonical
// identity per line is item identity (product, else ingredient id/name)
// plus received quantity — purchaseOrderItem linkage is server-resolved,
// prices are server-derived, and batch/notes are secondary metadata, so
// none of them participate (mirrors the order idempotency contract).
const GR_IDEMPOTENCY_MISMATCH_MESSAGE =
  'idempotencyKey already used with a different payload'
const canonicalGrItemKey = (item) => {
  const qty = Number(item.qtyReceived)
  if (item.product) return `p:${item.product}:${qty}`
  const ing =
    item.ingredient ??
    item.ingredientName ??
    item.poItemData?.ingredient ??
    item.poItemData?.ingredientName
  return `ing:${ing}:${qty}`
}
const grItemsMatchPayload = (storedItems, incomingItems) => {
  if (!Array.isArray(storedItems) || !Array.isArray(incomingItems)) return false
  if (storedItems.length !== incomingItems.length) return false
  const a = storedItems.map(canonicalGrItemKey).sort()
  const b = incomingItems.map(canonicalGrItemKey).sort()
  return a.every((key, i) => key === b[i])
}

// ponytail: multiple documentation photos -> Cloudinary, persisted as JSON array of URLs
// edit mode: req.body.documentation may carry kept old URLs (JSON array string) to merge
const uploadDocumentation = async (req) => {
  const files = []
  if (Array.isArray(req.files) && req.files.length > 0) files.push(...req.files)
  else if (req.file) files.push(req.file)

  let keptUrls = []
  const bodyDoc = req.body?.documentation
  if (Array.isArray(bodyDoc)) {
    keptUrls = bodyDoc.filter(Boolean)
  } else if (typeof bodyDoc === 'string' && bodyDoc.trim().startsWith('[')) {
    try {
      const arr = JSON.parse(bodyDoc)
      if (Array.isArray(arr)) keptUrls = arr.filter(Boolean)
    } catch {
      // not a JSON array -> treat as single legacy URL
      if (!files.length && bodyDoc.trim()) return bodyDoc
    }
  }

  if (files.length === 0 && keptUrls.length === 0) {
    // explicit clear / legacy single URL / field absent semantics
    if (bodyDoc === null) return null
    if (typeof bodyDoc === 'string') return bodyDoc || null
    return undefined
  }

  const urls = [...keptUrls]
  for (const f of files) {
    try {
      const { url } = await uploadToCloudinaryWithDedup(
        f.path,
        'pos-app-goods-receipts'
      )
      urls.push(url)
    } catch (cloudErr) {
      console.error(
        'Documentation upload skipped (Cloudinary not configured):',
        cloudErr.message
      )
    }
  }
  return urls.length > 0 ? JSON.stringify(urls) : null
}

// ponytail: allocate GR shipping cost proportionally across received lines
const getShippingShare = (shippingCost, poItemPrice, totalPOValue) => {
  const shipping = Number(shippingCost) || 0
  if (
    shipping <= 0 ||
    totalPOValue <= 0 ||
    !poItemPrice ||
    Number(poItemPrice) <= 0
  )
    return 0
  return Math.round((shipping * Number(poItemPrice)) / totalPOValue)
}

const picInclude = {
  model: db.user,
  as: 'picData',
  attributes: ['id', 'fullName', 'userName']
}

// F21 Batch 3: purchase_order_item already carries a real `ingredient` FK
// (validated at PO creation) — this resolves an item's ingredient identity
// from that FK whenever it's reachable in whichever object shape the four
// call sites below hand it (the raw create-flow item + its separately
// resolved `poItem`, or a goods_receipt_item loaded with its nested
// poItemData/poItemData.ingredientData association), instead of the
// previous Op.iLike name match, which breaks silently on an ingredient
// rename and can resolve non-deterministically when two ingredients in the
// same store share a name. Name matching is kept ONLY as the fallback for
// a GR line that was never linked to a PO item at all (free-text/manual
// receiving) — unchanged legacy behavior for that case.
//
// When an authoritative id IS present but does not resolve to a real
// ingredient row for this store (deleted, or a forged/mismatched store),
// this throws instead of silently skipping the stock/cost/ledger update —
// every call site already wraps its transaction in try/rollback/re-throw,
// so the whole receipt fails atomically rather than completing with a
// quietly-missed mutation.
const resolveIngredientForItem = async ({ item, poItem, store, transaction }) => {
  const authoritativeId =
    Number(item?.ingredient) ||
    Number(poItem?.ingredient) ||
    Number(item?.poItemData?.ingredient) ||
    Number(item?.poItemData?.ingredientData?.id) ||
    null

  if (authoritativeId) {
    const ingredient = await db.ingredient.findOne({
      where: { id: authoritativeId, store },
      transaction
    })
    if (!ingredient) {
      throw new Error(
        `Goods receipt references ingredient #${authoritativeId}, which was not found for this store (deleted, or store mismatch)`
      )
    }
    return ingredient
  }

  const ingName =
    item?.ingredientName ||
    item?.poItemData?.ingredientName ||
    item?.poItemData?.ingredientData?.name
  if (!ingName) return null

  return db.ingredient.findOne({
    where: { name: { [Op.iLike]: ingName.trim() }, store },
    transaction
  })
}

// ponytail: weighted-average HPP update when GR costPrice differs from PO price
// T-08 preserve DECIMAL qty/cost (no parseInt truncation)
const applyCostPrice = async ({ item, qty, store, transaction }) => {
  const costPrice = Number(item.costPrice) || 0
  const conversion = Number(item.conversionToBase) || 1
  const qtyStock = qty * conversion
  // HPP is per PO unit; convert to per base-stock-unit before averaging
  const baseUnitCost = conversion > 0 ? costPrice / conversion : 0
  if (baseUnitCost <= 0 || qtyStock <= 0) return

  if (item.product) {
    const product = await db.product.findByPk(item.product, { transaction })
    if (product) {
      // Batch 7: this read runs AFTER this same transaction's own atomic
      // `stock + qtyStock` increment for this item already committed
      // (read-your-own-writes) — product.stock here already includes this
      // receipt's own incoming quantity. Subtracting qtyStock back out
      // recovers the true pre-receipt stock the weighted average needs,
      // without moving this read earlier (which would drop the implicit
      // row-lock serialization Batch 6 proved concurrent receipts rely on).
      const oldStock = (Number(product.stock) || 0) - qtyStock
      const oldCost = Number(product.costPrice) || 0
      const newCost = Math.round(
        (oldStock * oldCost + qtyStock * baseUnitCost) / (oldStock + qtyStock)
      )
      await product.update({ costPrice: newCost }, { transaction })
    }
  }

  {
    // No separate `poItem` here — item.ingredient (create flow) or
    // item.poItemData.ingredient/.ingredientData (applyStock flow) already
    // covers both callers via resolveIngredientForItem's own priority chain.
    const ingredient = await resolveIngredientForItem({
      item,
      poItem: null,
      store,
      transaction
    })
    if (ingredient) {
      // Same read-your-own-writes correction as the product branch above —
      // ingredient.stock here already includes this receipt's own qtyStock.
      // ingredient.stock is in base units but ingredient.costPrice is the
      // price of one PURCHASE unit (itemCostService): average per base unit,
      // then store the result back per purchase unit. Averaging the stored
      // per-purchase-unit price against a per-base-unit receipt cost mixed
      // the two (Rp25.000/kg with Rp26/g) whenever conversionFactor ≠ 1.
      // A negative pre-receipt stock carries no cost to average against.
      const oldStock = Math.max(0, (Number(ingredient.stock) || 0) - qtyStock)
      const oldBaseCost = ingredientBaseUnitCost(ingredient)
      const newBaseCost =
        (oldStock * oldBaseCost + qtyStock * baseUnitCost) / (oldStock + qtyStock)
      await ingredient.update(
        { costPrice: ingredientPurchaseUnitCost(newBaseCost, ingredient) },
        { transaction }
      )
    }
  }
}

const reverseStock = async (items, store, transaction, userId) => {
  // F-STOCK-1: lock every distinct ingredient row once, sorted by id,
  // BEFORE any mutation below. The ingredient reversal writes an absolute
  // value computed from the read stock — without holding the row lock
  // across read+write, a concurrent writer (sale, another receipt) landing
  // in between is silently overwritten (lost update). Sorted order matches
  // the global lock-order convention (adjustIngredientStockBatch, etc.).
  const resolved = []
  for (const grItem of items) {
    const qty = Number(grItem.qtyReceived) || 0
    if (!Number.isFinite(qty) || qty <= 0) continue
    const qtyStock =
      Number(grItem.qtyStock) > 0
        ? Number(grItem.qtyStock)
        : qty * (Number(grItem.conversionToBase) || 1)
    const ingredient = await resolveIngredientForItem({
      item: grItem,
      poItem: null,
      store: store || null,
      transaction
    })
    resolved.push({ grItem, qty, qtyStock, ingredientId: ingredient?.id || null })
  }
  const ingredientIds = [
    ...new Set(resolved.map((r) => r.ingredientId).filter(Boolean))
  ].sort((a, b) => a - b)
  const lockedIngredients = ingredientIds.length
    ? await db.ingredient.findAll({
        where: { id: ingredientIds },
        order: [['id', 'ASC']],
        lock: transaction.LOCK.UPDATE,
        transaction
      })
    : []
  const lockedById = new Map(lockedIngredients.map((ing) => [ing.id, ing]))

  for (const { grItem, qty, qtyStock, ingredientId } of resolved) {
    if (grItem.purchaseOrderItem) {
      await db.purchase_order_item.update(
        {
          receivedQuantity: db.sequelize.literal(
            `GREATEST("receivedQuantity" - ${qty}, 0)`
          )
        },
        { where: { id: grItem.purchaseOrderItem }, transaction }
      )
    }

    if (grItem.product) {
      // Locked, atomic delta via the shared helper — previously this
      // computed the new value in JS from an unlocked read
      // (product.stock: Math.max(qtyBefore - qtyStock, 0)) and wrote it
      // as an absolute value, a lost-update race under any concurrent
      // writer to the same product (e.g. a sale finishing at the same
      // moment this reversal commits).
      await adjustProductStock({
        productId: grItem.product,
        store: store || null,
        deltaQty: -qtyStock,
        referenceType: 'adjustment',
        notes: `GR reversal: ${grItem.id || 'update'}`,
        createdBy: userId || null,
        transaction
      })
    }

    {
      const ingredient = ingredientId ? lockedById.get(ingredientId) : null
      if (ingredient) {
        // Locked read above: qtyBefore is current as of this transaction's
        // lock, so the absolute write below cannot clobber a concurrent
        // mutation (same clamp semantics as before, now race-safe).
        const qtyBefore = Number(ingredient.stock) || 0
        await ingredient.update(
          { stock: Math.max(qtyBefore - qtyStock, 0) },
          { transaction }
        )
        await db.stock_history.create(
          {
            ingredient: ingredient.id,
            ingredientName: ingredient.name,
            store: store || null,
            referenceType: 'adjustment',
            quantityBefore: qtyBefore,
            quantityChange: -qtyStock,
            quantityAfter: Math.max(qtyBefore - qtyStock, 0),
            unit: ingredient.unit || grItem.unit || 'pcs',
            notes: `GR reversal: ${grItem.id || 'update'}`,
            createdBy: userId || null
          },
          { transaction }
        )
      }
    }
  }
}

// B1: retire the product batches a Goods Receipt created when its stock
// effect is reversed, so FIFO and expiry write-off can never consume phantom
// quantities. Association is deterministic, never heuristic:
// - create() codes every product line batch as `item.batchNumber` when the
//   client supplies one, else `${receiptNumber}-${index + 1}`. The
//   receiptNumber prefix therefore identifies this receipt's auto-coded
//   batches; an explicit lot code must additionally match the reversed
//   item's expected batch quantity (mirroring addBatchStock's floor) and is
//   consumed oldest-first, one row per reversed item — a foreign batch can
//   only collide on an identical (product, store, code, received qty)
//   tuple, the documented residual.
// - Only `active` rows are eligible; already-consumed/expired/reversed rows
//   are never touched, and a second reversal of the same receipt is a
//   no-op (the lifecycle draft guards reject it first).
// - `qty`/`received_quantity` are left intact as the audit trail (same as
//   FIFO-consumed batches); `batch_stock.quantity` is zeroed and status
//   leaves `active`, which is exactly what FIFO, expiry, and valuation
//   filter on.
const voidReceiptBatches = async ({ receiptNumber, items, store, transaction }) => {
  const expectations = []
  for (const grItem of items || []) {
    if (!grItem.product) continue
    const qty = Number(grItem.qtyReceived) || 0
    if (!Number.isFinite(qty) || qty <= 0) continue
    const qtyStock =
      Number(grItem.qtyStock) > 0
        ? Number(grItem.qtyStock)
        : qty * (Number(grItem.conversionToBase) || 1)
    // Mirrors addBatchStock: fractional lines create no batch row.
    const expected = Math.floor(qtyStock) || 0
    if (expected <= 0) continue
    expectations.push({
      product: grItem.product,
      batchNumber: grItem.batchNumber || null,
      expected
    })
  }
  if (expectations.length === 0) return

  const productIds = [...new Set(expectations.map((e) => e.product))].sort((a, b) => a - b)
  const lockedBatches = await db.product_batch.findAll({
    where: { product: { [Op.in]: productIds }, store: store || null, status: 'active' },
    order: [['id', 'ASC']],
    lock: transaction.LOCK.UPDATE,
    transaction
  })

  const prefix = `${receiptNumber}-`
  const consumed = new Set()
  for (const exp of expectations) {
    const row = lockedBatches.find(
      (b) =>
        !consumed.has(b.id) &&
        Number(b.product) === Number(exp.product) &&
        (b.batchCode === exp.batchNumber ||
          (typeof b.batchCode === 'string' && b.batchCode.startsWith(prefix))) &&
        Number(b.received_quantity) === exp.expected
    )
    if (!row) continue
    consumed.add(row.id)
    await db.product_batch_stock.update(
      { quantity: 0 },
      { where: { batch: row.id }, transaction }
    )
    await row.update({ status: 'reversed' }, { transaction })
  }
}

const applyStock = async (items, receipt, transaction, userId) => {
  for (const item of items) {
    const qty = Number(item.qtyReceived) || 0
    if (!Number.isFinite(qty) || qty <= 0) continue

    const conversion =
      Number(item.conversionToBase) ||
      Number(item.poItemData?.conversionToBase) ||
      1
    const qtyStock = qty * conversion

    if (item.purchaseOrderItem) {
      await db.purchase_order_item.update(
        {
          receivedQuantity: db.sequelize.literal(`"receivedQuantity" + ${qty}`)
        },
        {
          where: {
            id: item.purchaseOrderItem,
            purchaseOrder: receipt.purchaseOrderId
          },
          transaction
        }
      )
    }

    if (item.product) {
      const product = await db.product.findByPk(item.product, { transaction })
      if (product) {
        const qtyBefore = Number(product.stock) || 0
        await product.update(
          { stock: db.sequelize.literal(`stock + ${qtyStock}`) },
          { transaction }
        )

        // ponytail: atomic upsert + add per-store stock
        if (receipt.store) {
          await db.sequelize.query(
            `INSERT INTO product_store_stock (product, store, stock, "createdAt", "updatedAt")
               VALUES ($1, $2, 0, NOW(), NOW())
               ON CONFLICT (product, store) DO NOTHING`,
            { bind: [item.product, receipt.store], transaction }
          )
          await db.product_store_stock.update(
            { stock: db.sequelize.literal(`stock + ${qtyStock}`) },
            {
              where: { product: item.product, store: receipt.store },
              transaction
            }
          )
        }

        await db.stock_history.create(
          {
            product: item.product,
            store: receipt.store,
            referenceType: 'purchase',
            quantityBefore: qtyBefore,
            quantityChange: qtyStock,
            quantityAfter: qtyBefore + qtyStock,
            unit: product.unit || item.unit || 'pcs',
            notes: `GR: ${receipt.receiptNumber} (PO: ${receipt.purchaseOrderId})`,
            createdBy: userId || null
          },
          { transaction }
        )
      }
    }

    {
      const ingredient = await resolveIngredientForItem({
        item,
        poItem: null,
        store: receipt.store,
        transaction
      })
      if (ingredient) {
        const qtyBefore = Number(ingredient.stock) || 0
        await ingredient.update(
          { stock: db.sequelize.literal(`stock + ${qtyStock}`) },
          { transaction }
        )
        await db.stock_history.create(
          {
            ingredient: ingredient.id,
            ingredientName: ingredient.name,
            store: receipt.store,
            referenceType: 'purchase',
            quantityBefore: qtyBefore,
            quantityChange: qtyStock,
            quantityAfter: qtyBefore + qtyStock,
            unit: ingredient.unit || item.unit || 'pcs',
            notes: `GR: ${receipt.receiptNumber} (PO: ${receipt.purchaseOrderId})`,
            createdBy: userId || null
          },
          { transaction }
        )
      }
    }

    await applyCostPrice({
      item,
      qty,
      store: receipt.store,
      transaction
    })
  }
}

const goodsReceiptController = {
  async getAll(req, res) {
    try {
      const store = resolveStoreId(req)
      const userRole = req.user?.roleType
      const {
        page = 1,
        limit = 10,
        status,
        poId,
        startDate,
        endDate,
        store: queryStore,
        search
      } = req.query

      const where = {}
      if (queryStore && userRole === 'super_admin') where.store = queryStore
      else if (store && userRole !== 'super_admin') where.store = store
      if (status) where.status = status
      if (poId) where.purchaseOrderId = poId
      if (search) {
        where[Op.or] = [
          { receiptNumber: { [Op.iLike]: `%${search}%` } },
          { notes: { [Op.iLike]: `%${search}%` } },
          { '$purchaseOrderData.orderNumber$': { [Op.iLike]: `%${search}%` } }
        ]
      }
      if (startDate || endDate) {
        where.receivedDate = {}
        if (startDate) where.receivedDate[Op.gte] = new Date(startDate)
        if (endDate) where.receivedDate[Op.lte] = new Date(endDate)
      }

      const offset = (parseInt(page) - 1) * parseInt(limit)

      const { count, rows } = await db.goodsReceipt.findAndCountAll({
        where,
        distinct: true,
        include: [
          {
            model: db.purchase_order,
            as: 'purchaseOrderData',
            attributes: ['id', 'orderNumber', 'status']
          },
          { model: db.location, as: 'storeData', attributes: ['id', 'name'] },
          picInclude,
          { model: db.goodsReceiptItem, as: 'items' }
        ],
        order: [['updatedAt', 'DESC']],
        limit: parseInt(limit),
        offset
      })

      await enrichAuditFields(db, rows)

      const stats = {
        total: count,
        draft: await db.goodsReceipt.count({
          where: { ...where, status: 'draft' }
        }),
        completed: await db.goodsReceipt.count({
          where: { ...where, status: 'completed' }
        }),
        cancelled: await db.goodsReceipt.count({
          where: { ...where, status: 'cancelled' }
        })
      }

      return res.status(200).json({
        success: true,
        message: 'Success',
        data: rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count,
          totalPages: Math.ceil(count / parseInt(limit))
        },
        stats
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
      const store = resolveStoreId(req)
      const userRole = req.user?.roleType

      const where = { id }
      if (store && userRole !== 'super_admin') where.store = store

      const receipt = await db.goodsReceipt.findOne({
        where,
        include: [
          {
            model: db.purchase_order,
            as: 'purchaseOrderData',
            attributes: ['id', 'orderNumber', 'status']
          },
          { model: db.location, as: 'storeData', attributes: ['id', 'name'] },
          picInclude,
          {
            model: db.goodsReceiptItem,
            as: 'items',
            include: [
              {
                model: db.product,
                as: 'productData',
                attributes: ['id', 'nameProduct']
              }
            ]
          }
        ]
      })

      if (!receipt) {
        return res
          .status(404)
          .json({ success: false, message: 'Goods receipt not found' })
      }

      let poItems = []
      if (receipt.purchaseOrderId) {
        poItems = await db.purchase_order_item.findAll({
          where: { purchaseOrder: receipt.purchaseOrderId }
        })
      }

      return res.status(200).json({
        success: true,
        message: 'Success',
        data: {
          ...receipt.toJSON(),
          purchaseOrderItems: poItems
        }
      })
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
      const store = resolveStoreId(req)
      const userRole = req.user?.roleType

      const where = { purchaseOrderId: poId }
      if (store && userRole !== 'super_admin') where.store = store

      const receipts = await db.goodsReceipt.findAll({
        where,
        include: [
          { model: db.goodsReceiptItem, as: 'items' },
          { model: db.location, as: 'storeData', attributes: ['id', 'name'] }
        ],
        order: [['createdAt', 'DESC']]
      })

      return res.status(200).json({
        success: true,
        message: 'Success',
        data: receipts
      })
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async create(req, res) {
    try {
      const store = resolveStoreId(req)
      const {
        purchaseOrderId,
        items,
        receivedDate,
        notes,
        pic,
        suratJalan,
        taxInvoiceNo,
        shippingCost
      } = req.body

      if (!purchaseOrderId || !items || items.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Purchase order and items are required'
        })
      }

      // ponytail: documentation photos -> Cloudinary (JSON array)
      let documentation = req.body.documentation || null
      const uploadedDocs = await uploadDocumentation(req)
      if (uploadedDocs !== undefined) documentation = uploadedDocs

      // ponytail: reject duplicate ingredients/products in same GR
      const keys = items
        .map((i) =>
          i.ingredient
            ? `ing-${i.ingredient}`
            : i.product
              ? `prod-${i.product}`
              : null
        )
        .filter(Boolean)
      const dupes = keys.filter((k, i) => keys.indexOf(k) !== i)
      if (dupes.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Duplicate item(s) in goods receipt: ${[...new Set(dupes)].join(', ')}`
        })
      }

      const { idempotencyKey } = req.body
      // T-10 idempotency: same key returns same GR without duplicating stock/journal
      if (idempotencyKey) {
        const existing = await db.goodsReceipt.findOne({
          where: { purchaseOrderId, idempotencyKey },
          include: [{ model: db.goodsReceiptItem, as: 'items' }]
        })
        if (existing) {
          if (!grItemsMatchPayload(existing.items, items)) {
            return res.status(409).json({
              success: false,
              message: GR_IDEMPOTENCY_MISMATCH_MESSAGE
            })
          }
          return res.status(200).json({
            success: true,
            message: 'Goods receipt already exists for this idempotency key',
            data: existing
          })
        }
      }

      const poWhere = { id: purchaseOrderId }
      if (store) poWhere.store = store

      const po = await db.purchase_order.findOne({
        where: poWhere
      })

      if (!po) {
        return res
          .status(404)
          .json({ success: false, message: 'Purchase order not found' })
      }

      if (po.status === 'cancelled') {
        return res
          .status(400)
          .json({ success: false, message: 'Cannot receive cancelled order' })
      }

      // ponytail: credit control - block GR until DP is fully paid
      if (po.paymentMethod === 'credit') {
        const dpAmount =
          (Number(po.dpPercent || 0) / 100) * Number(po.finalAmount || 0)
        const paidToPO =
          (await db.purchase_payment.sum('amount', {
            where: { purchaseOrder: purchaseOrderId, deletedAt: null }
          })) || 0
        if (paidToPO < dpAmount) {
          return res.status(400).json({
            success: false,
            message: `DP belum lunas. DP: Rp ${dpAmount.toLocaleString('id-ID')}, Dibayar: Rp ${paidToPO.toLocaleString('id-ID')}`
          })
        }
      }

      const receiptNumber = generateReceiptNo()
      const effectiveStore = store || po.store

      const transaction = await db.sequelize.transaction()

      try {
        // P1-5: drafts post nothing. The stock effect (PO received
        // quantities, product/ingredient stock, batches) applies exactly
        // once, on the draft -> completed transition. Receipts created
        // already-completed keep posting at create.
        const postNow = (req.body.status || 'completed') !== 'draft'
        const receipt = await db.goodsReceipt.create(
          {
            store: effectiveStore,
            receiptNumber,
            purchaseOrderId,
            receivedDate: receivedDate || new Date(),
            status: req.body.status || 'completed',
            stockPosted: postNow,
            notes,
            pic: pic || null,
            documentation,
            suratJalan: suratJalan || null,
            taxInvoiceNo: taxInvoiceNo || null,
            shippingCost: Number(shippingCost) || 0,
            idempotencyKey: idempotencyKey || null,
            createdBy: req.user?.id || null
          },
          { transaction }
        )

        const receiptItems = []
        const additionalCost = Number(po.additionalCost) || 0
        const tolerance = Number.isFinite(Number(po.overDeliveryTolerance))
          ? Number(po.overDeliveryTolerance)
          : 10
        // F22-B10-05: this read feeds the over-delivery validation below
        // (`remaining = maxDeliverable - alreadyReceived`). Without a lock,
        // two concurrent receipts against the same PO item can both read
        // the same pre-commit receivedQuantity, both individually pass the
        // check, and jointly exceed the PO item's allowed quantity — the
        // increment itself is atomic (a SQL literal expression), but the
        // validation gate it's checked against was stale. Locking these
        // rows serializes concurrent receipts against the same PO: the
        // second transaction's read blocks until the first commits, then
        // sees the now-current receivedQuantity. Same lock idiom already
        // used elsewhere (purchaseOrder.js, batchService.js,
        // stockMutationService.js, promoUsageService.js, loyaltyService.js).
        const allPoItems = await db.purchase_order_item.findAll({
          where: { purchaseOrder: purchaseOrderId },
          lock: transaction.LOCK.UPDATE,
          transaction
        })
        const totalPOValue = allPoItems.reduce(
          (sum, pi) => sum + Number(pi.quantity) * Number(pi.price),
          0
        )

        // Build lookup maps from the PO items already fetched above, and
        // bulk-fetch every distinct product referenced by this receipt's
        // lines — replaces up to 2 findOne/findByPk calls per line with
        // in-memory lookups against data already loaded in this transaction.
        const poItemById = new Map(allPoItems.map((pi) => [pi.id, pi]))
        const poItemByIngredient = new Map(
          allPoItems.filter((pi) => pi.ingredient).map((pi) => [pi.ingredient, pi])
        )
        const poItemByIngredientName = new Map(
          allPoItems
            .filter((pi) => pi.ingredientName)
            .map((pi) => [pi.ingredientName, pi])
        )
        const receiptProductIds = [
          ...new Set(items.map((it) => it.product).filter(Boolean))
        ]
        const receiptProducts = receiptProductIds.length
          ? await db.product.findAll({
              where: { id: receiptProductIds },
              transaction
            })
          : []
        const productById = new Map(receiptProducts.map((p) => [p.id, p]))

        for (const [index, item] of items.entries()) {
          const qtyRaw = Number(item.qtyReceived) || 0
          if (!Number.isFinite(qtyRaw) || qtyRaw <= 0) continue

          // Over-receive validation
          let poItem = null
          if (item.purchaseOrderItem) {
            poItem = poItemById.get(Number(item.purchaseOrderItem)) || null
          } else if (item.ingredient && purchaseOrderId) {
            poItem = poItemByIngredient.get(item.ingredient) || null
          } else if (item.ingredientName && purchaseOrderId) {
            poItem = poItemByIngredientName.get(item.ingredientName) || null
          }

          // Unit-aware fractional validation (T-30) after poItem known
          const unitForQty = item.unit || poItem?.unit || poItem?.ingredientData?.unit || 'pcs'
          try {
            assertQuantityForUnit(qtyRaw, unitForQty)
          } catch (e) {
            await transaction.rollback()
            return res.status(400).json({ success: false, message: e.message })
          }
          const qty = qtyRaw

          if (poItem) {
            const ordered = Number(poItem.quantity)
            const alreadyReceived = Number(poItem.receivedQuantity) || 0
            const toleranceQty = Math.ceil((ordered * tolerance) / 100)
            const maxDeliverable = ordered + toleranceQty
            const remaining = maxDeliverable - alreadyReceived
            if (qty > remaining) {
              await transaction.rollback()
              return res.status(400).json({
                success: false,
                message: `Over-receiving not allowed for ${item.ingredientName || poItem.ingredientName || 'item'}: max ${remaining} remaining (ordered ${ordered}, tolerance ${tolerance}% = +${toleranceQty}, already received ${alreadyReceived})`
              })
            }
          }

          const conversion =
            Number(item.conversionToBase) ||
            Number(poItem?.conversionToBase) ||
            1
          const baseCost =
            Number(item.costPrice) || (poItem ? Number(poItem.price) || 0 : 0)
          const landed =
            additionalCost > 0 && totalPOValue > 0 && poItem
              ? Math.round(
                  (additionalCost * (Number(poItem.price) || 0)) / totalPOValue
                )
              : 0
          const shippingShare = getShippingShare(
            shippingCost,
            poItem?.price,
            totalPOValue
          )
          const costPrice = baseCost + landed + shippingShare
          const qtyStock = qty * conversion

          receiptItems.push({
            goodsReceipt: receipt.id,
            purchaseOrderItem: item.purchaseOrderItem || poItem?.id || null,
            product: item.product || null,
            qtyReceived: qty,
            unit: item.unit || 'pcs',
            conditionNotes: item.conditionNotes || null,
            ingredientName: item.ingredientName || null,
            batchNumber: item.batchNumber || null,
            expiryDate: item.expiryDate || null,
            costPrice,
            landedCost: landed,
            conversionToBase: conversion,
            qtyStock
          })

          if (poItem && postNow) {
            await poItem.update(
              {
                receivedQuantity: db.sequelize.literal(
                  `"receivedQuantity" + ${qty}`
                )
              },
              { transaction }
            )
          }

          if (item.product && postNow) {
            const product = productById.get(item.product)
            if (product) {
              const qtyBefore = Number(product.stock) || 0
              await product.update(
                { stock: db.sequelize.literal(`stock + ${qtyStock}`) },
                { transaction }
              )

              // ponytail: atomic upsert + add per-store stock
              if (effectiveStore) {
                await db.sequelize.query(
                  `INSERT INTO product_store_stock (product, store, stock, "createdAt", "updatedAt")
                   VALUES ($1, $2, 0, NOW(), NOW())
                   ON CONFLICT (product, store) DO NOTHING`,
                  { bind: [item.product, effectiveStore], transaction }
                )
                await db.product_store_stock.update(
                  { stock: db.sequelize.literal(`stock + ${qtyStock}`) },
                  {
                    where: { product: item.product, store: effectiveStore },
                    transaction
                  }
                )
              }

              await db.stock_history.create(
                {
                  product: item.product,
                  store: effectiveStore,
                  referenceType: 'purchase',
                  quantityBefore: qtyBefore,
                  quantityChange: qtyStock,
                  quantityAfter: qtyBefore + qtyStock,
                  unit: product.unit || item.unit || 'pcs',
                  notes: `GR: ${receiptNumber} (PO: ${po.orderNumber})`,
                  createdBy: req.user?.id || null
                },
                { transaction }
              )

              // ponytail: FIFO - create batch + per-store batch stock per GR line
              const baseUnitCost = conversion > 0 ? costPrice / conversion : 0
              await batchService.addBatchStock({
                productId: item.product,
                store: effectiveStore,
                qty: qtyStock,
                costPerUnit: baseUnitCost,
                batchCode:
                  item.batchNumber || `${receiptNumber}-${index + 1}`,
                expiryDate: item.expiryDate || null,
                supplier: po.supplier || null,
                receivedDate: receivedDate || new Date(),
                transaction
              })
            }
          }

          {
            // `poItem` (resolved above via purchaseOrderItem id / ingredient
            // FK / ingredientName, in that priority order) is passed
            // explicitly here — it's the one call site where the PO item
            // was already resolved into a separate local variable rather
            // than nested inside `item` itself.
            const ingredient = postNow
              ? await resolveIngredientForItem({
                  item,
                  poItem,
                  store: effectiveStore,
                  transaction
                })
              : null

            if (ingredient) {
              const qtyBefore = Number(ingredient.stock) || 0
              await ingredient.update(
                { stock: db.sequelize.literal(`stock + ${qtyStock}`) },
                { transaction }
              )

              await db.stock_history.create(
                {
                  ingredient: ingredient.id,
                  ingredientName: ingredient.name,
                  store: effectiveStore,
                  referenceType: 'purchase',
                  quantityBefore: qtyBefore,
                  quantityChange: qtyStock,
                  quantityAfter: qtyBefore + qtyStock,
                  unit: ingredient.unit || item.unit || 'pcs',
                  notes: `GR: ${receiptNumber} (PO: ${po.orderNumber})`,
                  createdBy: req.user?.id || null
                },
                { transaction }
              )
            }
          }

          if (postNow) {
            await applyCostPrice({
              item: { ...item, costPrice, conversionToBase: conversion },
              qty,
              store: effectiveStore,
              transaction
            })
          }
        }

        if (receiptItems.length > 0) {
          await db.goodsReceiptItem.bulkCreate(receiptItems, { transaction })
        }

        // F22-B10-02: fulfillment is return-aware — approved Purchase
        // Returns reduce net fulfillment without ever decrementing
        // receivedQuantity itself. See purchaseOrderFulfillmentService.js.
        const fulfillmentStatus = await calculatePurchaseOrderFulfillmentStatus({
          purchaseOrderId,
          transaction
        })
        if (fulfillmentStatus === 'received') {
          await po.update(
            { receivedDate: receivedDate || new Date() },
            { transaction }
          )
        }

        // Durable inside the same transaction as the receipt/stock rows
        // above — a posting failure below is retried, not silently
        // discarded (same pattern as purchasePayment.js).
        let journalJob = null
        if ((req.body.status || 'completed') === 'completed') {
          journalJob = await enqueueAccountingJob({
            jobType: 'purchase_journal',
            store: effectiveStore,
            referenceType: 'goods_receipt',
            referenceId: receipt.id,
            payload: {
              store: effectiveStore,
              receiptId: receipt.id,
              receiptNumber,
              poNumber: po.orderNumber,
              totalAmount: po.totalAmount,
              discount: po.discount,
              taxAmount: po.taxAmount,
              items: receiptItems.map((i) => ({
                costPrice: i.costPrice,
                qtyReceived: i.qtyReceived
              })),
              date: new Date(receivedDate || Date.now()).toISOString(),
              createdBy: req.user?.id
            },
            transaction
          })
        }

        await transaction.commit()

        const created = await db.goodsReceipt.findByPk(receipt.id, {
          include: [{ model: db.goodsReceiptItem, as: 'items' }]
        })

        if (journalJob) {
          const journalResult = await attemptJob(journalJob)
          await recordImmediateAttempt(journalJob, journalResult)
          if (!journalResult.ok) {
            console.error('Purchase journal deferred to retry queue:', journalResult.error)
          }
        }

        await createAudit(
          req,
          'create',
          'goods_receipt',
          receipt.id,
          'Created goods_receipt: ' + receipt.id
        )

        return res.status(201).json({
          success: true,
          message: 'Success create goods receipt',
          data: created
        })
      } catch (err) {
        await transaction.rollback()
        throw err
      }
    } catch (error) {
      // Destructured locals (idempotencyKey, items) live inside the try
      // above — re-read them from the request body here.
      const catchKey = req.body?.idempotencyKey
      const catchItems = req.body?.items
      const catchPoId = req.body?.purchaseOrderId
      if (error.name === 'SequelizeUniqueConstraintError' && catchKey) {
        const existing = await db.goodsReceipt.findOne({
          where: { purchaseOrderId: catchPoId, idempotencyKey: catchKey },
          include: [{ model: db.goodsReceiptItem, as: 'items' }]
        })
        if (existing) {
          if (!grItemsMatchPayload(existing.items, catchItems)) {
            return res.status(409).json({
              success: false,
              message: GR_IDEMPOTENCY_MISMATCH_MESSAGE
            })
          }
          return res.status(200).json({
            success: true,
            message: 'Goods receipt already exists for this idempotency key',
            data: existing
          })
        }
      }
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async exportExcel(req, res) {
    try {
      const store = resolveStoreId(req)
      const userRole = req.user?.roleType
      const { status, startDate, endDate, store: queryStore } = req.query

      const where = {}
      if (queryStore && userRole === 'super_admin') where.store = queryStore
      else if (store && userRole !== 'super_admin') where.store = store
      if (status) where.status = status
      if (startDate || endDate) {
        where.receivedDate = {}
        if (startDate) where.receivedDate[Op.gte] = new Date(startDate)
        if (endDate) where.receivedDate[Op.lte] = new Date(endDate)
      }

      const rows = await db.goodsReceipt.findAll({
        where,
        include: [
          {
            model: db.purchase_order,
            as: 'purchaseOrderData',
            attributes: ['id', 'orderNumber', 'status']
          },
          { model: db.location, as: 'storeData', attributes: ['id', 'name'] },
          { model: db.goodsReceiptItem, as: 'items' }
        ],
        order: [['createdAt', 'DESC']]
      })

      return res.status(200).json({
        success: true,
        message: 'Success',
        data: rows
      })
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async update(req, res) {
    try {
      const { id } = req.params
      const store = resolveStoreId(req)
      const userRole = req.user?.roleType
      const {
        notes,
        receivedDate,
        items,
        status,
        pic,
        suratJalan,
        taxInvoiceNo,
        shippingCost
      } = req.body

      // ponytail: documentation photos -> Cloudinary (or explicit null to clear)
      let documentation
      const uploadedDocs = await uploadDocumentation(req)
      if (uploadedDocs !== undefined) {
        documentation = uploadedDocs
      } else if (req.body.documentation !== undefined) {
        documentation = req.body.documentation
      }

      const where = { id }
      if (store && userRole !== 'super_admin') where.store = store

      const receipt = await db.goodsReceipt.findOne({
        where,
        include: [
          {
            model: db.goodsReceiptItem,
            as: 'items',
            include: [
              {
                model: db.purchase_order_item,
                as: 'poItemData',
                include: [
                  {
                    model: db.ingredient,
                    as: 'ingredientData',
                    attributes: ['id', 'name']
                  }
                ]
              }
            ]
          }
        ]
      })

      if (!receipt) {
        return res
          .status(404)
          .json({ success: false, message: 'Goods receipt not found' })
      }

      if (receipt.status !== 'draft') {
        return res.status(400).json({
          success: false,
          message: 'Only draft receipt can be updated'
        })
      }

      // ponytail: reject duplicate ingredients/products in same GR
      if (items) {
        const keys = items
          .map((i) =>
            i.ingredient
              ? `ing-${i.ingredient}`
              : i.product
                ? `prod-${i.product}`
                : null
          )
          .filter(Boolean)
        const dupes = keys.filter((k, i) => keys.indexOf(k) !== i)
        if (dupes.length > 0) {
          return res.status(400).json({
            success: false,
            message: `Duplicate item(s) in goods receipt: ${[...new Set(dupes)].join(', ')}`
          })
        }
      }

      const transaction = await db.sequelize.transaction()
      // J1: set when this update transitions the receipt draft -> completed
      // (the only status transition update() performs that carries a
      // financial side effect). Enqueued inside the same transaction as the
      // state change below and attempted post-commit — the exact pattern
      // changeStatus() uses, so both completion paths post exactly one
      // purchase_journal. Completed receipts never reach the enqueue: the
      // re-locked draft guard above rejects them first.
      let journalJob = null
      try {
        // F-STOCK-1: re-lock the header inside the transaction and re-check
        // the draft guard here — the outer read above is stale by the time
        // this transaction runs, so two concurrent lifecycle operations
        // could otherwise both reverse/apply the same receipt. The header
        // is locked WITHOUT includes (Postgres forbids FOR UPDATE across
        // the LEFT OUTER JOINs an include would generate); items are
        // re-fetched right after, while the header lock is held, so they
        // are current too.
        const locked = await db.goodsReceipt.findByPk(id, {
          lock: transaction.LOCK.UPDATE,
          transaction
        })
        if (!locked) {
          await transaction.rollback()
          return res
            .status(404)
            .json({ success: false, message: 'Goods receipt not found' })
        }
        if (locked.status !== 'draft') {
          await transaction.rollback()
          return res.status(400).json({
            success: false,
            message: 'Only draft receipt can be updated'
          })
        }
        const lockedOldItems = await db.goodsReceiptItem.findAll({
          where: { goodsReceipt: id },
          include: [
            {
              model: db.purchase_order_item,
              as: 'poItemData',
              include: [
                {
                  model: db.ingredient,
                  as: 'ingredientData',
                  attributes: ['id', 'name']
                }
              ]
            }
          ],
          transaction
        })

        // F-STOCK-1: an update that carries no replacement items is a
        // metadata-only edit — reversing the old stock without re-applying
        // would silently strip the receipt's stock effect.
        const replacingItems = Array.isArray(items)
        const nextStatus = status || locked.status
        if (!replacingItems) {
          // P1-5: a metadata-only flip to completed on a never-posted draft
          // still has to post the existing lines exactly once.
          if (nextStatus === 'completed' && locked.status === 'draft' && !locked.stockPosted) {
            const poForPosting = await db.purchase_order.findByPk(
              locked.purchaseOrderId,
              { transaction }
            )
            await applyStock(lockedOldItems, locked, transaction, req.user?.id)
            for (const [index, line] of lockedOldItems.entries()) {
              if (!line.product) continue
              const lineQty = Number(line.qtyReceived) || 0
              if (!(lineQty > 0)) continue
              const lineConversion = Number(line.conversionToBase) || 1
              await batchService.addBatchStock({
                productId: line.product,
                store: store || locked.store,
                qty: lineQty * lineConversion,
                costPerUnit:
                  lineConversion > 0
                    ? Number(line.costPrice || 0) / lineConversion
                    : 0,
                batchCode:
                  line.batchNumber || `${locked.receiptNumber}-${index + 1}`,
                expiryDate: line.expiryDate || null,
                supplier: poForPosting?.supplier || null,
                receivedDate: receivedDate || locked.receivedDate || new Date(),
                transaction
              })
            }
          }
          await locked.update(
            {
              notes: notes !== undefined ? notes : locked.notes,
              receivedDate: receivedDate || locked.receivedDate,
              pic: pic !== undefined ? pic : locked.pic,
              documentation:
                documentation !== undefined ? documentation : locked.documentation,
              suratJalan:
                suratJalan !== undefined ? suratJalan : locked.suratJalan,
              taxInvoiceNo:
                taxInvoiceNo !== undefined ? taxInvoiceNo : locked.taxInvoiceNo,
              shippingCost:
                shippingCost !== undefined
                  ? Number(shippingCost) || 0
                  : Number(locked.shippingCost) || 0,
              // P1-5: a completed receipt always has its effect posted (see
              // the post-on-transition above); anything else keeps its flag.
              stockPosted:
                nextStatus === 'completed' ? true : locked.stockPosted,
              modifiedBy: req.user?.id || null
            },
            { transaction }
          )
          await transaction.commit()
          const untouched = await db.goodsReceipt.findByPk(locked.id, {
            include: [{ model: db.goodsReceiptItem, as: 'items' }]
          })
          return res.status(200).json({
            success: true,
            message: 'Success update goods receipt',
            data: untouched
          })
        }

        // P1-5: only unwind an effect that was actually posted.
        if (locked.stockPosted) {
          await reverseStock(
            lockedOldItems,
            store || locked.store,
            transaction,
            req.user?.id
          )

          // B1: the reversed stock effect included per-line batches created
          // at create time — retire them so FIFO/expiry cannot consume
          // phantom quantities. Deterministic association only (receipt
          // prefix / exact lot code + received qty); foreign batches are
          // never touched.
          await voidReceiptBatches({
            receiptNumber: locked.receiptNumber,
            items: lockedOldItems,
            store: store || locked.store,
            transaction
          })
        }

        // F-STOCK-1: an update that transitions the draft to cancelled
        // unwinds the receipt like a delete (reverse only) instead of
        // re-applying a stock effect a cancelled receipt must not keep.
        if (nextStatus === 'cancelled') {
          await db.goodsReceiptItem.destroy({
            where: { goodsReceipt: id },
            transaction
          })
          await locked.update(
            {
              notes: notes !== undefined ? notes : locked.notes,
              receivedDate: receivedDate || locked.receivedDate,
              status: 'cancelled',
              stockPosted: false,
              pic: pic !== undefined ? pic : locked.pic,
              documentation:
                documentation !== undefined ? documentation : locked.documentation,
              suratJalan:
                suratJalan !== undefined ? suratJalan : locked.suratJalan,
              taxInvoiceNo:
                taxInvoiceNo !== undefined ? taxInvoiceNo : locked.taxInvoiceNo,
              shippingCost:
                shippingCost !== undefined
                  ? Number(shippingCost) || 0
                  : Number(locked.shippingCost) || 0,
              modifiedBy: req.user?.id || null
            },
            { transaction }
          )
          await transaction.commit()
          const cancelled = await db.goodsReceipt.findByPk(locked.id, {
            include: [{ model: db.goodsReceiptItem, as: 'items' }]
          })
          return res.status(200).json({
            success: true,
            message: 'Success update goods receipt',
            data: cancelled
          })
        }

        await receipt.update(
          {
            notes: notes !== undefined ? notes : receipt.notes,
            receivedDate: receivedDate || receipt.receivedDate,
            status: status || receipt.status,
            // P1-5: the rebuild below posts whenever the receipt is (or
            // becomes) completed; an unposted draft staying draft keeps
            // its flag off.
            stockPosted:
              nextStatus === 'completed' ? true : locked.stockPosted,
            pic: pic !== undefined ? pic : receipt.pic,
            documentation:
              documentation !== undefined ? documentation : receipt.documentation,
            suratJalan:
              suratJalan !== undefined ? suratJalan : receipt.suratJalan,
            taxInvoiceNo:
              taxInvoiceNo !== undefined ? taxInvoiceNo : receipt.taxInvoiceNo,
            shippingCost:
              shippingCost !== undefined
                ? Number(shippingCost) || 0
                : Number(receipt.shippingCost) || 0,
            modifiedBy: req.user?.id || null
          },
          { transaction }
        )

        await db.goodsReceiptItem.destroy({
          where: { goodsReceipt: id },
          transaction
        })

        if (items && items.length > 0) {
          const po = await db.purchase_order.findOne({
            where: { id: receipt.purchaseOrderId }
          })
          const additionalCost = Number(po?.additionalCost) || 0
          const tolerance = Number.isFinite(Number(po?.overDeliveryTolerance))
            ? Number(po?.overDeliveryTolerance)
            : 10
          const allPoItems = await db.purchase_order_item.findAll({
            where: { purchaseOrder: receipt.purchaseOrderId },
            lock: transaction.LOCK.UPDATE,
            transaction
          })
          const totalPOValue = allPoItems.reduce(
            (sum, pi) => sum + Number(pi.quantity) * Number(pi.price),
            0
          )

          const newItems = []
          // B1: batch inputs for the re-applied lines, parallel to newItems
          // (same loop, same order) — the replacement receipt effect gets
          // fresh batches exactly like create() issues, since the old ones
          // were retired above.
          const newBatchInputs = []
          for (const item of items) {
            const qty = Number(item.qtyReceived) || 0
            if (!Number.isFinite(qty) || qty <= 0) continue

            let poItem =
              allPoItems.find((pi) => pi.id === item.purchaseOrderItem) || null
            if (!poItem && item.ingredient) {
              poItem =
                allPoItems.find((pi) => pi.ingredient === item.ingredient) ||
                null
            }
            if (!poItem && item.ingredientName) {
              poItem =
                allPoItems.find(
                  (pi) => pi.ingredientName === item.ingredientName
                ) || null
            }

            if (poItem) {
              const ordered = Number(poItem.quantity)
              const alreadyReceived = Number(poItem.receivedQuantity) || 0
              const toleranceQty = Math.ceil((ordered * tolerance) / 100)
              const maxDeliverable = ordered + toleranceQty
              const remaining = maxDeliverable - alreadyReceived
              if (qty > remaining) {
                await transaction.rollback()
                return res.status(400).json({
                  success: false,
                  message: `Over-receiving not allowed for ${item.ingredientName || poItem.ingredientName || 'item'}: max ${remaining} remaining (ordered ${ordered}, tolerance ${tolerance}%, already received ${alreadyReceived})`
                })
              }
            }

            const conversion =
              Number(item.conversionToBase) ||
              Number(poItem?.conversionToBase) ||
              1
            const baseCost =
              Number(item.costPrice) || (poItem ? Number(poItem.price) || 0 : 0)
            const landed =
              additionalCost > 0 && totalPOValue > 0 && poItem
                ? Math.round(
                    (additionalCost * (Number(poItem.price) || 0)) /
                      totalPOValue
                  )
                : 0
            const shippingShare = getShippingShare(
              shippingCost !== undefined ? shippingCost : receipt.shippingCost,
              poItem?.price,
              totalPOValue
            )
            const costPrice = baseCost + landed + shippingShare

            newItems.push({
              goodsReceipt: id,
              purchaseOrderItem: item.purchaseOrderItem || poItem?.id || null,
              product: item.product || null,
              qtyReceived: qty,
              unit: item.unit || 'pcs',
              conditionNotes: item.conditionNotes || null,
              ingredientName: item.ingredientName || null,
              batchNumber: item.batchNumber || null,
              expiryDate: item.expiryDate || null,
              costPrice,
              landedCost: landed,
              conversionToBase: conversion,
              qtyStock: qty * conversion
            })
            if (item.product) {
              newBatchInputs.push({
                product: item.product,
                qtyStock: qty * conversion,
                baseUnitCost: conversion > 0 ? costPrice / conversion : 0,
                batchNumber: item.batchNumber || null,
                expiryDate: item.expiryDate || null
              })
            }
          }

          if (newItems.length > 0) {
            await db.goodsReceiptItem.bulkCreate(newItems, { transaction })
            // P1-5: the replacement effect posts only when the receipt is
            // (or becomes) completed — an unposted draft staying draft
            // records rows with no stock movement.
            if (locked.stockPosted || nextStatus === 'completed') {
              await applyStock(newItems, receipt, transaction, req.user?.id)
              // B1: fresh batches for the re-applied stock effect — same
              // shape as create() (per-line batch, receiptNumber-indexed
              // auto code), so FIFO/expiry track the current backing, not
              // the retired one.
              for (const [index, batchInput] of newBatchInputs.entries()) {
                await batchService.addBatchStock({
                  productId: batchInput.product,
                  store: store || locked.store,
                  qty: batchInput.qtyStock,
                  costPerUnit: batchInput.baseUnitCost,
                  batchCode:
                    batchInput.batchNumber ||
                    `${locked.receiptNumber}-${index + 1}`,
                  expiryDate: batchInput.expiryDate || null,
                  supplier: po?.supplier || null,
                  receivedDate: receivedDate || new Date(),
                  transaction
                })
              }
            }
          }

          // J1: a draft completed through update() must post the same
          // purchase_journal as the equivalent changeStatus() transition.
          // Payload mirrors changeStatus() exactly (PO header + final
          // receipt items); the draft guard above guarantees this runs at
          // most once per receipt, and the transaction rollback below
          // guarantees a failed update enqueues nothing.
          if (locked.status === 'draft' && nextStatus === 'completed') {
            const journalPO = await db.purchase_order.findByPk(
              receipt.purchaseOrderId,
              { transaction }
            )
            const journalStore = store || locked.store
            journalJob = await enqueueAccountingJob({
              jobType: 'purchase_journal',
              store: journalStore,
              referenceType: 'goods_receipt',
              referenceId: locked.id,
              payload: {
                store: journalStore,
                receiptId: locked.id,
                receiptNumber: locked.receiptNumber,
                poNumber: journalPO?.orderNumber,
                totalAmount: journalPO?.totalAmount,
                discount: journalPO?.discount,
                taxAmount: journalPO?.taxAmount,
                items: newItems.map((i) => ({
                  costPrice: i.costPrice,
                  qtyReceived: i.qtyReceived
                })),
                date: new Date(receivedDate || Date.now()).toISOString(),
                createdBy: req.user?.id
              },
              transaction
            })
          }
        }

        await transaction.commit()
      } catch (err) {
        await transaction.rollback()
        throw err
      }

      const updated = await db.goodsReceipt.findByPk(receipt.id, {
        include: [{ model: db.goodsReceiptItem, as: 'items' }]
      })

      if (journalJob) {
        const journalResult = await attemptJob(journalJob)
        await recordImmediateAttempt(journalJob, journalResult)
        if (!journalResult.ok) {
          console.error('Purchase journal deferred to retry queue:', journalResult.error)
        }
      }

      await createAudit(
        req,
        'update',
        'goods_receipt',
        id,
        'Updated goods_receipt: ' + id
      )

      return res.status(200).json({
        success: true,
        message: 'Success update goods receipt',
        data: updated
      })
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async delete(req, res) {
    try {
      const { id } = req.params
      const store = resolveStoreId(req)
      const userRole = req.user?.roleType

      const where = { id }
      if (store && userRole !== 'super_admin') where.store = store

      const receipt = await db.goodsReceipt.findOne({
        where,
        include: [
          {
            model: db.goodsReceiptItem,
            as: 'items',
            include: [
              {
                model: db.purchase_order_item,
                as: 'poItemData',
                include: [
                  {
                    model: db.ingredient,
                    as: 'ingredientData',
                    attributes: ['id', 'name']
                  }
                ]
              }
            ]
          }
        ]
      })
      if (!receipt) {
        return res
          .status(404)
          .json({ success: false, message: 'Goods receipt not found' })
      }

      if (receipt.status !== 'draft') {
        return res.status(400).json({
          success: false,
          message: 'Only draft receipt can be deleted'
        })
      }

      const transaction = await db.sequelize.transaction()
      try {
        // F-STOCK-1: same in-transaction header lock + draft re-check as
        // update — a concurrent lifecycle operation must not reverse the
        // same receipt twice. Header locked without includes (FOR UPDATE
        // cannot span the LEFT OUTER JOINs); items re-fetched under lock.
        const locked = await db.goodsReceipt.findByPk(id, {
          lock: transaction.LOCK.UPDATE,
          transaction
        })
        if (!locked) {
          await transaction.rollback()
          return res
            .status(404)
            .json({ success: false, message: 'Goods receipt not found' })
        }
        if (locked.status !== 'draft') {
          await transaction.rollback()
          return res.status(400).json({
            success: false,
            message: 'Only draft receipt can be deleted'
          })
        }
        const lockedOldItems = await db.goodsReceiptItem.findAll({
          where: { goodsReceipt: id },
          include: [
            {
              model: db.purchase_order_item,
              as: 'poItemData',
              include: [
                {
                  model: db.ingredient,
                  as: 'ingredientData',
                  attributes: ['id', 'name']
                }
              ]
            }
          ],
          transaction
        })
        // P1-5: only unwind an effect that was actually posted; deleting a
        // never-posted draft removes rows with no stock movement.
        if (locked.stockPosted) {
          await reverseStock(
            lockedOldItems,
            store || locked.store,
            transaction,
            req.user?.id
          )

          // B1: retire this receipt's batches with its stock effect.
          await voidReceiptBatches({
            receiptNumber: locked.receiptNumber,
            items: lockedOldItems,
            store: store || locked.store,
            transaction
          })
        }

        await db.goodsReceiptItem.destroy({
          where: { goodsReceipt: id },
          transaction
        })
        await receipt.destroy({ transaction })
        await transaction.commit()
      } catch (err) {
        await transaction.rollback()
        throw err
      }

      await createAudit(
        req,
        'delete',
        'goods_receipt',
        id,
        'Deleted goods_receipt: ' + id
      )

      return res
        .status(200)
        .json({ success: true, message: 'Success delete goods receipt' })
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async changeStatus(req, res) {
    try {
      const { id } = req.params
      const { status } = req.body
      const store = resolveStoreId(req)
      const userRole = req.user?.roleType

      if (!['completed', 'cancelled'].includes(status)) {
        return res.status(400).json({
          success: false,
          message: 'Status must be "completed" or "cancelled"'
        })
      }

      const where = { id }
      if (store && userRole !== 'super_admin') where.store = store

      const receipt = await db.goodsReceipt.findOne({
        where,
        include: [
          {
            model: db.goodsReceiptItem,
            as: 'items',
            include: [
              {
                model: db.purchase_order_item,
                as: 'poItemData',
                include: [
                  {
                    model: db.ingredient,
                    as: 'ingredientData',
                    attributes: ['id', 'name']
                  }
                ]
              }
            ]
          }
        ]
      })
      if (!receipt) {
        return res
          .status(404)
          .json({ success: false, message: 'Goods receipt not found' })
      }

      if (receipt.status !== 'draft') {
        return res.status(400).json({
          success: false,
          message: `Cannot change status from "${receipt.status}"`
        })
      }

      const transaction = await db.sequelize.transaction()
      let journalJob = null
      try {
        // F-STOCK-1: lock the header and re-check the draft guard inside
        // the transaction — the outer read is stale, so concurrent
        // completions/cancellations could otherwise both apply effects.
        // Locked without includes (FOR UPDATE cannot span LEFT OUTER
        // JOINs); items re-fetched under the lock for the reversal below.
        const locked = await db.goodsReceipt.findByPk(id, {
          lock: transaction.LOCK.UPDATE,
          transaction
        })
        if (!locked) {
          await transaction.rollback()
          return res
            .status(404)
            .json({ success: false, message: 'Goods receipt not found' })
        }
        if (locked.status !== 'draft') {
          await transaction.rollback()
          return res.status(400).json({
            success: false,
            message: `Cannot change status from "${locked.status}"`
          })
        }
        const lockedItems = await db.goodsReceiptItem.findAll({
          where: { goodsReceipt: id },
          include: [
            {
              model: db.purchase_order_item,
              as: 'poItemData',
              include: [
                {
                  model: db.ingredient,
                  as: 'ingredientData',
                  attributes: ['id', 'name']
                }
              ]
            }
          ],
          transaction
        })

        if (status === 'completed') {
          // P1-5: drafts post nothing at create, so completing posts the
          // full effect exactly once (guarded by stockPosted — legacy rows
          // already posted at create keep skipping this). Same composition
          // as the update() path: applyStock (received quantities, product /
          // ingredient stock, costing) plus fresh per-line batches.
          if (!locked.stockPosted) {
            const poForPosting = await db.purchase_order.findByPk(
              locked.purchaseOrderId,
              { transaction }
            )
            await applyStock(lockedItems, locked, transaction, req.user?.id)
            for (const [index, line] of lockedItems.entries()) {
              if (!line.product) continue
              const lineQty = Number(line.qtyReceived) || 0
              if (!(lineQty > 0)) continue
              const lineConversion = Number(line.conversionToBase) || 1
              await batchService.addBatchStock({
                productId: line.product,
                store: store || locked.store,
                qty: lineQty * lineConversion,
                costPerUnit:
                  lineConversion > 0
                    ? Number(line.costPrice || 0) / lineConversion
                    : 0,
                batchCode:
                  line.batchNumber || `${locked.receiptNumber}-${index + 1}`,
                expiryDate: line.expiryDate || null,
                supplier: poForPosting?.supplier || null,
                receivedDate: locked.receivedDate || new Date(),
                transaction
              })
            }
            await locked.update({ stockPosted: true }, { transaction })
          }
          // Completion only flips the status, recalculates PO fulfillment,
          // and enqueues the purchase journal.
          await calculatePurchaseOrderFulfillmentStatus({
            purchaseOrderId: locked.purchaseOrderId,
            transaction
          })
        }

        if (status === 'cancelled') {
          // P1-5: only unwind an effect that was actually posted. A draft
          // that never posted leaves nothing behind.
          if (locked.stockPosted) {
            // F-STOCK-1: cancelling unwinds the create-time stock effect
            // (and the receivedQuantity increments) so a cancelled receipt
            // leaves no phantom stock behind.
            await reverseStock(
              lockedItems,
              store || locked.store,
              transaction,
              req.user?.id
            )
            // B1: retire this receipt's batches with its stock effect.
            await voidReceiptBatches({
              receiptNumber: locked.receiptNumber,
              items: lockedItems,
              store: store || locked.store,
              transaction
            })
          }
        }

        await locked.update(
          {
            status,
            // P1-5: a cancelled receipt holds no posted effect; a completed
            // one always does (posted just above when it wasn't already).
            stockPosted: status === 'cancelled' ? false : true,
            modifiedBy: req.user?.id || null,
            receivedDate:
              status === 'completed' ? new Date() : locked.receivedDate
          },
          { transaction }
        )

        // Durable inside the same transaction as the status/stock update
        // above — a posting failure below is retried, not silently
        // discarded (same pattern as purchasePayment.js).
        if (status === 'completed') {
          const po = await db.purchase_order.findByPk(
            receipt.purchaseOrderId,
            { transaction }
          )
          journalJob = await enqueueAccountingJob({
            jobType: 'purchase_journal',
            store: receipt.store,
            referenceType: 'goods_receipt',
            referenceId: receipt.id,
            payload: {
              store: receipt.store,
              receiptId: receipt.id,
              receiptNumber: receipt.receiptNumber,
              poNumber: po?.orderNumber,
              totalAmount: po?.totalAmount,
              discount: po?.discount,
              taxAmount: po?.taxAmount,
              items: (receipt.items || []).map((i) => ({
                costPrice: i.costPrice,
                qtyReceived: i.qtyReceived
              })),
              date: new Date().toISOString(),
              createdBy: req.user?.id
            },
            transaction
          })
        }

        await transaction.commit()
      } catch (err) {
        await transaction.rollback()
        throw err
      }

      await createAudit(
        req,
        'update',
        'goods_receipt',
        id,
        'Changed goods_receipt status to ' + status + ': ' + id
      )

      if (journalJob) {
        const journalResult = await attemptJob(journalJob)
        await recordImmediateAttempt(journalJob, journalResult)
        if (!journalResult.ok) {
          console.error('Purchase journal deferred to retry queue:', journalResult.error)
        }
      }

      return res.status(200).json({
        success: true,
        message: `Status changed to "${status}"`,
        data: await db.goodsReceipt.findByPk(id, {
          include: [{ model: db.goodsReceiptItem, as: 'items' }]
        })
      })
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  }
}

module.exports = goodsReceiptController
