'use strict'

const { Op } = require('sequelize')
const db = require('../../../db/models')
const { salonRoute } = require('./http')
const { SalonError, resolveSalonStore } = require('../../service/salonContext')
const { DateRange } = require('../../validation/salonSchemas')
const { CONTRACT_METHOD } = require('../../service/salonMoney')
const { workWindows } = require('../../service/salonSlots')
const { MIN, localDate, addDays } = require('../../service/salonTime')
const { hhmm } = require('./shared')
const { bookingKit } = require('./appointments')

const { storeShape, dayBounds } = bookingKit

// Salon reports (S2-b, SALON-BA §8). Reference: FE-SALON-App
// src/mocks/engine/reports.ts. Everything is aggregated from the ledgers
// themselves (salon_order + POS transaction, salon_staff_commission,
// salon_appointment[_item]), never from a summary table, so a report always
// adds up to its orders.
//
// `?store=` picks one of the caller's outlets; without it every outlet the
// caller may see (the owner: all of the tenant's). Dates are outlet dates:
// each outlet's range is cut in its own timezone.

const MAX_RANGE_DAYS = 92
const CONTRACT_METHODS = new Set(['cash', 'qris', 'transfer', 'card'])
const NOT_BOOKED = ['cancelled', 'no_show']

const parseRange = (query) => {
  const range = DateRange.parse({ from: query.from, to: query.to })
  if ((Date.parse(range.to) - Date.parse(range.from)) / 86400000 > MAX_RANGE_DAYS) {
    throw new SalonError('VALIDATION_FAILED', `Rentang tanggal maksimal ${MAX_RANGE_DAYS} hari`, 400, { field: 'to' })
  }
  return range
}

const scopeStores = (salon, requested) =>
  requested !== undefined && requested !== null && requested !== ''
    ? [resolveSalonStore(salon, requested)]
    : salon.stores

const eachDate = (from, to) => {
  const out = []
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d)
  return out
}

/** Per outlet: { store, shape, start, end } with the range in its own zone. */
const windowsOf = (stores, range) =>
  stores.map((store) => {
    const shape = storeShape(store)
    const { start, end } = dayBounds(shape, range.from, range.to)
    return { store, shape, start: new Date(start), end: new Date(end) }
  })

/** OR of (store = s AND column in [start, end)) over the outlets. */
const inWindows = (wins, column) => ({
  [Op.or]: wins.map((w) => ({ store: w.store.id, [column]: { [Op.gte]: w.start, [Op.lt]: w.end } }))
})

const userNames = async (ids) => {
  const unique = [...new Set(ids.filter((id) => id != null).map(Number))]
  if (!unique.length) return new Map()
  const rows = await db.user.findAll({ where: { id: unique }, attributes: ['id', 'fullName', 'userName'], paranoid: false })
  return new Map(rows.map((u) => [u.id, u.fullName || u.userName || '']))
}

const tzOfStore = (wins) => {
  const map = new Map(wins.map((w) => [w.store.id, w.shape.timezone]))
  return (storeId) => map.get(storeId) || 'Asia/Jakarta'
}

// ---------- pendapatan ----------

