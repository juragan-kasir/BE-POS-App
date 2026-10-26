'use strict'

const db = require('../../db/models')
const { assertDecimalQuantity } = require('../../utils/decimalQuantityGuard')
const { recipeYield } = require('./itemCostService')

/**
 * Single authoritative path for mutating a product's stock (product.stock
 * + product_store_stock + stock_history), used by every feature that
 * changes stock outside the checkout-time sale/return-approval paths
 * (which have their own already-audited, already-tested locking).
 *
 * Before this existed, every caller (goods receipt, purchase return,
 * stock opname, ...) independently reimplemented the same ~15-line
 * "upsert product_store_stock + update product.stock + insert
 * stock_history" pattern, and the copies diverged in correctness — some
 * used an atomic SQL delta, others computed the new value in JS from an
 * unlocked read (a lost-update race under concurrent writers to the same
 * product), and some wrote an absolute value that could silently
 * overwrite a concurrent sale's decrement. This helper always locks the
 * product row first and always applies the change as an atomic SQL delta,
 * so every caller gets the same, correct concurrency guarantee.
 *
 * Callers MUST already be inside a transaction and pass it in — this
 * function does not open its own, since it's meant to be one step inside
 * a larger atomic operation (e.g. "reverse this whole goods receipt").
 */

/**
 * Adjust a product's stock by a signed delta.
 *
 * @param {object} params
 * @param {number} params.productId
 * @param {number|null} [params.store] - per-store shadow row updated only if provided
 * @param {number} params.deltaQty - signed; positive = increase, negative = decrease
 * @param {string} params.referenceType - stock_history.referenceType
 * @param {number|null} [params.referenceId]
 * @param {string|null} [params.notes]
 * @param {number|null} [params.createdBy]
 * @param {import('sequelize').Transaction} params.transaction - required
 * @param {boolean} [params.floorAtZero=true] - clamp the result at 0 instead of allowing negative
 * @param {boolean} [params.allowFractional=false] - preserve a fractional deltaQty
 *   instead of truncating it. Defaults to false (unchanged, existing behavior)
 *   for every direct caller; only setProductStock's stock-opname path opts in,
 *   since that is the one flow verified (Phase 34) to require fractional
 *   physical counts for fractional-unit products. Goods receipt and purchase
 *   return, the other two direct callers, are intentionally left untouched.
 * @returns {Promise<{product: object, quantityBefore: number, quantityAfter: number}|null>} null if delta is 0 or product not found
 */
async function adjustProductStock({
  productId,
  store = null,
  deltaQty,
  referenceType,
  referenceId = null,
  notes = null,
  createdBy = null,
  transaction,
  floorAtZero = true,
  allowFractional = false
}) {
  if (!transaction) {
    throw new Error('adjustProductStock requires an explicit transaction')
  }
  const qty = allowFractional ? Number(deltaQty) || 0 : Math.trunc(Number(deltaQty)) || 0
  if (qty === 0) return null

  const product = await db.product.findByPk(productId, {
    transaction,
    lock: transaction.LOCK.UPDATE
  })
  if (!product) return null

  const quantityBefore = Number(product.stock) || 0
  const literal = floorAtZero
    ? `GREATEST(stock + (${qty}), 0)`
    : `stock + (${qty})`
  const quantityAfter = floorAtZero
    ? Math.max(quantityBefore + qty, 0)
    : quantityBefore + qty

  await product.update(
    { stock: db.sequelize.literal(literal) },
    { transaction }
  )
  product.stock = quantityAfter

  if (store) {
    // Seed a brand-new row with the product's own current baseline (not
    // 0) before applying the delta — stock opname is very often the
    // FIRST-EVER stock event for a given product/store pair (that's what
    // "count the physical stock and reconcile the system" means for a
    // store just being onboarded). Seeding at 0 would make the delta land
    // on the wrong absolute value the first time a per-store row is
    // created; seeding at the already-locked product baseline makes this
    // correct whether or not a row already existed.
    await db.sequelize.query(
      `INSERT INTO product_store_stock (product, store, stock, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (product, store) DO NOTHING`,
      { bind: [productId, store, quantityBefore], transaction }
    )
    await db.product_store_stock.update(
      { stock: db.sequelize.literal(literal) },
      { where: { product: productId, store }, transaction }
    )
  }

  await db.stock_history.create(
    {
      product: productId,
      store,
      referenceType,
      referenceId,
      quantityBefore,
      quantityChange: qty,
      quantityAfter,
      unit: product.unit || 'pcs',
      notes,
      createdBy
    },
    { transaction }
  )

  return { product, quantityBefore, quantityAfter }
}

