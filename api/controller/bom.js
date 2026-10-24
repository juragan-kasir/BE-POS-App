const db = require('../../db/models')
const { Op } = require('sequelize')
const { enrichAuditFields } = require('../../utils/auditFields')
const { ingredientBaseUnitCost } = require('../service/itemCostService')
const { createAudit } = require('../../utils/auditLog')
const { adoptRecipeMode } = require('../service/recipeModeService')

// Thrown inside the authoring transaction to refuse a BOM with a 400 —
// nothing is written.
class BomAuthoringError extends Error {}

// Authoring validation shared by create and update, run before any write so
// a refused request leaves the previous, still-valid BOM untouched. Mirrors
// the deduction-time checks (stockMutationService.resolveBomIngredientRequirements)
// so a recipe that would refuse every sale is caught here instead:
//   - at least one line, each qty a positive whole number (bom_line.qty is
//     INTEGER; a fraction would silently truncate),
//   - every ingredient exists and belongs to the BOM's own store,
//   - BASE-UNIT-ONLY: bom_line.unit === ingredient.baseUnit.
const validateBomLines = async (lines, store, transaction) => {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new BomAuthoringError('At least one ingredient is required')
  }
  const bomLines = lines.map((l) => ({
    ingredientId: Number(l.ingredientId),
    qty: Number(l.qty),
    unit: l.unit || 'pcs',
    notes: l.notes
  }))
  for (const line of bomLines) {
    if (!Number.isInteger(line.qty) || line.qty <= 0) {
      throw new BomAuthoringError('Ingredient quantity must be a positive whole number')
    }
  }
  const ingredientIds = [...new Set(bomLines.map((l) => l.ingredientId))]
  const ingredients = await db.ingredient.findAll({ where: { id: ingredientIds }, transaction })
  const ingredientById = new Map(ingredients.map((i) => [i.id, i]))
  for (const line of bomLines) {
    const ing = ingredientById.get(line.ingredientId)
    if (!ing) {
      throw new BomAuthoringError(`Ingredient ${line.ingredientId} not found`)
    }
    if (ing.store == null || Number(ing.store) !== Number(store)) {
      throw new BomAuthoringError(`Ingredient "${ing.name}" does not belong to this store`)
    }
    if (line.unit !== ing.baseUnit) {
      throw new BomAuthoringError(
        `Unit mismatch for ingredient "${ing.name}": BOM line uses "${line.unit}", ingredient base unit is "${ing.baseUnit}"`
      )
    }
  }
  return { bomLines, ingredients }
}

// Cost of ONE base unit of an ingredient (itemCostService). costPrice is the
// purchase price per purchase unit (`unit`, e.g. Rp25.000 per kg) while BOM
// lines are always in the base unit (enforced above). BA finding #4: using
// costPrice directly priced 5 butir as 5 kg (Rp143.000 instead of Rp6.800).
const baseUnitCost = ingredientBaseUnitCost

// HPP / food-cost / composition snapshot onto the product, from the BOM's
// current lines and the ingredients' current cost per base unit.
const refreshProductCosting = async (productId, bomLines, ingredients, transaction) => {
  const prod = await db.product.findByPk(productId, { transaction })
  if (!prod || bomLines.length === 0) return
  const costMap = Object.fromEntries(ingredients.map((i) => [i.id, baseUnitCost(i)]))
  const hpp = Math.round(
    bomLines.reduce((sum, l) => sum + (costMap[l.ingredientId] || 0) * Number(l.qty), 0)
  )
  const price = Number(prod.price || 0)
  const foodCostPersen =
    hpp > 0 && price > 0 ? Math.min(999.99, parseFloat(((hpp / price) * 100).toFixed(2))) : 0
  const marginPersen =
    hpp > 0 && price > 0 ? Math.max(0, parseFloat(((1 - hpp / price) * 100).toFixed(2))) : 0
  const composition = bomLines.map((l) => {
    const ing = ingredients.find((i) => i.id === l.ingredientId)
    return {
      ingredientId: l.ingredientId,
      name: ing?.name || 'Unknown',
      qty: l.qty,
      // The BOM quantity is in the base unit (5 butir, not 5 kg).
      unit: l.unit || ing?.baseUnit || 'pcs'
    }
  })
  await prod.update({ hppPerPorsi: hpp, foodCostPersen, marginPersen, composition }, { transaction })
}

