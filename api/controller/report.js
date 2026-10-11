'use strict'
const { Op } = require('sequelize')
const db = require('../../db/models')
const reportDefs = require('../service/reportDefs')
const { bucketCashFlowTenders } = require('../service/canonicalPayment')
const { getStoreTodayBounds, getStoreDayBounds, DEFAULT_TIMEZONE } = require('../../utils/businessDate')
const Order = db.order

exports.getDailyReport = async (req, res) => {
  try {
    const { rows } = await reportDefs.daily.getData(req)
    return res.json({ success: true, data: rows })
  } catch (err) {
    if (err.statusCode === 403) {
      return res.status(403).json({ success: false, message: err.message })
    }
    console.error('Daily report error:', err)
    return res.status(500).json({ success: false, message: err.message })
  }
}

exports.getSalesSummary = async (req, res) => {
  try {
    // req.storeId is already the fully-verified store scope (see the
    // longer comment in getBestSellerReport below) — no need for, and no
    // safe reason to add, a client-writable cookie fallback on top of it.
    const store = req.storeId
    if (!store && req.user?.roleType !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Store assignment required' })
    }
    const { startDate, endDate, filter } = req.query

    let dateRange = {}
    const now = new Date()
    // Store-local business date: resolve timezone from location, fallback to DEFAULT_TIMEZONE.
    // For global super_admin without store, keep UTC behavior and document limitation.
    let storeTimezone = DEFAULT_TIMEZONE
    if (store) {
      try {
        const loc = await db.location.findByPk(store, { attributes: ['timezone'] })
        if (loc?.timezone) storeTimezone = loc.timezone
      } catch {}
    }
    const todayBounds = getStoreTodayBounds(storeTimezone, now)
    const todayStart = todayBounds.start
    if (filter === 'today') {
      dateRange = {
        [Op.gte]: todayBounds.start,
        [Op.lte]: todayBounds.end
      }
    } else if (filter === 'weekly') {
      // Weekly in store-local calendar: Monday 00:00 to Sunday 23:59:59.999 in store timezone
      const localTodayStr = require('../../utils/businessDate').getStoreLocalDate(storeTimezone, now)
      const [y, m, d] = localTodayStr.split('-').map(Number)
      const dayOfWeek = new Date(`${localTodayStr}T00:00:00${require('../../utils/businessDate').getTimezoneOffset(storeTimezone)}`).getDay()
      const daysSinceMonday = (dayOfWeek + 6) % 7
      // For weekly, compute Monday in store timezone via offset arithmetic
      const mondayBounds = getStoreDayBounds(
        new Date(Date.UTC(y, m - 1, d - daysSinceMonday)).toISOString().slice(0,10),
        storeTimezone
      )
      // Approximate weekly as 7 days from mondayBounds.start
      dateRange = {
        [Op.gte]: mondayBounds.start,
        [Op.lte]: new Date(mondayBounds.start.getTime() + 7 * 86400000 - 1)
      }
    } else if (filter === 'monthly') {
      const localDateStr = require('../../utils/businessDate').getStoreLocalDate(storeTimezone, now)
      const [y, m] = localDateStr.split('-').map(Number)
      const monthStartStr = `${y}-${String(m).padStart(2,'0')}-01`
      const monthEndDate = new Date(y, m, 0) // last day of month
      const monthEndStr = `${y}-${String(m).padStart(2,'0')}-${String(monthEndDate.getDate()).padStart(2,'0')}`
      const monthStartBounds = getStoreDayBounds(monthStartStr, storeTimezone)
      const monthEndBounds = getStoreDayBounds(monthEndStr, storeTimezone)
      dateRange = { [Op.gte]: monthStartBounds.start, [Op.lte]: monthEndBounds.end }
    } else if (startDate && endDate) {
      const startBounds = getStoreDayBounds(String(startDate).slice(0,10), storeTimezone)
      const endBounds = getStoreDayBounds(String(endDate).slice(0,10), storeTimezone)
      dateRange = { [Op.gte]: startBounds.start, [Op.lte]: endBounds.end }
    } else {
      // No recognized filter and no explicit date range — this used to
      // mean "aggregate over the entire order table, unfiltered", a full
      // scan of the single highest-write-volume table (worse the older
      // and larger the deployment gets), silently triggered by the plain
      // "no filter selected" state. Default to a bounded recent window
      // instead of an unbounded one; callers that actually want a wider
      // range still can by passing filter/startDate/endDate explicitly.
      const thirtyDaysAgo = new Date(todayStart.getTime() - 29 * 86400000)
      dateRange = {
        [Op.gte]: thirtyDaysAgo,
        [Op.lte]: new Date(todayStart.getTime() + 86400000 - 1)
      }
    }

    const orderWhere = { paymentStatus: 'paid', status: { [Op.notIn]: ['cancelled', 'void'] } }
    if (store) orderWhere.store = store
    if (dateRange[Op.gte]) orderWhere.createdAt = dateRange

    const [totalSales, totalOrders, activeLocations, totalMembers] =
      await Promise.all([
        Order.sum('totalPrice', { where: orderWhere }),
        Order.count({ where: orderWhere }),
        db.location.count({
          where: { status: 'active', ...(store ? { id: store } : {}) }
        }),
        db.member.count({ where: store ? { store } : {} })
      ])

    const totalSalesNum = Number(totalSales || 0)
    const totalOrdersNum = Number(totalOrders || 0)
    const avgTransaction =
      totalOrdersNum > 0 ? totalSalesNum / totalOrdersNum : 0

    const chartReplacements = { ...(store && { store }), storeTimezone }
    let chartWhere = `WHERE "paymentStatus" = 'paid' AND "status" NOT IN ('cancelled','void')`
    if (store) chartWhere += ` AND "store" = :store`
    if (dateRange[Op.gte]) {
      chartWhere += ` AND "createdAt" >= :startDate AND "createdAt" <= :endDate`
      chartReplacements.startDate = dateRange[Op.gte]
      chartReplacements.endDate = dateRange[Op.lte]
    }

    let salesChart = await db.sequelize.query(
      `SELECT DATE("createdAt" AT TIME ZONE :storeTimezone) as date, SUM("totalPrice") as sales, COUNT(*) as orders
       FROM "order" ${chartWhere}
       GROUP BY DATE("createdAt" AT TIME ZONE :storeTimezone) ORDER BY date ASC`,
      { replacements: chartReplacements, type: db.sequelize.QueryTypes.SELECT }
    )

    const storeChartReplacements = { ...(store && { store }), storeTimezone }
    let storeChartWhere = `WHERE "paymentStatus" = 'paid' AND "status" NOT IN ('cancelled','void')`
    if (store) storeChartWhere += ` AND "store" = :store`
    if (dateRange[Op.gte]) {
      storeChartWhere += ` AND "createdAt" >= :startDate AND "createdAt" <= :endDate`
      storeChartReplacements.startDate = dateRange[Op.gte]
      storeChartReplacements.endDate = dateRange[Op.lte]
    }

    const rawStoreChart = await db.sequelize.query(
      `SELECT "store", DATE("createdAt" AT TIME ZONE :storeTimezone) as date, SUM("totalPrice") as sales, COUNT(*) as orders
       FROM "order" ${storeChartWhere}
       GROUP BY "store", DATE("createdAt" AT TIME ZONE :storeTimezone) ORDER BY "store", date ASC`,
      {
        replacements: storeChartReplacements,
        type: db.sequelize.QueryTypes.SELECT
      }
    )

    // Per-store totals derived from rawStoreChart (already fetched above,
    // grouped by store + date, with the same paymentStatus/store/date
    // filter as the per-location totals need) instead of issuing 2
    // separate SUM/COUNT queries per location — previously N locations
    // meant 2N round-trips here for data this query had already computed.
    const storeChartMap = {}
    const storeTotals = {}
    for (const row of rawStoreChart) {
      const sid = Number(row.store)
      if (!storeChartMap[sid]) storeChartMap[sid] = { storeId: sid, data: [] }
      storeChartMap[sid].data.push({
        date: row.date,
        sales: Number(row.sales || 0)
      })
      if (!storeTotals[sid]) storeTotals[sid] = { sales: 0, orders: 0 }
      storeTotals[sid].sales += Number(row.sales || 0)
      storeTotals[sid].orders += Number(row.orders || 0)
    }

    const storeWhere = store ? { id: store } : {}
    const locations = await db.location.findAll({
      where: storeWhere,
      attributes: ['id', 'name', 'city']
    })

    const stores = locations.map((loc) => ({
      id: loc.id,
      name: loc.name,
      city: loc.city,
      sales: storeTotals[loc.id]?.sales || 0,
      transactions: storeTotals[loc.id]?.orders || 0
    }))

    const storeSalesChart = stores.map((s) => ({
      storeId: s.id,
      storeName: s.name,
      data: (storeChartMap[s.id]?.data || []).map((d) => ({
        date: d.date,
        sales: d.sales
      }))
    }))

    const padChartData = (data, start, end) => {
      if (!data.length) return data
      const s = new Date(start)
      const e = new Date(end)
      const map = {}
      for (const d of data) map[d.date] = d
      const result = []
      const cur = new Date(s)
      while (cur <= e) {
        const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`
        result.push(map[key] || { date: key, sales: 0, orders: 0 })
        cur.setDate(cur.getDate() + 1)
      }
      return result
    }
    if (dateRange[Op.gte] && dateRange[Op.lte]) {
      salesChart = padChartData(
        salesChart,
        dateRange[Op.gte],
        dateRange[Op.lte]
      )
      for (const s of storeSalesChart)
        s.data = padChartData(s.data, dateRange[Op.gte], dateRange[Op.lte])
    }

    return res.status(200).json({
      success: true,
      data: {
        totalSales: totalSalesNum,
        totalOrders: totalOrdersNum,
        avgTransaction: Math.round(avgTransaction),
        totalCustomers: Number(totalMembers || 0),
        totalStores: Number(activeLocations || 0),
        salesChart: Array.isArray(salesChart) ? salesChart : [],
        storeSalesChart,
        stores
      }
    })
  } catch (err) {
    console.error('Sales summary error:', err)
    return res.status(500).json({ success: false, message: err.message })
  }
}

exports.getBestSellerReport = async (req, res) => {
  try {
    // req.storeId is already the fully-verified store scope by the time
    // any route handler runs (validateStoreAccess forces it to the
    // caller's own store for non-super_admin, or the explicitly-requested
    // store — or null, meaning "all stores" — for super_admin). Falling
    // back to req.query.store/req.cookies.store here re-introduces an
    // unverified, client-writable value into a store-scoped query for
    // exactly the (rare) case where req.storeId is legitimately falsy —
    // silently substituting an unverified source instead of just scoping
    // to nothing, which is what a falsy req.storeId is supposed to mean.
    const store = req.storeId
    if (!store && req.user?.roleType !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Store assignment required' })
    }
    const { limit = 10 } = req.query

    const where = store ? { store } : {}

    const [bestSelling, productCount, productRevenues] = await Promise.all([
      db.best_selling.findAll({
        where,
        order: [['totalSelling', 'DESC']],
        limit: parseInt(limit),
        attributes: ['productId', 'nameProduct', 'totalSelling', 'image']
      }),
      store
        ? db.sequelize.query(
            `SELECT COUNT(*)::int AS "count" FROM "product" p
             WHERE p."deletedAt" IS NULL AND p.status = 'active'
               AND EXISTS (
                 SELECT 1 FROM "product_store" ps
                 WHERE ps."product" = p."id" AND ps."store" = :store AND ps."deletedAt" IS NULL
               )`,
            { replacements: { store }, type: db.sequelize.QueryTypes.SELECT }
          )
        : db.product.count({ where: { status: 'active' } }),
      db.sequelize.query(
        `SELECT oi.product, COALESCE(SUM(oi."totalPrice"), 0) as revenue
         FROM order_item oi
         JOIN "order" o ON o.id = oi."order"
         WHERE o."paymentStatus" = 'paid' AND o.status NOT IN ('cancelled','void')${store ? ' AND o.store = :store' : ''}
         GROUP BY oi.product`,
        {
          replacements: store ? { store } : {},
          type: db.sequelize.QueryTypes.SELECT
        }
      )
    ])

    const activeProducts = Array.isArray(productCount)
      ? Number(productCount[0]?.count || 0)
      : Number(productCount || 0)

    const revenueMap = {}
    for (const r of productRevenues)
      revenueMap[Number(r.product)] = Number(r.revenue || 0)

    const totalUnitsSold = bestSelling.reduce(
      (s, p) => s + Number(p.totalSelling || 0),
      0
    )
    const totalRevenue = bestSelling.reduce(
      (s, p) => s + (revenueMap[Number(p.productId)] || 0),
      0
    )

    return res.status(200).json({
      success: true,
      data: {
        bestSellers: bestSelling.map((p) => ({
          id: p.productId,
          name: p.nameProduct,
          image: p.image,
          sold: Number(p.totalSelling || 0),
          revenue: revenueMap[Number(p.productId)] || 0
        })),
        summary: {
          totalUnitsSold,
          totalRevenue,
          activeProducts
        }
      }
    })
  } catch (err) {
    console.error('Best seller report error:', err)
    return res.status(500).json({ success: false, message: err.message })
  }
}

exports.getCashFlow = async (req, res) => {
  try {
    // Same reasoning as getSalesSummary/getBestSellerReport — req.storeId
    // is already the verified value; using req.query.store directly (the
    // raw, unparsed value) here for super_admin was redundant with what
    // validateStoreAccess already resolved it to.
    const store = req.storeId
    if (!store && req.user?.roleType !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Store assignment required' })
    }
    const { startDate, endDate } = req.query
    const replacements = {}
    let txConditions = '1=1'

    if (store) {
      txConditions += ` AND o."store" = :store`
      replacements.store = store
    }
    if (startDate) {
      txConditions += ` AND o."createdAt" >= :startDate`
      replacements.startDate = new Date(startDate)
    }
    if (endDate) {
      const end = new Date(endDate)
      end.setHours(23, 59, 59, 999)
      txConditions += ` AND o."createdAt" <= :endDate`
      replacements.endDate = end
    }

    // Aggregate payment breakdown by type in SQL
    const paymentRows = await db.sequelize.query(
      `SELECT t."typePayment",
              COALESCE(SUM(t."amount"), 0) as total
       FROM "transaction" t
       JOIN "order" o ON o.id = t."order"
       WHERE ${txConditions}
       GROUP BY t."typePayment"`,
      { replacements, type: db.sequelize.QueryTypes.SELECT }
    )

    // Tender buckets share one taxonomy (canonicalPayment
    // .bucketCashFlowTenders, same helper the export definition uses) so the
    // HTTP report and the export can never diverge: only CASH feeds Tunai.
    const {
      tunai: penerimaanTunai,
      qris: penerimaanQris,
      transfer: penerimaanTransfer,
      lainnya
    } = bucketCashFlowTenders(paymentRows)

    // Aggregate expenses in SQL
    const expReplacements = {}
    let expConditions = `"status" = 'approved'`
    if (store) {
      expConditions += ` AND "store" = :store`
      expReplacements.store = store
    }
    if (startDate) {
      expConditions += ` AND "date" >= :startDate`
      expReplacements.startDate = replacements.startDate
    }
    if (endDate) {
      expConditions += ` AND "date" <= :endDate`
      expReplacements.endDate = replacements.endDate
    }

    const [expAgg] = await db.sequelize.query(
      `SELECT COALESCE(SUM("amount"), 0) as total
       FROM expense
       WHERE ${expConditions}`,
      { replacements: expReplacements, type: db.sequelize.QueryTypes.SELECT }
    )

    // Aggregate supplier payments (cash outflow to suppliers) in SQL
    const ppReplacements = {}
    let ppConditions = '1=1'
    if (store) {
      ppConditions += ` AND "store" = :store`
      ppReplacements.store = store
    }
    if (startDate) {
      ppConditions += ` AND COALESCE("paymentDate", "createdAt") >= :startDate`
      ppReplacements.startDate = replacements.startDate
    }
    if (endDate) {
      ppConditions += ` AND COALESCE("paymentDate", "createdAt") <= :endDate`
      ppReplacements.endDate = replacements.endDate
    }

    const [ppAgg] = await db.sequelize.query(
      `SELECT COALESCE(SUM("amount"), 0) as total
       FROM purchase_payment
       WHERE ${ppConditions}`,
      { replacements: ppReplacements, type: db.sequelize.QueryTypes.SELECT }
    )
    const pengeluaranExpense = Number(expAgg.total || 0)
    const pengeluaranPurchasePayment = Number(ppAgg.total || 0)

    // Aggregate purchase return refunds (cash inflow back from suppliers).
    // Only credit resolutions return money; replacement re-supplies goods.
    // Refund per item = returned qty * PO item price, matching the same key
    // resolution (ingredient -> product -> ingredientName) used at approve.
    const refReplacements = {}
    let refConditions = `r."status" = 'approved' AND r."resolution" = 'credit'`
    if (store) {
      refConditions += ` AND r."store" = :store`
      refReplacements.store = store
    }
    if (startDate) {
      refConditions += ` AND r."createdAt" >= :startDate`
      refReplacements.startDate = replacements.startDate
    }
    if (endDate) {
      refConditions += ` AND r."createdAt" <= :endDate`
      refReplacements.endDate = replacements.endDate
    }

    const [refAgg] = await db.sequelize.query(
      `SELECT COALESCE(SUM(ri."qty" * COALESCE((
         SELECT poi."price"
         FROM purchase_order_item poi
         WHERE poi."purchaseOrder" = r."purchaseOrder"
           AND (
             (ri."ingredient" IS NOT NULL AND poi."ingredient" = ri."ingredient")
             OR (ri."product" IS NOT NULL AND poi."product" = ri."product")
             OR (
               ri."ingredient" IS NULL AND ri."product" IS NULL
               AND poi."ingredientName" = ri."ingredientName"
             )
           )
         LIMIT 1
       ), 0)), 0) as total
       FROM purchase_return r
       INNER JOIN purchase_return_item ri ON ri."purchaseReturn" = r.id
       WHERE ${refConditions}`,
      { replacements: refReplacements, type: db.sequelize.QueryTypes.SELECT }
    )
    const penerimaanReturPembelian = Number(refAgg.total || 0)

    const totalPengeluaran = pengeluaranExpense + pengeluaranPurchasePayment
    const totalKasMasuk =
      penerimaanTunai +
      penerimaanQris +
      penerimaanTransfer +
      lainnya +
      penerimaanReturPembelian

    res.json({
      success: true,
      data: {
        penerimaanTunai,
        penerimaanQris,
        penerimaanTransfer,
        penerimaanReturPembelian,
        pengeluaranExpense,
        pengeluaranPurchasePayment,
        totalKasMasuk,
        totalPengeluaran,
        netCashFlow: totalKasMasuk - totalPengeluaran
      }
    })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
}

exports.getProfitPerProduct = async (req, res) => {
  try {
    const { rows } = await reportDefs.profitPerProduct.getData(req)
    return res.json({ success: true, data: rows })
  } catch (err) {
    if (err.statusCode === 403) {
      return res.status(403).json({ success: false, message: err.message })
    }
    return res.status(500).json({ success: false, message: err.message })
  }
}
