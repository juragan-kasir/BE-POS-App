'use strict'

const db = require('../../db/models')
const { Op } = require('sequelize')
const { ingredientBaseUnitCost, refreshProductCosting } = require('./itemCostService')
const { portionsFromStock } = require('./recipeAvailabilityService')

// BRD Harga Modal/HPP/BOM/Stok BR-01/BR-02 (phase 3): a finished good sold
// as it is (Le Minerale) has no stock of its own — it is linked to ONE
// inventory item (ingredient) per outlet, and that item's balance, cost and
// minimum stock are the only ones. product.inventoryMode 'inventory_item'.
//
// The link is stored as the outlet BOM with exactly one line: the item and
// how many of its base units one sold unit uses (Q6: a pack of 24 links the
// same item with 24). That way the sale deducts the item once (BR-09/FR-08),
// availability, HPP, voids and returns all follow the existing BOM paths,
// and no migration is needed.

const INVENTORY_ITEM_MODE = 'inventory_item'
const INVENTORY_MODES = ['stocked', 'make_to_order', 'hybrid', INVENTORY_ITEM_MODE]
// Modes whose sale deducts the product's own (finished-good) stock.
const OWN_STOCK_MODES = ['stocked', 'hybrid']
const LINK_BOM_NAME = 'Item persediaan'
const MAX_LINK_QTY = 100000

const usesOwnStock = (mode) => OWN_STOCK_MODES.includes(mode || 'stocked')
const isInventoryItemMode = (mode) => mode === INVENTORY_ITEM_MODE

class InventoryLinkError extends Error {
  constructor(message, { statusCode = 400, code = 'INVENTORY_LINK_INVALID', field = 'inventoryLinks' } = {}) {
    super(message)
    this.statusCode = statusCode
    this.code = code
    this.field = field
  }
}

// `inventoryLinks` arrives as JSON (multipart product form) or an array:
// [{ store, ingredientId, qty }]. qty defaults to 1 base unit per sold unit.
// undefined = not sent (keep the links as they are).
const parseInventoryLinks = (raw) => {
  if (raw === undefined || raw === null || raw === '') return undefined
  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      throw new InventoryLinkError('inventoryLinks must be a JSON array')
    }
  }
  if (!Array.isArray(value)) throw new InventoryLinkError('inventoryLinks must be an array')
  const seen = new Set()
  return value.map((link) => {
    const store = Number(link?.store)
    const ingredientId = Number(link?.ingredientId)
    const qty = link?.qty === undefined || link?.qty === null || link?.qty === '' ? 1 : Number(link.qty)
    if (!Number.isInteger(store) || store <= 0 || !Number.isInteger(ingredientId) || ingredientId <= 0) {
      throw new InventoryLinkError('Each inventory link needs a store and an inventory item')
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_LINK_QTY) {
      throw new InventoryLinkError(`Quantity per sold unit must be a whole number from 1 to ${MAX_LINK_QTY}`)
    }
    if (seen.has(store)) throw new InventoryLinkError('One inventory item per outlet')
    seen.add(store)
    return { store, ingredientId, qty }
  })
}

/**
 * Validates the links an 'inventory_item' product will have after the
 * write: every outlet that sells it (`stores`) has one, and each item is an
 * active ingredient of that same outlet. `existing` are links already stored
 * for outlets the request does not change.
 *
 * @returns {Promise<Array<{store:number, ingredientId:number, qty:number, ingredient:object}>>}
 */
async function validateInventoryLinks({ links = [], existing = [], stores = [], transaction }) {
  const sellingStores = stores.map(Number)
  const sells = (store) => sellingStores.length === 0 || sellingStores.includes(store)
  for (const link of links) {
    if (!sells(link.store)) throw new InventoryLinkError(`Outlet ${link.store} does not sell this product`)
  }
  // A stored link of an outlet that no longer sells the product is left
  // as it is and not checked.
  const byStore = new Map(existing.filter((l) => sells(l.store)).map((l) => [l.store, l]))
  for (const link of links) byStore.set(link.store, link)
  const merged = sellingStores.length ? sellingStores.map((s) => byStore.get(s)).filter(Boolean) : [...byStore.values()]
  const missing = sellingStores.filter((s) => !byStore.has(s))
  if (merged.length === 0 || missing.length > 0) {
    throw new InventoryLinkError(
      'Pilih item persediaan untuk setiap outlet yang menjual produk ini',
      { code: 'INVENTORY_LINK_REQUIRED' }
    )
  }

  const ingredients = await db.ingredient.findAll({
    where: { id: [...new Set(merged.map((l) => l.ingredientId))] },
    transaction
  })
  const ingredientById = new Map(ingredients.map((i) => [i.id, i]))
  return merged.map((link) => {
    const ingredient = ingredientById.get(link.ingredientId)
    if (!ingredient) throw new InventoryLinkError(`Inventory item ${link.ingredientId} not found`)
    if (Number(ingredient.store) !== link.store) {
      throw new InventoryLinkError(`Item persediaan "${ingredient.name}" bukan milik outlet ini`)
    }
    if ((ingredient.status || 'active') !== 'active') {
      throw new InventoryLinkError(`Item persediaan "${ingredient.name}" tidak aktif`)
    }
    return { ...link, ingredient }
  })
}

