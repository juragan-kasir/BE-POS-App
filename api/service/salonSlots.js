'use strict'

const { MIN, zonedToUtc, localDate, weekdayOf, overlaps } = require('./salonTime')

// Pure salon schedule rules (BR-SLN-002…005), ported from FE-SALON-App
// src/mocks/engine/schedule.ts. No DB access: the controller loads a snapshot
// and these functions decide. The database still has the last word on double
// booking (EXCLUDE constraint salon_appointment_item_no_double_booking).
//
// Shapes (epoch ms for instants):
//   staff   { userId, name, level, skills: [{ productId, durationOverride, priceOverride }],
//             availability: [{ weekday, startTime 'HH:mm', endTime }],
//             timeOff: [{ startAt, endAt }], busy: [{ startAt, endAt }] }
//   service { id, name, basePrice, serviceConfig: { durationMin, bufferMin, levelPrices } }
//   store   { timezone, openTime, closeTime }

/** Minutes and price of one service for one staff, or null without the skill (BR-SLN-005). */
const staffServicePlan = (staff, service) => {
  const skill = staff.skills.find((s) => Number(s.productId) === Number(service.id))
  if (!skill) return null
  const config = service.serviceConfig || {}
  const durationMin = skill.durationOverride ?? config.durationMin
  const levelPrice = config.levelPrices ? config.levelPrices[staff.level] : undefined
  const price = skill.priceOverride ?? levelPrice ?? service.basePrice
  return { durationMin, bufferMin: config.bufferMin || 0, price }
}

/** Total blocked minutes of the services for a staff, NaN when a skill is missing (BR-SLN-002). */
const totalSpanMin = (staff, services) =>
  services.reduce((sum, s) => {
    const plan = staffServicePlan(staff, s)
    return plan ? sum + plan.durationMin + plan.bufferMin : Number.NaN
  }, 0)

class ScheduleError extends Error {
  constructor (code, message, details) {
    super(message)
    this.code = code
    this.details = details
  }
}

/** Consecutive items from `start`; the buffer is blocked time too. */
const buildItems = (staff, services, start) => {
  let cursor = start
  return services.map((service) => {
    const plan = staffServicePlan(staff, service)
    if (!plan) {
      throw new ScheduleError('STAFF_NOT_SKILLED', `${staff.name} belum bisa mengerjakan ${service.name}`, {
        staffId: String(staff.userId),
        serviceId: String(service.id)
      })
    }
    const itemStart = cursor
    const itemEnd = itemStart + (plan.durationMin + plan.bufferMin) * MIN
    cursor = itemEnd
    return {
      productId: Number(service.id),
      serviceName: service.name,
      staffId: Number(staff.userId),
      startAt: itemStart,
      endAt: itemEnd,
      price: plan.price,
      durationMin: plan.durationMin,
      bufferMin: plan.bufferMin
    }
  })
}

/** Working windows of a staff on an outlet date, cut to the outlet's opening hours. */
const workWindows = (staff, store, date) => {
  const weekday = weekdayOf(date)
  const open = zonedToUtc(date, store.openTime, store.timezone)
  const close = zonedToUtc(date, store.closeTime, store.timezone)
  return staff.availability
    .filter((a) => Number(a.weekday) === weekday)
    .map((a) => ({
      start: Math.max(open, zonedToUtc(date, a.startTime, store.timezone)),
      end: Math.min(close, zonedToUtc(date, a.endTime, store.timezone))
    }))
    .filter((w) => w.end > w.start)
}

const withinWindows = (staff, store, start, end) =>
  workWindows(staff, store, localDate(start, store.timezone)).some((w) => start >= w.start && end <= w.end)

/** Not on leave and not booked in [start, end) (BR-SLN-003). */
const isStaffFree = (staff, start, end) =>
  !staff.timeOff.some((t) => overlaps(start, end, t.startAt, t.endAt)) &&
  !staff.busy.some((b) => overlaps(start, end, b.startAt, b.endAt))

/** Booked minutes of a staff on an outlet date: "siapa saja" picks the lightest (BR-SLN-004). */
const loadOn = (staff, store, date) =>
  staff.busy
    .filter((b) => localDate(b.startAt, store.timezone) === date)
    .reduce((sum, b) => sum + (b.endAt - b.startAt) / MIN, 0)

/**
 * Bookable start times on an outlet date (BR-SLN-003/004). With staffId null
 * each start gets the free, skilled staff with the lowest load that day; ties
 * go to the lower user id, so the answer is deterministic.
 */
const computeSlots = ({ store, date, services, staff, staffId = null, stepMin, now }) => {
  const step = stepMin * MIN
  const candidates = staff
    .filter((s) => (staffId == null ? true : String(s.userId) === String(staffId)))
    .filter((s) => services.every((svc) => staffServicePlan(s, svc)))
    .sort((a, b) => Number(a.userId) - Number(b.userId))
  const byStart = new Map()
  for (const s of candidates) {
    const span = totalSpanMin(s, services) * MIN
    if (!Number.isFinite(span) || span <= 0) continue
    const load = loadOn(s, store, date)
    for (const w of workWindows(s, store, date)) {
      for (let t = w.start; t + span <= w.end; t += step) {
        if (t < now) continue
        if (!isStaffFree(s, t, t + span)) continue
        const existing = byStart.get(t)
        if (existing && existing.load <= load) continue
        byStart.set(t, { startAt: t, endAt: t + span, staffId: s.userId, load })
      }
    }
  }
  return [...byStart.values()]
    .sort((a, b) => a.startAt - b.startAt)
    .map(({ startAt, endAt, staffId: sid }) => ({ startAt, endAt, staffId: sid }))
}

/** Explicit state machine (plan §2.3). `paid` only through checkout. */
const TRANSITION_RULES = Object.freeze({
  confirm: { from: ['booked'], to: 'confirmed' },
  'check-in': { from: ['booked', 'confirmed'], to: 'checked_in' },
  start: { from: ['checked_in'], to: 'in_service' },
  complete: { from: ['in_service'], to: 'completed' },
  'no-show': { from: ['booked', 'confirmed'], to: 'no_show' },
  cancel: { from: ['booked', 'confirmed', 'checked_in'], to: 'cancelled', reason: true }
})

/** Same predicate as the exclusion constraint's WHERE. */
const BLOCKING_STATUSES = Object.freeze(['booked', 'confirmed', 'checked_in', 'in_service'])

module.exports = {
  ScheduleError,
  staffServicePlan,
  totalSpanMin,
  buildItems,
  workWindows,
  withinWindows,
  isStaffFree,
  computeSlots,
  TRANSITION_RULES,
  BLOCKING_STATUSES
}
