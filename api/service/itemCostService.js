'use strict'

const db = require('../../db/models')

/**
 * HPP (cost of one sold unit) — the single costing rule behind
 * order_item.hppSnapshot, the COGS journal and the profit reports.
 *
 * Cost units (one convention everywhere):
 *   - ingredient.costPrice is the price of ONE PURCHASE unit (`unit`, e.g.
 *     Rp25.000 per kg) — what the ingredient form calls "Harga Beli";
 *   - ingredient.stock and BOM line quantities are in the BASE unit
 *     (`baseUnit`, e.g. gram), and conversionFactor is how many base units
 *     one purchase unit holds;
 *   - product.costPrice is the cost of one sold unit (products are sold and
 *     stocked in the same unit).
 *
 * A cost that is not known is NULL, never a guess: a missing cost used to
 * fall back to the selling price, which reported a 100 % food cost and zero
 * profit for every product without a purchase price. Reports surface the
 * unknown lines instead.
 */

// Cost of ONE base unit of an ingredient (e.g. per gram from a per-kg price).
const ingredientBaseUnitCost = (ingredient) => {
  const costPrice = Number(ingredient?.costPrice || 0)
  const factor = Number(ingredient?.conversionFactor)
  return factor > 0 ? costPrice / factor : costPrice
}

// Back to the stored convention: price of one purchase unit, whole rupiah
// (ingredient.costPrice is an INTEGER column).
const ingredientPurchaseUnitCost = (baseUnitCost, ingredient) => {
  const factor = Number(ingredient?.conversionFactor)
  return Math.round(baseUnitCost * (factor > 0 ? factor : 1))
}

const roundCost = (value) => Math.round(value * 100) / 100

// Portions one recipe makes (bom_header.totalQty). The column predates the
// yield and was never written by the API, so 0/empty means one portion.
const recipeYield = (bomHeader) => {
  const value = Number(bomHeader?.totalQty)
  return Number.isInteger(value) && value > 1 ? value : 1
}

// Recipe cost of one portion: Σ (base-unit cost × BOM quantity) / yield.
// Unknown (null) as soon as one ingredient has no purchase price — a partial
// sum would silently understate the cost.
function recipeUnitCost(lines, ingredientById, yieldQty = 1) {
  let total = 0
  for (const line of lines) {
    const cost = ingredientBaseUnitCost(ingredientById.get(line.ingredientId))
    if (!(cost > 0)) return null
    total += cost * Number(line.qty)
  }
  return roundCost(total / (yieldQty > 0 ? yieldQty : 1))
}

// HPP status of a recipe product (BRD Harga Modal/HPP §5), one rule for the
// recipe screen, the product screens and the sale snapshot:
//   - 'auto'        every line has a cost: HPP = recipe cost per portion;
//   - 'provisional' the recipe is empty or a line has no cost, and the
//                   product carries an estimate (product.costPrice);
//   - 'unavailable' neither — there is no HPP to show or snapshot.
// Food cost and margin are always derived from that same HPP.
function recipeCosting({ lines = [], ingredientById = new Map(), yieldQty = 1, estimate = 0, price = 0 }) {
  const missingCost = []
  let recipeCost = 0
  for (const line of lines) {
    const ingredient = ingredientById.get(line.ingredientId)
    const cost = ingredientBaseUnitCost(ingredient)
    if (!(cost > 0)) {
      missingCost.push({ ingredientId: line.ingredientId, name: ingredient?.name ?? null })
      continue
    }
    recipeCost += cost * Number(line.qty)
  }
  const portions = yieldQty > 0 ? yieldQty : 1
  const estimateCost = Number(estimate) > 0 ? roundCost(Number(estimate)) : null

  let status = 'unavailable'
  let hppPerPortion = null
  if (lines.length > 0 && missingCost.length === 0) {
    status = 'auto'
    hppPerPortion = roundCost(recipeCost / portions)
  } else if (estimateCost != null) {
    status = 'provisional'
    hppPerPortion = estimateCost
  }

  const sellPrice = Number(price) || 0
  const ratio = hppPerPortion != null && sellPrice > 0 ? hppPerPortion / sellPrice : null
  return {
    status,
    yieldQty: portions,
    recipeTotalCost: missingCost.length === 0 && lines.length > 0 ? roundCost(recipeCost) : null,
    hppPerPortion,
    foodCostPercent: ratio == null ? null : roundCost(ratio * 100),
    marginPercent: ratio == null ? null : roundCost((1 - ratio) * 100),
    grossProfit: hppPerPortion != null && sellPrice > 0 ? roundCost(sellPrice - hppPerPortion) : null,
    missingCost
  }
}