exports.revenue = salonRoute({ perm: 'report.read' }, async ({ salon, query }) => {
  const range = parseRange(query)
  const wins = windowsOf(scopeStores(salon, query.store), range)
  const tz = tzOfStore(wins)
  const empty = { gross: 0, discount: 0, tips: 0, net: 0, refunds: 0, depositForfeited: 0, orderCount: 0, byService: [], byStaff: [], byDay: eachDate(range.from, range.to).map((date) => ({ date, net: 0 })), byMethod: [] }
  if (!wins.length) return empty

  const orders = await db.salon_order.findAll({
    where: { tenantId: salon.tenant.id, ...inWindows(wins, 'createdAt') },
    attributes: ['id', 'store', 'orderId', 'quote', 'status', 'refund', 'createdAt'],
    order: [['id', 'ASC']]
  })
  const paid = orders.filter((o) => o.status === 'paid')
  const refunded = orders.filter((o) => o.status === 'refunded')

  let gross = 0
  let discount = 0
  let tips = 0
  const byService = new Map()
  const byStaff = new Map()
  const byDay = new Map()
  for (const o of paid) {
    const q = o.quote || {}
    gross += Number(q.subtotal) || 0
    discount += Number(q.discountTotal) || 0
    tips += Number(q.tipTotal) || 0
    const day = localDate(new Date(o.createdAt).getTime(), tz(o.store))
    byDay.set(day, (byDay.get(day) || 0) + (Number(q.total) || 0) - (Number(q.tipTotal) || 0))
    for (const l of q.lines || []) {
      if (l.kind === 'tip') continue
      if (l.kind === 'service') {
        const cur = byService.get(l.name) || { name: l.name, count: 0, net: 0 }
        cur.count += 1
        cur.net += l.net
        byService.set(l.name, cur)
      }
      if (l.staffId != null) {
        const key = String(l.staffId)
        const cur = byStaff.get(key) || { staffId: key, name: '', count: 0, net: 0 }
        cur.count += l.kind === 'service' ? 1 : 0
        cur.net += l.net
        byStaff.set(key, cur)
      }
    }
  }
  const names = await userNames([...byStaff.keys()])
  for (const row of byStaff.values()) row.name = names.get(Number(row.staffId)) || '—'

  // Every positive till row of a paid order, the booking deposit included
  // (it is written on the order with the method it was paid with).
  const byMethod = new Map()
  if (paid.length) {
    const rows = await db.transaction.findAll({
      where: { order: paid.map((o) => o.orderId), amount: { [Op.gt]: 0 } },
      attributes: ['typePayment', 'amount']
    })
    for (const r of rows) {
      const method = CONTRACT_METHOD[r.typePayment] || String(r.typePayment || '').toLowerCase()
      if (!CONTRACT_METHODS.has(method)) continue
      byMethod.set(method, (byMethod.get(method) || 0) + Number(r.amount))
    }
  }

  const forfeited = await db.salon_appointment.sum('depositAmount', {
    where: {
      tenantId: salon.tenant.id,
      status: NOT_BOOKED,
      depositStatus: 'forfeited',
      depositAmount: { [Op.gt]: 0 },
      ...inWindows(wins, 'startAt')
    }
  })

  return {
    gross,
    discount,
    tips,
    net: gross - discount,
    refunds: refunded.reduce((s, o) => s + (Number(o.refund?.amount) || 0), 0),
    depositForfeited: Number(forfeited) || 0,
    orderCount: paid.length,
    byService: [...byService.values()].sort((a, b) => b.net - a.net),
    byStaff: [...byStaff.values()].sort((a, b) => b.net - a.net),
    byDay: eachDate(range.from, range.to).map((date) => ({ date, net: byDay.get(date) || 0 })),
    byMethod: [...byMethod.entries()].map(([method, amount]) => ({ method, amount }))
  }
})

// ---------- komisi ----------

exports.commission = salonRoute({ perm: ['report.read', 'commission.read'] }, async ({ salon, query }) => {
  const range = parseRange(query)
  const wins = windowsOf(scopeStores(salon, query.store), range)
  if (!wins.length) return { rows: [], total: 0 }
  // A stylist sees only their own row (DR-SLN-15).
  const self = salon.canonicalRole === 'staff' ? Number(salon.user.id) : null
  const ledger = await db.salon_staff_commission.findAll({
    where: { tenantId: salon.tenant.id, ...(self ? { staffId: self } : {}), ...inWindows(wins, 'createdAt') },
    attributes: ['staffId', 'kind', 'status', 'amount']
  })
  const rows = new Map()
  for (const c of ledger) {
    const row = rows.get(c.staffId) || { staffId: String(c.staffId), name: '', earned: 0, reversed: 0, tips: 0, net: 0 }
    if (c.status === 'reversed') row.reversed += c.amount
    else if (c.kind === 'tip') row.tips += c.amount
    else row.earned += c.amount
    row.net += c.amount
    rows.set(c.staffId, row)
  }
  const names = await userNames([...rows.keys()])
  const list = [...rows.entries()]
    .map(([id, row]) => ({ ...row, name: names.get(id) || '—' }))
    .sort((a, b) => b.net - a.net)
  return { rows: list, total: list.reduce((s, x) => s + x.net, 0) }
})

// ---------- okupansi ----------

/** Milliseconds of [aStart, aEnd) covered by [bStart, bEnd). */
const overlapMs = (aStart, aEnd, bStart, bEnd) => Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart))