// Links currently stored for a product: its one-line outlet BOMs.
async function storedInventoryLinks(productId, transaction) {
  const boms = await db.bom_header.findAll({
    where: { productId },
    include: [{ model: db.bom_line, as: 'lines' }],
    transaction
  })
  return boms
    .filter((b) => (b.lines || []).length === 1)
    .map((b) => ({ store: Number(b.store), ingredientId: Number(b.lines[0].ingredientId), qty: Number(b.lines[0].qty) }))
}

/**
 * Writes validated links as the product's outlet BOMs (one active line
 * each) and refreshes the product's HPP snapshot. An outlet that already
 * has a recipe of more than one ingredient is refused — the link would
 * silently replace it.
 */
async function saveInventoryLinks(productId, validated, transaction) {
  for (const { store, ingredientId, qty, ingredient } of validated) {
    const line = { ingredientId, qty, unit: ingredient.baseUnit }
    // Locked without includes (FOR UPDATE cannot span an outer join).
    let bom = await db.bom_header.findOne({ where: { productId, store }, transaction, lock: transaction.LOCK.UPDATE })
    const lineCount = bom ? await db.bom_line.count({ where: { bomHeaderId: bom.id }, transaction }) : 0
    if (lineCount > 1) {
      throw new InventoryLinkError(
        'Produk ini sudah punya resep dengan beberapa bahan di outlet tersebut. Hapus resepnya dulu sebelum menautkan item persediaan.',
        { statusCode: 409, code: 'RECIPE_EXISTS' }
      )
    }
    if (bom) {
      await bom.update({ name: LINK_BOM_NAME, totalQty: 1, status: 'active' }, { transaction })
      await db.bom_line.destroy({ where: { bomHeaderId: bom.id }, transaction })
    } else {
      bom = await db.bom_header.create(
        { store, productId, name: LINK_BOM_NAME, totalQty: 1, status: 'active' },
        { transaction }
      )
    }
    await db.bom_line.create({ ...line, bomHeaderId: bom.id }, { transaction })
    await refreshProductCosting(productId, [line], [ingredient], transaction, 1)
  }
  // The item is what is sold, not an ingredient list to show customers.
  await db.product.update({ composition: [] }, { where: { id: productId }, transaction })
}

/**
 * The links of a product as the product pages show them (FR-02): per
 * outlet, the item, its balance, minimum and cost read from the item, and
 * how many units it can sell.
 */
async function describeInventoryLinks(productId, { store = null, transaction } = {}) {
  const boms = await db.bom_header.findAll({
    where: { productId, ...(store ? { store } : {}) },
    include: [
      {
        model: db.bom_line,
        as: 'lines',
        include: [{ model: db.ingredient, as: 'ingredientData' }]
      },
      { model: db.location, as: 'storeData', attributes: ['id', 'name'], required: false }
    ],
    order: [['store', 'ASC']],
    transaction
  })
  return boms
    .filter((b) => (b.lines || []).length === 1 && b.lines[0].ingredientData)
    .map((b) => {
      const line = b.lines[0]
      const ing = line.ingredientData
      const qty = Number(line.qty)
      const stock = Number(ing.stock) || 0
      const baseCost = ingredientBaseUnitCost(ing)
      return {
        store: Number(b.store),
        storeName: b.storeData?.name ?? null,
        bomId: b.id,
        status: b.status,
        ingredientId: ing.id,
        ingredientName: ing.name,
        qty,
        baseUnit: ing.baseUnit,
        stock,
        minStock: Number(ing.minStock) || 0,
        costPerBaseUnit: baseCost > 0 ? Math.round(baseCost * 10000) / 10000 : null,
        unitCost: baseCost > 0 ? Math.round(baseCost * qty * 100) / 100 : null,
        availableUnits: portionsFromStock(stock, qty, 1)
      }
    })
}

