'use strict'
const db = require('../../../db/models')
const { assertReportStore, getReportStores, storeWhere } = require('./getReportStore')

const defaultColumns = [
  { key: 'name', label: 'Produk', type: 'string', width: 28, align: 'left' },
  { key: 'sold', label: 'Terjual', type: 'number', width: 14, align: 'right' },
  { key: 'revenue', label: 'Pendapatan', type: 'currency', width: 20, align: 'right' }
]
const totals = ['sold', 'revenue']
const filename = () => 'produk-terlaris'
const label = 'Produk Terlaris'

const getData = async (req) => {
  assertReportStore(req)
  // PGA-11: aggregate the whole outlet set (a multi-outlet owner's tenant).
  const stores = getReportStores(req)
  const { limit = 10 } = req.query

  const where = storeWhere(stores)

  const [bestSelling, , productRevenues] = await Promise.all([
    db.best_selling.findAll({
      where,
      order: [['totalSelling', 'DESC']],
      limit: parseInt(limit),
      attributes: ['productId', 'nameProduct', 'totalSelling', 'image']
    }),
    stores.length
      ? db.sequelize.query(
          `SELECT COUNT(*)::int AS "count" FROM "product" p
           WHERE p."deletedAt" IS NULL AND p.status = 'active'
             AND EXISTS (
               SELECT 1 FROM "product_store" ps
               WHERE ps."product" = p."id" AND ps."store" IN (:storeIds) AND ps."deletedAt" IS NULL
             )`,
          { replacements: { storeIds: stores }, type: db.sequelize.QueryTypes.SELECT }
        )
      : db.product.count({ where: { status: 'active' } }),
    db.sequelize.query(
      `SELECT oi.product, COALESCE(SUM(oi."totalPrice"), 0) as revenue
       FROM order_item oi
       JOIN "order" o ON o.id = oi."order"
       WHERE o."paymentStatus" = 'paid' AND o.status NOT IN ('cancelled','void')${stores.length ? ' AND o.store IN (:storeIds)' : ''}
       GROUP BY oi.product`,
      {
        replacements: stores.length ? { storeIds: stores } : {},
        type: db.sequelize.QueryTypes.SELECT
      }
    )
  ])

  const revenueMap = {}
  for (const r of productRevenues)
    revenueMap[Number(r.product)] = Number(r.revenue || 0)

  const rows = bestSelling.map((p) => ({
    id: p.productId,
    name: p.nameProduct,
    image: p.image,
    sold: Number(p.totalSelling || 0),
    revenue: revenueMap[Number(p.productId)] || 0
  }))

  return {
    rows,
    title: label,
    subtitle: `Limit: ${parseInt(limit)}` + (stores.length ? ` - Toko: ${stores.join(', ')}` : '')
  }
}

const archetype = 'ranking'
const layout = {"valueKey":"sold"}

module.exports = { getData, defaultColumns, totals, filename, label, archetype, layout }
