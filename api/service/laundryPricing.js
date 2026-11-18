'use strict'

// Pure laundry pricing helpers shared by quote/create/pickup tests.
// Mirrors FE `src/lib/laundry-pricing.js` so the server is the price of record.

const roundQty = (qty, rounding = 0.1) => {
  const step = Number(rounding) > 0 ? Number(rounding) : 0.1
  return Number((Math.round(Number(qty) / step) * step).toFixed(2))
}

// Kiloan weight is billed rounded UP to the next step (3.2 kg at 0.5 →
// 3.5 kg), the usual practice at Indonesian laundries (owner decision
// 2026-11-15, S-1). toFixed(6) strips float noise so 0.3/0.1 stays 3.
const ceilQty = (qty, rounding = 0.1) => {
  const step = Number(rounding) > 0 ? Number(rounding) : 0.1
  const steps = Math.ceil(Number((Number(qty) / step).toFixed(6)))
  return Number((steps * step).toFixed(2))
}

const billableQty = (serviceConfig = {}, qty = 0) => {
  const raw = Number(qty) || 0
  if (serviceConfig.pricingType !== 'kiloan') return raw
  const minQty = Number(serviceConfig.minQty) || 0
  return ceilQty(Math.max(raw, minQty), serviceConfig.rounding)
}

