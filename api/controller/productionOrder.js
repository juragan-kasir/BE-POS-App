const db = require('../../db/models')
const { Op } = require('sequelize')
const { createAudit } = require('../../utils/auditLog')
const { enrichAuditFields } = require('../../utils/auditFields')
const { resolveStoreId } = require('../../utils/tenantScope')
const { recipeYield } = require('../service/itemCostService')

const generateProductionNo = () => {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const timestamp = Date.now()
  return `PRD-${year}${month}${day}-${timestamp}`
}

const productionOrderController = {
  async getAll(req, res) {
    try {
      const {
        page = 1,
        limit = 10,
        status,
        startDate,
        endDate,
        product,
        search
      } = req.query

      const where = {}
      const effectiveStore = req.storeId
      if (effectiveStore) where.store = effectiveStore
      if (status) where.status = status
      if (product) where.productItemId = product
      if (search) {
        where[Op.or] = [
          { productionNo: { [Op.iLike]: `%${search}%` } },
          { '$productData.nameProduct$': { [Op.iLike]: `%${search}%` } }
        ]
      }
      if (startDate || endDate) {
        where.scheduledDate = {}
        if (startDate) where.scheduledDate[Op.gte] = startDate
        if (endDate) where.scheduledDate[Op.lte] = endDate
      }

      const offset = (parseInt(page) - 1) * parseInt(limit)

      const { count, rows } = await db.productionOrder.findAndCountAll({
        where,
        include: [
          {
            model: db.product,
            as: 'productData',
            attributes: ['id', 'nameProduct', 'sku', 'stock', 'unit']
          },
          { model: db.location, as: 'storeData', attributes: ['id', 'name'] }
        ],
        order: [['updatedAt', 'DESC']],
        limit: parseInt(limit),
        offset
      })

      await enrichAuditFields(db, rows)

      const stats = await Promise.all([
        db.productionOrder.count({ where: { ...where, status: 'draft' } }),
        db.productionOrder.count({ where: { ...where, status: 'planned' } }),
        db.productionOrder.count({
          where: { ...where, status: 'in_progress' }
        }),
        db.productionOrder.count({ where: { ...where, status: 'completed' } }),
        db.productionOrder.count({ where: { ...where, status: 'cancelled' } })
      ])

      return res.status(200).json({
        success: true,
        message: 'Success',
        data: rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count,
          totalPages: Math.ceil(count / parseInt(limit))
        },
        stats: {
          total: count,
          draft: stats[0],
          planned: stats[1],
          inProgress: stats[2],
          completed: stats[3],
          cancelled: stats[4]
        }
      })
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async getById(req, res) {
    try {
      const { id } = req.params
      const store = resolveStoreId(req)
      const userRole = req.user?.roleType

      const where = { id }
      if (store && userRole !== 'super_admin') where.store = store

      const order = await db.productionOrder.findOne({
        where,
        include: [
          { model: db.product, as: 'productData' },
          { model: db.location, as: 'storeData', attributes: ['id', 'name'] }
        ]
      })

      if (!order) {
        return res
          .status(404)
          .json({ success: false, message: 'Production order not found' })
      }

      let bomComponents = []
      if (order.productData?.composition) {
        bomComponents = order.productData.composition
      }

      // Try BOM table first
      // PROD-ORDER-01: scoped to this order's own store + active status,
      // matching the same {productId, store, status:'active'} shape
      // checkout's BOM lookup in order.js uses — a product can have a
      // different BOM per store, so an unscoped lookup could resolve and
      // display a different store's (or an inactive) recipe here.
      const bomHeader = await db.bom_header.findOne({
        where: { productId: order.productItemId, store: order.store, status: 'active' },
        include: [
          {
            model: db.bom_line,
            as: 'lines',
            include: [
              {
                model: db.ingredient,
                as: 'ingredientData',
                attributes: ['id', 'name']
              }
            ]
          }
        ]
      })
      if (bomHeader?.lines?.length) {
        bomComponents = bomHeader.lines.map((l) => ({
          ingredientId: l.ingredientId,
          ingredientName: l.ingredientData?.name || '',
          qty: l.qty,
          unit: l.unit,
          notes: l.notes
        }))
      }

      return res.status(200).json({
        success: true,
        message: 'Success',
        data: {
          ...order.toJSON(),
          bomComponents
        }
      })
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async create(req, res) {
    try {
      const store = resolveStoreId(req)
      const { productItemId, plannedQty, scheduledDate, notes, status } =
        req.body

      if (!productItemId || !plannedQty || plannedQty < 1) {
        return res.status(400).json({
          success: false,
          message: 'Product and planned quantity are required'
        })
      }

      const product = await db.product.findByPk(productItemId)
      if (!product) {
        return res
          .status(404)
          .json({ success: false, message: 'Product not found' })
      }

      const productionNo = generateProductionNo()

      const order = await db.productionOrder.create({
        store: store || null,
        productionNo,
        productItemId,
        plannedQty,
        producedQty: 0,
        status: status || 'draft',
        scheduledDate: scheduledDate || null,
        notes,
        createdBy: req.user?.id || null
      })

      await createAudit(
        req,
        'create',
        'production_order',
        order.id,
        'Created production_order: ' + order.id
      )

      return res.status(201).json({
        success: true,
        message: 'Success create production order',
        data: order
      })
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async update(req, res) {
    try {
      const { id } = req.params
      const store = resolveStoreId(req)
      const userRole = req.user?.roleType
      const { productItemId, plannedQty, scheduledDate, notes, status } =
        req.body

      const where = { id }
      if (store && userRole !== 'super_admin') where.store = store

      const order = await db.productionOrder.findOne({ where })
      if (!order) {
        return res
          .status(404)
          .json({ success: false, message: 'Production order not found' })
      }

      if (!['draft', 'planned'].includes(order.status)) {
        return res.status(400).json({
          success: false,
          message: `Cannot update order with status "${order.status}"`
        })
      }

      await order.update({
        productItemId: productItemId || order.productItemId,
        plannedQty: plannedQty || order.plannedQty,
        scheduledDate:
          scheduledDate !== undefined ? scheduledDate : order.scheduledDate,
        notes: notes !== undefined ? notes : order.notes,
        status: status || order.status,
        modifiedBy: req.user?.id || null
      })

      await createAudit(
        req,
        'update',
        'production_order',
        id,
        'Updated production_order: ' + id
      )

      return res.status(200).json({
        success: true,
        message: 'Success update production order',
        data: order
      })
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async delete(req, res) {
    try {
      const { id } = req.params
      const store = resolveStoreId(req)
      const userRole = req.user?.roleType

      const where = { id }
      if (store && userRole !== 'super_admin') where.store = store

      const order = await db.productionOrder.findOne({ where })
      if (!order) {
        return res
          .status(404)
          .json({ success: false, message: 'Production order not found' })
      }

      if (!['draft', 'cancelled'].includes(order.status)) {
        return res.status(400).json({
          success: false,
          message: `Cannot delete order with status "${order.status}"`
        })
      }

      await order.destroy()
      await createAudit(
        req,
        'delete',
        'production_order',
        id,
        'Deleted production_order: ' + id
      )

      return res
        .status(200)
        .json({ success: true, message: 'Success delete production order' })
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async changeStatus(req, res) {
    try {
      const { id } = req.params
      const { status } = req.body
      const store = resolveStoreId(req)
      const userRole = req.user?.roleType

      const validStatuses = [
        'draft',
        'planned',
        'in_progress',
        'completed',
        'cancelled'
      ]
      if (!validStatuses.includes(status)) {
        return res
          .status(400)
          .json({ success: false, message: 'Invalid status' })
      }

      const where = { id }
      if (store && userRole !== 'super_admin') where.store = store

      const order = await db.productionOrder.findOne({
        where,
        include: [{ model: db.product, as: 'productData' }]
      })
      if (!order) {
        return res
          .status(404)
          .json({ success: false, message: 'Production order not found' })
      }

      const oldStatus = order.status

      // If cancelling an in-progress order, reverse ingredient deduction
      if (status === 'cancelled' && oldStatus === 'in_progress') {
        const transaction = await db.sequelize.transaction()
        try {
          // PROD-ORDER-01: added the missing store scope (status:'active'
          // was already present here) — without it this could resolve a
          // different store's active BOM and restore the WRONG ingredients/
          // quantities on cancellation.
          const bomHeader = await db.bom_header.findOne({
            where: { productId: order.productItemId, store: order.store, status: 'active' },
            include: [{ model: db.bom_line, as: 'lines' }],
            transaction
          })
          if (bomHeader?.lines?.length) {
            for (const line of bomHeader.lines) {
              const ing = await db.ingredient.findByPk(line.ingredientId, {
                transaction,
                lock: transaction.LOCK.UPDATE
              })
              if (!ing) continue
              // Same per-portion rule as the start: lines are per recipe yield.
              const restoreQty =
                Math.round(((line.qty * order.plannedQty) / recipeYield(bomHeader)) * 10000) / 10000
              const oldIngStock = Number(ing.stock)
              await ing.update(
                { stock: oldIngStock + restoreQty },
                { transaction }
              )
              await db.stock_history.create(
                {
                  product: order.productItemId,
                  ingredient: ing.id,
                  ingredientName: ing.name,
                  store: order.store,
                  referenceType: 'production_reversal',
                  quantityBefore: oldIngStock,
                  quantityChange: restoreQty,
                  quantityAfter: oldIngStock + restoreQty,
                  unit: line.unit || ing.unit || 'pcs',
                  notes: `Production cancelled: ${order.productionNo}`,
                  createdBy: req.user?.id || null
                },
                { transaction }
              )
            }
          }
          await order.update(
            {
              status,
              modifiedBy: req.user?.id || null,
              completedDate: null
            },
            { transaction }
          )
          await transaction.commit()
        } catch (err) {
          await transaction.rollback()
          throw err
        }
      } else {
        await order.update({
          status,
          modifiedBy: req.user?.id || null,
          completedDate:
            status === 'completed' ? new Date() : order.completedDate
        })
      }

      await createAudit(
        req,
        'update',
        'production_order',
        id,
        'Changed status to ' + status + ': ' + id
      )

      return res.status(200).json({
        success: true,
        message: `Status changed to "${status}"`,
        data: order
      })
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async startProduction(req, res) {
    try {
      const { id } = req.params
      const store = resolveStoreId(req)
      const userRole = req.user?.roleType

      const where = { id }
      if (store && userRole !== 'super_admin') where.store = store

      const order = await db.productionOrder.findOne({
        where,
        include: [{ model: db.product, as: 'productData' }]
      })

      if (!order) {
        return res
          .status(404)
          .json({ success: false, message: 'Production order not found' })
      }

      if (order.status !== 'planned') {
        return res.status(400).json({
          success: false,
          message: 'Only planned orders can be started'
        })
      }

      // Get BOM components from BOM table first, fallback to product.composition
      const prodData = order.productData
      let bomComponents = []
      // PROD-ORDER-01: this is the actual stock-deduction path — the most
      // severe of the three unscoped BOM lookups in this file. Without
      // store scoping, a product with an active BOM in another store could
      // have THAT store's BOM resolved here, and its ingredientId values
      // deducted directly via findByPk further below (no store re-check at
      // that point) — genuine cross-store ingredient stock corruption, not
      // just a display bug. Matches checkout's {productId, store,
      // status:'active'} shape in order.js.
      const bomHeader = await db.bom_header.findOne({
        where: { productId: prodData.id, store: order.store, status: 'active' },
        include: [{ model: db.bom_line, as: 'lines' }]
      })
      if (bomHeader?.lines?.length) {
        // BOM lines are written for the recipe yield; one produced unit uses
        // 1/yield of each line.
        const portions = recipeYield(bomHeader)
        bomComponents = bomHeader.lines.map((l) => ({
          ingredientId: l.ingredientId,
          qty: l.qty,
          unit: l.unit,
          portions
        }))
      } else if (prodData.composition?.length) {
        bomComponents = prodData.composition
      }

      if (!bomComponents.length) {
        return res.status(400).json({
          success: false,
          message: 'Product has no BOM composition defined'
        })
      }

      const transaction = await db.sequelize.transaction()

      try {
        const effectiveStore = order.store

        for (const comp of bomComponents) {
          const qtyNeeded =
            Math.round((((parseFloat(comp.qty) || 0) * order.plannedQty) / (comp.portions || 1)) * 10000) / 10000
          if (qtyNeeded <= 0) continue

          const ingredientId = comp.ingredientId
          const ingredientName = comp.name || comp.ingredientName

          // BOM lines reference the ingredient table by PK; JSONB composition may
          // reference ingredients or products by name. Resolve ingredient first.
          let ingredient = null
          let productComp = null

          if (ingredientId) {
            ingredient = await db.ingredient.findByPk(ingredientId, {
              transaction,
              lock: transaction.LOCK.UPDATE
            })
            if (!ingredient) {
              productComp = await db.product.findByPk(ingredientId, {
                transaction,
                lock: transaction.LOCK.UPDATE
              })
            }
          }

          if (!ingredient && !productComp && ingredientName) {
            ingredient = await db.ingredient.findOne({
              where: {
                name: { [Op.iLike]: ingredientName.trim() },
                store: effectiveStore
              },
              transaction
            })
            if (!ingredient) {
              productComp = await db.product.findOne({
                where: {
                  nameProduct: { [Op.iLike]: ingredientName.trim() },
                  store: effectiveStore
                },
                transaction
              })
            }
          }

          if (ingredient) {
            const qtyBefore = Number(ingredient.stock) || 0
            if (qtyBefore < qtyNeeded) {
              throw new Error(
                `Bahan baku tidak cukup: ${ingredient.name} — tersedia ${qtyBefore}, dibutuhkan ${qtyNeeded}`
              )
            }
            await ingredient.update(
              { stock: qtyBefore - qtyNeeded },
              { transaction }
            )
            await db.stock_history.create(
              {
                ingredient: ingredient.id,
                ingredientName: ingredient.name,
                store: effectiveStore,
                referenceType: 'production',
                quantityBefore: qtyBefore,
                quantityChange: -qtyNeeded,
                quantityAfter: qtyBefore - qtyNeeded,
                unit: ingredient.unit || comp.unit || 'pcs',
                notes: `Production: ${prodData.nameProduct} (${order.productionNo})`,
                createdBy: req.user?.id || null
              },
              { transaction }
            )
          }

          if (productComp) {
            const qtyBefore = Number(productComp.stock) || 0
            if (qtyBefore < qtyNeeded) {
              throw new Error(
                `Stok produk tidak cukup: ${productComp.nameProduct} — tersedia ${qtyBefore}, dibutuhkan ${qtyNeeded}`
              )
            }
            await productComp.update(
              { stock: qtyBefore - qtyNeeded },
              { transaction }
            )
            await db.stock_history.create(
              {
                product: productComp.id,
                store: effectiveStore,
                referenceType: 'production',
                quantityBefore: qtyBefore,
                quantityChange: -qtyNeeded,
                quantityAfter: qtyBefore - qtyNeeded,
                unit: productComp.unit || comp.unit || 'pcs',
                notes: `Production: ${prodData.nameProduct} (${order.productionNo})`,
                createdBy: req.user?.id || null
              },
              { transaction }
            )
          }
        }

        await order.update(
          {
            status: 'in_progress',
            modifiedBy: req.user?.id || null
          },
          { transaction }
        )

        await transaction.commit()

        await createAudit(
          req,
          'update',
          'production_order',
          id,
          'Started production: ' + id
        )

        return res.status(200).json({
          success: true,
          message: 'Production started, BOM components deducted',
          data: order
        })
      } catch (err) {
        await transaction.rollback()
        throw err
      }
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async completeProduction(req, res) {
    try {
      const { id } = req.params
      const { producedQty } = req.body
      const store = resolveStoreId(req)
      const userRole = req.user?.roleType

      const where = { id }
      if (store && userRole !== 'super_admin') where.store = store

      const order = await db.productionOrder.findOne({
        where,
        include: [{ model: db.product, as: 'productData' }]
      })

      if (!order) {
        return res
          .status(404)
          .json({ success: false, message: 'Production order not found' })
      }

      if (order.status !== 'in_progress') {
        return res.status(400).json({
          success: false,
          message: 'Only in-progress orders can be completed'
        })
      }

      const finalQty = producedQty || order.plannedQty
      const product = order.productData
      const effectiveStore = order.store

      const transaction = await db.sequelize.transaction()

      try {
        const qtyBefore = Number(product.stock) || 0
        const finalQtyInt = Math.floor(Number(finalQty)) || 0
        await product.update(
          { stock: db.sequelize.literal(`stock + ${finalQtyInt}`) },
          { transaction }
        )

        // ponytail: atomic upsert + add per-store stock
        if (effectiveStore) {
          await db.sequelize.query(
            `INSERT INTO product_store_stock (product, store, stock, "createdAt", "updatedAt")
             VALUES ($1, $2, 0, NOW(), NOW())
             ON CONFLICT (product, store) DO NOTHING`,
            { bind: [product.id, effectiveStore], transaction }
          )
          await db.product_store_stock.update(
            { stock: db.sequelize.literal(`stock + ${finalQtyInt}`) },
            {
              where: { product: product.id, store: effectiveStore },
              transaction
            }
          )
        }

        await db.stock_history.create(
          {
            product: product.id,
            store: effectiveStore,
            referenceType: 'production',
            quantityBefore: qtyBefore,
            quantityChange: finalQty,
            quantityAfter: qtyBefore + finalQty,
            unit: product.unit || 'pcs',
            notes: `Production complete: ${product.nameProduct} (${order.productionNo})`,
            createdBy: req.user?.id || null
          },
          { transaction }
        )

        await order.update(
          {
            status: 'completed',
            producedQty: finalQty,
            completedDate: new Date(),
            modifiedBy: req.user?.id || null
          },
          { transaction }
        )

        await transaction.commit()

        await createAudit(
          req,
          'update',
          'production_order',
          id,
          'Completed production: ' + id
        )

        return res.status(200).json({
          success: true,
          message: 'Production completed, finished goods added to stock',
          data: order
        })
      } catch (err) {
        await transaction.rollback()
        throw err
      }
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  }
}

module.exports = productionOrderController
