'use strict'

const db = require('../../db/models')
const { recipeYield } = require('./itemCostService')
const { resolveBomIngredientRequirements } = require('./stockMutationService')

// BRD Harga Modal/HPP/BOM/Stok BR-05/FR-09: a recipe product (inventoryMode
// not 'stocked') has no stock of its own. The portions it can make at an
// outlet are MIN over its recipe lines of FLOOR(ingredient stock / use per
// portion), where use per portion = line qty / recipe yield — the same
// quantity a sale deducts (stockMutationService.resolveBomIngredientRequirements,
// rounded to 4 dp). The lines giving that minimum are the limiting
// ingredients. A recipe a sale would refuse (ingredient from another store,
// unit mismatch, missing ingredient) makes 0 portions.

const round4 = (n) => Math.round(n * 10000) / 10000

// Largest n with round4(perRecipe × n / yield) ≤ stock — exactly the check
// the deduction applies, so "N portions" never promises one the sale refuses.
const portionsFromStock = (stock, perRecipe, portions) => {
  const available = Number(stock) || 0
  if (!(perRecipe > 0) || available <= 0) return 0
  let n = Math.floor((available * portions) / perRecipe + 1e-9)
  while (n > 0 && round4((perRecipe * n) / portions) > available) n -= 1
  while (round4((perRecipe * (n + 1)) / portions) <= available) n += 1
  return n
}

/**
 * Recipe availability of every product with an active outlet BOM at `store`
 * (optionally limited to `productIds`).
 *
 * @returns {Promise<{
 *   products: Map<number, { portions: number, limitingIngredientIds: number[],
 *     requirements: Array<{ ingredientId: number, perPortion: number }> }>,
 *   ingredients: Map<number, { id: number, name: string, stock: number, baseUnit: string }>
 * }>}
 */
async function recipeAvailability(store, { productIds = null, transaction } = {}) {
  const products = new Map()
  const ingredients = new Map()
  if (store == null) return { products, ingredients }

  const boms = await db.bom_header.findAll({
    where: { store, status: 'active', ...(productIds ? { productId: productIds } : {}) },
    attributes: ['id', 'productId', 'totalQty'],
    include: [
      { model: db.bom_line, as: 'lines', attributes: ['ingredientId', 'qty', 'unit'], required: true },
      {
        model: db.product,
        as: 'productData',
        attributes: ['id', 'inventoryMode'],
        required: true
      }
    ],
    transaction
  })
  const recipeBoms = boms.filter((b) => (b.productData.inventoryMode || 'stocked') !== 'stocked')
  const ingredientIds = [...new Set(recipeBoms.flatMap((b) => b.lines.map((l) => l.ingredientId)))]
  const rows = ingredientIds.length
    ? await db.ingredient.findAll({
        where: { id: ingredientIds },
        attributes: ['id', 'name', 'stock', 'baseUnit', 'store'],
        transaction
      })
    : []
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const r of rows) {
    if (Number(r.store) !== Number(store)) continue
    ingredients.set(r.id, { id: r.id, name: r.name, stock: Number(r.stock) || 0, baseUnit: r.baseUnit })
  }

  for (const bom of recipeBoms) {
    const portions = recipeYield(bom)
    const perRecipe = new Map()
    let valid = true
    for (const line of bom.lines) {
      const ing = byId.get(line.ingredientId)
      if (!ing || Number(ing.store) !== Number(store) || line.unit !== ing.baseUnit || !(Number(line.qty) > 0)) {
        valid = false
        break
      }
      perRecipe.set(line.ingredientId, (perRecipe.get(line.ingredientId) || 0) + Number(line.qty))
    }
    const requirements = valid
      ? [...perRecipe].map(([ingredientId, qty]) => ({ ingredientId, perPortion: round4(qty / portions) }))
      : []
    let min = valid ? Infinity : 0
    let limiting = []
    if (valid) {
      for (const [ingredientId, qty] of perRecipe) {
        const n = portionsFromStock(byId.get(ingredientId).stock, qty, portions)
        if (n < min) {
          min = n
          limiting = [ingredientId]
        } else if (n === min) {
          limiting.push(ingredientId)
        }
      }
    }
    products.set(bom.productId, {
      portions: Number.isFinite(min) ? min : 0,
      limitingIngredientIds: limiting,
      requirements
    })
  }
  return { products, ingredients }
}

/**
 * Pre-check of a not-yet-paid order's recipe ingredients (QR order
 * placement): the same requirements the deduction will apply, summed per
 * ingredient across the order, against current (unlocked) stock. Returns
 * the shortages — empty when the order fits. A recipe product without an
 * active BOM throws the deduction's own 409.
 *
 * @param {Array<{productId:number, quantity:number}>} flatItems - bundle components expanded
 */
async function recipeShortages(flatItems, store, transaction) {
  const ids = [...new Set(flatItems.map((i) => Number(i.productId)).filter(Boolean))]
  if (!ids.length) return []
  const products = await db.product.findAll({
    where: { id: ids },
    attributes: ['id', 'nameProduct', 'inventoryMode'],
    transaction
  })
  const productById = new Map(products.map((p) => [p.id, p]))
  const requirements = await resolveBomIngredientRequirements(
    flatItems.map((i) => ({ productId: Number(i.productId), quantity: i.quantity })),
    store,
    productById,
    transaction
  )
  if (!requirements.length) return []

  const need = new Map()
  for (const r of requirements) {
    const row = need.get(r.ingredientId) || { ingredientId: r.ingredientId, name: r.ingredientName, required: 0, productIds: new Set() }
    row.required = round4(row.required + r.qty)
    row.productIds.add(r.productId)
    need.set(r.ingredientId, row)
  }
  const stock = await db.ingredient.findAll({
    where: { id: [...need.keys()] },
    attributes: ['id', 'stock'],
    transaction
  })
  const stockById = new Map(stock.map((s) => [s.id, Number(s.stock) || 0]))
  const shortages = []
  for (const row of need.values()) {
    const available = stockById.get(row.ingredientId) ?? 0
    if (row.required > available) {
      shortages.push({
        ingredientId: row.ingredientId,
        name: row.name,
        required: row.required,
        available,
        products: [...row.productIds].map((id) => ({ id, name: productById.get(id)?.nameProduct ?? null }))
      })
    }
  }
  return shortages
}

module.exports = { recipeAvailability, recipeShortages, portionsFromStock }