/**
 * Set a product's stock to an absolute counted value (e.g. stock opname).
 * The delta is computed against the freshly LOCKED live value, not
 * whatever value the caller last read (which could be from before the
 * lock, and stale by the time this commits) — so a concurrent sale's
 * atomic decrement landing between the physical count and this commit is
 * added on top of the count instead of being silently overwritten by it.
 *
 * @param {object} params - same as adjustProductStock, minus deltaQty, plus:
 * @param {number} params.newQty - the absolute target stock value
 */
async function setProductStock({
  productId,
  store = null,
  newQty,
  referenceType,
  referenceId = null,
  notes = null,
  createdBy = null,
  transaction
}) {
  if (!transaction) {
    throw new Error('setProductStock requires an explicit transaction')
  }
  const product = await db.product.findByPk(productId, {
    transaction,
    lock: transaction.LOCK.UPDATE
  })
  if (!product) return null

  const quantityBefore = Number(product.stock) || 0
  // Phase 34: no Math.trunc — a stock-opname physical count for a
  // fractional-unit product (kg, gram, liter, ...) is a real decimal, and
  // product.stock is DECIMAL(10,4); matches the ingredient-side sibling
  // branch in stockOpname.js, which never truncated this value.
  const target = Number(newQty) || 0
  const delta = target - quantityBefore
  if (delta === 0) return { product, quantityBefore, quantityAfter: quantityBefore }

  return adjustProductStock({
    productId,
    store,
    deltaQty: delta,
    referenceType,
    referenceId,
    notes,
    createdBy,
    transaction,
    floorAtZero: true,
    allowFractional: true
  })
}

/**
 * F7 — batch ingredient stock mutation, the ingredient-side counterpart to
 * adjustProductStock above. Deliberately NOT the same single-row
 * (findByPk) shape: the checkout hot path needs to lock every distinct
 * ingredient an order touches in one deterministic pass — exactly the
 * batching discipline order.js's deductStockForOrder already uses for
 * products (see its own comment on replacing "one findByPk+lock per
 * line") — so a single-row primitive would force the caller back into
 * that anti-pattern. This function accepts the whole order's worth of
 * per-(product, ingredient) contributions at once.
 *
 * Handles both deduction (negative qty) and restoration/reversal
 * (positive qty) — the same locking, revalidation, and snapshot logic
 * applies either way; only the sign differs.
 *
 * Callers MUST already be inside a transaction and pass it in, exactly
 * like adjustProductStock's contract.
 *
 * @param {object} params
 * @param {Array<{productId:number, ingredientId:number, ingredientName?:string, qty:number}>} params.items
 *   Signed per-(product, ingredient) quantities. Multiple entries may
 *   share the same ingredientId (e.g. two products both consuming
 *   "Sauce") — each is preserved as its own stock_history row even
 *   though the ingredient's stock counter is mutated exactly once.
 * @param {number} params.store - the order's own store. Every resolved
 *   ingredient must belong to this store or the whole batch is rejected —
 *   defense in depth, never trusts that the caller's BOM resolution
 *   already guaranteed this.
 * @param {string} params.referenceType - stock_history.referenceType
 * @param {number} params.referenceId - stock_history.referenceId
 * @param {string|null} [params.notes]
 * @param {number|null} [params.createdBy]
 * @param {import('sequelize').Transaction} params.transaction - required
 * @param {Array} [params.shortages] - BA gap 028 (DR-18) settlement mode.
 *   When given, an ingredient that cannot cover a deduction is NOT refused:
 *   each line takes what is left (never below zero), and every uncovered
 *   amount is pushed here as { type: 'ingredient', id, name, productId,
 *   required, deducted, shortfall } so the caller records and surfaces it.
 *   Without it, a shortage is refused (409 INGREDIENT_STOCK_CONFLICT).
 * @returns {Promise<Array<{ingredientId:number, quantityBefore:number, quantityAfter:number}>>}
 */