// A product whose stock is its inventory item never receives stock of its
// own (BR-01) — goods receipts, stock counts and transfers of it are
// recorded on the item. Throws a 422 naming the products.
async function assertNoOwnStockWrites(productIds, transaction) {
  const ids = [...new Set((productIds || []).map(Number).filter(Boolean))]
  if (!ids.length) return
  const linked = await db.product.findAll({
    where: { id: ids, inventoryMode: INVENTORY_ITEM_MODE },
    attributes: ['id', 'nameProduct'],
    transaction
  })
  if (!linked.length) return
  const names = linked.map((p) => p.nameProduct).join(', ')
  const e = new InventoryLinkError(
    `Stok ${names} mengikuti item persediaan. Catat penerimaan, stok opname, atau transfernya di bahan baku.`,
    { statusCode: 422, code: 'PRODUCT_USES_INVENTORY_ITEM', field: 'items' }
  )
  e.products = linked.map((p) => p.id)
  throw e
}

// BRD Q7 (read-only): products that still keep their own stock while an
// ingredient of the same name exists at an outlet that sells them — the
// double balances (Le Minerale) to reconcile. Nothing is changed: the owner
// links each one from the product form (mode "Item persediaan") after
// deciding which balance is right.
async function duplicateInventoryCandidates({ store = null } = {}) {
  const products = await db.product.findAll({
    where: { inventoryMode: { [Op.ne]: INVENTORY_ITEM_MODE } },
    attributes: ['id', 'nameProduct', 'inventoryMode', 'stock', 'minStock', 'costPrice', 'status']
  })
  if (!products.length) return []
  const assignments = await db.product_store.findAll({ attributes: ['product', 'store'], raw: true })
  const activeStores = (await db.location.findAll({ where: { status: 'active' }, attributes: ['id'], raw: true })).map(
    (l) => Number(l.id)
  )
  const storesByProduct = new Map()
  for (const a of assignments) {
    const list = storesByProduct.get(Number(a.product)) || []
    list.push(Number(a.store))
    storesByProduct.set(Number(a.product), list)
  }
  const ingredients = await db.ingredient.findAll({
    where: store ? { store } : {},
    attributes: ['id', 'name', 'store', 'stock', 'minStock', 'baseUnit', 'unit', 'costPrice', 'conversionFactor', 'status']
  })
  const key = (name) => String(name || '').trim().toLowerCase()
  const ingredientByStoreName = new Map(ingredients.map((i) => [`${i.store}|${key(i.name)}`, i]))
  const outletStock = await db.product_store_stock.findAll({ attributes: ['product', 'store', 'stock'], raw: true })
  const stockByKey = new Map(outletStock.map((r) => [`${r.product}|${r.store}`, Number(r.stock) || 0]))

  const rows = []
  for (const p of products) {
    const stores = storesByProduct.get(p.id) || activeStores
    for (const s of stores) {
      if (store && s !== Number(store)) continue
      const ing = ingredientByStoreName.get(`${s}|${key(p.nameProduct)}`)
      if (!ing) continue
      const baseCost = ingredientBaseUnitCost(ing)
      rows.push({
        productId: p.id,
        productName: p.nameProduct,
        inventoryMode: p.inventoryMode || 'stocked',
        store: s,
        productStock: stockByKey.get(`${p.id}|${s}`) ?? 0,
        productMinStock: Number(p.minStock) || 0,
        productCostPrice: Number(p.costPrice) || 0,
        ingredientId: ing.id,
        ingredientName: ing.name,
        ingredientStock: Number(ing.stock) || 0,
        ingredientMinStock: Number(ing.minStock) || 0,
        baseUnit: ing.baseUnit,
        ingredientCostPerBaseUnit: baseCost > 0 ? Math.round(baseCost * 10000) / 10000 : null
      })
    }
  }
  return rows.sort((a, b) => a.store - b.store || a.productId - b.productId)
}

const inventoryLinkErrorBody = (error) => ({
  success: false,
  code: error.code,
  field: error.field,
  message: error.message,
  ...(error.products ? { products: error.products } : {})
})

module.exports = {
  INVENTORY_ITEM_MODE,
  INVENTORY_MODES,
  OWN_STOCK_MODES,
  LINK_BOM_NAME,
  usesOwnStock,
  isInventoryItemMode,
  InventoryLinkError,
  inventoryLinkErrorBody,
  parseInventoryLinks,
  validateInventoryLinks,
  storedInventoryLinks,
  saveInventoryLinks,
  describeInventoryLinks,
  assertNoOwnStockWrites,
  duplicateInventoryCandidates
}
