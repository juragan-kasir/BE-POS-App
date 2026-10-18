'use strict'
const db = require('../../../db/models')
const { assertReportStore } = require('./getReportStore')
const { DEFAULT_TIMEZONE, getStoreDayBounds } = require('../../../utils/businessDate')

const defaultColumns = [
  { key: 'productName', label: 'Produk', type: 'string', width: 28, align: 'left' },
  { key: 'qtySold', label: 'Qty Terjual', type: 'number', width: 14, align: 'right' },
  { key: 'totalSales', label: 'Total Penjualan', type: 'currency', width: 20, align: 'right' },
  { key: 'totalHpp', label: 'HPP', type: 'currency', width: 20, align: 'right' },
  { key: 'profit', label: 'Laba', type: 'currency', width: 20, align: 'right' },
  { key: 'margin', label: 'Margin', type: 'percent', width: 12, align: 'right' }
]
const totals = ['qtySold', 'totalSales', 'totalHpp', 'profit']
const filename = () => 'laba-per-produk'
const label = 'Laba per Produk'

const getData = async (req) => {
  const store = assertReportStore(req)
  const { startDate, endDate } = req.query
  const replacements = {}
  // F6-09: a return can flip paymentStatus to 'refunded' after the sale —
  // the original sale must stay in gross figures; the return's own line
  // items (below) are what reduce it to a net figure, not this filter.
  // Cancelled/void orders are never active revenue, regardless of paymentStatus.
  let orderConditions = `o."paymentStatus" IN ('paid', 'refunded') AND o.status NOT IN ('cancelled', 'void')`

  if (store) {
    orderConditions += ` AND o."store" = :store`
    replacements.store = store
  }
  // Store-local day windows (same contract as the HTTP report controllers):
  // date bounds must not depend on the server machine's timezone — the old
  // setHours(23, 59, 59, 999) dropped 00:00-07:00 WIB sales from the window.
  let storeTimezone = DEFAULT_TIMEZONE
  if (store) {
    try {
      const loc = await db.location.findByPk(store, { attributes: ['timezone'] })
      if (loc?.timezone) storeTimezone = loc.timezone
    } catch {}
  }
  const startBounds = startDate
    ? getStoreDayBounds(String(startDate).slice(0, 10), storeTimezone)
    : null
  const endBounds = endDate
    ? getStoreDayBounds(String(endDate).slice(0, 10), storeTimezone)
    : null
  if (startBounds) {
    orderConditions += ` AND o."createdAt" >= :startDate`
    replacements.startDate = startBounds.start
  } else {
    // No lower bound given — default to 90 days back instead of scanning
    // the full order/order_item history, which grows unbounded over the
    // life of the store.
    const defaultStart = endBounds ? new Date(endBounds.start) : new Date()
    defaultStart.setDate(defaultStart.getDate() - 90)
    orderConditions += ` AND o."createdAt" >= :startDate`
    replacements.startDate = defaultStart
  }
  if (endBounds) {
    orderConditions += ` AND o."createdAt" <= :endDate`
    replacements.endDate = endBounds.end
  }

  // F6-01: hppSnapshot is a PER-UNIT cost (see order.js's createOrderItems/
  // createCustomerOrder — costPrice is a per-unit figure, never multiplied
  // by quantity before being stored) — it must be multiplied by quantity
  // here, exactly like accountingService.computeOrderCogs already does for
  // the GL. Summing hppSnapshot alone silently understates COGS for every
  // line with quantity > 1.
  const grossRows = await db.sequelize.query(
    `SELECT oi."product" as "productId",
            COALESCE(MAX(oi."productName"), 'Unknown') as "productName",
            COALESCE(SUM(oi."quantity"), 0) as "qtySold",
            COALESCE(SUM(oi."totalPrice"), 0) as "grossSales",
            COALESCE(SUM(COALESCE(oi."hppSnapshot", 0) * oi."quantity"), 0) as "grossHpp"
     FROM order_item oi
     JOIN "order" o ON o.id = oi."order"
     WHERE ${orderConditions}
     GROUP BY oi."product"`,
    { replacements, type: db.sequelize.QueryTypes.SELECT }
  )

  // F6-03: approved-return reconciliation, aggregated independently of the
  // gross query above so neither side's rows can multiply the other's
  // (see the SQL-safety note in getData's header comment / the F6 report).
  // sales_return_item -> sales_return is many-to-one and
  // sales_return_item -> order_item (via .orderItem) is many-to-one, so
  // this join produces at most one row per sales_return_item — it can
  // never inflate order_item's own gross totals, and multiple approved
  // returns against the same order_item simply add more (already-1:1)
  // rows here, which GROUP BY correctly sums once each.
  let returnConditions = `sr.status = 'approved' AND sr."approvedAt" IS NOT NULL`
  const returnReplacements = {}
  if (store) {
    returnConditions += ` AND sr."store" = :store`
    returnReplacements.store = store
  }
  if (replacements.startDate) {
    returnConditions += ` AND sr."approvedAt" >= :startDate`
    returnReplacements.startDate = replacements.startDate
  }
  if (replacements.endDate) {
    returnConditions += ` AND sr."approvedAt" <= :endDate`
    returnReplacements.endDate = replacements.endDate
  }

  const returnRows = await db.sequelize.query(
    `SELECT sri."product" as "productId",
            COALESCE(MAX(oi."productName"), 'Unknown') as "productName",
            COALESCE(SUM(sri."qty" * sri."price"), 0) as "returnedRevenue",
            COALESCE(SUM(sri."qty" * COALESCE(oi."hppSnapshot", 0)), 0) as "returnedHpp"
     FROM sales_return_item sri
     JOIN sales_return sr ON sr.id = sri."salesReturn"
     JOIN order_item oi ON oi.id = sri."orderItem"
     WHERE ${returnConditions}
     GROUP BY sri."product"`,
    { replacements: returnReplacements, type: db.sequelize.QueryTypes.SELECT }
  )

  // Union by productId — a return approved inside the requested period
  // whose original sale falls outside it must still reduce that product's
  // reported profit for this period, not be silently dropped.
  const byProduct = new Map()
  for (const r of grossRows) {
    byProduct.set(r.productId, {
      productId: r.productId,
      productName: r.productName,
      qtySold: Number(r.qtySold || 0),
      grossSales: Number(r.grossSales || 0),
      grossHpp: Number(r.grossHpp || 0),
      returnedRevenue: 0,
      returnedHpp: 0
    })
  }
  for (const r of returnRows) {
    const existing = byProduct.get(r.productId)
    if (existing) {
      existing.returnedRevenue = Number(r.returnedRevenue || 0)
      existing.returnedHpp = Number(r.returnedHpp || 0)
    } else {
      byProduct.set(r.productId, {
        productId: r.productId,
        productName: r.productName,
        qtySold: 0,
        grossSales: 0,
        grossHpp: 0,
        returnedRevenue: Number(r.returnedRevenue || 0),
        returnedHpp: Number(r.returnedHpp || 0)
      })
    }
  }

  const mapRows = Array.from(byProduct.values()).map((r) => {
    const totalSales = r.grossSales - r.returnedRevenue
    const totalHpp = r.grossHpp - r.returnedHpp
    const profit = totalSales - totalHpp
    return {
      productId: r.productId,
      productName: r.productName,
      qtySold: r.qtySold,
      totalSales,
      totalHpp,
      profit,
      margin: totalSales > 0 ? Math.round((profit / totalSales) * 10000) / 100 : 0
    }
  })
  mapRows.sort((a, b) => b.profit - a.profit)

  const subtitleParts = []
  if (startDate) subtitleParts.push(new Date(startDate).toLocaleDateString('id-ID'))
  if (endDate) subtitleParts.push(new Date(endDate).toLocaleDateString('id-ID'))
  if (store) subtitleParts.push(`Toko: ${store}`)

  return {
    rows: mapRows,
    title: label,
    subtitle: subtitleParts.join(' - ') || 'Periode'
  }
}

const archetype = 'ranking'
const layout = {"valueKey":"profit"}

module.exports = { getData, defaultColumns, totals, filename, label, archetype, layout }