async function adjustIngredientStockBatch({
  items,
  store,
  referenceType,
  referenceId,
  notes = null,
  createdBy = null,
  transaction,
  shortages = null
}) {
  if (!transaction) {
    throw new Error('adjustIngredientStockBatch requires an explicit transaction')
  }
  if (!items || items.length === 0) return []

  const ingredientIds = [...new Set(items.map((i) => i.ingredientId))].sort(
    (a, b) => a - b
  )

  const ingredients = await db.ingredient.findAll({
    where: { id: ingredientIds },
    transaction,
    lock: transaction.LOCK.UPDATE
  })
  const ingredientById = new Map(ingredients.map((i) => [i.id, i]))

  // Defense in depth — never trust that BOM resolution already verified
  // store ownership; a malformed or directly-tampered record must still
  // be rejected here, at the point stock is actually mutated. A NULL
  // ingredient.store never matches any real order store, so it always
  // fails this check.
  for (const id of ingredientIds) {
    const ing = ingredientById.get(id)
    if (!ing) {
      const e = new Error(`Ingredient ${id} not found`)
      e.statusCode = 409
      throw e
    }
    if (!ing.store || ing.store !== store) {
      const e = new Error(
        `Ingredient "${ing.name}" does not belong to store ${store}`
      )
      e.statusCode = 409
      throw e
    }
  }

  // Aggregate the true, atomic per-ingredient delta — this single number
  // per ingredient is what must never take stock negative, computed from
  // the just-locked value, not any pre-transaction estimate.
  const aggregateDelta = new Map()
  for (const item of items) {
    aggregateDelta.set(
      item.ingredientId,
      (aggregateDelta.get(item.ingredientId) || 0) + Number(item.qty)
    )
  }

  // DR-18 settlement mode: cap each deduction line at what is left of its
  // ingredient, so stock never goes below zero, and record the uncovered
  // remainder instead of refusing the payment.
  if (Array.isArray(shortages)) {
    const remaining = new Map(ingredientIds.map((id) => [id, Number(ingredientById.get(id).stock)]))
    for (const item of items) {
      const qty = Number(item.qty)
      if (qty >= 0) {
        remaining.set(item.ingredientId, remaining.get(item.ingredientId) + qty)
        continue
      }
      const need = -qty
      const left = Math.max(remaining.get(item.ingredientId), 0)
      const deducted = Math.min(left, need)
      remaining.set(item.ingredientId, remaining.get(item.ingredientId) - deducted)
      if (deducted < need) {
        const ing = ingredientById.get(item.ingredientId)
        shortages.push({
          type: 'ingredient',
          id: item.ingredientId,
          name: item.ingredientName || ing.name,
          productId: item.productId ?? null,
          required: need,
          deducted,
          shortfall: need - deducted
        })
        item.qty = -deducted
        item.shortfall = need - deducted
      }
    }
    aggregateDelta.clear()
    for (const item of items) {
      aggregateDelta.set(
        item.ingredientId,
        (aggregateDelta.get(item.ingredientId) || 0) + Number(item.qty)
      )
    }
  }

  for (const id of ingredientIds) {
    const ing = ingredientById.get(id)
    const delta = aggregateDelta.get(id) || 0
    const projected = Number(ing.stock) + delta
    if (delta < 0 && projected < 0) {
      const e = new Error(
        `Stok bahan baku "${ing.name}" tidak mencukupi. Tersedia: ${Number(ing.stock)}, dibutuhkan: ${-delta}`
      )
      e.statusCode = 409
      // Stable machine-readable refusal (docs/order-create-client-contract
      // §4): raised inside the sale transaction, after the idempotency-key
      // lookup — nothing is written, and it is never a key conflict.
      e.code = 'INGREDIENT_STOCK_CONFLICT'
      throw e
    }
  }

  // Exactly one atomic SQL delta per distinct ingredient.
  for (const id of ingredientIds) {
    const delta = aggregateDelta.get(id) || 0
    if (delta === 0) continue
    await db.ingredient.update(
      { stock: db.sequelize.literal(`GREATEST(stock + (${delta}), 0)`) },
      { where: { id }, transaction }
    )
  }

  // Per-(product, ingredient) stock_history rows — the immutable
  // deduction/restoration snapshot a future reversal reads, never
  // re-deriving anything from the BOM. A running before/after cursor per
  // ingredient keeps each row individually coherent while their
  // quantityChange values sum to exactly the aggregate delta applied
  // above.
  const runningBefore = new Map(
    ingredientIds.map((id) => [id, Number(ingredientById.get(id).stock)])
  )
  const historyRows = []
  for (const item of items) {
    const ing = ingredientById.get(item.ingredientId)
    const before = runningBefore.get(item.ingredientId)
    const change = Number(item.qty)
    const after = before + change
    runningBefore.set(item.ingredientId, after)
    historyRows.push({
      store,
      product: item.productId,
      ingredient: item.ingredientId,
      ingredientName: item.ingredientName || ing.name,
      referenceType,
      referenceId,
      quantityBefore: before,
      quantityChange: change,
      quantityAfter: after,
      unit: ing.baseUnit || ing.unit || 'pcs',
      notes: item.shortfall
        ? `${notes ? `${notes} — ` : ''}KURANG ${item.shortfall} (stok tidak mencukupi saat pembayaran)`
        : notes,
      createdBy
    })
  }
  if (historyRows.length) {
    await db.stock_history.bulkCreate(historyRows, { transaction })
  }

  return ingredientIds.map((id) => {
    const before = Number(ingredientById.get(id).stock)
    return {
      ingredientId: id,
      quantityBefore: before,
      quantityAfter: before + (aggregateDelta.get(id) || 0)
    }
  })
}


