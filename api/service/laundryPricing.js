'use strict'

// Pure laundry pricing helpers shared by quote/create/pickup tests.
// Mirrors FE `src/lib/laundry-pricing.js` so the server is the price of record.

const roundQty = (qty, rounding = 0.1) => {
  const step = Number(rounding) > 0 ? Number(rounding) : 0.1
  return Number((Math.round(Number(qty) / step) * step).toFixed(2))
}

const billableQty = (serviceConfig = {}, qty = 0) => {
  const raw = Number(qty) || 0
  if (serviceConfig.pricingType !== 'kiloan') return raw
  const minQty = Number(serviceConfig.minQty) || 0
  return roundQty(Math.max(raw, minQty), serviceConfig.rounding)
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
    reminderDays: Math.max(0, Number(parsed.reminderDays) || 0),
    terms: typeof parsed.terms === 'string' ? parsed.terms : '',
    conditionTags: Array.isArray(parsed.conditionTags)
      ? parsed.conditionTags.filter((tag) => typeof tag === 'string')
      : []
  }
}

module.exports = {
  roundQty,
  billableQty,
  lineTotal,
  surchargeFor,
  addHours,
  normalizeServiceConfig,
  normalizeLaundrySettings,
  validateServiceConfig,
  hppFor
}