/**
 * Unit cost per product at `store`, for the products of one order.
 *
 * Mirrors the stock-deduction rule (stockMutationService F7): a product that
 * is not 'stocked' consumes its active outlet BOM, so its cost is that
 * recipe per portion (recipeCosting) at the ingredients' current purchase
 * prices; a 'stocked' product (or one without a usable recipe) costs its
 * product.costPrice.
 *
 * @returns {Promise<Map<number, number|null>>} productId → unit cost or null
 */
async function resolveProductUnitCosts(productIds, store, transaction) {
  const ids = [...new Set((productIds || []).map(Number).filter((id) => id > 0))]
  const costs = new Map()
  if (ids.length === 0) return costs

  const products = await db.product.findAll({
    where: { id: ids },
    attributes: ['id', 'costPrice', 'inventoryMode'],
    transaction
  })
  const recipeProductIds = products
    .filter((p) => (p.inventoryMode || 'stocked') !== 'stocked')
    .map((p) => p.id)

  const recipes = recipeProductIds.length && store
    ? await db.bom_header.findAll({
        where: { productId: recipeProductIds, store, status: 'active' },
        include: [{ model: db.bom_line, as: 'lines' }],
        transaction
      })
    : []
  const recipeByProduct = new Map(
    recipes.filter((r) => r.lines && r.lines.length > 0).map((r) => [r.productId, r])
  )
  const ingredientIds = [
    ...new Set(recipes.flatMap((r) => (r.lines || []).map((l) => l.ingredientId)))
  ]
  const ingredients = ingredientIds.length
    ? await db.ingredient.findAll({
        where: { id: ingredientIds },
        attributes: ['id', 'costPrice', 'conversionFactor'],
        transaction
      })
    : []
  const ingredientById = new Map(ingredients.map((i) => [i.id, i]))

  for (const product of products) {
    const recipe = recipeByProduct.get(product.id)
    if (recipe) {
      // Same rule as the recipe screen: the recipe cost per portion, or the
      // product's estimate while the recipe is still incomplete.
      const { hppPerPortion } = recipeCosting({
        lines: recipe.lines,
        ingredientById,
        yieldQty: recipeYield(recipe),
        estimate: product.costPrice
      })
      costs.set(product.id, hppPerPortion)
      continue
    }
    const costPrice = Number(product.costPrice || 0)
    costs.set(product.id, costPrice > 0 ? roundCost(costPrice) : null)
  }
  return costs
}

// Cost of one bundle: Σ component cost × component quantity; null when any
// component cost is unknown.
function bundleUnitCost(bundle, costs) {
  let total = 0
  for (const component of bundle?.items || []) {
    const cost = costs.get(Number(component.product))
    if (cost == null) return null
    total += cost * (Number(component.quantity) || 1)
  }
  return roundCost(total)
}

// Every product id whose cost an order needs: lines and bundle components.
function costedProductIds(items, bundleMap) {
  const ids = []
  for (const item of items || []) {
    const bundle = item.bundleId ? bundleMap?.[item.bundleId] : null
    if (bundle) {
      for (const component of bundle.items || []) ids.push(component.product)
    } else {
      ids.push(item.product || item.productId)
    }
  }
  return ids
}

module.exports = {
  ingredientBaseUnitCost,
  ingredientPurchaseUnitCost,
  recipeYield,
  recipeUnitCost,
  recipeCosting,
  resolveProductUnitCosts,
  bundleUnitCost,
  costedProductIds
}