/**
 * Manual stock entry for ONE ingredient (opening stock, correction, count):
 * the single-row counterpart of adjustIngredientStockBatch. The row is
 * locked first and the change is computed from the LOCKED value, then
 * applied as one atomic SQL delta — a concurrent sale's decrement landing
 * between the operator's read and this commit is never overwritten.
 *
 * mode 'set' always writes a history row, even when the delta is 0: a
 * counted zero is a recorded fact, distinct from stock never entered.
 *
 * @param {object} params
 * @param {number} params.ingredientId
 * @param {number|null} params.store - the caller's store; the ingredient
 *   must belong to it (null = a global caller, no store check)
 * @param {'add'|'subtract'|'set'} params.mode
 * @param {number} params.quantity - non-negative, ≤ 4 decimals
 * @param {import('sequelize').Transaction} params.transaction - required
 * @returns {Promise<{ingredient: object, quantityBefore: number, quantityChange: number, quantityAfter: number}|null>}
 *   null when the ingredient does not exist (or is outside the store)
 */
async function adjustIngredientStock({
  ingredientId,
  store = null,
  mode,
  quantity,
  referenceType = 'adjustment',
  notes = null,
  createdBy = null,
  transaction
}) {
  if (!transaction) {
    throw new Error('adjustIngredientStock requires an explicit transaction')
  }
  const fail = (statusCode, message, code) => {
    const e = new Error(message)
    e.statusCode = statusCode
    if (code) e.code = code
    throw e
  }
  if (!['add', 'subtract', 'set'].includes(mode)) {
    fail(400, 'type must be one of add, subtract, set')
  }
  const qty = Number(quantity)
  if (!Number.isFinite(qty) || qty < 0) {
    fail(400, 'Quantity must be a non-negative number')
  }
  assertDecimalQuantity(qty, 'quantity')
  if (mode !== 'set' && qty === 0) {
    fail(400, 'Quantity must be greater than 0')
  }

  const ingredient = await db.ingredient.findOne({
    where: { id: ingredientId, ...(store != null ? { store } : {}) },
    transaction,
    lock: transaction.LOCK.UPDATE
  })
  if (!ingredient) return null

  const quantityBefore = Number(ingredient.stock) || 0
  // Rounded to the column's 4 decimals so before + change === after exactly.
  const round4 = (n) => Math.round(n * 10000) / 10000
  const quantityChange = round4(
    mode === 'add' ? qty : mode === 'subtract' ? -qty : qty - quantityBefore
  )
  const quantityAfter = round4(quantityBefore + quantityChange)
  if (quantityAfter < 0) {
    fail(
      409,
      `Stok bahan baku "${ingredient.name}" tidak mencukupi. Tersedia: ${quantityBefore}, dikurangi: ${qty}`,
      'INGREDIENT_STOCK_CONFLICT'
    )
  }

  if (quantityChange !== 0) {
    await db.ingredient.update(
      { stock: db.sequelize.literal(`stock + (${quantityChange})`) },
      { where: { id: ingredient.id }, transaction }
    )
  }
  ingredient.stock = quantityAfter

  await db.stock_history.create(
    {
      store: ingredient.store,
      ingredient: ingredient.id,
      ingredientName: ingredient.name,
      referenceType,
      referenceId: ingredient.id,
      quantityBefore,
      quantityChange,
      quantityAfter,
      unit: ingredient.baseUnit || ingredient.unit || 'pcs',
      notes,
      createdBy
    },
    { transaction }
  )

  return { ingredient, quantityBefore, quantityChange, quantityAfter }
}