// Saving an active BOM moves a 'stocked' product to make_to_order; the
// rules are in recipeModeService.
const auditRecipeMode = (req, productId) =>
  createAudit(
    req,
    'update',
    'product',
    productId,
    `Product ${productId} now deducts its recipe ingredients (active BOM)`,
    { inventoryMode: 'stocked' },
    { inventoryMode: 'make_to_order' }
  )

const bomController = {
  async getAll(req, res) {
    try {
      const { page = 1, limit = 20, search, status } = req.query
      const store = req.storeId
      const offset = (parseInt(page) - 1) * parseInt(limit)

      const where = { ...(store ? { store } : {}) }
      if (status && status !== 'all') where.status = status
      if (search)
        where['$productData.nameProduct$'] = { [Op.iLike]: `%${search}%` }

      const { count, rows } = await db.bom_header.findAndCountAll({
        where,
        include: [
          {
            model: db.product,
            as: 'productData',
            attributes: ['id', 'nameProduct', 'sku']
          },
          {
            model: db.bom_line,
            as: 'lines',
            include: [
              {
                model: db.ingredient,
                as: 'ingredientData',
                attributes: ['id', 'name', 'unit']
              }
            ]
          }
        ],
        order: [['updatedAt', 'DESC']],
        limit: parseInt(limit),
        offset
      })
      await enrichAuditFields(db, rows)

      return res.status(200).json({
        success: true,
        message: 'Success',
        data: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / parseInt(limit))
        }
      })
    } catch (error) {
      console.error('Error =>', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async getById(req, res) {
    try {
      const { id } = req.params
      const store = req.storeId
      const where = { id }
      if (store) where.store = store
      const bom = await db.bom_header.findOne({
        where,
        include: [
          {
            model: db.product,
            as: 'productData',
            attributes: ['id', 'nameProduct', 'sku', 'composition']
          },
          {
            model: db.bom_line,
            as: 'lines',
            include: [
              {
                model: db.ingredient,
                as: 'ingredientData',
                attributes: ['id', 'name', 'unit']
              }
            ]
          }
        ]
      })

      if (!bom)
        return res
          .status(404)
          .json({ success: false, message: 'BOM not found' })
      return res
        .status(200)
        .json({ success: true, message: 'Success', data: bom })
    } catch (error) {
      console.error('Error =>', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  // F21 Batch 3 (P2): lets a product-editing page ask "does this product
  // already have a BOM" without duplicating bom_header's own existence
  // check (already used internally by create's duplicate-BOM guard) or
  // pulling the full get-all list. Read-only, no new business logic.
  async getByProduct(req, res) {
    try {
      const { productId } = req.params
      const store = req.storeId
      const where = { productId }
      if (store) where.store = store
      const bom = await db.bom_header.findOne({
        where,
        include: [
          {
            model: db.bom_line,
            as: 'lines',
            attributes: ['id']
          }
        ]
      })

      if (!bom)
        return res
          .status(404)
          .json({ success: false, message: 'BOM not found for this product' })
      return res
        .status(200)
        .json({ success: true, message: 'Success', data: bom })
    } catch (error) {
      console.error('Error =>', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async create(req, res) {
    try {
      // MEDIUM fix: removed req.cookies.store — cookie is client-controlled.
      // Use server-pinned req.storeId (validateStoreAccess JWT store) with
      // req.user?.store as a fallback for routes missing middleware.
      const store = req.storeId ?? req.user?.store
      const { productId, name, notes, lines } = req.body
      if (!productId || !lines?.length) {
        return res
          .status(400)
          .json({ success: false, message: 'productId and lines are required' })
      }
      // A storeless BOM is never found at sale time (deduction looks it up
      // by the order's store), so a global caller must name the store.
      if (store == null) {
        return res
          .status(400)
          .json({ success: false, message: 'store is required to create a BOM' })
      }

      const created = await db.sequelize.transaction(async (t) => {
        const existing = await db.bom_header.findOne({ where: { productId, store }, transaction: t })
        if (existing) throw new BomAuthoringError('BOM already exists for this product')

        const { bomLines, ingredients } = await validateBomLines(lines, store, t)
        const bom = await db.bom_header.create(
          {
            store,
            productId,
            name: name || `BOM-${Date.now()}`,
            notes,
            status: req.body.status || 'active'
          },
          { transaction: t }
        )
        await db.bom_line.bulkCreate(
          bomLines.map((l) => ({ ...l, bomHeaderId: bom.id })),
          { transaction: t }
        )
        await refreshProductCosting(productId, bomLines, ingredients, t)
        const recipeModeAdopted = bom.status === 'active' && (await adoptRecipeMode(productId, t))
        return { bom, recipeModeAdopted }
      })

      const result = await db.bom_header.findByPk(created.bom.id, {
        include: [
          { model: db.product, as: 'productData' },
          { model: db.bom_line, as: 'lines' }
        ]
      })

      createAudit(req, 'create', 'bom', created.bom.id, `Created BOM ${created.bom.id} for product ${productId}`)
      if (created.recipeModeAdopted) auditRecipeMode(req, productId)
      return res
        .status(201)
        .json({ success: true, message: 'BOM created', data: result, recipeModeAdopted: created.recipeModeAdopted })
    } catch (error) {
      if (error instanceof BomAuthoringError) {
        return res.status(400).json({ success: false, message: error.message })
      }
      console.error('Error =>', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async update(req, res) {
    try {
      const { id } = req.params
      const { name, notes, lines, status } = req.body
      const store = req.storeId

      const where = { id }
      if (store) where.store = store

      const outcome = await db.sequelize.transaction(async (t) => {
        const bom = await db.bom_header.findOne({ where, transaction: t, lock: t.LOCK.UPDATE })
        if (!bom) return null

        // Lines are validated against the BOM's OWN store before anything is
        // written; a refused update leaves header and lines untouched.
        const validated = lines !== undefined ? await validateBomLines(lines, bom.store, t) : null

        // Only what the request carries changes; an empty name keeps the old.
        const updateData = {}
        if (typeof name === 'string' && name.trim() !== '') updateData.name = name
        if (notes !== undefined) updateData.notes = notes
        if (status) updateData.status = status
        if (Object.keys(updateData).length) await bom.update(updateData, { transaction: t })

        if (validated) {
          await db.bom_line.destroy({ where: { bomHeaderId: bom.id }, transaction: t })
          await db.bom_line.bulkCreate(
            validated.bomLines.map((l) => ({ ...l, bomHeaderId: bom.id })),
            { transaction: t }
          )
        }

        // ——— Recalculate HPP from the current lines and ingredient cost ———
        const currentLines = await db.bom_line.findAll({ where: { bomHeaderId: bom.id }, transaction: t })
        if (currentLines.length > 0) {
          const ingIds = [...new Set(currentLines.map((l) => l.ingredientId))]
          const ings = await db.ingredient.findAll({ where: { id: ingIds }, transaction: t })
          await refreshProductCosting(bom.productId, currentLines, ings, t)
        }
        const recipeModeAdopted =
          bom.status === 'active' && currentLines.length > 0 && (await adoptRecipeMode(bom.productId, t))
        return { bom, recipeModeAdopted }
      })

      if (!outcome) {
        return res
          .status(404)
          .json({ success: false, message: 'BOM not found' })
      }

      const result = await db.bom_header.findByPk(id, {
        include: [
          { model: db.product, as: 'productData' },
          { model: db.bom_line, as: 'lines' }
        ]
      })

      createAudit(req, 'update', 'bom', id, `Updated BOM: ${id}`)
      if (outcome.recipeModeAdopted) auditRecipeMode(req, outcome.bom.productId)
      return res
        .status(200)
        .json({ success: true, message: 'BOM updated', data: result, recipeModeAdopted: outcome.recipeModeAdopted })
    } catch (error) {
      if (error instanceof BomAuthoringError) {
        return res.status(400).json({ success: false, message: error.message })
      }
      console.error('Error =>', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async delete(req, res) {
    try {
      const { id } = req.params
      const store = req.storeId
      const where = { id }
      if (store) where.store = store
      const bom = await db.bom_header.findOne({ where })
      if (!bom)
        return res
          .status(404)
          .json({ success: false, message: 'BOM not found' })

      await db.bom_line.destroy({ where: { bomHeaderId: id } })
      await bom.destroy()

      // ——— Reset product composition ———
      const prod = await db.product.findByPk(bom.productId)
      if (prod) {
        await prod.update({
          hppPerPorsi: 0,
          foodCostPersen: 0,
          marginPersen: 0,
          composition: []
        })
      }

      createAudit(req, 'delete', 'bom', bom.id, `Deleted BOM ${bom.id} (product ${bom.productId})`)
      return res.status(200).json({ success: true, message: 'BOM deleted' })
    } catch (error) {
      console.error('Error =>', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  }
}

module.exports = bomController
