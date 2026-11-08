const db = require('../../db/models')
const { Op } = require('sequelize')
const inventoryService = require('../service/inventoryService')
const reconcileService = require('../service/reconcileService')
const batchService = require('../service/batchService')
const {
  scalarStoreScope,
  isSuperAdmin,
  callerStoreIds,
  productInCallerScope
} = require('../../utils/tenantScope')

// HIGH-5: The original `getStoreId(req)` helper accepted untrusted inputs:
//   req.query.storeId  — validateStoreAccess is blind to `query.storeId`
//   req.query.store    — partially validated, but `storeId` key bypasses it
//   req.cookies?.store — never validated by validateStoreAccess
//   req.user?.store    — safe, but superseded by the attack-controlled inputs above
//
// The helper is replaced with a single trusted source: req.storeId (pinned
// by validateStoreAccess from the JWT store claim). For super_admin with an
// explicit ?store param that IS validated by validateStoreAccess, req.storeId
// is already set to that value. No cookie, no query.storeId, no fail-open.
//
// getTenantStoreId() is the ONLY authoritative store source in this file.
const getTenantStoreId = (req) => req.storeId ?? req.user?.store ?? null

// Sweep stage 2: the active products a caller may forecast or value — those
// sold by a store in its roster, or unassigned (the PGA-01 family
// convention); every product for a global caller.
const scopedActiveProducts = async (req) => {
  const ids = await callerStoreIds(req)
  const where = { status: 'active' }
  if (ids !== null) {
    const rows = ids.length
      ? await db.product_store.findAll({
          where: { store: ids },
          attributes: ['product'],
          raw: true
        })
      : []
    where[Op.or] = [
      { id: [...new Set(rows.map((r) => Number(r.product)))] },
      db.sequelize.literal(
        'NOT EXISTS (SELECT 1 FROM product_store ps WHERE ps.product = "product".id AND ps."deletedAt" IS NULL)'
      )
    ]
  }
  return db.product.findAll({
    where,
    attributes: ['id', 'nameProduct', 'stock', 'minStock', 'costPrice']
  })
}

const productNotFound = (res) =>
  res.status(404).json({ success: false, message: 'Product not found' })

