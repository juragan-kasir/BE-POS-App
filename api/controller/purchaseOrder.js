const db = require('../../db/models')
const { Op } = require('sequelize')
const ExcelJS = require('exceljs')
const { createAudit } = require('../../utils/auditLog')
const batchService = require('../service/batchService')
const { withDeadlockRetry } = require('../../utils/deadlockRetry')
const { resolveStoreId } = require('../../utils/tenantScope')
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

// T-02/T-03/T-12 Authoritative PO monetary calculation — single source of truth
// for totalAmount/discount/taxRate→taxAmount/additionalCost→finalAmount.
// Mirrors Phase 22 Batch 2 formula: taxableBase = total - discount,
// taxAmount = Math.round(taxableBase * taxRate/100), final = taxableBase+tax+additionalCost.
// Over-delivery tolerance handling per T-01: Math.ceil, documented at call sites.
function calculatePoFinancials({ totalAmount, discount = 0, taxRate = 0, additionalCost = 0 }) {
  const safeTaxRate = Math.min(100, Math.max(0, Number(taxRate) || 0))
  const safeAdditional = Number(additionalCost) || 0
  const safeDiscount = Number(discount) || 0
  const safeTotal = Number(totalAmount) || 0
  const taxableBase = safeTotal - safeDiscount
  const taxAmount = Math.round(taxableBase * (safeTaxRate / 100))
  const finalAmount = taxableBase + taxAmount + safeAdditional
  return { safeTaxRate, taxAmount, finalAmount, taxableBase }
}

// A PO discount is a cut of the item total; more than the total would
// leave the PO with a negative final amount. (Negative values are already
// refused by the request schema.)
function discountErrorFor(discount, totalAmount) {
  if ((Number(discount) || 0) > (Number(totalAmount) || 0)) {
    return 'Diskon tidak boleh melebihi total harga'
  }
  return null
}

const itemsTotal = (items) =>
  items.reduce((sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.price) || 0), 0)

// T-09 Product-store canonical validation: product_store junction table is canonical
// (see api/controller/product.js:95 syncProductStores / getProductStoreSubQuery).
// Unassigned products (no product_store rows) are globally valid for any store.
async function validateProductsForStore(products, storeId) {
  if (!products || products.length === 0) return
  const ids = [...new Set(products.filter(Boolean).map(Number).filter(Boolean))]
  if (ids.length === 0) return
  // All ids must exist (defensive)
  const found = await db.product.findAll({ where: { id: ids }, attributes: ['id'] })
  const foundIds = new Set(found.map((r) => r.id))
  for (const pid of ids) {
    if (!foundIds.has(pid)) throw new Error(`Product #${pid} not found`)
  }
  // If any product has product_store assignments, it must include this store
  const assignments = await db.product_store.findAll({ where: { product: ids } })
  const assignedMap = new Map()
  for (const a of assignments) {
    if (!assignedMap.has(a.product)) assignedMap.set(a.product, new Set())
    assignedMap.get(a.product).add(a.store)
  }
  for (const pid of ids) {
    const stores = assignedMap.get(pid)
    if (stores && stores.size > 0 && !stores.has(Number(storeId))) {
      throw new Error(`Product #${pid} is not assigned to store ${storeId}`)
    }
  }
}

