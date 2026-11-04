'use strict'
const db = require('../../../db/models')
const { Op } = require('sequelize')
const { assertReportStore, getReportStores, storeWhere } = require('./getReportStore')

const defaultColumns = [
  { key: 'cashier', label: 'Kasir', type: 'string', width: 22, align: 'left' },
  { key: 'totalSales', label: 'Total Penjualan', type: 'currency', width: 20, align: 'right' },
  { key: 'transactions', label: 'Transaksi', type: 'number', width: 14, align: 'right' },
  { key: 'avgTransaction', label: 'Rata-rata Transaksi', type: 'currency', width: 20, align: 'right' },
  { key: 'itemsSold', label: 'Item Terjual', type: 'number', width: 14, align: 'right' },
  { key: 'accuracyRate', label: 'Akurasi', type: 'percent', width: 12, align: 'right' }
]
const totals = ['totalSales', 'transactions', 'itemsSold']
const filename = () => 'kinerja-kasir'
const label = 'Kinerja Kasir'

const getData = async (req) => {
  const { startDate, endDate } = req.query
  assertReportStore(req)
  // PGA-11: aggregate the whole outlet set (a multi-outlet owner's tenant).
  const stores = getReportStores(req)

  const where = storeWhere(stores)
  if (startDate || endDate) {
    where.report_date = {}
    if (startDate) where.report_date[Op.gte] = new Date(startDate)
    if (endDate) where.report_date[Op.lte] = new Date(endDate)
  }

  const { rows } = await db.kasir_performance.findAndCountAll({
    where,
    include: [
      {
        model: db.user,
        as: 'cashierData',
        attributes: ['id', 'fullName', 'userName']
      },
      { model: db.location, as: 'storeData', attributes: ['id', 'name'] }
    ],
    order: [
      ['total_sales', 'DESC'],
      ['report_date', 'DESC']
    ]
  })

  const mapRows = rows.map((r) => ({
    cashier: r.cashierData?.fullName || r.cashierData?.userName || '-',
    totalSales: Number(r.total_sales || 0),
    transactions: Number(r.transactions || 0),
    avgTransaction: Number(r.avg_transaction || 0),
    itemsSold: Number(r.items_sold || 0),
    accuracyRate: Number(r.accuracy_rate || 0)
  }))

  const subtitleParts = []
  if (startDate) subtitleParts.push(new Date(startDate).toLocaleDateString('id-ID'))
  if (endDate) subtitleParts.push(new Date(endDate).toLocaleDateString('id-ID'))
  if (stores.length) subtitleParts.push(`Toko: ${stores.join(', ')}`)

  return {
    rows: mapRows,
    title: label,
    subtitle: subtitleParts.join(' - ') || 'Periode'
  }
}

const archetype = 'roster'
const layout = {}

module.exports = { getData, defaultColumns, totals, filename, label, archetype, layout }
