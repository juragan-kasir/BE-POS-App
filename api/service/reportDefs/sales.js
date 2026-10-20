'use strict'
const db = require('../../../db/models')
const { Op } = require('sequelize')
const { assertReportStore } = require('./getReportStore')

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

  let dateRange = {}
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (filter === 'today') {
    dateRange = { [Op.gte]: todayStart, [Op.lte]: new Date(todayStart.getTime() + 86400000 - 1) }
  } else if (filter === 'weekly') {
    const daysSinceMonday = (now.getDay() + 6) % 7
    const monday = new Date(todayStart)
    monday.setDate(todayStart.getDate() - daysSinceMonday)
    dateRange = { [Op.gte]: monday, [Op.lte]: new Date(monday.getTime() + 7 * 86400000 - 1) }
  } else if (filter === 'monthly') {
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)
    dateRange = { [Op.gte]: monthStart, [Op.lte]: monthEnd }
  } else if (startDate && endDate) {
    dateRange = { [Op.gte]: new Date(startDate), [Op.lte]: new Date(endDate) }
  }

  const orderWhere = { paymentStatus: 'paid', status: { [Op.notIn]: ['cancelled', 'void'] } }
  if (store) orderWhere.store = store
  if (dateRange[Op.gte]) orderWhere.createdAt = dateRange

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
