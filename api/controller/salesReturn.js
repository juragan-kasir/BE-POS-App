const db = require('../../db/models')
const { Op } = require('sequelize')
const { createAudit } = require('../../utils/auditLog')
const { scalarStoreScope } = require('../../utils/tenantScope')
const { withDeadlockRetry } = require('../../utils/deadlockRetry')
const {
  adjustIngredientStockBatch,
  resolveBomIngredientRequirements
} = require('../service/stockMutationService')
const {
  enqueueAccountingJob,
  attemptJob,
  recordImmediateAttempt
} = require('../service/accountingOutboxService')
const { normalizePaymentMethod } = require('../service/canonicalPayment')
const { resolveAttributedRegister } = require('../service/settlementAttribution')
const { reverseEarnedPoints } = require('../service/loyaltyService')

const salesReturnController = {
  async getAll(req, res) {
    try {
      const {
        page = 1,
        limit = 10,
        status,
        startDate,
        endDate,
        store: queryStore,
        search
      } = req.query

      // super_admin may optionally filter by a specific store (or see
      // every store when omitted); scalarStoreScope forces everyone else
      // to their own store regardless of what's set here, fixing the
      // previous fail-open bug where a falsy store meant "no filter at
      // all" instead of "match nothing".
      const where = {}
      if (queryStore) where.store = queryStore
      if (status) where.status = status
      if (search) {
        where[Op.or] = [
          { returnNumber: { [Op.iLike]: `%${search}%` } },
          { reason: { [Op.iLike]: `%${search}%` } }
        ]
      }
      if (startDate || endDate) {
        where.createdAt = {}
        if (startDate) where.createdAt[Op.gte] = new Date(startDate)
        if (endDate) where.createdAt[Op.lte] = new Date(endDate + 'T23:59:59')
      }

      const offset = (parseInt(page) - 1) * parseInt(limit)

      const { count, rows } = await db.sales_return.findAndCountAll({
        where: scalarStoreScope(req, where),
        include: [
          {
            model: db.sales_return_item,
            as: 'items',
            include: [
              {
                model: db.product,
                as: 'productData',
                attributes: ['id', 'nameProduct']
              }
            ]
          },
          { model: db.location, as: 'storeData', attributes: ['id', 'name'] },
          {
            model: db.user,
            as: 'returnedByData',
            attributes: ['id', 'fullName']
          }
        ],
        order: [['updatedAt', 'DESC']],
        limit: parseInt(limit),
        offset
      })

      return res.status(200).json({
        success: true,
        message: 'Success',
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
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async getById(req, res) {
    try {
      const { id } = req.params

      const ret = await db.sales_return.findOne({
        where: scalarStoreScope(req, { id }),
        include: [
          {
            model: db.sales_return_item,
            as: 'items',
            include: [
              {
                model: db.product,
                as: 'productData',
                attributes: ['id', 'nameProduct']
              }
            ]
          },
          { model: db.location, as: 'storeData', attributes: ['id', 'name'] },
          {
            model: db.user,
            as: 'returnedByData',
            attributes: ['id', 'fullName']
          }
        ]
      })

      if (!ret) {
        return res
          .status(404)
          .json({ success: false, message: 'Sales return not found' })
      }

      return res
        .status(200)
        .json({ success: true, message: 'Success', data: ret })
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async approve(req, res) {
    // F-RET-2: the whole approval runs under withDeadlockRetry — it now
    // locks return → order → product → ingredient rows, and a concurrent
    // cancellation, goods receipt, or second approval can deadlock against
    // it. A killed transaction committed nothing, so re-running from
    // scratch is safe. Safe to retry: guard failures below throw tagged
    // errors (mapped to responses outside the closure) and no response is
    // ever sent before a retryable error can be thrown.
    const approvalError = (statusCode, message) => {
      const e = new Error(message)
      e.statusCode = statusCode
      return e
    }
    const { id } = req.params
    const { refundReference } = req.body || {}
    let outcome = null
    try {
      outcome = await withDeadlockRetry(async () => {
      const transaction = await db.sequelize.transaction()
      try {

        // Locked so a concurrent approve() or reject() on the same return
        // (double-click, or two staff acting on it at once) blocks here until
        // this transaction commits or rolls back, instead of both readers
        // seeing status:'pending' and both proceeding — which previously
        // allowed a double refund + double stock restore, or a return ending
        // up 'rejected' after its refund/stock-restore side effects had
        // already run from a concurrent approve().
        //
        // Fetched WITHOUT the `items` include: Postgres refuses FOR UPDATE
        // across the outer join Sequelize generates for a hasMany include
        // ("FOR UPDATE cannot be applied to the nullable side of an outer
        // join") — the items are fetched separately below, once the lock is
        // held.
        const ret = await db.sales_return.findOne({
          where: scalarStoreScope(req, { id }),
          lock: transaction.LOCK.UPDATE,
          transaction
        })

        if (!ret) {
          throw approvalError(404, 'Sales return not found')
        }

        if (ret.status !== 'pending') {
          throw approvalError(409, 'Only pending returns can be approved')
        }

        ret.items = await db.sales_return_item.findAll({
          where: { salesReturn: ret.id },
          transaction
        })

        // Locked so this serializes against a concurrent cancellation of
        // the same order (updateOrderStatus also locks the order row) —
        // previously this was an unlocked read that never even checked the
        // order's status, so approving a return could restore stock a
        // second time immediately after (or concurrently with) a
        // cancellation that had already restored it once. The existing
        // guard in updateOrderStatus (refusing to cancel an order with an
        // *approved* return) only covered the reverse ordering; it did
        // nothing when approve() ran concurrently with, or right after, a
        // cancel that hadn't been reflected here yet.
        const order = await db.order.findByPk(ret.order, {
          lock: transaction.LOCK.UPDATE,
          transaction
        })
        if (!order) {
          throw approvalError(404, 'Original order not found')
        }
        if (['cancelled', 'void'].includes(order.status)) {
          throw approvalError(
            409,
            'Cannot approve a return for an order that has been cancelled'
          )
        }

        // Authoritative refund-amount invariant — computed fresh from the
        // payment ledger under the order lock just acquired above, which is
        // what serializes this against any other approve() call on the same
        // order (whichever transaction commits first is what the other one
        // observes here). Deliberately NOT derived from order.totalPrice,
        // sales_return.refundAmount history, or paymentStatus — a
        // transaction row's existence is the only real record of money
        // actually moving in this schema (confirmed: every creation site
        // writes one exactly when a real payment or refund happens, never
        // for a pending/speculative one), so summing raw transaction rows
        // is ground truth. This single sum already covers split tender
        // (each split writes its own row), cash and non-cash payments, and
        // both refund-producing mechanisms in this codebase — this
        // sales_return flow AND the order-cancellation auto-refund path —
        // without needing to special-case either.
        const ledgerRows = await db.transaction.findAll({
          where: { order: order.id },
          attributes: ['amount'],
          transaction
        })
        const totalCollected = ledgerRows
          .filter((t) => Number(t.amount) > 0)
          .reduce((sum, t) => sum + Number(t.amount), 0)
        const totalRefunded = ledgerRows
          .filter((t) => Number(t.amount) < 0)
          .reduce((sum, t) => sum + Math.abs(Number(t.amount)), 0)
        const remainingRefundable = totalCollected - totalRefunded

        if (Number(ret.refundAmount) > remainingRefundable) {
          throw approvalError(
            409,
            `Refund amount (${ret.refundAmount}) exceeds the remaining refundable amount (${remainingRefundable})`
          )
        }

        // Original order lines are immutable once created, so they are the
        // stable source of bundle context for return lines (a return item
        // carries only product + orderItem FK, never bundleId).
        const originalOrderItems = await db.order_item.findAll({
          where: { order: ret.order },
          transaction
        })
        const originalOrderItemById = new Map(
          originalOrderItems.map((oi) => [oi.id, oi])
        )

        // F-RET-1: reversal is driven by the immutable stock_history
        // 'sale' snapshot written when the order was paid — the exact
        // precedent reverseOrderStock (order.js) establishes for
        // cancellations. The sale path (deductStockForOrder) has ZERO
        // conversionToBase references: a regular line deducts exactly its
        // integer quantity, a bundle line deducts sale-time
        // bi.quantity x bundleQty per component, and every deduction lands
        // in stock_history. Re-deriving the mutation from the CURRENT
        // bundle/BOM/mode configuration (or from client-supplied
        // conversionToBase, which the sale never honored) restores the
        // wrong quantity the moment any of those change after the sale —
        // or immediately, for any conv != 1. conversionToBase on the
        // return item is therefore informational only and plays no role
        // in the stock math below.
        //
        // Per-product evidence (all derived inside this transaction from
        // locked historical rows, never from mutable configuration):
        // - histFG: base units of each product the sale deducted (FG rows
        //   only). A product with no FG 'sale' rows was make_to_order at
        //   sale time (FG untouched) — even if its mode has since flipped.
        // - remainder: histFG minus the exact contribution of non-bundle
        //   order lines (a stocked product's direct line deducts exactly
        //   its quantity). The remainder is bundle-attributable and yields
        //   the SALE-TIME per-unit composition u_{bundle,component}.
        // - orderedUnits: ordered base units per product (direct qty plus
        //   bundle units via sale-time u), the denominator for the
        //   proportional ingredient leg. histIng x returned/ordered is
        //   exact by construction (histIng = perUnit x ordered).
        // - Partial returns restore their own increment only; the
        //   per-orderItem cumulative guard at create time keeps the sum of
        //   all approvals <= the original deduction — no drift, no double
        //   reverse.
        const saleHistory = await db.stock_history.findAll({
          where: { referenceType: 'sale', referenceId: ret.order },
          transaction
        })
        // Pre-history orders (zero 'sale' rows — the sale wrote them
        // atomically or not at all, so partial history cannot occur) fall
        // back to the legacy current-configuration expansion below. Every
        // order written by the current sale path carries its snapshot.
        const useLegacyHistory = saleHistory.length === 0

        const histFG = new Map()
        const histIng = new Map()
        if (!useLegacyHistory) {
          for (const row of saleHistory) {
            const change = Number(row.quantityChange) || 0
            if (row.ingredient != null) {
              if (!(change < 0)) continue
              const key = `${row.product}:${row.ingredient}`
              const existing = histIng.get(key)
              if (existing) {
                existing.consumed += -change
              } else {
                histIng.set(key, {
                  productId: row.product,
                  ingredientId: row.ingredient,
                  ingredientName: row.ingredientName,
                  consumed: -change
                })
              }
              continue
            }
            const productId = Number(row.product)
            if (!productId || !(change < 0)) continue
            histFG.set(productId, (histFG.get(productId) || 0) - change)
          }
        }

        const directOrderedQty = new Map()
        const bundleOrderedUnits = new Map()
        for (const oi of originalOrderItems) {
          const qty = Number(oi.quantity) || 0
          if (!(qty > 0)) continue
          if (oi.bundleId) {
            bundleOrderedUnits.set(
              oi.bundleId,
              (bundleOrderedUnits.get(oi.bundleId) || 0) + qty
            )
          } else if (oi.product) {
            directOrderedQty.set(
              oi.product,
              (directOrderedQty.get(oi.product) || 0) + qty
            )
          }
        }

        // Sale-time per-unit bundle composition: history-derived entries
        // (bundlePerUnitHist, from the FG remainder) and current-config
        // fills (bundlePerUnitFill, ONLY for components that left no FG
        // trace because make_to_order members never deduct FG). The two
        // maps are disjoint by construction — the fill never overrides a
        // history entry. FG restoration uses Hist only; the ingredient
        // denominator/numerator use Hist + Fill.
        //
        // Current bundle rows are read ONLY for that fill. The
        // single-bundle exact path needs no config read at all when every
        // member is stocked, so post-sale recipe edits cannot skew it.
        const bundlePerUnitHist = new Map()
        const bundlePerUnitFill = new Map()
        const setBundlePerUnitHist = (bundleId, productId, perUnit) => {
          if (!(perUnit > 0)) return
          let perUnitMap = bundlePerUnitHist.get(bundleId)
          if (!perUnitMap) {
            perUnitMap = new Map()
            bundlePerUnitHist.set(bundleId, perUnitMap)
          }
          if (!perUnitMap.has(productId)) perUnitMap.set(productId, perUnit)
        }
        const setBundlePerUnitFill = (bundleId, productId, perUnit) => {
          if (!(perUnit > 0)) return
          if (bundlePerUnitHist.get(bundleId)?.has(productId)) return
          let perUnitMap = bundlePerUnitFill.get(bundleId)
          if (!perUnitMap) {
            perUnitMap = new Map()
            bundlePerUnitFill.set(bundleId, perUnitMap)
          }
          if (!perUnitMap.has(productId)) perUnitMap.set(productId, perUnit)
        }
        const bundlePerUnitAll = (bundleId) => {
          const merged = new Map(bundlePerUnitHist.get(bundleId) || [])
          for (const [productId, perUnit] of bundlePerUnitFill.get(bundleId) || []) {
            if (!merged.has(productId)) merged.set(productId, perUnit)
          }
          return merged
        }
        if (!useLegacyHistory && bundleOrderedUnits.size > 0) {
          const remainder = new Map()
          for (const [productId, total] of histFG) {
            const rem = total - (directOrderedQty.get(productId) || 0)
            if (rem > 0) remainder.set(productId, rem)
          }
          const bundleIds = [...bundleOrderedUnits.keys()]
          if (bundleIds.length === 1) {
            const onlyId = bundleIds[0]
            const orderedUnits = bundleOrderedUnits.get(onlyId) || 0
            if (orderedUnits > 0) {
              for (const [productId, rem] of remainder) {
                setBundlePerUnitHist(onlyId, productId, rem / orderedUnits)
              }
            }
          } else {
            const totalBundleUnits = bundleIds.reduce(
              (sum, id) => sum + (bundleOrderedUnits.get(id) || 0),
              0
            )
            for (const [productId, rem] of remainder) {
              // Multi-bundle fallback: split the remainder across the
              // bundles by ordered units. Same-bundle-type lines share one
              // composition, so a unit-weighted split is exact whenever the
              // sharing bundles do not contain this product in differing
              // sale-time ratios; differing ratios across bundle types
              // sharing one component is the documented residual risk.
              for (const bId of bundleIds) {
                const orderedUnits = bundleOrderedUnits.get(bId) || 0
                if (!(orderedUnits > 0) || !(totalBundleUnits > 0)) continue
                setBundlePerUnitHist(
                  bId,
                  productId,
                  rem * (orderedUnits / totalBundleUnits) / orderedUnits
                )
              }
            }
          }
          // Fill components that left no FG trace (make_to_order members)
          // from the current configuration — same as the pre-fix behavior
          // for exactly this corner, never an override of history-derived
          // entries (setBundlePerUnitFill skips products already resolved
          // from the remainder).
          for (const bId of bundleIds) {
            const bundle = await db.product_bundle.findByPk(bId, {
              include: [{ model: db.product_bundle_item, as: 'items' }],
              transaction
            })
            for (const bi of bundle?.items || []) {
              if (!bi.product) continue
              setBundlePerUnitFill(bId, bi.product, Number(bi.quantity) || 0)
            }
          }
        }

        // Canonical DECIMAL(10,4) quantization at the computation boundary
        // — no raw JS float ever reaches the SQL literals or the history
        // rows below. All sale-side quantities are integers, so
        // history-proportional shares are exact; this only hardens the
        // boundary against binary floating-point residue.
        const q4 = (v) => Math.round((Number(v) || 0) * 10000) / 10000

        const fgRestoreLines = []
        // Returned base units per product for THIS approval — the
        // ingredient-ratio numerator. Tracked independently of FG
        // restoration: a make_to_order line restores zero FG yet still
        // returns base units whose ingredient consumption must reverse.
        const returnedUnits = new Map()
        const addReturnedUnits = (productId, units) => {
          const q = q4(units)
          if (!(q > 0)) return
          returnedUnits.set(productId, q4((returnedUnits.get(productId) || 0) + q))
        }
        const pushFgRestore = (productId, units, unit) => {
          const q = q4(units)
          if (!(q > 0)) return
          fgRestoreLines.push({ productId, baseQty: q, unit: unit || null })
        }

        if (useLegacyHistory) {
          // Legacy pre-history orders: no snapshot exists, so the current
          // configuration is the only source. Quantities stay in sale
          // (base) units — conversionToBase never multiplies.
          for (const item of ret.items) {
            const lineQty = Number(item.qty) || 0
            if (!(lineQty > 0)) continue
            const originalLine = item.orderItem
              ? originalOrderItemById.get(item.orderItem)
              : null
            const bundleId = originalLine?.bundleId || null
            if (bundleId) {
              const bundle = await db.product_bundle.findByPk(bundleId, {
                include: [{ model: db.product_bundle_item, as: 'items' }],
                transaction
              })
              if (!bundle) {
                throw approvalError(404, `Bundle ${bundleId} not found`)
              }
              for (const bi of bundle.items || []) {
                if (!bi.product) continue
                pushFgRestore(bi.product, Number(bi.quantity) * lineQty, null)
              }
              continue
            }
            if (!item.product) continue
            pushFgRestore(item.product, lineQty, item.unit || null)
          }
        } else {
          for (const item of ret.items) {
            const lineQty = Number(item.qty) || 0
            if (!(lineQty > 0)) continue
            const originalLine = item.orderItem
              ? originalOrderItemById.get(item.orderItem)
              : null
            const bundleId = originalLine?.bundleId || null
            if (bundleId) {
              // FG restoration uses history-derived composition ONLY:
              // make_to_order members (Fill map) deducted no FG at sale
              // time, so they reverse nothing here. Returned units still
              // accrue for every member (Hist + Fill) — the ingredient leg
              // needs them regardless of FG mode.
              for (const [productId, perUnit] of bundlePerUnitAll(bundleId)) {
                addReturnedUnits(productId, lineQty * perUnit)
              }
              for (const [productId, perUnit] of bundlePerUnitHist.get(bundleId) || []) {
                pushFgRestore(productId, lineQty * perUnit, null)
              }
              continue
            }
            if (!item.product) continue
            addReturnedUnits(item.product, lineQty)
            // Stocked-at-sale evidence: the sale deducted FG stock for this
            // product. No FG 'sale' rows means it was make_to_order when
            // sold (FG untouched) — restoring any would inflate stock,
            // even if the mode has since flipped to stocked.
            if ((histFG.get(item.product) || 0) <= 0) continue
            pushFgRestore(item.product, lineQty, item.unit || null)
          }
        }

        // Ordered base units per product — the ingredient-ratio denominator.
        // Direct lines contribute their quantity; bundle lines contribute
        // sale-time per-unit x ordered units (history-derived, plus the
        // make_to_order-member fill documented above).
        const orderedUnits = new Map(directOrderedQty)
        for (const bId of bundleOrderedUnits.keys()) {
          const ordered = bundleOrderedUnits.get(bId) || 0
          for (const [productId, perUnit] of bundlePerUnitAll(bId)) {
            orderedUnits.set(
              productId,
              (orderedUnits.get(productId) || 0) + perUnit * ordered
            )
          }
        }
        // Legacy orders have no snapshot: fall back to the pre-fix
        // current-configuration expansion shape for the ingredient leg.
        const legacyBomFlatItems = []
        if (useLegacyHistory) {
          for (const item of ret.items) {
            const lineQty = Number(item.qty) || 0
            if (!(lineQty > 0)) continue
            const originalLine = item.orderItem
              ? originalOrderItemById.get(item.orderItem)
              : null
            const bundleId = originalLine?.bundleId || null
            if (bundleId) {
              const bundle = await db.product_bundle.findByPk(bundleId, {
                include: [{ model: db.product_bundle_item, as: 'items' }],
                transaction
              })
              for (const bi of bundle?.items || []) {
                if (!bi.product) continue
                legacyBomFlatItems.push({
                  productId: bi.product,
                  quantity: Number(bi.quantity) * lineQty
                })
              }
              continue
            }
            if (!item.product) continue
            legacyBomFlatItems.push({ productId: item.product, quantity: lineQty })
          }
        }
        const bomRestoreItems = []
        if (!useLegacyHistory) {
          for (const entry of histIng.values()) {
            const ordered = orderedUnits.get(entry.productId) || 0
            const returned = returnedUnits.get(entry.productId) || 0
            if (!(ordered > 0) || !(returned > 0)) continue
            // Exact by construction: consumed = perUnit x ordered, so
            // consumed x returned / ordered = perUnit x returned.
            const qty = q4((entry.consumed * returned) / ordered)
            if (!(qty > 0)) continue
            bomRestoreItems.push({
              productId: entry.productId,
              ingredientId: entry.ingredientId,
              ingredientName: entry.ingredientName,
              qty
            })
          }
        }

        // Every distinct product locked once, sorted by id, before any
        // mutation — the same convention as deductStockForOrder (products)
        // and adjustIngredientStockBatch (ingredients, locked sorted
        // inside that helper). Previously products were fetched unlocked
        // and history before/after was computed from the stale read.
        const restoreProductIds = [
          ...new Set(fgRestoreLines.map((l) => l.productId).filter(Boolean))
        ].sort((a, b) => a - b)
        const restoreProducts = restoreProductIds.length
          ? await db.product.findAll({
              where: { id: { [Op.in]: restoreProductIds } },
              lock: transaction.LOCK.UPDATE,
              transaction
            })
          : []
        const restoreProductById = new Map(
          restoreProducts.map((p) => [p.id, p])
        )

        for (const line of fgRestoreLines) {
          if (!restoreProductById.has(line.productId)) {
            throw approvalError(404, `Product ${line.productId} not found`)
          }
        }

        // 1. Restore Stock
        for (const line of fgRestoreLines) {
          const product = restoreProductById.get(line.productId)
          // F-RET-1: no inventoryMode gate here — make_to_order-at-sale
          // products never reach this loop (their sale wrote no FG
          // 'sale' rows, so pushFgRestore was never called for them).
          // Gating on the CURRENT mode would skip a legitimate restore
          // after a stocked -> make_to_order flip, or conjure phantom
          // stock after a make_to_order -> stocked flip. History decides.
          if (!(line.baseQty > 0)) continue

          const oldStock = Number(product.stock) || 0
          await product.update(
            {
              stock: db.sequelize.literal(`stock + (${line.baseQty})`)
            },
            { transaction }
          )
          // Keep the in-memory row consistent so a second line for the
          // same product later in this loop sees the restored value in
          // its history row (same pattern as deductStockForOrder).
          product.stock = oldStock + line.baseQty

          // Update per-store stock
          await db.sequelize.query(
            `INSERT INTO product_store_stock (product, store, stock, "createdAt", "updatedAt")
             VALUES ($1, $2, 0, NOW(), NOW())
             ON CONFLICT (product, store) DO NOTHING`,
            { bind: [line.productId, ret.store], transaction }
          )
          await db.product_store_stock.update(
            {
              stock: db.sequelize.literal(`stock + (${line.baseQty})`)
            },
            {
              where: { product: line.productId, store: ret.store },
              transaction
            }
          )

          await db.stock_history.create(
            {
              product: line.productId,
              store: ret.store,
              referenceType: 'sale_return',
              referenceId: ret.id,
              quantityBefore: oldStock,
              quantityChange: line.baseQty,
              quantityAfter: oldStock + line.baseQty,
              unit: line.unit || product.unit || 'pcs',
              notes: `Sales return approved: ${ret.reason}`,
              createdBy: req.user?.id || null
            },
            { transaction }
          )
        }

        // 1b. Restore BOM ingredient stock — F-RET-1: reverses the exact
        // immutable ingredient consumption recorded in the order's 'sale'
        // history rows (bomRestoreItems, scaled history-proportionally for
        // partial returns), never re-resolving the CURRENT BOM. A recipe,
        // mode, or bundle edit between the sale and this approval therefore
        // cannot change what is restored. Positive quantities restore (the
        // sale path negates them). Legacy pre-history orders keep the
        // pre-fix current-BOM resolution shape.
        const bomRestoreSource = useLegacyHistory
          ? legacyBomFlatItems
          : null
        const legacyBomRequirements = bomRestoreSource
          ? await resolveBomIngredientRequirements(
              bomRestoreSource,
              ret.store,
              restoreProductById,
              transaction
            )
          : []
        const bomBatchItems =
          bomRestoreSource != null
            ? legacyBomRequirements
            : bomRestoreItems
        if (bomBatchItems.length) {
          await adjustIngredientStockBatch({
            items: bomBatchItems,
            store: ret.store,
            referenceType: 'sale_return',
            referenceId: ret.id,
            notes: `Sales return approved: ${ret.returnNumber}`,
            createdBy: req.user?.id || null,
            transaction
          })
        }

        // 2. Refund Transaction — P1 (DR-PAY-ATTR-01/02): canonical
        // tender, refunding-register attribution (SHARE-serialized against
        // close), authenticated actor, and reference propagation onto the
        // immutable ledger row. Cash without an open register is refused;
        // non-cash without one proceeds unattributed (NULL, never guessed).
        if (ret.refundAmount > 0) {
          const refundMethod = normalizePaymentMethod(
            ret.refundMethod || order.paymentMethod || 'cash'
          )
          let refundRegisterId = null
          if (refundMethod === 'CASH') {
            const refunding = await resolveAttributedRegister(
              ret.store ?? order.store,
              transaction
            )
            refundRegisterId = refunding.id
          } else {
            const opportunistic = await db.cashRegister.findOne({
              where: { store: ret.store ?? order.store, status: 'open' },
              lock: transaction.LOCK.SHARE,
              transaction
            })
            if (opportunistic) refundRegisterId = opportunistic.id
          }
          await db.transaction.create(
            {
              order: ret.order,
              salesReturnId: ret.id,
              typePayment: refundMethod,
              amount: -Math.abs(ret.refundAmount),
              referenceNumber: refundReference || null,
              cashRegisterId: refundRegisterId,
              notes: `Refund for return ${ret.returnNumber}`,
              createdBy: req.user?.id || null
            },
            { transaction }
          )
        }

        // 3. Update Return Status + approval metadata — populated only
        // here, atomically with the transition, never accepted at create
        // time and never editable afterward.
        const approvedAt = new Date()
        await ret.update(
          {
            status: 'approved',
            approvedBy: req.user?.id || null,
            approvedAt,
            refundReference: refundReference || null
          },
          { transaction }
        )

        // DR-16: reverse earned points for the returned units, using the
        // same approved product.point x quantity formula applied to this
        // return's lines. Derived from the durable ledger history in this
        // transaction (order row locked above): reverses at most the
        // remaining award, so multiple partial approvals can never
        // double-reverse, and a return on an order that never earned is a
        // safe no-op. Redemption handling is untouched.
        await reverseEarnedPoints({
          orderId: ret.order,
          orderNumber: order.orderNumber,
          memberId: order.customerId,
          items: (ret.items || []).map((i) => ({ productId: i.product, quantity: i.qty })),
          userId: req.user?.id || null,
          transaction,
          reason: `sales return ${ret.returnNumber}`
        })

        // 4. Recompute Order Payment Status
        const updatedOrder = await db.order.findByPk(ret.order, {
          include: [{ model: db.transaction, as: 'transactions' }],
          transaction
        })
        if (updatedOrder) {
          const totalPaid = updatedOrder.transactions.reduce(
            (sum, t) => sum + Number(t.amount),
            0
          )
          let newPaymentStatus = 'unpaid'
          if (totalPaid >= updatedOrder.totalPrice) {
            newPaymentStatus = 'paid'
          } else if (totalPaid > 0) {
            newPaymentStatus = 'partial'
          }
          await updatedOrder.update(
            { paymentStatus: newPaymentStatus },
            { transaction }
          )
        }

        // Durable inside the same transaction as the refund ledger row and
        // status update above — a posting failure below is retried, not
        // silently discarded (see accountingOutboxService.js).
        const journalJob = await enqueueAccountingJob({
          jobType: 'sales_return_journal',
          store: ret.store,
          referenceType: 'sales_return',
          referenceId: ret.id,
          payload: {
            store: ret.store,
            returnId: ret.id,
            returnNumber: ret.returnNumber,
            orderId: ret.order,
            refundAmount: ret.refundAmount,
            refundMethod: ret.refundMethod,
            items: ret.items || [],
            date: new Date().toISOString(),
            createdBy: req.user?.id
          },
          transaction
        })

        await transaction.commit()

        // Post-commit side effects stay outside the retried closure above
        // in outcome handling below — attemptJob/createAudit must never
        // run twice for one logical approval.
        return { ret, journalJob }
      } catch (error) {
        await transaction.rollback()
        throw error
      }
      })
    } catch (error) {
      // Tagged validation errors from the approval guards carry their own
      // statusCode; anything else (including a twice-deadlocked run) is a
      // 500 with atomicity preserved by the rollback above.
      if (error && error.statusCode) {
        return res.status(error.statusCode).json({
          success: false,
          message: error.message
        })
      }
      console.error(error)
      return res.status(500).json({
        success: false,
        message: error.message || 'Internal server error'
      })
    }

    const { ret, journalJob } = outcome

    const journalResult = await attemptJob(journalJob)
    await recordImmediateAttempt(journalJob, journalResult)
    if (!journalResult.ok) {
      console.error('Sales return journal deferred to retry queue:', journalResult.error)
    }

    await createAudit(
      req,
      'update',
      'sales_return',
      id,
      'Approved sales return: ' + ret.returnNumber
    )

    return res
      .status(200)
      .json({ success: true, message: 'Sales return approved', data: ret })
  },

  async reject(req, res) {
    // Runs in its own transaction with the return row locked, same as
    // approve() — previously this had no transaction and no lock at all,
    // so a reject() landing while a concurrent approve() was still
    // mid-flight (unlocked, or racing before this fix) could leave the
    // return visibly 'rejected' even though approve()'s refund and
    // stock-restore had already executed. Locking here means reject()
    // now blocks behind whichever of the two got to the row first, then
    // correctly sees the already-updated status and bails out below.
    const transaction = await db.sequelize.transaction()
    try {
      const { id } = req.params

      const ret = await db.sales_return.findOne({
        where: scalarStoreScope(req, { id }),
        lock: transaction.LOCK.UPDATE,
        transaction
      })
      if (!ret) {
        await transaction.rollback()
        return res
          .status(404)
          .json({ success: false, message: 'Sales return not found' })
      }

      if (ret.status === 'rejected') {
        await transaction.commit()
        return res.status(200).json({
          success: true,
          message: 'Sales return already rejected',
          data: ret
        })
      }

      if (ret.status !== 'pending') {
        await transaction.rollback()
        return res.status(409).json({
          success: false,
          message: 'Only pending returns can be rejected'
        })
      }

      await ret.update({ status: 'rejected' }, { transaction })
      await transaction.commit()

      await createAudit(
        req,
        'update',
        'sales_return',
        id,
        'Rejected sales return: ' + ret.returnNumber
      )

      return res
        .status(200)
        .json({ success: true, message: 'Sales return rejected', data: ret })
    } catch (error) {
      await transaction.rollback()
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  }
}

module.exports = salesReturnController