// stock_history reference types that put a known quantity on an
// ingredient: manual entry/correction, a physical count, a receipt.
// Sales, reversals and returns only move an already-known quantity.
const STOCK_RECORDING_REFERENCE_TYPES = ['adjustment', 'opname', 'purchase']

/**
 * Whether each ingredient's stock has ever been entered through a recorded
 * event. An ingredient created with stock 0 and never counted is
 * "uninitialized" — its 0 is unknown, not a verified zero.
 *
 * Also matches legacy manual adjustments written before stock_history
 * carried the ingredient id (product NULL, referenceId = ingredient id).
 *
 * @param {number[]} ingredientIds
 * @returns {Promise<Map<number, {lastRecordedAt: Date, lastCountedAt: Date|null}>>}
 *   only ingredients that have at least one recording event
 */
async function getIngredientStockRecording(ingredientIds) {
  const ids = [...new Set((ingredientIds || []).map(Number).filter(Number.isFinite))]
  if (ids.length === 0) return new Map()
  const rows = await db.sequelize.query(
    `SELECT COALESCE(ingredient, "referenceId") AS "ingredientId",
            MAX("createdAt") AS "lastRecordedAt",
            MAX("createdAt") FILTER (WHERE "referenceType"::text = 'opname') AS "lastCountedAt"
       FROM stock_history
      WHERE "deletedAt" IS NULL
        AND "referenceType"::text IN (:types)
        AND (ingredient IN (:ids)
             OR (ingredient IS NULL AND product IS NULL
                 AND "referenceType"::text = 'adjustment' AND "referenceId" IN (:ids)))
      GROUP BY 1`,
    {
      replacements: { ids, types: STOCK_RECORDING_REFERENCE_TYPES },
      type: db.Sequelize.QueryTypes.SELECT
    }
  )
  return new Map(
    rows.map((r) => [
      Number(r.ingredientId),
      { lastRecordedAt: r.lastRecordedAt, lastCountedAt: r.lastCountedAt || null }
    ])
  )
}

