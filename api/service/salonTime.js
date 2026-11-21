'use strict'

// Outlet-zone time helpers for the salon schedule (BR-SLN-001): instants are
// stored UTC; calendar days, weekdays and HH:mm hours are the outlet's own
// (location.timezone). Intl only — no timezone library in the BE.

const MIN = 60000
const DAY = 86400000

const formatters = new Map()
const formatter = (tz) => {
  if (!formatters.has(tz)) {
    formatters.set(
      tz,
      new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })
    )
  }
  return formatters.get(tz)
}

/** Wall-clock parts of an instant in a zone. */
const partsIn = (instant, tz) => {
  const out = {}
  for (const p of formatter(tz).formatToParts(new Date(instant))) out[p.type] = p.value
  return out
}

/** Offset (ms) of a zone at an instant: local wall clock − UTC. */
const offsetAt = (instant, tz) => {
  const p = partsIn(instant, tz)
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  return asUtc - Math.floor(new Date(instant).getTime() / 1000) * 1000
}

/** "2026-11-18" + "10:00" in the outlet zone → epoch ms (UTC). */
const zonedToUtc = (date, hhmm, tz) => {
  const [y, m, d] = date.split('-').map(Number)
  const [h, min] = hhmm.split(':').map(Number)
  const wall = Date.UTC(y, m - 1, d, h, min)
  // Two passes settle the offset even across a DST change (none in WIB/WITA/WIT).
  let utc = wall - offsetAt(wall, tz)
  utc = wall - offsetAt(utc, tz)
  return utc
}

/** Outlet calendar date (YYYY-MM-DD) of an instant. */
const localDate = (instant, tz) => {
  const p = partsIn(instant, tz)
  return `${p.year}-${p.month}-${p.day}`
}

/** Outlet wall time (HH:mm) of an instant. */
const localTime = (instant, tz) => {
  const p = partsIn(instant, tz)
  return `${p.hour}:${p.minute}`
}

/** 0 = Sunday … 6 = Saturday of a calendar date (zone independent). */
const weekdayOf = (date) => {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** Calendar date + n days. */
const addDays = (date, days) => {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d) + days * DAY).toISOString().slice(0, 10)
}

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd

const toIso = (instant) => new Date(instant).toISOString()

module.exports = { MIN, DAY, zonedToUtc, localDate, localTime, weekdayOf, addDays, overlaps, toIso }
