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

// Recipe cost of one unit: Σ (base-unit cost × BOM quantity). Unknown (null)
// as soon as one ingredient has no purchase price — a partial sum would
// silently understate the cost.
function recipeUnitCost(lines, ingredientById) {
  let total = 0
  for (const line of lines) {
    const cost = ingredientBaseUnitCost(ingredientById.get(line.ingredientId))
    if (!(cost > 0)) return null
    total += cost * Number(line.qty)
  }
  return roundCost(total)
}

/**
 * Unit cost per product at `store`, for the products of one order.
 *
 * Mirrors the stock-deduction rule (stockMutationService F7): a product that
 * is not 'stocked' consumes its active outlet BOM, so its cost is that
 * recipe at the ingredients' current purchase prices; a 'stocked' product
 * (or one without a usable recipe) costs its product.costPrice.
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
      costs.set(product.id, recipeUnitCost(recipe.lines, ingredientById))
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
  recipeUnitCost,
  resolveProductUnitCosts,
  bundleUnitCost,
  costedProductIds
}
