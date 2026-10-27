const db = require('../../db/models')
const { Op } = require('sequelize')
const { enrichAuditFields } = require('../../utils/auditFields')
const { recipeCosting, recipeYield, refreshProductCosting } = require('../service/itemCostService')
const { createAudit } = require('../../utils/auditLog')
const { adoptRecipeMode } = require('../service/recipeModeService')
const { INVENTORY_ITEM_MODE } = require('../service/inventoryLinkService')

// Thrown inside the authoring transaction to refuse a BOM with a 400 —
// nothing is written.
class BomAuthoringError extends Error {
  constructor(message, statusCode = 400) {
    super(message)
    this.statusCode = statusCode
  }
}

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

// Recipe yield (bom_header.totalQty): whole portions, at least 1.
const parseYield = (value) => {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) {
    throw new BomAuthoringError('Recipe yield must be a whole number of portions (at least 1)')
  }
  return n
}

// Live HPP of each BOM (bom_header rows with `lines`), read at the
// ingredients' current cost — never the snapshot stored on the product,
// which is global while recipes are per outlet. Returns bomId → costing.
const costingForBoms = async (boms) => {
  const result = new Map()
  if (!boms.length) return result
  const productIds = [...new Set(boms.map((b) => b.productId))]
  const ingredientIds = [...new Set(boms.flatMap((b) => (b.lines || []).map((l) => l.ingredientId)))]
  const [products, ingredients] = await Promise.all([
    db.product.findAll({ where: { id: productIds }, attributes: ['id', 'price', 'costPrice'] }),
    ingredientIds.length
      ? db.ingredient.findAll({
          where: { id: ingredientIds },
          attributes: ['id', 'name', 'costPrice', 'conversionFactor']
        })
      : []
  ])
  const productById = new Map(products.map((p) => [p.id, p]))
  const ingredientById = new Map(ingredients.map((i) => [i.id, i]))
  for (const bom of boms) {
    const product = productById.get(bom.productId)
    result.set(
      bom.id,
      recipeCosting({
        lines: bom.lines || [],
        ingredientById,
        yieldQty: recipeYield(bom),
        estimate: product?.costPrice,
        price: product?.price
      })
    )
  }
  return result
}

const withCosting = (bom, costing) => ({ ...bom.toJSON(), costing: costing.get(bom.id) || null })

// A finished good linked to an inventory item (BRD BR-02) keeps its link
// as a one-line outlet BOM, owned by the product form — it is not a recipe
// to edit or delete here.
const assertNotInventoryLink = async (productId, transaction) => {
  const product = await db.product.findByPk(productId, { attributes: ['inventoryMode'], transaction })
  if (product?.inventoryMode === INVENTORY_ITEM_MODE) {
    throw new BomAuthoringError(
      'Produk ini tertaut ke item persediaan. Ubah tautannya dari halaman produk.',
      409
    )
  }
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
            attributes: ['id', 'nameProduct', 'sku'],
            where: { inventoryMode: { [Op.ne]: INVENTORY_ITEM_MODE } }
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
        distinct: true,
        order: [['updatedAt', 'DESC']],
        limit: parseInt(limit),
        offset
      })
      await enrichAuditFields(db, rows)
      const costing = await costingForBoms(rows)

      return res.status(200).json({
        success: true,
        message: 'Success',
        data: rows.map((bom) => withCosting(bom, costing)),
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
      const costing = await costingForBoms([bom])
      return res
        .status(200)
        .json({ success: true, message: 'Success', data: withCosting(bom, costing) })
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

  // HPP of a product per outlet recipe (BRD Harga Modal/HPP): status
  // auto/provisional/unavailable, HPP per portion, food cost and margin,
  // read live so an ingredient price change shows at once. A store-bound
  // caller sees its own outlet only. Products without a recipe get an
  // empty list — their cost is product.costPrice.
  async costing(req, res) {
    try {
      const productId = Number(req.params.productId)
      if (!Number.isInteger(productId) || productId <= 0) {
        return res.status(400).json({ success: false, message: 'productId must be a positive integer' })
      }
      const product = await db.product.findByPk(productId, {
        attributes: ['id', 'nameProduct', 'price', 'costPrice', 'inventoryMode']
      })
      if (!product) {
        return res.status(404).json({ success: false, message: 'Product not found' })
      }
      const store = req.storeId
      const boms = await db.bom_header.findAll({
        where: { productId, ...(store ? { store } : {}) },
        include: [
          { model: db.bom_line, as: 'lines' },
          { model: db.location, as: 'storeData', attributes: ['id', 'name'], required: false }
        ],
        order: [['store', 'ASC']]
      })
      const costing = await costingForBoms(boms)
      return res.status(200).json({
        success: true,
        message: 'Success',
        data: {
          productId: product.id,
          price: Number(product.price) || 0,
          estimate: Number(product.costPrice) || 0,
          inventoryMode: product.inventoryMode || 'stocked',
          recipes: boms.map((bom) => ({
            bomId: bom.id,
            store: bom.store,
            storeName: bom.storeData?.name ?? null,
            status: bom.status,
            ...costing.get(bom.id)
          }))
        }
      })
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
        await assertNotInventoryLink(productId, t)
        const existing = await db.bom_header.findOne({ where: { productId, store }, transaction: t })
        if (existing) throw new BomAuthoringError('BOM already exists for this product')

        const yieldQty = parseYield(req.body.totalQty) ?? 1
        const { bomLines, ingredients } = await validateBomLines(lines, store, t)
        const bom = await db.bom_header.create(
          {
            store,
            productId,
            name: name || `BOM-${Date.now()}`,
            totalQty: yieldQty,
            notes,
            status: req.body.status || 'active'
          },
          { transaction: t }
        )
        await db.bom_line.bulkCreate(
          bomLines.map((l) => ({ ...l, bomHeaderId: bom.id })),
          { transaction: t }
        )
        await refreshProductCosting(productId, bomLines, ingredients, t, yieldQty)
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
        return res.status(error.statusCode).json({ success: false, message: error.message })
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
        await assertNotInventoryLink(bom.productId, t)

        // Lines are validated against the BOM's OWN store before anything is
        // written; a refused update leaves header and lines untouched.
        const validated = lines !== undefined ? await validateBomLines(lines, bom.store, t) : null

        // Only what the request carries changes; an empty name keeps the old.
        const updateData = {}
        const yieldQty = parseYield(req.body.totalQty)
        if (yieldQty !== undefined) updateData.totalQty = yieldQty
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
          await refreshProductCosting(bom.productId, currentLines, ings, t, recipeYield(bom))
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
        return res.status(error.statusCode).json({ success: false, message: error.message })
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
      await assertNotInventoryLink(bom.productId)

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
      if (error instanceof BomAuthoringError) {
        return res.status(error.statusCode).json({ success: false, message: error.message })
      }
      console.error('Error =>', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  }
}

module.exports = bomController