// F7 — resolves BOM ingredient requirements for a flat list of
// (productId, quantity) consumption entries, for products whose
// inventoryMode requires it ('stocked' products are skipped entirely,
// even if a BOM happens to exist for them). BOM/ingredient STRUCTURE
// reads here are unlocked (mirrors bundleMap's own pre-existing
// convention of reading definitional data before any lock is taken) —
// only ingredient STOCK itself is trusted under a lock, later, inside
// adjustIngredientStockBatch. Every fail-closed condition throws a 409
// with `statusCode` set; callers run this before any stock mutation so a
// rejection here rolls back the whole enclosing transaction.
async function resolveBomIngredientRequirements(flatItems, store, productById, t) {
  const requirements = []
  for (const { productId, quantity } of flatItems) {
    const product = productById.get(productId)
    if (!product) continue
    const mode = product.inventoryMode || 'stocked'
    if (mode === 'stocked') continue
    const orderQty = Math.floor(Number(quantity)) || 0
    if (orderQty <= 0) continue

    const bomHeader = await db.bom_header.findOne({
      where: { productId, store, status: 'active' },
      include: [{ model: db.bom_line, as: 'lines' }],
      transaction: t
    })
    if (!bomHeader || !bomHeader.lines || bomHeader.lines.length === 0) {
      const e = new Error(
        `Produk "${product.nameProduct}" menggunakan mode inventaris "${mode}" tetapi tidak memiliki BOM aktif`
      )
      e.statusCode = 409
      throw e
    }

    const ingredientIds = [...new Set(bomHeader.lines.map((l) => l.ingredientId))]
    const ingredients = await db.ingredient.findAll({
      where: { id: ingredientIds },
      transaction: t
    })
    const ingredientById = new Map(ingredients.map((i) => [i.id, i]))

    // Duplicate BOM lines for the same ingredient are summed BEFORE
    // multiplying by orderQty, never deduplicated-away.
    const perIngredientQty = new Map()
    for (const line of bomHeader.lines) {
      const lineQty = Number(line.qty)
      if (!(lineQty > 0)) {
        const e = new Error(
          `BOM produk "${product.nameProduct}" memiliki kuantitas bahan baku tidak valid`
        )
        e.statusCode = 409
        throw e
      }
      const ing = ingredientById.get(line.ingredientId)
      if (!ing) {
        const e = new Error(
          `BOM produk "${product.nameProduct}" mereferensikan bahan baku yang tidak ditemukan`
        )
        e.statusCode = 409
        throw e
      }
      // Defense in depth against a malformed/cross-store BOM link —
      // never trust that bom.js's authoring-time validation caught this.
      if (!ing.store || ing.store !== store) {
        const e = new Error(
          `BOM produk "${product.nameProduct}" mereferensikan bahan baku "${ing.name}" dari toko lain`
        )
        e.statusCode = 409
        throw e
      }
      // BASE-UNIT-ONLY contract — case-sensitive, no conversion.
      if (line.unit !== ing.baseUnit) {
        const e = new Error(
          `Satuan BOM tidak cocok untuk bahan baku "${ing.name}": BOM menggunakan "${line.unit}", satuan dasar bahan baku adalah "${ing.baseUnit}"`
        )
        e.statusCode = 409
        throw e
      }
      perIngredientQty.set(
        line.ingredientId,
        (perIngredientQty.get(line.ingredientId) || 0) + lineQty
      )
    }

    // BOM lines are written for the whole recipe yield; one sold portion
    // uses 1/yield of each line (ingredient stock is DECIMAL(10,4)).
    const portions = recipeYield(bomHeader)
    for (const [ingredientId, qtyPerRecipe] of perIngredientQty) {
      const ing = ingredientById.get(ingredientId)
      requirements.push({
        productId,
        ingredientId,
        ingredientName: ing.name,
        qty: Math.round(((qtyPerRecipe * orderQty) / portions) * 10000) / 10000
      })
    }
  }
  return requirements
}

module.exports = {
  adjustProductStock,
  setProductStock,
  adjustIngredientStockBatch,
  adjustIngredientStock,
  getIngredientStockRecording,
  STOCK_RECORDING_REFERENCE_TYPES,
  resolveBomIngredientRequirements
}
