const db = require('../../db/models')
const { Op } = require('sequelize')
const { enrichAuditFields } = require('../../utils/auditFields')
const { createAudit } = require('../../utils/auditLog')
const { scalarStoreScope, isSuperAdmin, resolveStoreId } = require('../../utils/tenantScope')

const stockHistoryController = {
  async getAll(req, res) {
    try {
      const {
        referenceType,
        product,
        ingredient,
        itemType,
        startDate,
        endDate,
        store: queryStore,
        page = 1,
        limit = 50
      } = req.query

      // History Stok shows ingredients and finished products on separate
      // tabs. A recipe sale row carries both `ingredient` and the menu
      // `product`, so the ingredient column alone decides the item type.
      if (itemType !== undefined && !['ingredient', 'product'].includes(itemType)) {
        return res.status(400).json({
          success: false,
          message: "itemType must be 'ingredient' or 'product'"
        })
      }

      let store = queryStore
      if (req.user?.roleType !== 'super_admin') {
        // HIGH-4: always use the pinned server-side store (validateStoreAccess
        // already blocked a foreign ?store for tenant roles). req.storeId is
        // the authoritative value; fall back to JWT claim for routes that lack
        // the middleware (defensive).
        store = req.storeId ?? req.user?.store
      }

      const where = {}

      if (store) {
        where.store = store
      }

      if (referenceType) {
        where.referenceType = referenceType
      }

      if (product) {
        where.product = product
      }

      if (itemType === 'ingredient') {
        where.ingredient = ingredient ? ingredient : { [Op.ne]: null }
      } else if (itemType === 'product') {
        where.ingredient = null
      } else if (ingredient) {
        where.ingredient = ingredient
      }

      if (startDate || endDate) {
        where.createdAt = {}
        if (startDate) where.createdAt[Op.gte] = new Date(startDate)
        if (endDate) where.createdAt[Op.lte] = new Date(endDate + 'T23:59:59')
      }

      const offset = (parseInt(page) - 1) * parseInt(limit)

      const { count, rows } = await db.stock_history.findAndCountAll({
        where,
        include: [
          {
            model: db.product,
            as: 'productData',
            attributes: ['id', 'nameProduct'],
            required: false
          },
          // History Stok shows the store of every row (client note 2026-10-24)
          {
            model: db.location,
            as: 'storeData',
            attributes: ['id', 'name'],
            required: false
          }
        ],
        order: [['updatedAt', 'DESC']],
        limit: parseInt(limit),
        offset
      })

      await enrichAuditFields(db, rows)

      return res.status(200).json({
        success: true,
        message: 'Success get stock history',
        data: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / parseInt(limit))
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

  async getByProduct(req, res) {
    try {
      const { productId } = req.params

      // HIGH-4: was `where: { product: productId }` with no store filter —
      // any authenticated user with a guessed productId received stock
      // movements from ALL stores for that product (confirmed: store 1 and
      // store 6 both have rows in stock_history).
      // scalarStoreScope adds `store = <userStore>` for non-super-admin and
      // is unrestricted for super_admin (intentional global access).
      // Rows with store: null (historical entries without a store context)
      // are intentionally excluded for tenant users; super_admin sees them.
      const where = scalarStoreScope(req, { product: productId })

      const history = await db.stock_history.findAll({
        where,
        order: [['createdAt', 'DESC']]
      })

      return res.status(200).json({
        success: true,
        message: 'Success get product stock history',
        data: history
      })
    } catch (error) {
      console.log(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async getLowStock(req, res) {
    try {
      const store = req.storeId

      const [products, productStores, locations] = await Promise.all([
        db.product.findAll({
          where: {
            status: 'active',
            minStock: { [Op.gt]: 0 }
          },
          attributes: ['id', 'nameProduct', 'stock', 'minStock', 'unit']
        }),
        db.product_store.findAll({
          attributes: ['product', 'store']
        }),
        db.location.findAll({
          where: { status: 'active' },
          attributes: ['id', 'name']
        })
      ])

      const storeMap = {}
      locations.forEach((loc) => {
        storeMap[loc.id] = loc.name
      })

      const productStoreMap = {}
      productStores.forEach((ps) => {
        if (!productStoreMap[ps.product]) productStoreMap[ps.product] = []
        productStoreMap[ps.product].push(ps.store)
      })

      // Batch 12: scope products to the caller's store via product_store
      // membership when a store is resolved — the same convention already
      // used by getLowStockAll and getDashboardSummary's low-stock count
      // (`EXISTS (... ps.store = :store)`). Without this, every store's
      // low-stock products were returned regardless of caller.
      const lowStockProducts = products
        .filter(
          (p) =>
            p.stock <= p.minStock &&
            (!store || (productStoreMap[p.id] || []).includes(Number(store)))
        )
        .map((p) => ({
          id: p.id,
          nameProduct: p.nameProduct,
          stock: p.stock,
          minStock: p.minStock,
          unit: p.unit,
          stores: (productStoreMap[p.id] || []).map(
            (sid) => storeMap[sid] || `Store #${sid}`
          )
        }))

      const ingredientWhere = { status: 'active' }
      if (store) {
        ingredientWhere.store = store
      }
      const ingredients = await db.ingredient.findAll({
        where: ingredientWhere,
        attributes: ['id', 'name', 'stock', 'minStock', 'unit', 'store'],
        include: [
          {
            model: db.location,
            as: 'storeData',
            attributes: ['id', 'name']
          }
        ]
      })

      const lowStockIngredients = ingredients.filter(
        (i) => i.stock <= i.minStock
      )

      return res.status(200).json({
        success: true,
        message: 'Success get low stock items',
        data: {
          products: lowStockProducts,
          ingredients: lowStockIngredients,
          totalProducts: lowStockProducts.length,
          totalIngredients: lowStockIngredients.length
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

  async getLowStockAll(req, res) {
    try {
      const { page = 1, limit = 20, type, search } = req.query
      // F21-02: this previously read the raw client-supplied req.query.store
      // instead of the middleware-validated req.storeId. validateStoreAccess
      // always pins req.storeId to the caller's own store for non-super-admin
      // regardless of what (or whether) a store query param was supplied, so
      // omitting the param used to fall through the `if (store)` filter below
      // and return every store's low-stock data. resolveStoreId is the same
      // hardened helper already used by getDashboardSummary/other controllers
      // — super_admin keeps its existing "explicit store, else all stores"
      // behavior; everyone else is now always scoped to req.storeId.
      const store = resolveStoreId(req)

      const [products, ingredients, locations, productStores] =
        await Promise.all([
          db.product.findAll({
            where: {
              status: 'active',
              minStock: { [Op.gt]: 0 }
            },
            attributes: ['id', 'nameProduct', 'stock', 'minStock', 'unit']
          }),
          db.ingredient.findAll({
            where: { status: 'active' },
            attributes: ['id', 'name', 'stock', 'minStock', 'unit', 'store']
          }),
          db.location.findAll({
            where: { status: 'active' },
            attributes: ['id', 'name']
          }),
          db.product_store.findAll({
            attributes: ['product', 'store']
          })
        ])

      const productStoreMap = {}
      productStores.forEach((ps) => {
        if (!productStoreMap[ps.product]) productStoreMap[ps.product] = []
        productStoreMap[ps.product].push(ps.store)
      })

      const storeMap = {}
      locations.forEach((loc) => {
        storeMap[loc.id] = loc.name
      })

      const normalizeStoreIds = (storeField) => {
        if (!storeField) return []
        if (Array.isArray(storeField)) return storeField
        if (typeof storeField === 'number') return [storeField]
        return []
      }

      const rawItems = []

      for (const p of products) {
        if (p.stock > p.minStock) continue
        const storeIds = normalizeStoreIds(productStoreMap[p.id])
        if (storeIds.length === 0) {
          rawItems.push({
            type: 'product',
            id: p.id,
            name: p.nameProduct,
            stock: p.stock,
            minStock: p.minStock,
            unit: p.unit,
            storeId: null,
            storeName: 'Unknown'
          })
        } else {
          for (const storeId of storeIds) {
            rawItems.push({
              type: 'product',
              id: p.id,
              name: p.nameProduct,
              stock: p.stock,
              minStock: p.minStock,
              unit: p.unit,
              storeId,
              storeName: storeMap[storeId] || `Store #${storeId}`
            })
          }
        }
      }

      for (const ing of ingredients) {
        if (ing.stock > ing.minStock) continue
        const storeId = ing.store
        rawItems.push({
          type: 'ingredient',
          id: ing.id,
          name: ing.name,
          stock: ing.stock,
          minStock: ing.minStock,
          unit: ing.unit,
          storeId: storeId || null,
          storeName: storeId
            ? storeMap[storeId] || `Store #${storeId}`
            : 'Unknown'
        })
      }

      // Apply filters
      let filtered = rawItems

      if (store) {
        const storeNum = parseInt(store)
        filtered = filtered.filter((item) => item.storeId === storeNum)
      }

      if (type) {
        filtered = filtered.filter((item) => item.type === type)
      }

      if (search) {
        const q = search.toLowerCase()
        filtered = filtered.filter((item) =>
          item.name.toLowerCase().includes(q)
        )
      }

      // Sort by stock ascending
      filtered.sort((a, b) => a.stock - b.stock)

      // Pagination
      const total = filtered.length
      const pageNum = Math.max(1, parseInt(page))
      const limitNum = Math.max(1, Math.min(100, parseInt(limit)))
      const totalPages = Math.ceil(total / limitNum)
      const offset = (pageNum - 1) * limitNum
      const items = filtered.slice(offset, offset + limitNum)

      const stats = {
        totalLowStock: filtered.length,
        totalProducts: filtered.filter((i) => i.type === 'product').length,
        totalIngredients: filtered.filter((i) => i.type === 'ingredient')
          .length,
        totalStores: new Set(filtered.map((i) => i.storeId)).size,
        totalOutOfStock: filtered.filter((i) => i.stock <= 0).length
      }

      return res.status(200).json({
        success: true,
        message: 'Success get low stock items all stores',
        data: {
          items,
          stats,
          total,
          pagination: {
            page: pageNum,
            limit: limitNum,
            total,
            totalPages
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

  async autoGeneratePOFromLowStock(req, res) {
    try {
      const store = isSuperAdmin(req)
        ? (req.storeId || req.query?.store || req.body?.store || null)
        : (req.storeId ?? req.user?.store ?? null)
      const createdBy = req.user?.id || null

      const ingredientWhere = { status: 'active' }
      if (store) {
        ingredientWhere.store = store
      }

      const ingredients = await db.ingredient.findAll({
        where: ingredientWhere,
        attributes: [
          'id',
          'name',
          'stock',
          'minStock',
          'unit',
          'supplier',
          'costPrice',
          'store'
        ],
        include: [
          {
            model: db.supplier,
            as: 'supplierData',
            attributes: ['id', 'name']
          }
        ]
      })

      const lowStockIngredients = ingredients.filter(
        (i) => i.stock <= i.minStock
      )

      if (lowStockIngredients.length === 0) {
        return res.status(200).json({
          success: true,
          message: 'Tidak ada bahan baku yang stoknya menipis',
          data: { purchaseOrders: [], totalItems: 0 }
        })
      }

      const groupedBySupplier = {}
      const noSupplier = []

      for (const ing of lowStockIngredients) {
        const supplierId = ing.supplier
        if (supplierId) {
          if (!groupedBySupplier[supplierId]) {
            groupedBySupplier[supplierId] = {
              supplierName: ing.supplierData?.name || `Supplier #${supplierId}`,
              store: ing.store,
              items: []
            }
          }
          groupedBySupplier[supplierId].items.push(ing)
        } else {
          noSupplier.push(ing)
        }
      }

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

      const createdPOs = []

      for (const [supplierId, group] of Object.entries(groupedBySupplier)) {
        const orderNumber = generateOrderNumber('PO')
        const items = group.items.map((ing) => ({
          ingredient: ing.id,
          ingredientName: ing.name,
          quantity: Math.max(ing.minStock - ing.stock, 1),
          price: ing.costPrice || 0,
          unit: ing.unit || 'pcs'
        }))

        const totalAmount = items.reduce(
          (sum, item) => sum + item.quantity * item.price,
          0
        )

        const purchaseOrder = await db.purchase_order.create({
          store: group.store || store || null,
          orderNumber,
          totalAmount,
          discount: 0,
          finalAmount: totalAmount,
          status: 'draft',
          orderDate: new Date(),
          notes: 'Auto-generated dari low stock alert',
          createdBy,
          pic: null,
          dueDate: null
        })

        const orderItems = items.map((item) => ({
          purchaseOrder: purchaseOrder.id,
          product: null,
          ingredient: item.ingredient,
          ingredientName: item.ingredientName,
          supplier: parseInt(supplierId) || null,
          quantity: item.quantity,
          unit: item.unit,
          price: item.price,
          total: item.quantity * item.price,
          receivedQuantity: 0
        }))

        await db.purchase_order_item.bulkCreate(orderItems)

        const createdPO = await db.purchase_order.findOne({
          where: { id: purchaseOrder.id },
          include: [
            {
              model: db.purchase_order_item,
              as: 'items',
              include: [
                {
                  model: db.supplier,
                  as: 'supplierData',
                  attributes: ['id', 'name']
                }
              ]
            }
          ]
        })

        await createAudit(
          req,
          'create',
          'purchase_order',
          purchaseOrder.id,
          'Auto-generated PO from low stock alert'
        )

        createdPOs.push(createdPO)
      }

      if (noSupplier.length > 0) {
        const orderNumber = generateOrderNumber('PO')
        const items = noSupplier.map((ing) => ({
          ingredient: ing.id,
          ingredientName: ing.name,
          quantity: Math.max(ing.minStock - ing.stock, 1),
          price: ing.costPrice || 0,
          unit: ing.unit || 'pcs'
        }))

        const totalAmount = items.reduce(
          (sum, item) => sum + item.quantity * item.price,
          0
        )

        const purchaseOrder = await db.purchase_order.create({
          store: noSupplier[0]?.store || store || null,
          orderNumber,
          supplier: null,
          totalAmount,
          discount: 0,
          finalAmount: totalAmount,
          status: 'draft',
          orderDate: new Date(),
          notes: `Auto-generated dari low stock alert. Items tanpa supplier: ${noSupplier.map((i) => i.name).join(', ')}`,
          createdBy,
          pic: null,
          dueDate: null
        })

        const orderItems = items.map((item) => ({
          purchaseOrder: purchaseOrder.id,
          product: null,
          ingredient: item.ingredient,
          ingredientName: item.ingredientName,
          quantity: item.quantity,
          unit: item.unit,
          price: item.price,
          total: item.quantity * item.price,
          receivedQuantity: 0
        }))

        await db.purchase_order_item.bulkCreate(orderItems)

        const createdPO = await db.purchase_order.findOne({
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
          'Auto-generated PO from low stock alert (no supplier)'
        )

        createdPOs.push(createdPO)
      }

      return res.status(201).json({
        success: true,
        message: `Berhasil generate ${createdPOs.length} PO draft dari ${lowStockIngredients.length} bahan baku low stock`,
        data: {
          purchaseOrders: createdPOs,
          totalItems: lowStockIngredients.length,
          withSupplier: Object.keys(groupedBySupplier).length,
          withoutSupplier: noSupplier.length
        }
      })
    } catch (error) {
      console.log(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  }
}

module.exports = stockHistoryController
