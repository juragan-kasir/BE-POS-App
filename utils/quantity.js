'use strict'

// Retail R1 (owner decision 2026-11-08): products flagged allowDecimalQty are
// sold by weight or volume (kg, liter). Quantities keep three decimals
// (gram / milliliter precision) and a line total is rounded to the nearest
// Rp1, half up. Everything else still sells in whole units.

const QTY_DECIMALS = 3
const QTY_SCALE = 10 ** QTY_DECIMALS

// A quantity rounded to three decimals (number in, number out; NaN stays NaN).
const roundQty = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return n
  return Math.round(n * QTY_SCALE) / QTY_SCALE
}

// True when the value has at most three decimals.
const hasQtyPrecision = (value) => {
  const n = Number(value)
  return Number.isFinite(n) && Math.abs(n * QTY_SCALE - Math.round(n * QTY_SCALE)) < 1e-6
}

// Unit price × quantity, rounded to the nearest Rp1 half up. Computed on the
// integer milli-quantity so 1.005 kg or 2.675 kg never round the wrong way
// through binary floating point.
const lineTotal = (unitPrice, quantity) => {
  const price = Number(unitPrice) || 0
  const milli = Math.round((Number(quantity) || 0) * QTY_SCALE)
  const totalMilli = price * milli
  const sign = totalMilli < 0 ? -1 : 1
  return sign * Math.floor((Math.abs(totalMilli) + QTY_SCALE / 2) / QTY_SCALE)
}

// Whether a product may be sold in this quantity: whole units always, a
// fraction only for a product sold by weight.
const isSellableQuantity = (product, quantity) => {
  const n = Number(quantity)
  if (!Number.isFinite(n) || n <= 0) return false
  if (Number.isInteger(n)) return true
  return !!product?.allowDecimalQty && hasQtyPrecision(n)
}

module.exports = {
  QTY_DECIMALS,
  roundQty,
  hasQtyPrecision,
  lineTotal,
  isSellableQuantity
}
