const db = require('../../db/models')
const { Op } = require('sequelize')
const { recordAudit, ACTOR_TYPES } = require('../../utils/auditLog')

// Client note 2026-10-24 (Waroeng Bakso): a menu with an active recipe is
// expected to use up its ingredients when sold, yet a product keeps the
// default 'stocked' mode unless someone changes it, so every sale deducted
// the finished-good stock and History Stock never showed the ingredients.
// A 'stocked' product with an active BOM therefore moves to
// 'make_to_order', unless
//   - it has a production order that was not cancelled (a produced item
//     really is sold from its own stock), or
//   - a store that sells it has no active BOM with lines yet: the mode is
//     global, and make_to_order without a BOM refuses the sale
//     (stockMutationService).
// A product with no product_store rows is sold by every active store.
// 'hybrid' and 'make_to_order' are explicit choices and stay as they are.
const recipeModeDecision = async (productId, transaction) => {
  const product = await db.product.findByPk(productId, {
    transaction,
    ...(transaction ? { lock: transaction.LOCK.UPDATE } : {})
  })
  if (!product) return { adopt: false, reason: 'missing', product }
  if ((product.inventoryMode || 'stocked') !== 'stocked') return { adopt: false, reason: 'explicit_mode', product }

  const produced = await db.productionOrder.count({
    where: { productItemId: productId, status: { [Op.ne]: 'cancelled' } },
    transaction
  })
  if (produced > 0) return { adopt: false, reason: 'production_order', product }

  const assigned = await db.product_store.findAll({ where: { product: productId }, attributes: ['store'], transaction })
  const sellingStores = assigned.length
    ? assigned.map((r) => Number(r.store))
    : (await db.location.findAll({ where: { status: 'active' }, attributes: ['id'], transaction })).map((l) => l.id)
  const activeBoms = await db.bom_header.findAll({
    where: { productId, status: 'active' },
    attributes: ['id', 'store'],
    include: [{ model: db.bom_line, as: 'lines', attributes: ['id'], required: true }],
    transaction
  })
  const storesWithRecipe = new Set(activeBoms.map((b) => Number(b.store)))
  const missing = sellingStores.filter((s) => !storesWithRecipe.has(s))
  if (sellingStores.length === 0 || missing.length > 0) {
    return { adopt: false, reason: 'store_without_bom', product, missingStores: missing }
  }
  return { adopt: true, reason: 'adopted', product, stores: sellingStores }
}

// Switches the product when the decision allows it. Returns true when the
// mode was switched.
const adoptRecipeMode = async (productId, transaction) => {
  const decision = await recipeModeDecision(productId, transaction)
  if (!decision.adopt) return false
  await decision.product.update({ inventoryMode: 'make_to_order' }, { transaction })
  return true
}

// One-off catch-up for products whose BOM went active before saving a BOM
// switched the mode (BE #265, 2026-10-24): those stay 'stocked' until their
// BOM is saved again. Dry run unless `apply` is set; `productIds` limits it
// to those products. Each product is decided and switched in its own
// transaction, with a SYSTEM audit row.
const backfillRecipeMode = async ({ apply = false, productIds: only } = {}) => {
  const boms = await db.bom_header.findAll({
    where: { status: 'active', ...(only?.length ? { productId: only } : {}) },
    attributes: ['productId'],
    include: [
      { model: db.bom_line, as: 'lines', attributes: ['id'], required: true },
      {
        model: db.product,
        as: 'productData',
        attributes: ['id'],
        required: true,
        where: { [Op.or]: [{ inventoryMode: 'stocked' }, { inventoryMode: null }] }
      }
    ]
  })
  const productIds = [...new Set(boms.map((b) => Number(b.productId)))].sort((a, b) => a - b)

  const switched = []
  const skipped = []
  for (const productId of productIds) {
    await db.sequelize.transaction(async (t) => {
      const decision = await recipeModeDecision(productId, t)
      const row = { id: productId, name: decision.product?.nameProduct ?? null }
      if (!decision.adopt) {
        skipped.push({ ...row, reason: decision.reason, missingStores: decision.missingStores })
        return
      }
      switched.push({ ...row, stores: decision.stores })
      if (!apply) return
      await decision.product.update({ inventoryMode: 'make_to_order' }, { transaction: t })
      await recordAudit({
        actor: { type: ACTOR_TYPES.SYSTEM, id: null, name: 'backfill-recipe-mode' },
        action: 'update',
        entity: 'product',
        entityId: productId,
        storeId: decision.stores.length === 1 ? decision.stores[0] : null,
        description: `Product ${productId} now deducts its recipe ingredients (active BOM, backfill)`,
        previousState: { inventoryMode: 'stocked' },
        newState: { inventoryMode: 'make_to_order' },
        source: 'script',
        transaction: t
      })
    })
  }
  return { applied: apply, switched, skipped }
}

module.exports = { recipeModeDecision, adoptRecipeMode, backfillRecipeMode }