exports.occupancy = salonRoute({ perm: 'report.read' }, async ({ salon, query }) => {
  const range = parseRange(query)
  const wins = windowsOf(scopeStores(salon, query.store), range)
  const dates = eachDate(range.from, range.to)
  const rows = []
  for (const w of wins) {
    const profiles = await db.salon_staff_profile.findAll({
      where: { tenantId: salon.tenant.id, store: w.store.id, active: true },
      include: [{ model: db.user, as: 'userData', attributes: ['id', 'fullName', 'userName'] }],
      order: [['userId', 'ASC']]
    })
    if (!profiles.length) continue
    const userIds = profiles.map((p) => p.userId)
    const keys = { tenantId: salon.tenant.id, store: w.store.id, userId: userIds }
    const availability = await db.salon_availability.findAll({ where: keys })
    const timeOff = await db.salon_time_off.findAll({
      where: { ...keys, startAt: { [Op.lt]: w.end }, endAt: { [Op.gt]: w.start } }
    })
    const items = await db.salon_appointment_item.findAll({
      where: {
        tenantId: salon.tenant.id,
        store: w.store.id,
        staffId: userIds,
        status: { [Op.notIn]: NOT_BOOKED },
        startAt: { [Op.gte]: w.start, [Op.lt]: w.end }
      },
      attributes: ['staffId', 'startAt', 'endAt']
    })
    for (const p of profiles) {
      const staff = {
        availability: availability
          .filter((a) => a.userId === p.userId)
          .map((a) => ({ weekday: a.weekday, startTime: hhmm(a.startTime), endTime: hhmm(a.endTime) }))
      }
      const off = timeOff.filter((t) => t.userId === p.userId)
      let availableMs = 0
      for (const date of dates) {
        for (const win of workWindows(staff, w.shape, date)) {
          const leave = off.reduce((s, t) => s + overlapMs(win.start, win.end, new Date(t.startAt).getTime(), new Date(t.endAt).getTime()), 0)
          availableMs += win.end - win.start - leave
        }
      }
      const bookedMs = items
        .filter((i) => i.staffId === p.userId)
        .reduce((s, i) => s + (new Date(i.endAt).getTime() - new Date(i.startAt).getTime()), 0)
      const availableMin = Math.round(availableMs / MIN)
      const bookedMin = Math.round(bookedMs / MIN)
      rows.push({
        staffId: String(p.userId),
        name: p.userData?.fullName || p.userData?.userName || '',
        availableMin,
        bookedMin,
        rate: availableMin ? Math.min(1, bookedMin / availableMin) : 0
      })
    }
  }
  return { rows: rows.sort((a, b) => b.rate - a.rate) }
})

// ---------- no-show & pelanggan ----------

exports.noShow = salonRoute({ perm: 'report.read' }, async ({ salon, query }) => {
  const range = parseRange(query)
  const wins = windowsOf(scopeStores(salon, query.store), range)
  if (!wins.length) return { total: 0, noShow: 0, cancelled: 0, rate: 0, newCustomers: 0, returningCustomers: 0 }

  // Bookings made ahead (walk-ins cannot be no-shows).
  const apts = await db.salon_appointment.findAll({
    where: { tenantId: salon.tenant.id, source: { [Op.ne]: 'walk_in' }, ...inWindows(wins, 'startAt') },
    attributes: ['status']
  })
  const noShow = apts.filter((a) => a.status === 'no_show').length
  const cancelled = apts.filter((a) => a.status === 'cancelled').length

  // Members with a salon sale in the period; new = their first salon sale of
  // the tenant (any outlet) falls in the period.
  const [visitors] = await db.sequelize.query(
    `SELECT DISTINCT o."customerId" AS "memberId", so."store"
       FROM "salon_order" so JOIN "order" o ON o.id = so."orderId"
      WHERE so."tenantId" = :tenantId AND o."customerId" IS NOT NULL
        AND (${wins.map((_, i) => `(so."store" = :s${i} AND so."createdAt" >= :a${i} AND so."createdAt" < :b${i})`).join(' OR ')})`,
    {
      replacements: Object.assign(
        { tenantId: salon.tenant.id },
        ...wins.map((w, i) => ({ [`s${i}`]: w.store.id, [`a${i}`]: w.start, [`b${i}`]: w.end }))
      )
    }
  )
  const memberIds = [...new Set(visitors.map((v) => Number(v.memberId)))]
  let newCustomers = 0
  if (memberIds.length) {
    const [firsts] = await db.sequelize.query(
      `SELECT o."customerId" AS "memberId", MIN(so."createdAt") AS "first"
         FROM "salon_order" so JOIN "order" o ON o.id = so."orderId"
        WHERE so."tenantId" = :tenantId AND o."customerId" IN (:memberIds)
        GROUP BY o."customerId"`,
      { replacements: { tenantId: salon.tenant.id, memberIds } }
    )
    const tz = wins[0].shape.timezone
    newCustomers = firsts.filter((f) => localDate(new Date(f.first).getTime(), tz) >= range.from).length
  }
  return {
    total: apts.length,
    noShow,
    cancelled,
    rate: apts.length ? noShow / apts.length : 0,
    newCustomers,
    returningCustomers: memberIds.length - newCustomers
  }
})
