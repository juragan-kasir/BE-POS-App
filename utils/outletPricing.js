'use strict'

// W3-1 (DR-11): single authoritative outlet-price resolution shared by
// checkout (counter + QR) and display (customer menu, POS listing).
//
// Rule: the live product_store_price row for an exact product + store match
// wins when present; otherwise the base product.price applies. Paranoid
// default stays enabled, so soft-deleted rows count as missing. No global
// fallback, no cross-store reads (product + store is unique).
//
// Prices are INTEGER minor units. Configured values (including 0 and
// negatives) resolve as-is — no normalization happens here; validation
// hardening is a separate follow-up.

const db = require('../db/models')

// Returns the live outlet row price, or null when no live row exists.
const resolveOutletBasePrice = async (productId, store) => {
  if (productId === undefined || productId === null || store === undefined || store === null) {
    return null
  }
  const row = await db.product_store_price.findOne({
    where: { product: productId, store },
    attributes: ['price']
  })
  if (!row || row.price === null || row.price === undefined) {
    return null
  }
  return Number(row.price)
}

// Authoritative catalog base for a product in a store: outlet row wins,
// otherwise base product.price.
const resolveCatalogBase = async (prod, store) => {
  if (prod && prod.id !== undefined && prod.id !== null && store !== undefined && store !== null) {
    const outletPrice = await resolveOutletBasePrice(prod.id, store)
    if (outletPrice !== null) {
      return outletPrice
    }
  }
  return Number(prod.price) || 0
}

// Batched per-store effective catalog price for a set of products —
// semantically identical to resolveCatalogBase(product, store) but a single
// query, so listings do not run an N+1 per product. Returns
// Map<productId, effectivePrice>. Mirrors the F4-03 getEffectiveStockMap
// pattern.
const getEffectivePriceMap = async (products, store) => {
  const productById = new Map(
    products.filter((p) => p && p.id != null).map((p) => [String(p.id), p])
  )
  const map = new Map()
  for (const [id] of productById) {
    map.set(id, Number(productById.get(id).price) || 0)
  }
  if (!map.size || !store) return map
  try {
    const rows = await db.product_store_price.findAll({
      where: { product: Array.from(productById.keys()), store },
      attributes: ['product', 'price']
    })
    for (const row of rows) {
      if (row.price !== null && row.price !== undefined) {
        map.set(String(row.product), Number(row.price))
      }
    }
  } catch (err) {
    if (err && err.code === '42P01') {
      return map
    }
    throw err
  }
  return map
}

// Retail R1 (owner decision 2026-11-08): quantity price breaks (grosir).
// A product's priceTiers entry may carry `minQty`; for a line of `qty` units
// the tier with the HIGHEST minQty that is <= qty sets the unit price. Tiers
// without a valid minQty are named price lists (member, grosir label) and
// are never applied automatically. Returns null when no break applies.
const quantityTierPrice = (tiers, qty) => {
  const quantity = Number(qty)
  if (!Array.isArray(tiers) || !(quantity > 0)) return null
  let best = null
  for (const t of tiers) {
    const minQty = Number(t && t.minQty)
    const price = Number(t && t.price)
    if (!(minQty > 0) || !Number.isFinite(price) || price < 0) continue
    if (minQty <= quantity && (!best || minQty > best.minQty)) best = { minQty, price }
  }
  return best ? Math.round(best.price) : null
}

// Cleans priceTiers on save: keeps name/price, and minQty only when it is a
// positive number (a tier without one stays a named price list).
const normalizePriceTiers = (tiers) => {
  if (!Array.isArray(tiers)) return []
  return tiers
    .filter((t) => t && typeof t === 'object')
    .map((t) => {
      const out = { ...t }
      const price = Number(t.price)
      out.price = Number.isFinite(price) && price >= 0 ? Math.round(price) : 0
      const minQty = Number(t.minQty)
      if (minQty > 0) out.minQty = minQty
      else delete out.minQty
      return out
    })
}

// Public view of a product's grosir breaks: [{ minQty, price }] sorted by
// minQty, only tiers quantityTierPrice would ever apply (named tiers such as
// member prices are left out).
const quantityBreaksOf = (tiers) => {
  if (!Array.isArray(tiers)) return []
  return tiers
    .map((t) => ({ minQty: Number(t?.minQty), price: Number(t?.price) }))
    .filter(
      (t) =>
        Number.isFinite(t.minQty) &&
        t.minQty > 0 &&
        Number.isFinite(t.price) &&
        t.price >= 0
    )
    .map((t) => ({ minQty: t.minQty, price: Math.round(t.price) }))
    .sort((a, b) => a.minQty - b.minQty)
}

module.exports = {
  quantityBreaksOf,
  resolveOutletBasePrice,
  resolveCatalogBase,
  getEffectivePriceMap,
  quantityTierPrice,
  normalizePriceTiers
}
