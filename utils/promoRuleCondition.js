// Promo rule conditions are written by the FE promo form as
// { productIdX, qtyX, productIdY, qtyY } (buy_x_get_y) and { minAmount }
// (spend_threshold). Older rows may carry the original BE names
// (buyProductId/buyQuantity, minSpend), so both are read; the form's
// names win when both exist.
const firstDefined = (...values) => values.find((v) => v !== undefined && v !== null)

const buyXGetYCondition = (condition) => {
  const c = condition || {}
  return {
    buyProductId: firstDefined(c.productIdX, c.buyProductId),
    buyQuantity: Number(firstDefined(c.qtyX, c.buyQuantity)) || 1
  }
}

const spendThreshold = (condition) => {
  const c = condition || {}
  return Number(firstDefined(c.minAmount, c.minSpend)) || 0
}

// An empty or missing daysOfWeek means "every day", the same reading
// the checkout and the active-promo list already use.
const isActiveOnDay = (daysOfWeek, day) =>
  !Array.isArray(daysOfWeek) || daysOfWeek.length === 0 || daysOfWeek.includes(day)

module.exports = { buyXGetYCondition, spendThreshold, isActiveOnDay }