const allocateProportionally = (total, weights = []) => {
  const value = Math.round(Number(total) || 0)
  if (!weights.length) return []
  if (!value) return weights.map(() => 0)
  const sign = value < 0 ? -1 : 1
  const absolute = Math.abs(value)
  const positive = weights.map((weight) => Math.max(0, Number(weight) || 0))
  const weightTotal = positive.reduce((sum, weight) => sum + weight, 0)
  if (!weightTotal) return weights.map((_, index) => (index === 0 ? value : 0))
  const raw = positive.map((weight) => (absolute * weight) / weightTotal)
  const floors = raw.map(Math.floor)
  let remainder = absolute - floors.reduce((sum, amount) => sum + amount, 0)
  const order = raw
    .map((amount, index) => ({ index, fraction: amount - floors[index] }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)
  const result = [...floors]
  let cursor = 0
  while (remainder > 0) {
    result[order[cursor % order.length].index] += 1
    remainder -= 1
    cursor += 1
  }
  return result.map((amount) => amount * sign)
}

const normalizeCostComponents = (components = []) =>
  (Array.isArray(components) ? components : [])
    .map((component) => ({
      kind: component?.kind || 'other',
      note: component?.note || '',
      amount: Math.max(0, Math.round(Number(component?.amount) || 0))
    }))
    .filter((component) => component.amount > 0)

const hppFor = (serviceConfig = {}, billQty = 0) => {
  const components = normalizeCostComponents(serviceConfig.costComponents)
  const hppUnit = components.reduce((sum, component) => sum + component.amount, 0)
  const hppTotal = Math.round(hppUnit * (Number(billQty) || 0))
  const componentTotals = allocateProportionally(
    hppTotal,
    components.map((component) => component.amount)
  )
  return {
    hppUnit,
    hppTotal,
    components: components.map((component, index) => ({
      ...component,
      amount: componentTotals[index] || 0
    }))
  }
}

const lineTotal = (product, qty) => {
  const serviceConfig = product?.serviceConfig || {}
  const actualQty = Number(qty) || 0
  const billQty = billableQty(serviceConfig, actualQty)
  const price = Number(product?.price) || 0
  const subtotal = Math.round(billQty * price)
  const hpp = hppFor(serviceConfig, billQty)
  return {
    actualQty,
    billQty,
    subtotal,
    minimumApplied:
      serviceConfig.pricingType === 'kiloan' && actualQty < Number(serviceConfig.minQty || 0),
    price,
    unit: product?.unit,
    channel: serviceConfig.channel || 'full',
    pricingMode: serviceConfig.pricingMode || 'unit',
    minQty: Number(serviceConfig.minQty) || 0,
    rounding: Number(serviceConfig.rounding) || 1,
    requiresIroning: Boolean(serviceConfig.requiresIroning),
    hppUnit: hpp.hppUnit,
    hppTotal: hpp.hppTotal,
    hppComponents: hpp.components
  }
}

const surchargeFor = (subtotal, turnaround) => {
  if (!turnaround) return 0
  const base = Number(subtotal) || 0
  if (turnaround.surchargeType === 'percent') {
    return Math.round((base * (Number(turnaround.surchargeValue) || 0)) / 100)
  }
  if (turnaround.surchargeType === 'fixed') {
    return Math.max(0, Math.round(Number(turnaround.surchargeValue) || 0))
  }
  return 0
}

const addHours = (date, hours) =>
  new Date(new Date(date).getTime() + (Number(hours) || 0) * 36e5)

const { DEFAULT_TIMEZONE, isValidTimezone, getTimezoneOffsetMs, getStoreLocalDate } = require('../../utils/businessDate')
const DAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday']
const parseMinutes = (v) => {
  if (typeof v !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim())
  if (!m) return null
  const h = Number(m[1]), mm = Number(m[2])
  if (h<0||h>23||mm<0||mm>59) return null
  return h*60+mm
}
const minutesToHHMM = (mins) => `${String(Math.floor(mins/60)).padStart(2,'0')}:${String(mins%60).padStart(2,'0')}`
const dateStringUTC = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`
const localToInstant = (dateStr, minutes, tz) => {
  const [y,mo,da] = dateStr.split('-').map(Number)
  const hour = Math.floor(minutes/60), minute = minutes%60
  const guess = Date.UTC(y, mo-1, da, hour, minute, 0)
  const first = new Date(guess - getTimezoneOffsetMs(tz, new Date(guess)))
  return new Date(guess - getTimezoneOffsetMs(tz, first))
}
const addDaysUTC = (dateStr, n) => {
  const d = new Date(`${dateStr}T00:00:00Z`); d.setUTCDate(d.getUTCDate()+n); return dateStringUTC(d)
}
const localParts = (inst, tz) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23', weekday:'long' }).formatToParts(inst)
  const g = (t)=>parts.find(p=>p.type===t)?.value
  return { date: `${g('year')}-${g('month')}-${g('day')}`, minutes: Number(g('hour'))*60 + Number(g('minute')), dayName: (g('weekday')||'').toLowerCase() }
}
// Convert BE openingHours array to a simple per-day map usable for due calc
// Also accepts the compact laundry shape { open, close, closedDays: [0..6] }
// (0 = Sunday) that FE-LAUNDRY saves, so its outlets get opening-hours due
// dates instead of silently falling back to elapsed time.
const compactOpeningMap = (hours) => {
  const o = parseMinutes(hours.open), c = parseMinutes(hours.close)
  if (o == null || c == null) return null
  const closed = new Set((Array.isArray(hours.closedDays) ? hours.closedDays : []).map(Number))
  const map = {}
  DAY_NAMES.forEach((day, index) => {
    map[day] = closed.has(index) ? { closed: true } : { open: o, close: c }
  })
  return map
}
const openingMap = (openingHours) => {
  if (openingHours && typeof openingHours === 'object' && !Array.isArray(openingHours)) {
    return compactOpeningMap(openingHours)
  }
  if (!Array.isArray(openingHours) || !openingHours.length) return null
  const map = {}
  for (const e of openingHours) {
    if (!e || typeof e !== 'object') continue
    const day = String(e.day||'').toLowerCase()
    if (!DAY_NAMES.includes(day)) continue
    if (e.isOpen === false) { map[day] = { closed:true }; continue }
    if (e.is24Hours) { map[day] = { open:0, close:1440 }; continue }
    const o = parseMinutes(e.open), c = parseMinutes(e.close)
    if (o==null || c==null) continue
    map[day] = { open:o, close:c }
  }
  return Object.keys(map).length ? map : null
}
const windowFor = (dateStr, map) => {
  const dow = DAY_NAMES[new Date(`${dateStr}T00:00:00Z`).getUTCDay()]
  const e = map[dow]
  if (!e || e.closed) return null
  return e
}
const nextOpenMoment = (inst, map, tz) => {
  let p = localParts(inst, tz)
  let date = p.date
  for (let i=0;i<14;i++) {
    const w = windowFor(date, map)
    if (w) {
      const startMin = (i===0) ? Math.max(p.minutes, w.open) : w.open
      if (startMin < w.close) return { date, minutes: startMin }
    }
    date = addDaysUTC(date, 1)
  }
  return { date: p.date, minutes: p.minutes }
}
const addOpenHours = (start, hours, map, tz) => {
  let remaining = (Number(hours)||0) * 60
  let cur = { ...start }
  for (let i=0;i<120 && remaining>0;i++) {
    const w = windowFor(cur.date, map)
    if (!w || cur.minutes >= w.close) {
      const inst = localToInstant(addDaysUTC(cur.date,1), 0, tz)
      cur = nextOpenMoment(inst, map, tz); continue
    }
    const avail = w.close - cur.minutes
    if (remaining <= avail) return { date: cur.date, minutes: cur.minutes + remaining }
    remaining -= avail
    const inst = localToInstant(addDaysUTC(cur.date,1), 0, tz)
    cur = nextOpenMoment(inst, map, tz)
  }
  return cur
}
const dueAtFrom = (receivedAt, hours, openingHours, timezone) => {
  const duration = Number(hours)||0
  const tz = isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE
  const inst = receivedAt instanceof Date ? receivedAt : new Date(receivedAt)
  const map = openingMap(openingHours)
  if (!map) return addHours(inst, duration)
  const start = nextOpenMoment(inst, map, tz)
  let end
  if (duration < 24) end = addOpenHours(start, duration, map, tz)
  else {
    // day packages: add calendar time to start, then snap to next open if closed
    const startInst = localToInstant(start.date, start.minutes, tz)
    end = nextOpenMoment(addHours(startInst, duration), map, tz)
  }
  return localToInstant(end.date, end.minutes, tz)
}

const normalizeServiceConfig = (value) => {
  if (value === null || value === undefined || value === '') return null
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return {
    pricingType: parsed.pricingType === 'satuan' ? 'satuan' : 'kiloan',
    channel: parsed.channel === 'self' ? 'self' : 'full',
    pricingMode: parsed.pricingMode === 'cycle' ? 'cycle' : 'unit',
    minQty: Math.max(0, Number(parsed.minQty) || 0),
    rounding: Number(parsed.rounding) > 0 ? Number(parsed.rounding) : 1,
    requiresIroning: parsed.requiresIroning === true,
    costComponents: normalizeCostComponents(parsed.costComponents)
  }
}

const validateServiceConfig = (config) => {
  if (!config) return { ok: false, message: 'serviceConfig is required for a laundry service' }
  if (!['kiloan', 'satuan'].includes(config.pricingType)) {
    return { ok: false, message: 'serviceConfig.pricingType must be kiloan or satuan' }
  }
  if (!['full', 'self'].includes(config.channel)) {
    return { ok: false, message: 'serviceConfig.channel must be full or self' }
  }
  if (!['unit', 'cycle'].includes(config.pricingMode)) {
    return { ok: false, message: 'serviceConfig.pricingMode must be unit or cycle' }
  }
  if (config.pricingType === 'kiloan' && !(config.minQty > 0)) {
    return { ok: false, message: 'serviceConfig.minQty must be greater than 0 for kiloan' }
  }
  if (!(config.rounding > 0)) {
    return { ok: false, message: 'serviceConfig.rounding must be greater than 0' }
  }
  return { ok: true }
}

const normalizeLaundrySettings = (value) => {
  if (value === null || value === undefined || value === '') return null
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return {
    serviceModel: ['full', 'self', 'hybrid'].includes(parsed.serviceModel)
      ? parsed.serviceModel
      : 'full',
    storageDays: Math.max(0, Number(parsed.storageDays) || 0),
    minDpPercent: Math.min(100, Math.max(0, Number(parsed.minDpPercent) || 0)),
    // Max manual discount per order in rupiah; 0 = default 20% of subtotal.
    maxManualDiscount: Math.max(0, Math.round(Number(parsed.maxManualDiscount) || 0)),
    reminderDays: Math.max(0, Number(parsed.reminderDays) || 0),
    terms: typeof parsed.terms === 'string' ? parsed.terms : '',
    conditionTags: Array.isArray(parsed.conditionTags)
      ? parsed.conditionTags.filter((tag) => typeof tag === 'string')
      : [],
    ownerPinHash:
      typeof parsed.ownerPinHash === 'string' && parsed.ownerPinHash ? parsed.ownerPinHash : null
  }
}

// Cap for a cashier's manual discount, same rule as FE-LAUNDRY
// setManualDiscount: the configured limit, else 20% of subtotal, never more
// than the subtotal.
const manualDiscountCap = (settings, subtotal) => {
  const configured = Math.max(0, Math.round(Number(settings?.maxManualDiscount) || 0))
  const base = Math.max(0, Math.round(Number(subtotal) || 0))
  return Math.min(configured || Math.round(base * 0.2), base)
}

const publicLaundrySettings = (value) => {
  if (!value || typeof value !== 'object') return value ?? null
  // A stored `hasOwnerPin` is never trusted: it is always derived from the hash.
  // eslint-disable-next-line no-unused-vars
  const { ownerPinHash, ownerPin, hasOwnerPin, ...rest } = value
  return { ...rest, hasOwnerPin: Boolean(ownerPinHash) }
}

module.exports = {
  allocateProportionally,
  roundQty,
  ceilQty,
  billableQty,
  lineTotal,
  surchargeFor,
  addHours,
  dueAtFrom,
  normalizeServiceConfig,
  normalizeLaundrySettings,
  publicLaundrySettings,
  manualDiscountCap,
  validateServiceConfig,
  hppFor
}
