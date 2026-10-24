// BA DR-28 decision 4: a supplier product's minimum order quantity is a whole
// number (typed digits only, stored as INTEGER). Empty means the default 1.
// Returns the number, or null when the value is not a whole number >= 0.
const parseMinOrderQty = (value) => {
  if (value === undefined || value === null) return 1
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? value : null
  const text = String(value).trim()
  if (text === '') return 1
  return /^\d+$/.test(text) ? Number(text) : null
}

module.exports = { parseMinOrderQty }
