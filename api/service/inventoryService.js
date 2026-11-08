const db = require('../../db/models')
const { Op } = require('sequelize')

const DEFAULT_DAYS = 30
const DEAD_STOCK_THRESHOLD = 60
const EXPIRY_ALERT_DAYS = 30
const MS_PER_DAY = 24 * 60 * 60 * 1000

const inventoryService = {
  async calculateDailyConsumption(productId, storeId, days = DEFAULT_DAYS) {
    const since = new Date()
    since.setDate(since.getDate() - days)
    since.setHours(0, 0, 0, 0)

    const rows = await db.stock_history.findAll({
      where: {
        product: productId,
        ...(storeId ? { store: storeId } : {}),
        referenceType: 'sale',
        createdAt: { [Op.gte]: since }
      },
      attributes: [
        [
          db.sequelize.fn('SUM', db.sequelize.col('quantityChange')),
          'totalSold'
        ]
      ]
    })

    const totalSold = Math.abs(Number(rows[0]?.get('totalSold') || 0))
    return days > 0 ? Number((totalSold / days).toFixed(4)) : 0
  },

  // Pure computation shared by the single-product and bulk forecast paths —
  // takes already-resolved consumption/stock so the bulk path can compute
  // them in batch instead of one query pair per product.
  _computeForecast(product, consumption, currentStock, storeId) {
    const minStock = Number(product.minStock) || 0
    const safetyStock = Math.max(minStock, Math.ceil(consumption * 3))
    const reorderPoint = Math.ceil(consumption * 7) + safetyStock

    let forecastedStockoutDate = null
    let daysUntilStockout = null
    if (consumption > 0) {
      daysUntilStockout = Math.floor((currentStock - safetyStock) / consumption)
      if (daysUntilStockout < 0) daysUntilStockout = 0
      const d = new Date()
      d.setDate(d.getDate() + daysUntilStockout)
      forecastedStockoutDate = d.toISOString().split('T')[0]
    }

    const confidence =
      consumption > 0
        ? Math.min(90, Math.round((DEFAULT_DAYS / 30) * 80 + 10))
        : 50

    return {
      productId: product.id,
      productName: product.nameProduct,
      storeId: storeId || null,
      currentStock,
      dailyConsumption: consumption,
      minStock,
      safetyStock,
      reorderPoint,
      daysUntilStockout,
      forecastedStockoutDate,
      confidence,
      status:
        currentStock <= safetyStock
          ? 'critical'
          : currentStock <= reorderPoint
            ? 'low'
            : 'healthy'
    }
  },

  async buildForecast(productId, storeId) {
    const product = await db.product.findByPk(productId)
    if (!product) throw new Error(`Product ${productId} not found`)

    const consumption = await this.calculateDailyConsumption(productId, storeId)
    let currentStock = Number(product.stock) || 0
    if (storeId) {
      const pss = await db.product_store_stock.findOne({
        where: { product: productId, store: storeId }
      })
      if (pss) currentStock = Number(pss.stock) || 0
    }

    return this._computeForecast(product, consumption, currentStock, storeId)
  },

  // Batched consumption lookup for a set of products in one query instead of
  // one aggregate query per product.
  async calculateDailyConsumptionBulk(productIds, storeId, days = DEFAULT_DAYS) {
    const map = new Map(productIds.map((id) => [id, 0]))
    if (productIds.length === 0) return map

    const since = new Date()
    since.setDate(since.getDate() - days)
    since.setHours(0, 0, 0, 0)

    const rows = await db.stock_history.findAll({
      where: {
        product: { [Op.in]: productIds },
        ...(storeId ? { store: storeId } : {}),
        referenceType: 'sale',
        createdAt: { [Op.gte]: since }
      },
      attributes: [
        'product',
        [
          db.sequelize.fn('SUM', db.sequelize.col('quantityChange')),
          'totalSold'
        ]
      ],
      group: ['product']
    })

    for (const row of rows) {
      const totalSold = Math.abs(Number(row.get('totalSold') || 0))
      map.set(
        Number(row.get('product')),
        days > 0 ? Number((totalSold / days).toFixed(4)) : 0
      )
    }
    return map
  },

  // Build forecasts for many products with a fixed set of batch queries
  // (2 total) instead of ~2 queries per product.
  async buildForecastsBulk(products, storeId) {
    if (products.length === 0) return []
    const productIds = products.map((p) => p.id)

    const [consumptionMap, storeStockMap] = await Promise.all([
      this.calculateDailyConsumptionBulk(productIds, storeId),
      storeId
        ? db.product_store_stock
            .findAll({ where: { product: { [Op.in]: productIds }, store: storeId } })
            .then((rows) => new Map(rows.map((r) => [Number(r.product), Number(r.stock) || 0])))
        : Promise.resolve(new Map())
    ])

    return products.map((product) => {
      const consumption = consumptionMap.get(product.id) || 0
      const currentStock = storeStockMap.has(product.id)
        ? storeStockMap.get(product.id)
        : Number(product.stock) || 0
      return this._computeForecast(product, consumption, currentStock, storeId)
    })
  },

  async saveForecast(forecast) {
    const where = {
      product: forecast.productId,
      store: forecast.storeId || null
    }
    const existing = await db.stock_forecast.findOne({ where })
    if (existing) {
      return existing.update({
        current_quantity: forecast.currentStock,
        daily_consumption_rate: forecast.dailyConsumption,
        safety_stock: forecast.safetyStock,
        reorder_point: forecast.reorderPoint,
        forecasted_stockout_date: forecast.forecastedStockoutDate,
        days_until_stockout: forecast.daysUntilStockout,
        confidence_level: forecast.confidence,
        forecast_date: new Date()
      })
    }
    return db.stock_forecast.create({
      product: forecast.productId,
      store: forecast.storeId || null,
      current_quantity: forecast.currentStock,
      daily_consumption_rate: forecast.dailyConsumption,
      safety_stock: forecast.safetyStock,
      reorder_point: forecast.reorderPoint,
      forecasted_stockout_date: forecast.forecastedStockoutDate,
      days_until_stockout: forecast.daysUntilStockout,
      confidence_level: forecast.confidence,
      forecast_date: new Date()
    })
  },

  // Batched persistence: one fetch of existing rows + one update per row
  // that already exists + a single bulkCreate for new rows, instead of a
  // findOne+create/update pair per product.
  async saveForecastsBulk(forecasts, storeId) {
    if (forecasts.length === 0) return
    const store = storeId || null
    const productIds = forecasts.map((f) => f.productId)

    const existing = await db.stock_forecast.findAll({
      where: { product: { [Op.in]: productIds }, store }
    })
    const existingByProduct = new Map(existing.map((e) => [Number(e.product), e]))

    const toCreate = []
    const updates = []
    for (const forecast of forecasts) {
      const fields = {
        current_quantity: forecast.currentStock,
        daily_consumption_rate: forecast.dailyConsumption,
        safety_stock: forecast.safetyStock,
        reorder_point: forecast.reorderPoint,
        forecasted_stockout_date: forecast.forecastedStockoutDate,
        days_until_stockout: forecast.daysUntilStockout,
        confidence_level: forecast.confidence,
        forecast_date: new Date()
      }
      const row = existingByProduct.get(forecast.productId)
      if (row) {
        updates.push(row.update(fields))
      } else {
        toCreate.push({ product: forecast.productId, store, ...fields })
      }
    }

    await Promise.all(updates)
    if (toCreate.length > 0) {
      await db.stock_forecast.bulkCreate(toCreate)
    }
  },

  async detectDeadStock(storeId, thresholdDays = DEAD_STOCK_THRESHOLD) {
    const since = new Date()
    since.setDate(since.getDate() - thresholdDays)
    since.setHours(0, 0, 0, 0)

    const rows = await db.sequelize.query(
      `SELECT p.id as "productId", p."nameProduct",
              p."costPrice" as "costPrice",
              COALESCE(pss.stock, p.stock) as stock,
              MAX(sh."createdAt") as "lastSale"
       FROM product p
       LEFT JOIN product_store_stock pss ON pss.product = p.id AND pss.store = :storeId
       LEFT JOIN stock_history sh ON sh.product = p.id
         AND sh."referenceType" = 'sale'
         AND sh.store = :storeId
       WHERE p.status = 'active'
       GROUP BY p.id, p."nameProduct", p."costPrice", pss.stock, p.stock
       HAVING MAX(sh."createdAt") IS NULL OR MAX(sh."createdAt") < :since
       ORDER BY COALESCE(pss.stock, p.stock) DESC`,
      {
        replacements: { storeId, since },
        type: db.sequelize.QueryTypes.SELECT
      }
    )

    const results = []
    for (const row of rows) {
      const qty = Number(row.stock) || 0
      if (qty <= 0) continue
      const lastSale = row.lastSale ? new Date(row.lastSale) : null
      const daysWithout = lastSale
        ? Math.floor((Date.now() - lastSale.getTime()) / 86400000)
        : thresholdDays
      if (daysWithout < thresholdDays) continue

      const level =
        qty >= 100
          ? 'critical'
          : qty >= 50
            ? 'high'
            : qty >= 20
              ? 'medium'
              : 'low'

      results.push({
        productId: row.productId,
        productName: row.nameProduct,
        productData: { id: row.productId, nameProduct: row.nameProduct },
        quantity: qty,
        stock: qty,
        costPrice: Number(row.costPrice) || 0,
        daysWithoutSale: daysWithout,
        lastSaleDate: lastSale ? lastSale.toISOString().split('T')[0] : null,
        alertLevel: level
      })

      await db.dead_stock_alert.destroy({
        where: { product: row.productId, store: storeId },
        force: true
      })
      await db.dead_stock_alert.create({
        product: row.productId,
        store: storeId,
        quantity: qty,
        days_without_sale: daysWithout,
        last_sale_date: lastSale ? lastSale.toISOString().split('T')[0] : null,
        alert_level: level,
        alert_status: 'active'
      })
    }
    return results
  },

  // storeIds: the stores whose batches to list, or null for every store
  // (a global caller only).
  async getExpiringBatches(storeIds, withinDays = EXPIRY_ALERT_DAYS) {
    const today = new Date()
    const limit = new Date()
    limit.setDate(limit.getDate() + withinDays)

    const where = {
      expiryDate: {
        [Op.gte]: today,
        [Op.lte]: limit
      },
      status: 'active'
    }
    if (storeIds !== null && storeIds !== undefined) {
      where.store = storeIds.length ? storeIds : -1
    }

    const batches = await db.product_batch.findAll({
      where,
      include: [
        {
          model: db.product,
          as: 'productData',
          attributes: ['id', 'nameProduct']
        },
        {
          model: db.location,
          as: 'storeData',
          attributes: ['id', 'name']
        }
      ],
      order: [['expiryDate', 'ASC']]
    })

    return batches.map((b) => ({
      id: b.id,
      productId: b.product,
      productName: b.productData?.nameProduct,
      productData: { id: b.product, nameProduct: b.productData?.nameProduct },
      batchCode: b.batchCode,
      expiryDate: b.expiryDate,
      qty: b.qty,
      stock: b.qty,
      storeId: b.store,
      daysLeft: Math.floor((new Date(b.expiryDate) - today) / 86400000)
    }))
  },

  async calculateValuation(productId, storeId, method = 'FIFO') {
    const batches = await db.product_batch.findAll({
      where: { product: productId, status: 'active' },
      include: [{ model: db.product_batch_stock, as: 'stocks' }],
      order: [
        ['received_date', 'ASC'],
        ['expiryDate', 'ASC'],
        ['id', 'ASC']
      ]
    })

    const available = (b) => {
      if (!storeId) return Number(b.qty) || 0
      const bs = (b.stocks || []).find(
        (s) => Number(s.store) === Number(storeId)
      )
      return bs ? Number(bs.quantity) || 0 : 0
    }

    let totalCost = 0
    let totalQty = 0
    let avgCost = 0

    if (method === 'SPECIFIC_ID') {
      batches.forEach((b) => {
        const q = available(b)
        totalCost += Number(b.cost_per_unit || 0) * q
        totalQty += q
      })
    } else if (method === 'FIFO') {
      // true FIFO: value remaining stock at cost of the oldest remaining layers
      batches.forEach((b) => {
        const q = available(b)
        totalCost += Number(b.cost_per_unit || 0) * q
        totalQty += q
      })
      avgCost = totalQty > 0 ? totalCost / totalQty : 0
    } else {
      const costs = batches.map((b) => Number(b.cost_per_unit || 0))
      const qtys = batches.map((b) => available(b))
      const weightedSum = costs.reduce((s, c, i) => s + c * (qtys[i] || 0), 0)
      totalQty = qtys.reduce((s, q) => s + q, 0)
      avgCost = totalQty > 0 ? weightedSum / totalQty : 0
      totalCost = totalQty > 0 ? avgCost * totalQty : 0
    }

    const valuation = {
      productId,
      storeId: storeId || null,
      method,
      totalQuantity: totalQty,
      totalCost: Number(totalCost.toFixed(2)),
      averageCost: Number(avgCost.toFixed(2)),
      batches: batches.map((b) => ({
        id: b.id,
        batchCode: b.batchCode,
        qty: available(b),
        costPerUnit: b.cost_per_unit,
        expiryDate: b.expiryDate
      }))
    }

    await db.inventory_valuation.create({
      product: productId,
      store: storeId || null,
      valuation_date: new Date(),
      quantity: totalQty,
      total_cost: totalCost,
      average_cost: avgCost,
      cogs_method: method,
      valuation_type: 'perpetual'
    })

    return valuation
  },

  // scopedProducts: the active products the caller may value (see
  // scopedActiveProducts in the inventory controller); every active product
  // when omitted.
  async aggregateValuation(storeId, method = 'FIFO', scopedProducts = null) {
    const products =
      scopedProducts ||
      (await db.product.findAll({
        where: { status: 'active' },
        attributes: ['id', 'nameProduct', 'costPrice', 'stock']
      }))

    // Batch-fetch per-store stock for every product in one query instead of
    // one product_store_stock.findOne per product.
    const storeStockByProduct =
      storeId && products.length
        ? new Map(
            (
              await db.product_store_stock.findAll({
                where: {
                  product: products.map((p) => p.id),
                  store: storeId
                }
              })
            ).map((pss) => [Number(pss.product), Number(pss.stock) || 0])
          )
        : null

    const productsOut = []
    let totalValue = 0
    let totalStock = 0

    for (const p of products) {
      const stock = storeStockByProduct?.has(p.id)
        ? storeStockByProduct.get(p.id)
        : Number(p.stock) || 0
      if (stock <= 0) continue

      const costPrice = Number(p.costPrice) || 0
      productsOut.push({
        id: p.id,
        nameProduct: p.nameProduct,
        stock,
        costPrice
      })
      totalValue += stock * costPrice
      totalStock += stock
    }

    return {
      storeId: storeId || null,
      method,
      totalValue: Number(totalValue.toFixed(2)),
      totalProducts: productsOut.length,
      avgCost:
        totalStock > 0 ? Number((totalValue / totalStock).toFixed(2)) : 0,
      products: productsOut
    }
  },

  async aggregateSupplierPerformance(month = null) {
    const monthStr = month || new Date().toISOString().slice(0, 7)
    const monthStart = `${monthStr}-01`

    const where = {
      status: { [Op.ne]: 'cancelled' },
      orderDate: { [Op.gte]: monthStart }
    }
    const orders = await db.purchase_order.findAll({ where })

    const map = {}
    for (const po of orders) {
      const sup = po.supplier
      if (!sup) continue
      if (!map[sup]) {
        map[sup] = {
          supplier: sup,
          totalOrders: 0,
          onTime: 0,
          late: 0,
          leadTimes: [],
          totalValue: 0,
          totalQty: 0
        }
      }
      const rec = map[sup]
      rec.totalOrders += 1
      rec.totalValue += Number(po.finalAmount || po.totalAmount || 0)

      if (po.status === 'received' && po.dueDate && po.receivedDate) {
        const due = new Date(po.dueDate)
        const recd = new Date(po.receivedDate)
        if (recd <= due) rec.onTime += 1
        else rec.late += 1
        rec.leadTimes.push(
          Math.ceil((recd - new Date(po.orderDate)) / MS_PER_DAY)
        )
      }
    }

    const results = []
    for (const [supId, data] of Object.entries(map)) {
      const onTimeRate =
        data.totalOrders > 0
          ? Number(((data.onTime / data.totalOrders) * 100).toFixed(2))
          : 0
      const avgLead =
        data.leadTimes.length > 0
          ? Number(
              (
                data.leadTimes.reduce((s, l) => s + l, 0) /
                data.leadTimes.length
              ).toFixed(2)
            )
          : null
      const score = Math.min(
        100,
        Math.round(
          onTimeRate * 0.6 + (avgLead !== null && avgLead <= 7 ? 20 : 10)
        )
      )

      const monthDate = `${monthStr}-01`
      await db.supplier_performance.destroy({
        where: { supplier: supId, month: monthDate },
        force: true
      })
      const perf = await db.supplier_performance.create({
        supplier: supId,
        month: monthDate,
        total_orders: data.totalOrders,
        on_time_deliveries: data.onTime,
        late_deliveries: data.late,
        total_value: data.totalValue,
        total_quantity: data.totalQty,
        avg_lead_time_days: avgLead,
        score
      })
      results.push(perf)
    }
    return results
  }
}

module.exports = inventoryService
