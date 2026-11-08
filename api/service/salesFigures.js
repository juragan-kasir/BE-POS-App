'use strict'

const db = require('../../db/models')
const { completedSaleSql } = require('../../utils/completedSaleSql')

const completedOrderWhere = () => ({
  [db.Sequelize.Op.and]: [db.sequelize.literal(completedSaleSql('"order".'))]
})

const rangeSql = (column, { start, end }) =>
  `${start ? ` AND ${column} >= :start` : ''}${end ? ` AND ${column} <= :end` : ''}`

// An outlet set (`stores`, e.g. a multi-outlet owner's tenant roster) wins
// over a single `store`; neither = every outlet (the vendor's view).
const scopeIds = ({ stores, store }) => {
  if (Array.isArray(stores) && stores.length > 0) return stores.map(Number)
  return store ? [Number(store)] : []
}
const storeSql = (column, opts) => (scopeIds(opts).length > 0 ? ` AND ${column} IN (:storeIds)` : '')

const replacementsFor = (opts) => {
  const { start, end } = opts
  const r = {}
  if (start) r.start = start
  if (end) r.end = end
  const ids = scopeIds(opts)
  if (ids.length > 0) r.storeIds = ids
  return r
}

const dayKey = (value) => new Date(value).toISOString().slice(0, 10)

const select = (sql, replacements) =>
  db.sequelize.query(sql, { replacements, type: db.sequelize.QueryTypes.SELECT })

// Refunds of approved sales returns, dated by their approval (a January sale
// returned in February reduces February). refundAmount is what the customer
// got back, tax included — the same basis as order.totalPrice.
const refundTotals = async (opts) => {
  const rows = await select(
    `SELECT sr."store" AS "storeId",
            DATE(sr."approvedAt"${opts.timezone ? ' AT TIME ZONE :timezone' : ''}) AS date,
            COALESCE(SUM(sr."refundAmount"), 0)::bigint AS amount
       FROM sales_return sr
      WHERE sr.status = 'approved' AND sr."approvedAt" IS NOT NULL AND sr."deletedAt" IS NULL
        ${rangeSql('sr."approvedAt"', opts)}
        ${storeSql('sr."store"', opts)}
      GROUP BY sr."store", 2`,
    { ...replacementsFor(opts), ...(opts.timezone ? { timezone: opts.timezone } : {}) }
  )
  const byStore = {}
  const byDay = {}
  let total = 0
  for (const r of rows) {
    const amount = Number(r.amount || 0)
    const day = dayKey(r.date)
    total += amount
    byStore[r.storeId] = (byStore[r.storeId] || 0) + amount
    byDay[day] = (byDay[day] || 0) + amount
  }
  return { total, byStore, byDay }
}

// Profit figures with the daily report's definitions (reportDefs/daily.js):
// net sales = subtotal − discount − refunded lines (tax excluded);
// HPP = Σ hppSnapshot × qty of completed sales − HPP of returned units;
// a line without a cost snapshot adds nothing and is counted in qtyWithoutCost.
const profitFigures = async (opts) => {
  const repl = replacementsFor(opts)
  const storeO = storeSql('o."store"', opts)
  const [[sales], [cogs], [returned]] = await Promise.all([
    select(
      `SELECT COALESCE(SUM(o."subTotal"), 0)::bigint AS "subTotal",
              COALESCE(SUM(o."discountAmount"), 0)::bigint AS discount
         FROM "order" o
        WHERE ${completedSaleSql('o.')} AND o."deletedAt" IS NULL
          ${rangeSql('o."createdAt"', opts)}${storeO}`,
      repl
    ),
    select(
      `SELECT COALESCE(SUM(COALESCE(oi."hppSnapshot", 0) * oi."quantity"), 0)::bigint AS cogs,
              ROUND(COALESCE(SUM(oi."quantity") FILTER (WHERE oi."hppSnapshot" IS NULL), 0), 3) AS "qtyWithoutCost"
         FROM order_item oi
         JOIN "order" o ON o.id = oi."order"
        WHERE ${completedSaleSql('o.')} AND o."deletedAt" IS NULL
          ${rangeSql('o."createdAt"', opts)}${storeO}`,
      repl
    ),
    select(
      `SELECT COALESCE(SUM(sri."qty" * sri."price"), 0)::bigint AS lines,
              COALESCE(SUM(sri."qty" * COALESCE(oi."hppSnapshot", 0)) FILTER (WHERE sr."restock"), 0)::bigint AS hpp
         FROM sales_return_item sri
         JOIN sales_return sr ON sr.id = sri."salesReturn"
         JOIN order_item oi ON oi.id = sri."orderItem"
        WHERE sr.status = 'approved' AND sr."approvedAt" IS NOT NULL AND sr."deletedAt" IS NULL
          ${rangeSql('sr."approvedAt"', opts)}
          ${storeSql('sr."store"', opts)}`,
      repl
    )
  ])
  const netSales =
    Number(sales.subTotal || 0) - Number(sales.discount || 0) - Number(returned.lines || 0)
  const cogsNet = Number(cogs.cogs || 0) - Number(returned.hpp || 0)
  return {
    netSales,
    cogs: cogsNet,
    grossProfit: netSales - cogsNet,
    qtyWithoutCost: Number(cogs.qtyWithoutCost || 0)
  }
}

const marginPercent = (part, whole) =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0

module.exports = { completedOrderWhere, refundTotals, profitFigures, marginPercent, dayKey }
