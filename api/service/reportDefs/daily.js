'use strict'
const db = require('../../../db/models')
const { completedSaleSql } = require('../../../utils/completedSaleSql')
const { assertReportStore } = require('./getReportStore')
const { getStoreDayBounds, DEFAULT_TIMEZONE } = require('../../../utils/businessDate')

const defaultColumns = [
  { key: 'date', label: 'Tanggal', type: 'date', width: 14, align: 'left' },
  { key: 'totalTransaksi', label: 'Transaksi', type: 'number', width: 12, align: 'right' },
  { key: 'totalPenjualanKotor', label: 'Penjualan Kotor', type: 'currency', width: 18, align: 'right' },
  { key: 'diskon', label: 'Diskon', type: 'currency', width: 16, align: 'right' },
  { key: 'pajak', label: 'Pajak', type: 'currency', width: 16, align: 'right' },
  { key: 'serviceCharge', label: 'Service Charge', type: 'currency', width: 16, align: 'right' },
  { key: 'totalPenjualanBersih', label: 'Penjualan Bersih', type: 'currency', width: 18, align: 'right' },
  { key: 'totalHpp', label: 'HPP', type: 'currency', width: 18, align: 'right' },
  { key: 'grossProfit', label: 'Laba Kotor', type: 'currency', width: 18, align: 'right' },
  { key: 'operationalExpense', label: 'Biaya Operasional', type: 'currency', width: 16, align: 'right' },
  { key: 'netProfit', label: 'Laba Bersih', type: 'currency', width: 18, align: 'right' },
  { key: 'totalCovers', label: 'Jumlah Tamu', type: 'number', width: 12, align: 'right' }
]

const totals = ['totalTransaksi', 'totalPenjualanBersih', 'totalHpp', 'grossProfit', 'netProfit', 'totalCovers']

const filename = () => 'laporan-harian'

const label = 'Laporan Harian'

const archetype = 'summary'
const layout = {
  kpis: ['totalTransaksi', 'totalPenjualanBersih', 'grossProfit', 'netProfit']
}

