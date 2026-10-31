'use strict'
const db = require('../../../db/models')
const { Op } = require('sequelize')
const { assertReportStore } = require('./getReportStore')
const { getStoreFilterRange } = require('../../../utils/businessDate')
const { resolveStoreTimezone } = require('../../../utils/storeTimezone')

const defaultColumns = [
  { key: 'name', label: 'Toko', type: 'string', width: 18, align: 'left' },
  { key: 'city', label: 'Kota', type: 'string', width: 14, align: 'left' },
  { key: 'sales', label: 'Total Penjualan', type: 'currency', width: 20, align: 'right' },
  { key: 'transactions', label: 'Transaksi', type: 'number', width: 14, align: 'right' }
]
const totals = ['sales', 'transactions']
const filename = () => 'ringkasan-penjualan'
const label = 'Ringkasan Penjualan'

const getData = async (req) => {
  const store = assertReportStore(req)
  const { startDate, endDate, filter } = req.query

  const range = getStoreFilterRange(
    { filter, startDate, endDate },
    await resolveStoreTimezone(store)
  )
  const dateRange = {}
  if (range?.start) dateRange[Op.gte] = range.start
  if (range?.end) dateRange[Op.lte] = range.end

  const orderWhere = { paymentStatus: 'paid', status: { [Op.notIn]: ['cancelled', 'void'] } }
  if (store) orderWhere.store = store
  if (range) orderWhere.createdAt = dateRange

  const storeWhere = store ? { id: store } : {}
  const locations = await db.location.findAll({ where: storeWhere, attributes: ['id', 'name', 'city'] })
  // location.city holds a region code; show the region name.
  const cityCodes = [...new Set(locations.map((loc) => loc.city).filter(Boolean).map(String))]
  const cityNames = new Map()
  if (cityCodes.length && db.region) {
    const regions = await db.region.findAll({ where: { code: cityCodes }, attributes: ['code', 'name'] })
    regions.forEach((r) => cityNames.set(String(r.code), r.name))
  }
  const rows = await Promise.all(
    locations.map(async (loc) => {
      const locWhere = { paymentStatus: 'paid', status: { [Op.notIn]: ['cancelled', 'void'] }, store: loc.id }
      if (dateRange[Op.gte]) locWhere.createdAt = dateRange
      const [sales, ordersCount] = await Promise.all([
        db.order.sum('totalPrice', { where: locWhere }),
        db.order.count({ where: locWhere })
      ])
      return { name: loc.name, city: (loc.city && (cityNames.get(String(loc.city)) || loc.city)) || '-', sales: Number(sales || 0), transactions: Number(ordersCount || 0) }
    })
  )

  const PERIOD_LABELS = { today: 'Hari ini', weekly: 'Minggu ini', monthly: 'Bulan ini' }
  const period = PERIOD_LABELS[filter] ||
    (startDate && endDate ? `${startDate} - ${endDate}` : 'Semua periode')
  return { rows, title: label, subtitle: `Periode: ${period}` }
}

const archetype = 'summary'
const layout = {
  kpis: ['sales', 'transactions']
}

module.exports = { getData, defaultColumns, totals, filename, label, archetype, layout }
