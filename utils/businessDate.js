'use strict'

// Phase 22 Batch 3 — Timezone-Aware Due Date Foundation.
//
// Single authoritative source for every "what calendar date is it right
// now, for this store" and "how many days until this due date" question
// in the codebase. Business-date classification (AP due dates, H-4
// reminders, etc.) must go through this module rather than reaching for
// `new Date()` / `toISOString().slice(0, 10)` directly, both of which are
// silently UTC- or server-local-time-based and therefore wrong for a
// store observing a different IANA timezone than the server process.
//
// Deliberately dependency-free: Node's built-in Intl.DateTimeFormat
// already carries the full IANA timezone database (including DST
// transition rules), so no new package (moment-timezone, luxon, etc.) is
// introduced. `moment` (no timezone plugin) is already a dependency but
// cannot correctly answer "what date is it in Asia/Jakarta" — only
// Intl's `timeZone` option can, and it needs nothing extra.

const DEFAULT_TIMEZONE = 'Asia/Jakarta'

// en-CA formats as YYYY-MM-DD directly, avoiding a separate reassembly
// step from en-US's MM/DD/YYYY output.
const localDateFormatterCache = new Map()
const getFormatter = (timezone) => {
  let fmt = localDateFormatterCache.get(timezone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
    localDateFormatterCache.set(timezone, fmt)
  }
  return fmt
}

/**
 * Validate an IANA timezone identifier (e.g. "Asia/Jakarta").
 * Rejects aliases/abbreviations ("WIB") and fixed-offset strings
 * ("UTC+7") — those are not valid IANA identifiers.
 */
const isValidTimezone = (timezone) => {
  if (typeof timezone !== 'string' || !timezone.trim()) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

/**
 * The calendar date (YYYY-MM-DD) at `instant` (a real moment in time),
 * as observed in `timezone`. This is the store's "local date" — the
 * authoritative business-date used for due-date/reminder classification.
 * Falls back to DEFAULT_TIMEZONE for a missing/invalid timezone rather
 * than throwing, since this is read on hot paths (AP dashboard) where a
 * misconfigured store must not break the whole response.
 */
const getStoreLocalDate = (timezone, instant = new Date()) => {
  const tz = isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE
  return getFormatter(tz).format(instant instanceof Date ? instant : new Date(instant))
}

/**
 * Signed calendar-day difference between two YYYY-MM-DD date strings:
 * dateA - dateB. Both inputs are already plain calendar dates (no time/
 * timezone component), so diffing via Date.UTC on both sides is safe —
 * it does not reintroduce a timezone bug, it just anchors both values on
 * the same synthetic UTC midnight so DST/offset differences can't skew
 * the day count the way naive ms/86400000 arithmetic on real instants
 * would.
 */
const daysBetweenDateStrings = (dateA, dateB) => {
  const [ay, am, ad] = dateA.split('-').map(Number)
  const [by, bm, bd] = dateB.split('-').map(Number)
  const utcA = Date.UTC(ay, am - 1, ad)
  const utcB = Date.UTC(by, bm - 1, bd)
  return Math.round((utcA - utcB) / 86400000)
}

/**
 * daysUntilDue = dueDate - currentStoreLocalDate, as a signed integer.
 * Returns null when dueDate is missing (Step 12: a missing due date must
 * never be classified as overdue).
 */
const getDaysUntilDue = (dueDate, timezone, now = new Date()) => {
  if (!dueDate) return null
  const today = getStoreLocalDate(timezone, now)
  return daysBetweenDateStrings(dueDate, today)
}

/**
 * Backward-compatible with the pre-existing apDashboard() daysOverdue
 * metric (Batch 1 finding F22-B1-04): max(0, -daysUntilDue). Existing
 * consumers that only cared about "how many days past due" keep working
 * unchanged; daysUntilDue is the new, bidirectional signal.
 */
const getDaysOverdue = (daysUntilDue) => {
  if (daysUntilDue === null || daysUntilDue === undefined) return 0
  return Math.max(0, -daysUntilDue)
}

const DUE_DATE_CLASSIFICATIONS = Object.freeze({
  H4: 'H-4',
  H3: 'H-3',
  H2: 'H-2',
  H1: 'H-1',
  DUE_TODAY: 'DUE_TODAY',
  OVERDUE: 'OVERDUE',
  UPCOMING: 'UPCOMING'
})

/**
 * The single authoritative H-4..Overdue classification rule. Must not be
 * reimplemented anywhere else (controller, FE, future scheduler) — every
 * consumer should call this function (BE) or receive its already-computed
 * result over the API (FE).
 */
const classifyDueDate = (daysUntilDue) => {
  if (daysUntilDue === null || daysUntilDue === undefined) return null
  if (daysUntilDue < 0) return DUE_DATE_CLASSIFICATIONS.OVERDUE
  if (daysUntilDue === 0) return DUE_DATE_CLASSIFICATIONS.DUE_TODAY
  if (daysUntilDue === 1) return DUE_DATE_CLASSIFICATIONS.H1
  if (daysUntilDue === 2) return DUE_DATE_CLASSIFICATIONS.H2
  if (daysUntilDue === 3) return DUE_DATE_CLASSIFICATIONS.H3
  if (daysUntilDue === 4) return DUE_DATE_CLASSIFICATIONS.H4
  return DUE_DATE_CLASSIFICATIONS.UPCOMING
}

const offsetFormatterCache = new Map()
const getOffsetFormatter = (timezone) => {
  let fmt = offsetFormatterCache.get(timezone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
    offsetFormatterCache.set(timezone, fmt)
  }
  return fmt
}

const getTimezoneOffsetMs = (timezone, instant = new Date()) => {
  const tz = isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE
  const at = instant instanceof Date ? instant : new Date(instant)
  const parts = getOffsetFormatter(tz).formatToParts(at)
  const read = (type) => {
    const part = parts.find((p) => p.type === type)
    return part ? Number(part.value) : 0
  }
  const asUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour'),
    read('minute'),
    read('second')
  )
  return asUtc - Math.floor(at.getTime() / 1000) * 1000
}

