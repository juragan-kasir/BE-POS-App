'use strict'

const {
  DEFAULT_TIMEZONE,
  isValidTimezone,
  getStoreLocalDate,
  getTimezoneOffsetMs
} = require('./businessDate')

const DAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday'
]

const parseMinutes = (value) => {
  if (typeof value !== 'string') return null
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  return hours * 60 + minutes
}

const isExplicitlyClosed = (entry) => entry && entry.isOpen === false

const getStoreNowParts = (timezone, now) => {
  const tz = isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now)
  const read = (type) => parts.find((part) => part.type === type)?.value
  const hour = Number(read('hour'))
  const minute = Number(read('minute'))
  return {
    dayName: read('weekday')?.toLowerCase() || null,
    minutes:
      Number.isNaN(hour) || Number.isNaN(minute) ? null : hour * 60 + minute
  }
}

const dateString = (date) =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(
    2,
    '0'
  )}-${String(date.getUTCDate()).padStart(2, '0')}`

const localDateTimeToInstant = (dateStr, minutes, timezone) => {
  const tz = isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE
  const [year, month, day] = dateStr.split('-').map(Number)
  const hour = Math.floor(minutes / 60)
  const minute = minutes % 60
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0)
  const first = new Date(guess - getTimezoneOffsetMs(tz, new Date(guess)))
  return new Date(guess - getTimezoneOffsetMs(tz, first))
}

const findNextOpening = (entries, timezone, now, nowMinutes) => {
  const byDay = new Map(
    entries
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => [String(entry.day || '').toLowerCase(), entry])
  )
  const localDate = getStoreLocalDate(timezone, now)
  const cursor = new Date(`${localDate}T00:00:00Z`)

  for (let offset = 0; offset <= 7; offset += 1) {
    const day = new Date(cursor.getTime() + offset * 86400000)
    const entry = byDay.get(DAY_NAMES[day.getUTCDay()])
    if (!entry || isExplicitlyClosed(entry)) continue
    const open = entry.is24Hours ? 0 : parseMinutes(entry.open)
    if (open === null) continue
    if (offset === 0 && open <= nowMinutes) continue
    return localDateTimeToInstant(dateString(day), open, timezone)
  }
  return null
}

const getStoreOpenStatus = (openingHours, timezone, now = new Date()) => {
  const tz = isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE
  if (!Array.isArray(openingHours) || openingHours.length === 0) {
    return { isOpen: true, nextOpenAt: null }
  }

  const { dayName, minutes } = getStoreNowParts(tz, now)
  if (!dayName || minutes === null) {
    return { isOpen: true, nextOpenAt: null }
  }

  const entries = openingHours.filter(
    (entry) => entry && typeof entry === 'object'
  )
  const today = entries.find(
    (entry) => String(entry.day || '').toLowerCase() === dayName
  )
  if (!today) return { isOpen: true, nextOpenAt: null }

  if (today.is24Hours && !isExplicitlyClosed(today)) {
    return { isOpen: true, nextOpenAt: null }
  }

  const todayOpen = parseMinutes(today.open)
  const todayClose = parseMinutes(today.close)

  if (!isExplicitlyClosed(today) && todayOpen !== null && todayClose !== null) {
    const overnight = todayClose <= todayOpen
    const isOpenToday = overnight
      ? minutes >= todayOpen
      : minutes >= todayOpen && minutes < todayClose
    if (isOpenToday) return { isOpen: true, nextOpenAt: null }
  }

  const localDate = getStoreLocalDate(tz, now)
  const previous = new Date(`${localDate}T00:00:00Z`)
  previous.setUTCDate(previous.getUTCDate() - 1)
  const yesterday = entries.find(
    (entry) =>
      String(entry.day || '').toLowerCase() ===
      DAY_NAMES[previous.getUTCDay()]
  )
  if (yesterday && !isExplicitlyClosed(yesterday) && !yesterday.is24Hours) {
    const open = parseMinutes(yesterday.open)
    const close = parseMinutes(yesterday.close)
    if (open !== null && close !== null && close <= open && minutes < close) {
      return { isOpen: true, nextOpenAt: null }
    }
  }

  return {
    isOpen: false,
    nextOpenAt: findNextOpening(entries, tz, now, minutes)
  }
}

module.exports = { getStoreOpenStatus }