const getData = async (req) => {
  const store = assertReportStore(req)
  const { startDate, endDate } = req.query
  const replacements = {}
  // Store-local business date: resolve timezone from location, fallback to DEFAULT_TIMEZONE.
  // For global super_admin without store, keep UTC (DEFAULT_TIMEZONE) and document limitation.
  let storeTimezone = DEFAULT_TIMEZONE
  if (store) {
    try {
      const loc = await db.location.findByPk(store, { attributes: ['timezone'] })
      if (loc?.timezone) storeTimezone = loc.timezone
    } catch {}
  }
  replacements.storeTimezone = storeTimezone
  // F6-09: a return can flip paymentStatus to 'refunded' after the sale —
  // the original sale must stay in gross figures; the return-side queries
  // below are what reduce it to a net figure, not this filter.
  // Cancelled/void orders are never active revenue, regardless of paymentStatus.
  let orderConditions = completedSaleSql('o.')

  if (store) {
    orderConditions += ` AND o."store" = :store`
    replacements.store = store
  }
  if (startDate) {
    const startBounds = getStoreDayBounds(String(startDate).slice(0, 10), storeTimezone)
    orderConditions += ` AND o."createdAt" >= :startDate`
    replacements.startDate = startBounds.start
  }
  if (endDate) {
    const endBounds = getStoreDayBounds(String(endDate).slice(0, 10), storeTimezone)
    orderConditions += ` AND o."createdAt" <= :endDate`
    replacements.endDate = endBounds.end
  }

  const dailyOrders = await db.sequelize.query(
    `SELECT DATE(o."createdAt" AT TIME ZONE :storeTimezone) as tanggal,
            COUNT(*) as "totalTransaksi",
            COALESCE(SUM(o."subTotal"), 0) as "totalPenjualan",
            COALESCE(SUM(o."discountAmount"), 0) as "totalDiscount",
            COALESCE(SUM(o."totalQuantity"), 0) as "totalQty",
            COALESCE(SUM(o."totalCovers"), 0) as "totalCovers"
     FROM "order" o
     WHERE ${orderConditions}
     GROUP BY DATE(o."createdAt" AT TIME ZONE :storeTimezone)
     ORDER BY tanggal DESC`,
    { replacements, type: db.sequelize.QueryTypes.SELECT }
  )

  const rows = []
  if (dailyOrders.length) {
    // F6-01: hppSnapshot (or its price fallback) is a PER-UNIT figure — it
    // must be multiplied by quantity, exactly like
    // accountingService.computeOrderCogs already does for the GL. Summing
    // it alone silently understates COGS for every line with quantity > 1.
    const dailyHpp = await db.sequelize.query(
      `SELECT DATE(o."createdAt" AT TIME ZONE :storeTimezone) as tanggal,
              COALESCE(SUM(COALESCE(oi."hppSnapshot", oi."price", 0) * oi."quantity"), 0) as "totalHpp"
       FROM order_item oi
       JOIN "order" o ON o.id = oi."order"
       WHERE ${orderConditions}
       GROUP BY DATE(o."createdAt" AT TIME ZONE :storeTimezone)`,
      { replacements, type: db.sequelize.QueryTypes.SELECT }
    )
    const hppMap = {}
    for (const row of dailyHpp) hppMap[row.tanggal] = Number(row.totalHpp || 0)

    let expenseConditions = `"status" = 'approved'`
    const expReplacements = {}
    if (store) { expenseConditions += ` AND "store" = :store`; expReplacements.store = store }
    if (startDate) { expenseConditions += ` AND "date" >= :startDate`; expReplacements.startDate = replacements.startDate }
    if (endDate) { expenseConditions += ` AND "date" <= :endDate`; expReplacements.endDate = replacements.endDate }

    let dailyExpenses = []
    if (startDate || endDate || store) {
      dailyExpenses = await db.sequelize.query(
        `SELECT DATE("date") as tanggal, COALESCE(SUM("amount"), 0) as "totalExpense"
         FROM expense
         WHERE ${expenseConditions}
         GROUP BY DATE("date")`,
        { replacements: expReplacements, type: db.sequelize.QueryTypes.SELECT }
      )
    }
    const expenseMap = {}
    for (const row of dailyExpenses) expenseMap[row.tanggal] = Number(row.totalExpense || 0)

    // F4: refund impact, sourced directly from approved sales_return_item
    // rows — the same line-item grain profitPerProduct.js's F6-03
    // reconciliation uses — never inferred from order.paymentStatus,
    // which cannot be trusted for this purpose (see the cashRegister.js
    // cash-ledger fix for why). Grouped by the return's own approval
    // date, independent of the underlying order's current status or date
    // (F6 §8: a January sale returned in February reduces February's
    // figures, not January's — matches this report's pre-existing
    // convention).
    let refundConditions = `sr.status = 'approved' AND sr."approvedAt" IS NOT NULL`
    const refundReplacements = {}
    if (store) { refundConditions += ` AND sr."store" = :store`; refundReplacements.store = store }
    if (startDate) { refundConditions += ` AND sr."approvedAt" >= :startDate`; refundReplacements.startDate = replacements.startDate }
    if (endDate) { refundConditions += ` AND sr."approvedAt" <= :endDate`; refundReplacements.endDate = replacements.endDate }

    // F6-03: aggregated independently of dailyOrders/dailyHpp above so
    // neither side's rows can multiply the other's — sales_return_item ->
    // sales_return and sales_return_item -> order_item (via .orderItem)
    // are both many-to-one, so this join produces at most one row per
    // sales_return_item; multiple approved returns against the same
    // order_item simply add more (already-1:1) rows here, correctly
    // summed once each by GROUP BY.
    const dailyRefunds = await db.sequelize.query(
      `SELECT DATE(sr."approvedAt") as tanggal,
              COALESCE(SUM(sri."qty" * sri."price"), 0) as "totalRefund",
              COALESCE(SUM(sri."qty" * COALESCE(oi."hppSnapshot", 0)), 0) as "totalReturnedHpp"
       FROM sales_return_item sri
       JOIN sales_return sr ON sr.id = sri."salesReturn"
       JOIN order_item oi ON oi.id = sri."orderItem"
       WHERE ${refundConditions}
       GROUP BY DATE(sr."approvedAt")`,
      { replacements: refundReplacements, type: db.sequelize.QueryTypes.SELECT }
    )
    const refundMap = {}
    const returnedHppMap = {}
    for (const row of dailyRefunds) {
      refundMap[row.tanggal] = Number(row.totalRefund || 0)
      returnedHppMap[row.tanggal] = Number(row.totalReturnedHpp || 0)
    }

    for (const row of dailyOrders) {
      const tanggal = row.tanggal
      const totalPenjualan = Number(row.totalPenjualan || 0)
      const totalDiscount = Number(row.totalDiscount || 0)
      const totalRefund = refundMap[tanggal] || 0
      const netRevenue = totalPenjualan - totalDiscount - totalRefund
      // F6-03: net of the same approved returns' COGS reversal — the
      // returned units' original cost must not still count against a
      // period whose revenue no longer includes them.
      const totalHpp = (hppMap[tanggal] || 0) - (returnedHppMap[tanggal] || 0)
      const totalExpense = expenseMap[tanggal] || 0
      const grossProfit = netRevenue - totalHpp
      const netProfit = grossProfit - totalExpense
      const foodCostPersen = totalPenjualan > 0 ? Math.round((totalHpp / totalPenjualan) * 10000) / 100 : 0
      rows.push({
        tanggal,
        totalTransaksi: Number(row.totalTransaksi || 0),
        totalPenjualanBersih: netRevenue,
        totalRefund,
        totalHpp,
        foodCostPersen,
        grossProfit,
        netProfit,
        totalCovers: Number(row.totalCovers || 0) || Number(row.totalQty || 0)
      })
    }
  }

  const subtitleParts = []
  if (startDate) subtitleParts.push(new Date(startDate).toLocaleDateString('id-ID'))
  if (endDate) subtitleParts.push(new Date(endDate).toLocaleDateString('id-ID'))
  if (store) subtitleParts.push(`Toko: ${store}`)

  return {
    rows,
    title: label,
    subtitle: subtitleParts.join(' - ') || new Date().toLocaleDateString('id-ID')
  }
}

module.exports = { getData, defaultColumns, totals, filename, label, archetype, layout }