const getTimezoneOffset = (timezone, instant = new Date()) => {
  const ms = getTimezoneOffsetMs(timezone, instant)
  const sign = ms < 0 ? '-' : '+'
  const abs = Math.abs(ms)
  const hours = String(Math.floor(abs / 3600000)).padStart(2, '0')
  const minutes = String(Math.floor((abs % 3600000) / 60000)).padStart(2, '0')
  return `${sign}${hours}:${minutes}`
}

const getStoreDayBounds = (dateStr, timezone) => {
  const tz = isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE
  const [year, month, day] = String(dateStr).split('-').map(Number)
  const resolveStart = (y, m, d) => {
    const guess = Date.UTC(y, m - 1, d, 0, 0, 0)
    let start = new Date(guess - getTimezoneOffsetMs(tz, new Date(guess)))
    const refined = new Date(guess - getTimezoneOffsetMs(tz, start))
    if (refined.getTime() !== start.getTime()) start = refined
    return start
  }
  const start = resolveStart(year, month, day)
  const next = new Date(Date.UTC(year, month - 1, day + 1))
  const nextStart = resolveStart(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate()
  )
  const end = new Date(nextStart.getTime() - 1)
  return { start, end }
}

const getStoreTodayBounds = (timezone, now = new Date()) => {
  const localDateStr = getStoreLocalDate(timezone, now)
  return getStoreDayBounds(localDateStr, timezone)
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

const shiftDateString = (dateStr, days) => {
  const [y, m, d] = dateStr.split('-').map(Number)
  const shifted = new Date(Date.UTC(y, m - 1, d + days))
  return shifted.toISOString().slice(0, 10)
}

/**
 * Day of week (0 = Sunday) and "HH:mm:ss" at `instant`, as seen on the
 * store's wall clock. Promo active days and happy-hour windows are
 * defined in store time, not in the server's timezone (UTC on Vercel).
 */
const getStoreClock = (timezone, instant = new Date()) => {
  const offsetMs = getTimezoneOffsetMs(timezone, instant)
  const local = new Date((instant instanceof Date ? instant : new Date(instant)).getTime() + offsetMs)
  const pad = (n) => String(n).padStart(2, '0')
  return {
    day: local.getUTCDay(),
    time: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`
  }
}

/**
 * Instant for a date-range bound sent by a client. A plain "YYYY-MM-DD"
 * means that whole calendar day in the store's timezone (start of day for
 * `startDate`, end of day for `endDate`); anything else (a full ISO
 * instant) is used as-is.
 */
const toStoreRangeBound = (value, timezone, edge) => {
  if (value === undefined || value === null || value === '') return null
  const str = String(value)
  if (!DATE_ONLY.test(str)) return new Date(str)
  const bounds = getStoreDayBounds(str, timezone)
  return edge === 'end' ? bounds.end : bounds.start
}

/**
 * Start/end instants of "today", "this week" (Monday-Sunday) or "this
 * month" on the store's calendar.
 */
const getStorePeriodBounds = (period, timezone, now = new Date()) => {
  const today = getStoreLocalDate(timezone, now)
  if (period === 'week') {
    const daysSinceMonday = (getStoreClock(timezone, now).day + 6) % 7
    const monday = shiftDateString(today, -daysSinceMonday)
    return {
      start: getStoreDayBounds(monday, timezone).start,
      end: getStoreDayBounds(shiftDateString(monday, 6), timezone).end
    }
  }
  if (period === 'month') {
    const [y, m] = today.split('-').map(Number)
    const first = `${today.slice(0, 7)}-01`
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
    return {
      start: getStoreDayBounds(first, timezone).start,
      end: getStoreDayBounds(last, timezone).end
    }
  }
  return getStoreDayBounds(today, timezone)
}

const FILTER_PERIODS = { today: 'today', weekly: 'week', monthly: 'month' }

/**
 * The { start, end } instants a report's `filter` (today | weekly |
 * monthly) or `startDate`/`endDate` pair covers on the store's calendar,
 * or null when neither is given.
 */
const getStoreFilterRange = ({ filter, startDate, endDate }, timezone, now = new Date()) => {
  if (FILTER_PERIODS[filter]) return getStorePeriodBounds(FILTER_PERIODS[filter], timezone, now)
  if (!startDate && !endDate) return null
  return {
    start: toStoreRangeBound(startDate, timezone, 'start'),
    end: toStoreRangeBound(endDate, timezone, 'end')
  }
}

module.exports = {
  DEFAULT_TIMEZONE,
  DUE_DATE_CLASSIFICATIONS,
  isValidTimezone,
  getStoreLocalDate,
  daysBetweenDateStrings,
  getDaysUntilDue,
  getDaysOverdue,
  classifyDueDate,
  getTimezoneOffset,
  getTimezoneOffsetMs,
  getStoreDayBounds,
  getStoreTodayBounds,
  getStoreClock,
  toStoreRangeBound,
  getStorePeriodBounds,
  getStoreFilterRange
}