const purchaseOrderController = {
  async getAll(req, res) {
    try {
      const userRole = req.user?.roleType || req.user?.role
      const isSuperAdmin = userRole === 'super_admin'
      const {
        status,
        startDate,
        endDate,
        search,
        deleted,
        source,
        stores,
        page = 1,
        limit = 10
      } = req.query

      const where = {}
      if (deleted) where.deletedAt = { [Op.ne]: null }
      if (status) {
        const statuses = status
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        if (statuses.length === 1) where.status = statuses[0]
        else if (statuses.length > 1) where.status = { [Op.in]: statuses }
      }
      if (source === 'goods_request') {
        where[Op.and] = db.sequelize.literal(
          'EXISTS (SELECT 1 FROM goods_request gr WHERE gr."purchaseOrderId" = "purchase_order"."id" AND gr."deletedAt" IS NULL)'
        )
      } else if (source === 'manual') {
        where[Op.and] = db.sequelize.literal(
          'NOT EXISTS (SELECT 1 FROM goods_request gr WHERE gr."purchaseOrderId" = "purchase_order"."id" AND gr."deletedAt" IS NULL)'
        )
      }
      if (startDate || endDate) {
        where.orderDate = {}
        if (startDate) where.orderDate[Op.gte] = new Date(startDate)
        if (endDate) where.orderDate[Op.lte] = new Date(endDate)
      }
      if (search) {
        where[Op.or] = [{ orderNumber: { [Op.iLike]: `%${search}%` } }]
      }
      let storeIds = null
      if (isSuperAdmin && stores) {
        storeIds = stores.split(',').map(Number).filter(Boolean)
      } else if (!isSuperAdmin && req.storeId) {
        storeIds = [parseInt(req.storeId)]
      }
      if (storeIds && storeIds.length === 1) {
        where.store = storeIds[0]
      } else if (storeIds && storeIds.length > 1) {
        where.store = { [Op.in]: storeIds }
      }

      const offset = (parseInt(page) - 1) * parseInt(limit)

      const statsWhere = storeIds
        ? (storeIds.length === 1 ? { store: storeIds[0] } : { store: { [Op.in]: storeIds } })
        : {}
      const [
        draftCount,
        pendingCount,
        orderedCount,
        receivedCount,
        cancelledCount
      ] = await Promise.all([
        db.purchase_order.count({ where: { ...statsWhere, status: 'draft' } }),
        db.purchase_order.count({
          where: { ...statsWhere, status: 'pending' }
        }),
        db.purchase_order.count({
          where: { ...statsWhere, status: 'ordered' }
        }),
        db.purchase_order.count({
          where: { ...statsWhere, status: 'received' }
        }),
        db.purchase_order.count({
          where: { ...statsWhere, status: 'cancelled' }
        })
      ])
      const stats = {
        draft: draftCount,
        pending: pendingCount,
        ordered: orderedCount,
        received: receivedCount,
        cancelled: cancelledCount
      }

      // ponytail: JS-side aggregation, raw SQL was hard to maintain
      const allPOs = await db.purchase_order.findAll({
        where: { ...statsWhere, status: { [Op.ne]: 'draft' } },
        attributes: ['id', 'finalAmount']
      })

      const poIds = allPOs.map((p) => p.id)
      const paymentAggs =
        poIds.length > 0
          ? await db.purchase_payment.findAll({
              attributes: [
                'purchaseOrder',
                [
                  db.sequelize.fn('SUM', db.sequelize.col('amount')),
                  'totalPaid'
                ]
              ],
              where: { deletedAt: null, purchaseOrder: poIds },
              group: ['purchaseOrder'],
              raw: true
            })
          : []

      const paidMap = {}
      paymentAggs.forEach((p) => {
        paidMap[p.purchaseOrder] = Number(p.totalPaid)
      })

      let unpaid = 0,
        partial = 0,
        paid = 0
      allPOs.forEach((po) => {
        const tp = paidMap[po.id] || 0
        if (tp === 0) unpaid++
        else if (tp < Number(po.finalAmount)) partial++
        else paid++
      })

      const paymentStats = { unpaid, partial, paid }

      const { count, rows } = await db.purchase_order.findAndCountAll({
        where,
        attributes: {
          include: [
            [
              db.Sequelize.literal(`(
                SELECT COALESCE(SUM(amount), 0)
                FROM purchase_payment
                WHERE "purchase_payment"."purchaseOrder" = "purchase_order"."id"
                  AND "purchase_payment"."deletedAt" IS NULL
              )`),
              'totalPaid'
            ],
            [
              db.Sequelize.literal(`(
                SELECT STRING_AGG(DISTINCT s.name, ', ' ORDER BY s.name)
                FROM purchase_order_item poi
                JOIN supplier s ON s.id = poi.supplier AND s."deletedAt" IS NULL
                WHERE poi."purchaseOrder" = "purchase_order"."id"
                  AND poi."deletedAt" IS NULL
              )`),
              'supplierNames'
            ],
            [
              db.Sequelize.literal(`(
                SELECT 1
                FROM goods_request gr
                WHERE gr."purchaseOrderId" = "purchase_order"."id"
                  AND gr."deletedAt" IS NULL
                LIMIT 1
              )`),
              'isFromGoodsRequest'
            ]
          ]
        },
        include: [
          {
            model: db.user,
            as: 'picData',
            attributes: ['id', 'fullName']
          },
          {
            model: db.user,
            as: 'createdByUser',
            attributes: ['id', 'fullName', 'userName']
          },
          {
            model: db.location,
            as: 'storeData',
            attributes: ['id', 'name']
          },
          {
            model: db.purchase_order_item,
            as: 'items',
            attributes: [
              'id',
              'ingredientName',
              'quantity',
              'price',
              'unit',
              'supplier',
              'receivedQuantity'
            ],
            include: [
              {
                model: db.supplier,
                as: 'supplierData',
                attributes: ['id', 'name']
              }
            ]
          }
        ],
        order: [['updatedAt', 'DESC']],
        limit: parseInt(limit),
        offset,
        distinct: true
      })

      return res.status(200).json({
        success: true,
        message: 'Success get purchase orders',
        data: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / parseInt(limit))
        },
        stats,
        paymentStats
      })
    } catch (error) {
      console.log(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async getById(req, res) {
    try {
      const { id } = req.params
      const store = req.storeId

      const where = { id }
      if (store) where.store = store

      const purchaseOrder = await db.purchase_order.findOne({
        where,
        include: [
          {
            model: db.user,
            as: 'picData',
            attributes: ['id', 'fullName']
          },
          {
            model: db.user,
            as: 'createdByUser',
            attributes: ['id', 'fullName']
          },
          {
            model: db.location,
            as: 'storeData',
            attributes: ['id', 'name']
          },
          {
            model: db.purchase_order_item,
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
                attributes: ['id', 'name', 'unit']
              },
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
            attributes: [
              'id',
              'amount',
              'paymentDate',
              'paymentMethod',
              'reference',
              'notes'
            ]
          }
        ]
      })

      if (!purchaseOrder) {
        return res.status(404).json({
          success: false,
          message: 'Purchase order not found'
        })
      }

      const returnAgg = await db.purchase_return_item.findAll({
        include: [
          {
            model: db.purchase_return,
            as: 'return',
            where: { purchaseOrder: id, status: { [Op.ne]: 'rejected' } },
            attributes: []
          }
        ],
        attributes: [
          'ingredient',
          'product',
          'ingredientName',
          [
            db.Sequelize.fn(
              'COALESCE',
              db.Sequelize.fn('SUM', db.Sequelize.col('qty')),
              0
            ),
            'returnedQty'
          ]
        ],
        group: ['ingredient', 'product', 'ingredientName'],
        raw: true
      })

      const returnMap = {}
      returnAgg.forEach((r) => {
        const key = r.ingredient
          ? `ing-${r.ingredient}`
          : r.product
            ? `prod-${r.product}`
            : r.ingredientName
              ? `name-${r.ingredientName}`
              : null
        if (key) returnMap[key] = parseFloat(r.returnedQty) || 0
      })

      const data = purchaseOrder.toJSON()
      if (data.items) {
        data.items = data.items.map((item) => ({
          ...item,
          returnedQty: item.ingredient
            ? returnMap[`ing-${item.ingredient}`] || 0
            : item.product
              ? returnMap[`prod-${item.product}`] || 0
              : item.ingredientName
                ? returnMap[`name-${item.ingredientName}`] || 0
                : 0
        }))
      }

      const supplierNames = [
        ...new Set(
          (data.items || [])
            .map((item) => item.supplierData?.name)
            .filter(Boolean)
        )
      ]
      data.supplierNames = supplierNames

      // ponytail: sertakan data goods request jika PO berasal dari permintaan barang
      if (data.notes && data.notes.includes('Dari Permintaan Barang:')) {
        const safePoId = parseInt(purchaseOrder.id, 10)
        if (!Number.isNaN(safePoId)) {
          const gr = await db.goodsRequest.findOne({
            where: { purchaseOrderId: safePoId },
            attributes: [
              'id', 'requestNumber', 'requestedBy', 'requestDate',
              'neededDate', 'notes', 'status', 'store'
            ],
            include: [
              {
                model: db.goodsRequestItem,
                as: 'items',
                attributes: ['id', 'ingredientName', 'productName', 'qty', 'unit', 'notes']
              }
            ]
          })
          if (gr) {
            data.goodsRequestData = gr.toJSON()
          }
        }
      }

      return res.status(200).json({
        success: true,
        message: 'Success get purchase order',
        data
      })
    } catch (error) {
      console.log(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async sendToSupplier(req, res) {
    try {
      const { id } = req.params
      const store = req.storeId

      const where = { id }
      if (store) where.store = store

      const po = await db.purchase_order.findOne({ where })

      if (!po) {
        return res.status(404).json({
          success: false,
          message: 'Purchase order not found'
        })
      }

      if (po.status !== 'pending') {
        return res.status(400).json({
          success: false,
          message: `Only pending PO can be sent to supplier. Current status: ${po.status}`
        })
      }

      await po.update({
        status: 'ordered',
        modifiedBy: req.user?.id || null
      })

      await createAudit(
        req,
        'update',
        'purchase_order',
        id,
        'Sent PO to supplier: ' + id
      )

      return res.status(200).json({
        success: true,
        message: 'Purchase order sent to supplier',
        data: po
      })
    } catch (error) {
      console.log(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async create(req, res) {
    try {
      const {
        items,
        discount = 0,
        notes,
        orderDate,
        pic,
        dueDate,
        status,
        paymentMethod,
        tenor,
        dpPercent,
        taxRate = 0,
        additionalCost = 0,
        additionalCostNotes = null,
        overDeliveryTolerance = 10
      } = req.body
      const createdBy = req.user?.id || null
      const store = req.storeId

      const isDraft = status === 'draft'

      if (!isDraft) {
        if (!items || items.length === 0) {
          return res.status(400).json({
            success: false,
            message: 'Items are required'
          })
        }

        if (paymentMethod === 'credit' && !dueDate) {
          return res.status(400).json({
            success: false,
            message: 'Tanggal jatuh tempo wajib diisi'
          })
        }

        // reject duplicate ingredient/product + supplier combos in same PO
        const keys = items
          .map((i) => {
            const base = i.ingredient
              ? `ing-${i.ingredient}`
              : i.product
                ? `prod-${i.product}`
                : null
            return base && i.supplier ? `${base}-sup-${i.supplier}` : base
          })
          .filter(Boolean)
        const dupes = keys.filter((k, i) => keys.indexOf(k) !== i)
        if (dupes.length > 0) {
          return res.status(400).json({
            success: false,
            message: `Duplicate item(s) in purchase order: ${[...new Set(dupes)].join(', ')}`
          })
        }
      }

      // T-09 product-store validation (canonical product_store junction)
      if (!isDraft && items && items.length > 0 && store) {
        const productIds = items.map((i) => i.product).filter(Boolean)
        try {
          await validateProductsForStore(productIds, store)
        } catch (e) {
          return res.status(400).json({ success: false, message: e.message })
        }
      }

      const orderNumber = generateOrderNumber('PO')

      const totalAmount =
        items?.length > 0
          ? items.reduce((sum, item) => {
              const qty = Number(item.quantity) || 0
              const price = Number(item.price) || 0
              if (!Number.isFinite(qty) || !Number.isFinite(price))
                throw new Error('Invalid quantity or price: must be finite numbers')
              return sum + qty * price
            }, 0)
          : 0

      const createDiscountError = discountErrorFor(discount, totalAmount)
      if (createDiscountError) {
        return res.status(400).json({ success: false, message: createDiscountError })
      }

      // T-02 authoritative tax 0-100, T-12 reuse via helper
      const nTaxRate = Number(taxRate)
      if (Number.isFinite(nTaxRate) && (nTaxRate < 0 || nTaxRate > 100)) {
        return res.status(400).json({ success: false, message: 'taxRate must be between 0 and 100' })
      }
      const { safeTaxRate, taxAmount: computedTaxAmount, finalAmount } = calculatePoFinancials({
        totalAmount,
        discount,
        taxRate,
        additionalCost
      })

      const purchaseOrder = await db.purchase_order.create({
        store: store || null,
        orderNumber,
        totalAmount,
        discount,
        taxRate: safeTaxRate,
        taxAmount: computedTaxAmount,
        finalAmount,
        status: status || 'pending',
        orderDate: orderDate || new Date(),
        notes,
        createdBy,
        pic: pic || null,
        dueDate,
        paymentMethod: paymentMethod || 'cash',
        tenor: tenor || 0,
        dpPercent: dpPercent || 0,
        additionalCost: Number(additionalCost) || 0,
        additionalCostNotes: additionalCostNotes || null,
        overDeliveryTolerance:
          Number.isFinite(Number(overDeliveryTolerance)) ? Number(overDeliveryTolerance) : 10
      })

      if (items?.length > 0) {
        const orderItems = items.map((item) => ({
          purchaseOrder: purchaseOrder.id,
          product: item.product || null,
          ingredient: item.ingredient || null,
          ingredientName: item.ingredientName || null,
          supplier: item.supplier || null,
          quantity: item.quantity,
          unit: item.unit || 'pcs',
          price: item.price,
          total: item.quantity * item.price,
          receivedQuantity: 0,
          conversionToBase: Number(item.conversionToBase) || 1
        }))

        await db.purchase_order_item.bulkCreate(orderItems)
      }

      const createdOrder = await db.purchase_order.findOne({
        where: { id: purchaseOrder.id },
        include: [
          {
            model: db.purchase_order_item,
            as: 'items'
          }
        ]
      })

      await createAudit(
        req,
        'create',
        'purchase_order',
        purchaseOrder.id,
        'Created purchase_order: ' + purchaseOrder.id
      )

      return res.status(201).json({
        success: true,
        message: 'Success create purchase order',
        data: createdOrder
      })
    } catch (error) {
      console.log(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async update(req, res) {
    try {
      const { id } = req.params
      const { store: requestedStore, ...bodyRest } = req.body
      const {
        items,
        discount,
        notes,
        orderDate,
        pic,
        dueDate,
        paymentMethod,
        tenor,
        dpPercent,
        taxRate,
        additionalCost,
        additionalCostNotes,
        overDeliveryTolerance,
        status
      } = bodyRest
      const modifiedBy = req.user?.id || null
      const userRole = req.user?.roleType
      const userStore = req.user?.store

      // Super admin may move the PO to any store; other roles are always
      // scoped to their own store (validateStoreAccess already guards this).
      const where = { id }
      if (userRole !== 'super_admin' && req.storeId) where.store = req.storeId

      const purchaseOrder = await db.purchase_order.findOne({
        where
      })

      if (!purchaseOrder) {
        return res.status(404).json({
          success: false,
          message: 'Purchase order not found'
        })
      }

      // Only super admin may change the store of an existing PO
      let finalStore
      if (requestedStore !== undefined) {
        finalStore =
          userRole === 'super_admin' ? requestedStore : userStore || null
      }

      if (
        purchaseOrder.status === 'received' ||
        purchaseOrder.status === 'cancelled'
      ) {
        return res.status(400).json({
          success: false,
          message: 'Cannot update received or cancelled purchase order'
        })
      }

      // T-11 lifecycle: only draft->pending via update is allowed (import activation, T-12)
      // All other status mutations must use dedicated endpoints
      if (status !== undefined) {
        const allowedDraftActivate = purchaseOrder.status === 'draft' && status === 'pending'
        const forbidden =
          status === 'received' ||
          status === 'cancelled' ||
          (status === 'ordered' && purchaseOrder.status !== 'draft') ||
          (!allowedDraftActivate && status !== purchaseOrder.status)
        // Allow draft->pending (and draft->draft no-op), reject others
        if (!allowedDraftActivate && status !== purchaseOrder.status) {
          return res.status(400).json({
            success: false,
            message:
              'Status cannot be changed via update. Use send-to-supplier, cancel, or goods-receipt. Only draft -> pending activation is allowed via update.'
          })
        }
        if (forbidden && !allowedDraftActivate) {
          // covered above but explicit
        }
      }

      // T-02/T-03/T-04 financial lock after first receipt (header-only bypass closed)
      const hasFinancialChange =
        discount !== undefined ||
        taxRate !== undefined ||
        additionalCost !== undefined ||
        additionalCostNotes !== undefined ||
        overDeliveryTolerance !== undefined
      let alreadyReceivedCache = null
      const getAlreadyReceived = async () => {
        if (alreadyReceivedCache !== null) return alreadyReceivedCache
        const eis = await db.purchase_order_item.findAll({ where: { purchaseOrder: id } })
        alreadyReceivedCache = eis.some((ei) => (Number(ei.receivedQuantity) || 0) > 0)
        return alreadyReceivedCache
      }
      if (hasFinancialChange) {
        const alreadyReceived = await getAlreadyReceived()
        if (alreadyReceived) {
          return res.status(400).json({
            success: false,
            message:
              'Cannot change financial fields (discount, taxRate, additionalCost, additionalCostNotes, overDeliveryTolerance) after goods have been received. Create a Purchase Return instead.'
          })
        }
      }
      if (taxRate !== undefined) {
        const n = Number(taxRate)
        if (!Number.isFinite(n) || n < 0 || n > 100) {
          return res.status(400).json({ success: false, message: 'taxRate must be between 0 and 100' })
        }
      }

      const effectivePaymentMethod =
        paymentMethod ?? purchaseOrder.paymentMethod
      if (
        dueDate !== undefined &&
        !dueDate &&
        effectivePaymentMethod === 'credit'
      ) {
        return res.status(400).json({
          success: false,
          message: 'Tanggal jatuh tempo wajib diisi'
        })
      }

      // reject duplicate ingredient/product + supplier combos in same PO
      if (items) {
        const keys = items
          .map((i) => {
            const base = i.ingredient
              ? `ing-${i.ingredient}`
              : i.product
                ? `prod-${i.product}`
                : null
            return base && i.supplier ? `${base}-sup-${i.supplier}` : base
          })
          .filter(Boolean)
        const dupes = keys.filter((k, i) => keys.indexOf(k) !== i)
        if (dupes.length > 0) {
          return res.status(400).json({
            success: false,
            message: `Duplicate item(s) in purchase order: ${[...new Set(dupes)].join(', ')}`
          })
        }
        // T-09 product-store validation for update (when store known)
        const effectiveStoreForItems = finalStore !== undefined ? finalStore : purchaseOrder.store
        if (effectiveStoreForItems) {
          const productIds = items.map((i) => i.product).filter(Boolean)
          try {
            await validateProductsForStore(productIds, effectiveStoreForItems)
          } catch (e) {
            return res.status(400).json({ success: false, message: e.message })
          }
        }
      }

      // Checked before the items are replaced: this handler has no
      // transaction, so a rejection after that point would leave new
      // items under the old totals.
      const updateDiscountError = discountErrorFor(
        discount !== undefined ? discount : purchaseOrder.discount,
        items ? itemsTotal(items) : purchaseOrder.totalAmount
      )
      if (updateDiscountError) {
        return res.status(400).json({ success: false, message: updateDiscountError })
      }

      let totalAmount = purchaseOrder.totalAmount
      if (items) {
        // Preserve receivedQuantity from existing items before destroying
        const existingItems = await db.purchase_order_item.findAll({
          where: { purchaseOrder: id }
        })

        // F22-B10-07: this destroys every existing PO item and recreates
        // them from the request body — brand-new ids, and receivedQuantity
        // only carries over if the new item's identity key happens to
        // exactly match an old one. Once real receiving has already
        // happened (any existing item's receivedQuantity > 0), doing this
        // orphans goodsReceiptItem.purchaseOrderItem FKs pointing at the
        // now-soft-deleted old rows, and any edit that changes product/
        // ingredient/supplier silently drops that item's received history,
        // letting the same physical goods be received again against a
        // fresh receivedQuantity:0 row. The only existing guard here
        // blocked 'received'/'cancelled' — an 'ordered' PO that already
        // has partial receiving was still treated as freely item-mutable.
        // Header-only updates (no `items` in the payload) are unaffected.
        const alreadyReceived = existingItems.some(
          (ei) => (Number(ei.receivedQuantity) || 0) > 0
        )
        if (alreadyReceived) {
          return res.status(400).json({
            success: false,
            message:
              'Cannot modify purchase order items after goods have already been received against this order. Create a Purchase Return instead.'
          })
        }

        const receivedMap = {}
        existingItems.forEach((ei) => {
          const base = ei.ingredient
            ? `ing-${ei.ingredient}`
            : ei.product
              ? `prod-${ei.product}`
              : `id-${ei.id}`
          const key = base && ei.supplier ? `${base}-sup-${ei.supplier}` : base
          receivedMap[key] = Number(ei.receivedQuantity) || 0
        })

        await db.purchase_order_item.destroy({
          where: { purchaseOrder: id }
        })

        const orderItems = items.map((item) => {
          const base = item.ingredient
            ? `ing-${item.ingredient}`
            : item.product
              ? `prod-${item.product}`
              : null
          const key =
            base && item.supplier ? `${base}-sup-${item.supplier}` : base
          return {
            purchaseOrder: id,
            product: item.product || null,
            ingredient: item.ingredient || null,
            ingredientName: item.ingredientName || null,
            supplier: item.supplier || null,
            quantity: item.quantity,
            unit: item.unit || 'pcs',
            price: item.price,
            total: item.quantity * item.price,
            receivedQuantity:
              key && receivedMap[key] !== undefined ? receivedMap[key] : 0,
            conversionToBase: Number(item.conversionToBase) || 1
          }
        })

        await db.purchase_order_item.bulkCreate(orderItems)

        totalAmount = items.reduce((sum, item) => {
          const qty = Number(item.quantity) || 0
          const price = Number(item.price) || 0
          if (!Number.isFinite(qty) || !Number.isFinite(price))
            throw new Error('Invalid quantity or price: must be finite numbers')
          return sum + qty * price
        }, 0)
      }

      const finalDiscount = discount !== undefined ? Number(discount) || 0 : Number(purchaseOrder.discount) || 0
      const finalAdditionalCost =
        additionalCost !== undefined
          ? Number(additionalCost) || 0
          : Number(purchaseOrder.additionalCost) || 0
      const finalTaxRateRaw = taxRate !== undefined ? taxRate : purchaseOrder.taxRate
      // T-02/T-03/T-12 Authoritative calculation via single helper
      const { safeTaxRate: finalTaxRate, taxAmount: finalTaxAmount, finalAmount } =
        calculatePoFinancials({
          totalAmount,
          discount: finalDiscount,
          taxRate: finalTaxRateRaw,
          additionalCost: finalAdditionalCost
        })

      const nextStatus =
        status !== undefined && purchaseOrder.status === 'draft' && status === 'pending'
          ? 'pending'
          : purchaseOrder.status

      await purchaseOrder.update({
        totalAmount,
        discount: finalDiscount,
        taxRate: finalTaxRate,
        taxAmount: finalTaxAmount,
        finalAmount,
        status: nextStatus,
        notes: notes !== undefined ? notes : purchaseOrder.notes,
        orderDate: orderDate || purchaseOrder.orderDate,
        modifiedBy,
        pic: pic !== undefined ? pic : purchaseOrder.pic,
        dueDate: dueDate !== undefined ? dueDate : purchaseOrder.dueDate,
        paymentMethod:
          paymentMethod !== undefined
            ? paymentMethod
            : purchaseOrder.paymentMethod,
        tenor: tenor !== undefined ? tenor : purchaseOrder.tenor,
        dpPercent:
          dpPercent !== undefined ? dpPercent : purchaseOrder.dpPercent,
        additionalCost: finalAdditionalCost,
        additionalCostNotes:
          additionalCostNotes !== undefined
            ? additionalCostNotes
            : purchaseOrder.additionalCostNotes,
        overDeliveryTolerance:
          overDeliveryTolerance !== undefined
            ? (Number.isFinite(Number(overDeliveryTolerance)) ? Number(overDeliveryTolerance) : 10)
            : (Number.isFinite(Number(purchaseOrder.overDeliveryTolerance)) ? Number(purchaseOrder.overDeliveryTolerance) : 10),
        ...(finalStore !== undefined ? { store: finalStore } : {})
      })

      await createAudit(
        req,
        'update',
        'purchase_order',
        id,
        'Updated purchase_order: ' + id
      )

      return res.status(200).json({
        success: true,
        message: 'Success update purchase order',
        data: purchaseOrder
      })
    } catch (error) {
      console.log(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async receive(req, res) {
    try {
      const { id } = req.params
      const store = resolveStoreId(req)
      const { items, receivedDate } = req.body

      const where = { id }
      if (store) where.store = store

      const purchaseOrder = await db.purchase_order.findOne({
        where,
        include: [{ model: db.purchase_order_item, as: 'items' }]
      })

      if (!purchaseOrder) {
        return res.status(404).json({
          success: false,
          message: 'Purchase order not found'
        })
      }

      if (purchaseOrder.status === 'cancelled') {
        return res.status(400).json({
          success: false,
          message: 'Cannot receive cancelled order'
        })
      }

      if (purchaseOrder.status === 'received') {
        return res.status(400).json({
          success: false,
          message: 'Purchase order already fully received'
        })
      }

      if (purchaseOrder.paymentMethod === 'credit') {
        const dpAmount =
          (Number(purchaseOrder.dpPercent || 0) / 100) *
          Number(purchaseOrder.finalAmount || 0)
        const paidToPO =
          (await db.purchase_payment.sum('amount', {
            where: { purchaseOrder: id, deletedAt: null }
          })) || 0
        if (paidToPO < dpAmount) {
          return res.status(400).json({
            success: false,
            message: `DP belum lunas. DP: Rp ${dpAmount.toLocaleString('id-ID')}, Dibayar: Rp ${paidToPO.toLocaleString('id-ID')}`
          })
        }
      }

      await withDeadlockRetry(async () => {
      const transaction = await db.sequelize.transaction()

      try {
        if (items && items.length > 0) {
          // Build a lookup of existing PO items by their DB id
          const poItems = purchaseOrder.items.reduce((map, pi) => {
            map[pi.id] = pi
            return map
          }, {})

          // Locked in a stable (ascending product id) order, not whatever
          // order the request body listed items in — two concurrent
          // receipts (against the same or different POs) sharing 2+
          // products in differently-ordered item arrays could otherwise
          // each lock one product and wait on the other, deadlocking
          // (mirrors the fix already applied to checkout's product
          // locking in order.js). Items without a product (ingredient-
          // only lines) sort last and keep their relative order.
          const sortedItems = [...items].sort((a, b) => {
            const poA = poItems[a.id]
            const poB = poItems[b.id]
            const pa = a.product || poA?.product || Infinity
            const pb = b.product || poB?.product || Infinity
            return pa - pb
          })

          for (const item of sortedItems) {
            if (!poItems[item.id]) continue

            // Legacy receive() race: `poItems` (built from
            // `purchaseOrder.items`, loaded before this transaction even
            // opened) is a stale, unlocked snapshot — maxReceive/receiveQty
            // computed from it can let two concurrent receive() calls both
            // read the same pre-commit receivedQuantity and jointly
            // over-receive. Re-fetching with a row lock here serializes
            // concurrent receives against the same PO item: the second
            // transaction's locked read blocks until the first commits,
            // then sees the now-current receivedQuantity. Same lock idiom
            // already used a few lines below for product/ingredient rows.
            const poItem = await db.purchase_order_item.findOne({
              where: { id: item.id, purchaseOrder: id },
              transaction,
              lock: transaction.LOCK.UPDATE
            })
            if (!poItem) continue

            // T-01 per-PO tolerance, documented Math.ceil behavior (keep for this phase)
            // Tolerance is per-item: maxDeliverable = ordered + ceil(ordered*tolerance/100)
            const tolerance = Number.isFinite(Number(purchaseOrder.overDeliveryTolerance))
              ? Number(purchaseOrder.overDeliveryTolerance)
              : 10
            const ordered = Number(poItem.quantity) || 0
            const alreadyReceived = Number(poItem.receivedQuantity) || 0
            const toleranceQty = Math.ceil((ordered * tolerance) / 100)
            const maxDeliverable = ordered + toleranceQty
            const remaining = maxDeliverable - alreadyReceived
            const requested = Number(item.receivedQuantity)
            if (!Number.isFinite(requested) || requested <= 0) continue
            // Clamp to remaining (preserves legacy receive's clamp semantics, now tolerance-aware)
            const receiveQty = Math.min(requested, Math.max(0, remaining))

            await db.purchase_order_item.update(
              {
                // Postgres folds unquoted identifiers to lowercase — this
                // literal must quote the camelCase column or the UPDATE
                // fails with "column receivedquantity does not exist".
                receivedQuantity: db.sequelize.literal(
                  `"receivedQuantity" + ${receiveQty}`
                )
              },
              { where: { id: item.id, purchaseOrder: id }, transaction }
            )

            if (item.product) {
              // Lock the row so quantityBefore reflects the value at write
              // time (not a stale pre-lock read), and write the new stock
              // via an atomic SQL expression rather than JS arithmetic — two
              // concurrent receipts against the same product previously
              // raced: both read the same starting stock, and the second
              // write silently overwrote the first's increment (lost update).
              const product = await db.product.findByPk(item.product, {
                transaction,
                lock: transaction.LOCK.UPDATE
              })
              if (product) {
                const quantityBefore = Number(product.stock) || 0

                await db.stock_history.create(
                  {
                    store,
                    product: item.product,
                    referenceType: 'purchase',
                    referenceId: id,
                    quantityBefore,
                    quantityChange: receiveQty,
                    quantityAfter: quantityBefore + receiveQty,
                    unit: item.unit || 'pcs',
                    createdBy: req.user?.id
                  },
                  { transaction }
                )

                await product.update(
                  { stock: db.sequelize.literal(`stock + ${receiveQty}`) },
                  { transaction }
                )

                // ponytail: atomic upsert + add per-store stock
                if (store) {
                  await db.sequelize.query(
                    `INSERT INTO product_store_stock (product, store, stock, "createdAt", "updatedAt")
                     VALUES ($1, $2, 0, NOW(), NOW())
                     ON CONFLICT (product, store) DO NOTHING`,
                    { bind: [item.product, store], transaction }
                  )
                  await db.product_store_stock.update(
                    { stock: db.sequelize.literal(`stock + ${receiveQty}`) },
                    {
                      where: { product: item.product, store },
                      transaction
                    }
                  )

                  // ponytail: FIFO - create a batch per received line
                  await batchService.addBatchStock({
                    productId: item.product,
                    store,
                    qty: receiveQty,
                    costPerUnit:
                      Number(item.price) || Number(poItem.price) || 0,
                    batchCode: `${purchaseOrder.orderNumber}-${poItem.id || item.id}`,
                    receivedDate: receivedDate || new Date(),
                    transaction
                  })
                }
              }
            }

            if (item.ingredient || item.ingredientName) {
              const ingredient = item.ingredient
                ? await db.ingredient.findByPk(item.ingredient, {
                    transaction,
                    lock: transaction.LOCK.UPDATE
                  })
                : await db.ingredient.findOne({
                    where: { name: item.ingredientName, store },
                    transaction,
                    lock: transaction.LOCK.UPDATE
                  })

              if (ingredient) {
                const quantityBefore = Number(ingredient.stock) || 0
                await db.stock_history.create(
                  {
                    store,
                    ingredient: ingredient.id,
                    ingredientName: ingredient.name,
                    referenceType: 'purchase',
                    referenceId: id,
                    quantityBefore,
                    quantityChange: receiveQty,
                    quantityAfter: quantityBefore + receiveQty,
                    unit: item.unit || 'pcs',
                    createdBy: req.user?.id
                  },
                  { transaction }
                )
                await ingredient.update(
                  { stock: db.sequelize.literal(`stock + ${receiveQty}`) },
                  { transaction }
                )
              }
            }
          }
        }

        // F22-B10-02: fulfillment is return-aware — see
        // purchaseOrderFulfillmentService.js. Same gap this endpoint had
        // independently of goodsReceipt.js's create()/changeStatus().
        await calculatePurchaseOrderFulfillmentStatus({
          purchaseOrderId: id,
          transaction
        })
        await purchaseOrder.update(
          { receivedDate: receivedDate || new Date() },
          { transaction }
        )

        await transaction.commit()
      } catch (err) {
        await transaction.rollback()
        throw err
      }
      })

      await createAudit(
        req,
        'update',
        'purchase_order',
        id,
        'Received purchase_order: ' + id
      )

      return res.status(200).json({
        success: true,
        message: 'Success receive purchase order',
        data: purchaseOrder
      })
    } catch (error) {
      if (error.statusCode) {
        return res.status(error.statusCode).json({ success: false, message: error.message })
      }
      console.log(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async delete(req, res) {
    try {
      const { id } = req.params
      const store = req.storeId

      const where = { id }
      if (store) where.store = store

      const purchaseOrder = await db.purchase_order.findOne({
        where
      })

      if (!purchaseOrder) {
        return res.status(404).json({
          success: false,
          message: 'Purchase order not found'
        })
      }

      if (purchaseOrder.status === 'received') {
        return res.status(400).json({
          success: false,
          message: 'Cannot delete received order, use cancel instead'
        })
      }

      // F22-B10-08: this soft-deletes every PO item then the PO itself.
      // goodsReceipt/goodsReceiptItem rows are never touched here (they
      // survive), but default-scoped queries exclude paranoid soft-deleted
      // rows — orphaning the existing GR's ability to resolve its own PO/
      // PO-item lineage (e.g. calculatePurchaseOrderFulfillmentStatus, or
      // a later Purchase Return's item matching). The only existing guard
      // blocked 'received' — an 'ordered' PO that already has partial
      // receiving (or a PO cancelled while 'ordered', which never reverses
      // receivedQuantity) was still deletable. Same guard pattern as
      // Batch 16's item-mutation fix: block once any existing item already
      // has receivedQuantity > 0, regardless of the status label.
      const existingItems = await db.purchase_order_item.findAll({
        where: { purchaseOrder: id }
      })
      const alreadyReceived = existingItems.some(
        (ei) => (Number(ei.receivedQuantity) || 0) > 0
      )
      if (alreadyReceived) {
        return res.status(400).json({
          success: false,
          message:
            'Cannot delete a purchase order that already has received goods. Use cancel instead.'
        })
      }

      await db.purchase_order_item.destroy({
        where: { purchaseOrder: id }
      })

      await purchaseOrder.destroy()

      await createAudit(
        req,
        'delete',
        'purchase_order',
        id,
        'Deleted purchase_order: ' + id
      )

      return res.status(200).json({
        success: true,
        message: 'Success delete purchase order'
      })
    } catch (error) {
      console.log(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async cancel(req, res) {
    try {
      const { id } = req.params
      const store = resolveStoreId(req)

      const where = { id }
      if (store) where.store = store

      const purchaseOrder = await db.purchase_order.findOne({
        where,
        include: [{ model: db.purchase_order_item, as: 'items' }]
      })

      if (!purchaseOrder) {
        return res.status(404).json({
          success: false,
          message: 'Purchase order not found'
        })
      }

      if (purchaseOrder.status === 'cancelled') {
        return res.status(400).json({
          success: false,
          message: 'Purchase order is already cancelled'
        })
      }

      // T-07 cancellation policy: reject if any receivedQuantity > 0 (even partial)
      const alreadyReceivedForCancel = (purchaseOrder.items || []).some(
        (it) => (Number(it.receivedQuantity) || 0) > 0
      )
      if (alreadyReceivedForCancel) {
        return res.status(400).json({
          success: false,
          message:
            'Cannot cancel purchase order that already has received goods. Use Purchase Return instead.'
        })
      }

      if (purchaseOrder.status === 'received') {
        const grs = await db.goodsReceipt.findAll({
          where: { purchaseOrderId: id, status: 'completed' },
          include: [{ model: db.goodsReceiptItem, as: 'items' }]
        })

        const t = await db.sequelize.transaction()
        try {
          for (const gr of grs) {
            for (const grItem of gr.items) {
              const qty = Number(grItem.qtyReceived) || 0
              if (!Number.isFinite(qty) || qty <= 0) continue

              // Reverse receivedQuantity on PO item
              if (grItem.purchaseOrderItem) {
                await db.purchase_order_item.update(
                  {
                    receivedQuantity: db.sequelize.literal(
                      `GREATEST("receivedQuantity" - ${qty}, 0)`
                    )
                  },
                  {
                    where: { id: grItem.purchaseOrderItem, purchaseOrder: id },
                    transaction: t
                  }
                )
              } else if (grItem.ingredientName) {
                // Match PO item by ingredient name and reverse receivedQuantity
                const poItem = await db.purchase_order_item.findOne({
                  where: {
                    purchaseOrder: id,
                    ingredientName: grItem.ingredientName
                  },
                  transaction: t
                })
                if (poItem) {
                  await poItem.update(
                    {
                      receivedQuantity: db.sequelize.literal(
                        `GREATEST("receivedQuantity" - ${qty}, 0)`
                      )
                    },
                    { transaction: t }
                  )
                }
              }

              // Reverse product stock
              if (grItem.product) {
                const product = await db.product.findByPk(grItem.product, {
                  transaction: t
                })
                if (product) {
                  const qtyBefore = Number(product.stock) || 0
                  await product.update(
                    { stock: Math.max(qtyBefore - qty, 0) },
                    { transaction: t }
                  )
                  if (purchaseOrder.store) {
                    await db.sequelize.query(
                      `INSERT INTO product_store_stock (product, store, stock, "createdAt", "updatedAt")
                       VALUES ($1, $2, 0, NOW(), NOW())
                       ON CONFLICT (product, store) DO NOTHING`,
                      {
                        bind: [grItem.product, purchaseOrder.store],
                        transaction: t
                      }
                    )
                    await db.product_store_stock.update(
                      {
                        stock: db.sequelize.literal(
                          `GREATEST(stock - ${qty}, 0)`
                        )
                      },
                      {
                        where: {
                          product: grItem.product,
                          store: purchaseOrder.store
                        },
                        transaction: t
                      }
                    )
                  }
                  await db.stock_history.create(
                    {
                      product: grItem.product,
                      store: purchaseOrder.store,
                      referenceType: 'adjustment',
                      quantityBefore: qtyBefore,
                      quantityChange: -qty,
                      quantityAfter: Math.max(qtyBefore - qty, 0),
                      unit: grItem.unit || 'pcs',
                      notes: `PO cancel: ${purchaseOrder.orderNumber}`,
                      createdBy: req.user?.id || null
                    },
                    { transaction: t }
                  )
                }
              }

              // Reverse ingredient stock
              if (grItem.ingredientName) {
                const ingredient = await db.ingredient.findOne({
                  where: {
                    name: grItem.ingredientName,
                    store: purchaseOrder.store
                  },
                  transaction: t
                })
                if (ingredient) {
                  const qtyBefore = Number(ingredient.stock) || 0
                  await ingredient.update(
                    { stock: Math.max(qtyBefore - qty, 0) },
                    { transaction: t }
                  )
                  await db.stock_history.create(
                    {
                      ingredient: ingredient.id,
                      ingredientName: ingredient.name,
                      store: purchaseOrder.store,
                      referenceType: 'adjustment',
                      quantityBefore: qtyBefore,
                      quantityChange: -qty,
                      quantityAfter: Math.max(qtyBefore - qty, 0),
                      unit: grItem.unit || 'pcs',
                      notes: `PO cancel: ${purchaseOrder.orderNumber}`,
                      createdBy: req.user?.id || null
                    },
                    { transaction: t }
                  )
                }
              }
            }

            await gr.update(
              { status: 'cancelled', modifiedBy: req.user?.id || null },
              { transaction: t }
            )
          }

          await purchaseOrder.update(
            { status: 'cancelled', modifiedBy: req.user?.id || null },
            { transaction: t }
          )
          await t.commit()
        } catch (err) {
          await t.rollback()
          throw err
        }
      } else {
        await purchaseOrder.update({
          status: 'cancelled',
          modifiedBy: req.user?.id || null
        })
      }

      await createAudit(
        req,
        'update',
        'purchase_order',
        id,
        'Cancelled purchase_order: ' + id
      )

      return res.status(200).json({
        success: true,
        message: 'Success cancel purchase order'
      })
    } catch (error) {
      console.log(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async downloadTemplate(req, res) {
    try {
      const workbook = new ExcelJS.Workbook()
      const worksheet = workbook.addWorksheet('Purchase Order Template')

      worksheet.addRow([
        'Supplier Name',
        'Product/Item',
        'Quantity',
        'Unit',
        'Price',
        'Notes'
      ])

      worksheet.getRow(1).font = { bold: true }
      worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFD3D3D3' }
      }

      worksheet.columns = [
        { width: 25 },
        { width: 30 },
        { width: 15 },
        { width: 10 },
        { width: 15 },
        { width: 30 }
      ]

      const buffer = await workbook.xlsx.writeBuffer()

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
      res.setHeader(
        'Content-Disposition',
        'attachment; filename=po-template.xlsx'
      )

      return res.status(200).send(buffer)
    } catch (error) {
      console.error('Error =>', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async downloadData(req, res) {
    try {
      const store = req.storeId
      const where = {}
      if (store) where.store = store

      const orders = await db.purchase_order.findAll({
        where,
        include: [
          {
            model: db.purchase_order_item,
            as: 'items',
            include: [
              { model: db.supplier, as: 'supplierData', attributes: ['name'] }
            ]
          }
        ],
        order: [['createdAt', 'ASC']]
      })

      const workbook = new ExcelJS.Workbook()
      const worksheet = workbook.addWorksheet('Purchase Orders')

      worksheet.addRow([
        'Order No',
        'Supplier',
        'Total Amount',
        'Discount',
        'Final Amount',
        'Status',
        'Order Date',
        'Created At'
      ])
      worksheet.getRow(1).font = { bold: true }
      worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFD3D3D3' }
      }

      orders.forEach((o) => {
        const supplierNames = [
          ...new Set(
            (o.items || [])
              .map((item) => item.supplierData?.name)
              .filter(Boolean)
          )
        ].join(', ')
        worksheet.addRow([
          o.orderNumber,
          supplierNames || 'Unknown',
          o.totalAmount,
          o.discount,
          o.finalAmount,
          o.status,
          o.orderDate ? o.orderDate.toISOString().split('T')[0] : '',
          o.createdAt ? o.createdAt.toISOString() : ''
        ])
      })

      worksheet.columns = [
        { width: 20 },
        { width: 25 },
        { width: 15 },
        { width: 10 },
        { width: 15 },
        { width: 12 },
        { width: 15 },
        { width: 20 }
      ]

      const buffer = await workbook.xlsx.writeBuffer()

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
      res.setHeader(
        'Content-Disposition',
        'attachment; filename=purchase-orders.xlsx'
      )

      return res.status(200).send(buffer)
    } catch (error) {
      console.error('Error =>', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async importData(req, res) {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({ success: false, message: 'No file uploaded' })
      }

      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(req.file.buffer)
      const worksheet = workbook.getWorksheet(1)

      const ordersToCreate = []
      const errors = []

      worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return

        try {
          const [supplierName, productItem, quantity, unit, price, notes] =
            row.values

          if (!supplierName || !productItem || !quantity || !price) {
            errors.push(
              `Row ${rowNumber}: Supplier, product, quantity and price are required`
            )
            return
          }

          ordersToCreate.push({
            supplier: supplierName.trim(),
            items: [
              {
                product: null,
                ingredientName: productItem.trim(),
                quantity: parseFloat(quantity),
                unit: (unit || 'pcs').trim(),
                price: parseFloat(price)
              }
            ],
            notes: notes?.trim() || null,
            store: resolveStoreId(req)
          })
        } catch (error) {
          errors.push(`Row ${rowNumber}: ${error.message}`)
        }
      })

      if (errors.length > 0) {
        return res
          .status(400)
          .json({ success: false, message: 'Validation errors', errors })
      }

      const createdOrders = []
      const supplierCache = {}
      for (const data of ordersToCreate) {
        // Resolve supplier name to ID
        let supplierId = null
        if (data.supplier) {
          const trimmedName = data.supplier.trim()
          const cacheKey = `${trimmedName}-${data.store || ''}`
          if (supplierCache[cacheKey]) {
            supplierId = supplierCache[cacheKey]
          } else {
            const supplierObj = await db.supplier.findOne({
              where: {
                name: { [Op.iLike]: trimmedName },
                store: data.store || null
              }
            })
            if (supplierObj) {
              supplierId = supplierObj.id
              supplierCache[cacheKey] = supplierId
            }
          }
        }

        const order = await db.purchase_order.create({
          store: data.store,
          orderNumber: generateOrderNumber('PO'),
          totalAmount: data.items.reduce((s, i) => s + i.quantity * i.price, 0),
          discount: 0,
          finalAmount: data.items.reduce((s, i) => s + i.quantity * i.price, 0),
          status: 'draft',
          orderDate: new Date(),
          notes: data.notes,
          createdBy: req.user?.id || null
        })
        const orderItems = data.items.map((item) => ({
          purchaseOrder: order.id,
          product: item.product || null,
          ingredient: item.ingredient || null,
          ingredientName: item.ingredientName || null,
          supplier: supplierId,
          quantity: item.quantity,
          unit: item.unit || 'pcs',
          price: item.price,
          total: item.quantity * item.price,
          receivedQuantity: 0
        }))
        await db.purchase_order_item.bulkCreate(orderItems)
        createdOrders.push(order)
      }

      await createAudit(
        req,
        'import',
        'purchase_order',
        null,
        'Imported purchase_order from file'
      )

      return res.status(200).json({
        success: true,
        message: `Imported ${createdOrders.length} purchase orders`,
        data: {
          total: ordersToCreate.length,
          created: createdOrders.length
        }
      })
    } catch (error) {
      console.error('Error =>', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  }
}

module.exports = purchaseOrderController