const inventoryController = {
  async getForecasts(req, res) {
    try {
      // HIGH-5 fix: use trusted server-side store only.
      const storeId = getTenantStoreId(req)
      // Fail closed: non-super-admin without a store cannot see any forecasts.
      if (!storeId && !isSuperAdmin(req)) {
        return res
          .status(400)
          .json({ success: false, message: 'Store required' })
      }
      const where = scalarStoreScope(req, {})
      if (req.query.productId) where.product = parseInt(req.query.productId)

      const forecasts = await db.stock_forecast.findAll({
        where,
        include: [
          {
            model: db.product,
            as: 'productData',
            attributes: ['id', 'nameProduct', 'sku']
          },
          { model: db.location, as: 'storeData', attributes: ['id', 'name'] }
        ],
        order: [
          ['days_until_stockout', 'ASC'],
          ['forecast_date', 'DESC']
        ],
        limit: parseInt(req.query.limit || 50)
      })

      const data = forecasts.map((f) => {
        const j = f.toJSON()
        return {
          ...j,
          currentStock: j.current_quantity,
          dailyConsumption: j.daily_consumption_rate,
          safetyStock: j.safety_stock,
          reorderPoint: j.reorder_point,
          forecastedStockoutDate: j.forecasted_stockout_date,
          confidence: j.confidence_level,
          forecastDate: j.forecast_date
        }
      })

      return res.status(200).json({ success: true, data })
    } catch (error) {
      console.error('Error:', error)
      return res.status(500).json({ success: false, message: error.message })
    }
  },

  async runForecast(req, res) {
    try {
      // HIGH-5 fix: use trusted server-side store only.
      const storeId = getTenantStoreId(req)
      const productId = req.query.productId
        ? parseInt(req.query.productId)
        : null

      if (productId) {
        if (!(await productInCallerScope(req, productId)))
          return productNotFound(res)
        const f = await inventoryService.buildForecast(productId, storeId)
        await inventoryService.saveForecast(f)
        return res.status(200).json({ success: true, data: f })
      }

      const products = await scopedActiveProducts(req)
      // Bulk path: a fixed handful of batch queries instead of ~5 sequential
      // queries per product, which timed out once the catalog grew past a
      // few hundred SKUs.
      const results = await inventoryService.buildForecastsBulk(
        products,
        storeId
      )
      await inventoryService.saveForecastsBulk(results, storeId)
      return res
        .status(200)
        .json({ success: true, data: results, total: results.length })
    } catch (error) {
      console.error('Error:', error)
      return res.status(500).json({ success: false, message: error.message })
    }
  },

  async getDeadStock(req, res) {
    try {
      // HIGH-5 fix: use trusted server-side store only.
      const storeId = getTenantStoreId(req)
      if (!storeId) {
        return res
          .status(400)
          .json({ success: false, message: 'storeId/store required' })
      }
      const threshold = parseInt(req.query.threshold || 60)
      const results = await inventoryService.detectDeadStock(storeId, threshold)
      return res
        .status(200)
        .json({ success: true, data: results, total: results.length })
    } catch (error) {
      console.error('Error:', error)
      return res.status(500).json({ success: false, message: error.message })
    }
  },

  async getExpiringSoon(req, res) {
    try {
      // HIGH-5 fix: use trusted server-side store only.
      const storeId = getTenantStoreId(req)
      const withinDays = parseInt(req.query.days || 30)
      // Sweep stage 2: the batches of the active store, or of the caller's
      // whole roster; the service no longer reads every tenant's batches.
      const storeIds = storeId ? [Number(storeId)] : await callerStoreIds(req)
      const results = await inventoryService.getExpiringBatches(
        storeIds,
        withinDays
      )
      return res
        .status(200)
        .json({ success: true, data: results, total: results.length })
    } catch (error) {
      console.error('Error:', error)
      return res.status(500).json({ success: false, message: error.message })
    }
  },

  async getValuation(req, res) {
    try {
      const { method = 'FIFO' } = req.query
      // HIGH-5 fix: use trusted server-side store only.
      const storeId = getTenantStoreId(req)
      const productId = req.query.productId
        ? parseInt(req.query.productId)
        : null

      if (productId) {
        if (!(await productInCallerScope(req, productId)))
          return productNotFound(res)
        const result = await inventoryService.calculateValuation(
          productId,
          storeId,
          method
        )
        return res.status(200).json({ success: true, data: result })
      }

      const result = await inventoryService.aggregateValuation(
        storeId,
        method,
        await scopedActiveProducts(req)
      )
      return res.status(200).json({ success: true, data: result })
    } catch (error) {
      console.error('Error:', error)
      return res.status(500).json({ success: false, message: error.message })
    }
  },

  async getSupplierPerformance(req, res) {
    try {
      const month = req.query.month || null
      const results = await inventoryService.aggregateSupplierPerformance(month)
      return res
        .status(200)
        .json({ success: true, data: results, total: results.length })
    } catch (error) {
      console.error('Error:', error)
      return res.status(500).json({ success: false, message: error.message })
    }
  },

  async getBatches(req, res) {
    try {
      // HIGH-5 fix: use trusted server-side store only.
      // Non-super-admin: scalarStoreScope always adds store = <tenantStore>.
      // Super-admin without ?store: no store filter (intentional global access).
      const where = scalarStoreScope(req, {})
      if (req.query.productId) where.product = parseInt(req.query.productId)
      if (req.query.status) where.status = req.query.status

      const batches = await db.product_batch.findAll({
        where,
        include: [
          {
            model: db.product,
            as: 'productData',
            attributes: ['id', 'nameProduct']
          },
          { model: db.location, as: 'storeData', attributes: ['id', 'name'] },
          {
            model: db.supplier,
            as: 'supplierData',
            attributes: ['id', 'name']
          },
          { model: db.product_batch_stock, as: 'stocks' }
        ],
        order: [['expiryDate', 'ASC']]
      })
      return res
        .status(200)
        .json({ success: true, data: batches, total: batches.length })
    } catch (error) {
      console.error('Error:', error)
      return res.status(500).json({ success: false, message: error.message })
    }
  },

  async getBatchById(req, res) {
    try {
      const { id } = req.params
      // IDOR fix: was findByPk(id) with no store filter, reachable by any
      // authenticated role, leaking another store's batch expiry/supplier data.
      const batch = await db.product_batch.findOne({
        where: scalarStoreScope(req, { id }),
        include: [
          {
            model: db.product,
            as: 'productData',
            attributes: ['id', 'nameProduct']
          },
          { model: db.location, as: 'storeData', attributes: ['id', 'name'] },
          {
            model: db.supplier,
            as: 'supplierData',
            attributes: ['id', 'name']
          },
          { model: db.product_batch_stock, as: 'stocks' }
        ]
      })
      if (!batch) {
        return res
          .status(404)
          .json({ success: false, message: 'Batch not found' })
      }
      return res.status(200).json({ success: true, data: batch })
    } catch (error) {
      console.error('Error:', error)
      return res.status(500).json({ success: false, message: error.message })
    }
  },

  async getReconcile(req, res) {
    try {
      // HIGH-5 fix: use trusted server-side store only.
      const storeId = getTenantStoreId(req)
      const productId = req.query.productId
        ? parseInt(req.query.productId)
        : null
      const minDiff = Number(req.query.minDiff || 1)
      const rows = await reconcileService.getDiscrepancies({
        storeId,
        productId,
        minDiff
      })
      return res
        .status(200)
        .json({ success: true, data: rows, total: rows.length })
    } catch (error) {
      console.error('Error:', error)
      return res.status(500).json({ success: false, message: error.message })
    }
  },

  async postReconcile(req, res) {
    try {
      // HIGH-5 fix: use trusted server-side store only; body storeId/cookie removed.
      const storeId = getTenantStoreId(req)
      const productId = req.body.productId ? parseInt(req.body.productId) : null
      const direction = req.body.direction || 'store-to-global'
      if (!['store-to-global', 'global-to-store'].includes(direction)) {
        return res.status(400).json({
          success: false,
          message: 'direction must be store-to-global or global-to-store'
        })
      }
      const result = await reconcileService.reconcile({
        direction,
        storeId,
        productId,
        createdBy: req.user?.id || null
      })
      return res.status(200).json({ success: true, ...result })
    } catch (error) {
      console.error('Error:', error)
      return res.status(500).json({ success: false, message: error.message })
    }
  },

  async postWriteOffExpired(req, res) {
    try {
      // HIGH-5 fix: use trusted server-side store only; body storeId/cookie removed.
      const storeId = getTenantStoreId(req)
      const productId = req.body.productId ? parseInt(req.body.productId) : null
      const result = await batchService.writeOffExpired({
        storeId,
        productId,
        createdBy: req.user?.id || null
      })
      return res.status(200).json({ success: true, ...result })
    } catch (error) {
      console.error('Error:', error)
      return res.status(500).json({ success: false, message: error.message })
    }
  }
}

module.exports = inventoryController
