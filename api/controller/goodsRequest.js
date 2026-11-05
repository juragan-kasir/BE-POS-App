const db = require('../../db/models')
const { Op } = require('sequelize')
const { createAudit } = require('../../utils/auditLog')
const { enrichAuditFields } = require('../../utils/auditFields')
const { resolveStoreId, tenantStoreWhere } = require('../../utils/tenantScope')

const generateRequestNumber = () => {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const random = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, '0')
  return `PB-${year}${month}${day}-${random}`
}

const generateOrderNumber = (prefix) => {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const random = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, '0')
  return `${prefix}-${year}${month}${day}-${random}`
}

const goodsRequestController = {
  async getAll(req, res) {
    try {
      const {
        page = 1,
        limit = 10,
        status,
        startDate,
        endDate,
        search,
        supplier,
        queryStore
      } = req.query

      const where = {}
      const effectiveStore = req.storeId
      const userRole = req.user?.roleType

      if (queryStore && userRole === 'super_admin') where.store = queryStore
      else if (effectiveStore) where.store = effectiveStore

      if (status) {
        where.status = status
      }

      if (search) {
        where[Op.or] = [
          { requestNumber: { [Op.iLike]: `%${search}%` } },
          { requestedBy: { [Op.iLike]: `%${search}%` } },
          { '$storeData.name$': { [Op.iLike]: `%${search}%` } }
        ]
      }

      if (supplier) {
        const supplierId = parseInt(supplier, 10)
        if (!Number.isNaN(supplierId)) {
          where[Op.and] = db.sequelize.literal(
            `EXISTS (SELECT 1 FROM goods_request_item gri WHERE gri."goodsRequest" = "goodsRequest"."id" AND gri."supplier" = ${supplierId} AND gri."deletedAt" IS NULL)`
          )
        }
      }

      if (startDate || endDate) {
        where.createdAt = {}
        if (startDate) where.createdAt[Op.gte] = new Date(startDate)
        if (endDate) where.createdAt[Op.lte] = new Date(endDate)
      }

      const offset = (parseInt(page) - 1) * parseInt(limit)

      const [
        requests,
        total,
        pendingCount,
        approvedCount,
        rejectedCount,
        cancelledCount
      ] = await Promise.all([
        db.goodsRequest.findAll({
          where,
          include: [
            {
              model: db.goodsRequestItem,
              as: 'items',
              attributes: [
                'id',
                'supplier',
                'productName',
                'ingredientName',
                'qty',
                'unit'
              ],
              include: [
                {
                  model: db.supplier,
                  as: 'supplierData',
                  attributes: ['id', 'name']
                }
              ]
            },
            {
              model: db.location,
              as: 'storeData',
              attributes: ['id', 'name']
            },
            {
              model: db.purchase_order,
              as: 'purchaseOrderData',
              attributes: ['id', 'orderNumber', 'status']
            }
          ],
          order: [['updatedAt', 'DESC']],
          limit: parseInt(limit),
          offset
        }),
        db.goodsRequest.count({ where }),
        db.goodsRequest.count({ where: { ...where, status: 'pending' } }),
        db.goodsRequest.count({ where: { ...where, status: 'approved' } }),
        db.goodsRequest.count({ where: { ...where, status: 'rejected' } }),
        db.goodsRequest.count({ where: { ...where, status: 'cancelled' } })
      ])

      await enrichAuditFields(db, requests)

      const data = requests.map((request) => ({
        id: request.id,
        requestNumber: request.requestNumber,
        status: request.status,
        requestedBy: request.requestedBy,
        notes: request.notes,
        approvedAt: request.approvedAt,
        purchaseOrderId: request.purchaseOrderId,
        purchaseOrderData: request.purchaseOrderData
          ? {
              id: request.purchaseOrderData.id,
              orderNumber: request.purchaseOrderData.orderNumber,
              status: request.purchaseOrderData.status
            }
          : null,
        store: request.storeData
          ? { id: request.storeData.id, name: request.storeData.name }
          : null,
        items: request.items || [],
        totalItems: (request.items || []).length,
        totalQty: (request.items || []).reduce(
          (sum, item) => sum + (item.qty || 0),
          0
        ),
        createdByUser: request.createdByUser,
        modifiedByUser: request.modifiedByUser,
        approvedByUser: request.approvedByUser,
        createdAt: request.createdAt,
        updatedAt: request.updatedAt
      }))

      return res.status(200).json({
        success: true,
        message: 'Success',
        data,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit))
        },
        stats: {
          total,
          pending: pendingCount,
          approved: approvedCount,
          rejected: rejectedCount,
          cancelled: cancelledCount
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
      Object.assign(where, await tenantStoreWhere(req))

      const request = await db.goodsRequest.findOne({
        where,
        include: [
          { model: db.location, as: 'storeData', attributes: ['id', 'name'] },
          {
            model: db.purchase_order,
            as: 'purchaseOrderData',
            attributes: ['id', 'orderNumber', 'status']
          },
          {
            model: db.user,
            as: 'approvedByUser',
            attributes: ['id', 'userName', 'fullName']
          },
          {
            model: db.user,
            as: 'createdByUser',
            attributes: ['id', 'userName', 'fullName']
          },
          {
            model: db.goodsRequestItem,
            as: 'items',
            include: [
              {
                model: db.product,
                as: 'productData',
                attributes: ['id', 'nameProduct']
              },
              {
                model: db.ingredient,
                as: 'ingredientData',
                attributes: ['id', 'name']
              },
              {
                model: db.supplier,
                as: 'supplierData',
                attributes: ['id', 'name']
              }
            ]
          }
        ]
      })

      if (!request) {
        return res
          .status(404)
          .json({ success: false, message: 'Goods request not found' })
      }

      return res.status(200).json({
        success: true,
        message: 'Success',
        data: request
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
      const { items, requestedBy, notes, requestDate, neededDate } = req.body
      const createdBy = req.user?.id || null

      if (!items || items.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Items are required'
        })
      }

      const requestNumber = generateRequestNumber()

      const transaction = await db.sequelize.transaction()

      try {
        const request = await db.goodsRequest.create(
          {
            requestNumber,
            store: store || null,
            status: 'pending',
            requestedBy: requestedBy || '',
            requestDate: requestDate || null,
            neededDate: neededDate || null,
            notes: notes || '',
            createdBy
          },
          { transaction }
        )

        const requestItems = items.map((item) => ({
          goodsRequest: request.id,
          product: item.product || null,
          productName: item.productName || null,
          ingredient: item.ingredient || null,
          ingredientName: item.ingredientName || null,
          supplier: item.supplier || null,
          qty: item.qty,
          unit: item.unit || 'pcs',
          notes: item.notes || null
        }))

        await db.goodsRequestItem.bulkCreate(requestItems, { transaction })

        await transaction.commit()

        await createAudit(
          req,
          'create',
          'goods_request',
          request.id,
          'Created goods_request: ' + request.id
        )

        const createdRequest = await db.goodsRequest.findOne({
          where: { id: request.id },
          include: [{ model: db.goodsRequestItem, as: 'items' }]
        })

        return res.status(201).json({
          success: true,
          message: 'Success create goods request',
          data: createdRequest
        })
      } catch (error) {
        await transaction.rollback()
        throw error
      }
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
      const { items, requestedBy, notes, requestDate, neededDate } = req.body

      const where = { id }
      Object.assign(where, await tenantStoreWhere(req))

      const request = await db.goodsRequest.findOne({ where })

      if (!request) {
        return res
          .status(404)
          .json({ success: false, message: 'Goods request not found' })
      }

      if (!['pending', 'cancelled'].includes(request.status)) {
        return res.status(400).json({
          success: false,
          message: 'Only pending or cancelled goods request can be updated'
        })
      }

      if (!items || items.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Items are required'
        })
      }

      const transaction = await db.sequelize.transaction()

      try {
        await request.update(
          {
            requestedBy:
              requestedBy !== undefined ? requestedBy : request.requestedBy,
            requestDate:
              requestDate !== undefined ? requestDate : request.requestDate,
            neededDate:
              neededDate !== undefined ? neededDate : request.neededDate,
            notes: notes !== undefined ? notes : request.notes,
            status: request.status === 'cancelled' ? 'draft' : request.status
          },
          { transaction }
        )

        await db.goodsRequestItem.destroy(
          { where: { goodsRequest: request.id } },
          { transaction }
        )

        const requestItems = items.map((item) => ({
          goodsRequest: request.id,
          product: item.product || null,
          productName: item.productName || null,
          ingredient: item.ingredient || null,
          ingredientName: item.ingredientName || null,
          supplier: item.supplier || null,
          qty: item.qty,
          unit: item.unit || 'pcs',
          notes: item.notes || null
        }))

        await db.goodsRequestItem.bulkCreate(requestItems, { transaction })

        await transaction.commit()

        await createAudit(
          req,
          'update',
          'goods_request',
          request.id,
          'Updated goods_request: ' + request.id
        )

        const updatedRequest = await db.goodsRequest.findOne({
          where: { id: request.id },
          include: [{ model: db.goodsRequestItem, as: 'items' }]
        })

        return res.status(200).json({
          success: true,
          message: 'Success update goods request',
          data: updatedRequest
        })
      } catch (error) {
        await transaction.rollback()
        throw error
      }
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
      Object.assign(where, await tenantStoreWhere(req))

      const request = await db.goodsRequest.findOne({ where })

      if (!request) {
        return res
          .status(404)
          .json({ success: false, message: 'Goods request not found' })
      }

      if (!['pending', 'cancelled'].includes(request.status)) {
        return res.status(400).json({
          success: false,
          message: 'Only pending or cancelled goods request can be deleted'
        })
      }

      await request.destroy()

      await createAudit(
        req,
        'delete',
        'goods_request',
        request.id,
        'Deleted goods_request: ' + request.id
      )

      return res.status(200).json({
        success: true,
        message: 'Success delete goods request',
        data: { id: request.id }
      })
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
      const approvedBy = req.user?.id || null

      const validStatuses = ['approved', 'rejected', 'cancelled']
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid status'
        })
      }

      const where = { id }
      Object.assign(where, await tenantStoreWhere(req))

      const request = await db.goodsRequest.findOne({
        where,
        include: [{ model: db.goodsRequestItem, as: 'items' }]
      })

      if (!request) {
        return res
          .status(404)
          .json({ success: false, message: 'Goods request not found' })
      }

      const isPending = request.status === 'pending'
      const isCancelFromApproved =
        request.status === 'approved' && status === 'cancelled'
      if (!isPending && !isCancelFromApproved) {
        return res.status(400).json({
          success: false,
          message: `Goods request is already ${request.status}`
        })
      }

      const transaction = await db.sequelize.transaction()

      try {
        if (status === 'approved') {
          const items = request.items || []

          const supplierIds = [
            ...new Set(items.map((it) => it.supplier).filter(Boolean))
          ]

          let priceByProduct = {}
          let priceByName = {}
          try {
            if (supplierIds.length > 0) {
              const catalog = await db.supplier_product.findAll({
                where: { supplier: { [Op.in]: supplierIds } },
                attributes: [
                  'supplier',
                  'productId',
                  'name',
                  'price',
                  'lastPrice'
                ]
              })
              priceByProduct = {}
              priceByName = {}
              for (const cp of catalog) {
                const price = Number(cp.price || cp.lastPrice || 0)
                if (cp.productId) {
                  const key = `${cp.supplier}:${cp.productId}`
                  if (!(key in priceByProduct)) priceByProduct[key] = price
                }
                const nameKey = String(cp.name || '')
                  .toLowerCase()
                  .trim()
                if (nameKey) {
                  const key = `${cp.supplier}:${nameKey}`
                  if (!(key in priceByName)) priceByName[key] = price
                }
              }
            }
          } catch {
            priceByProduct = {}
            priceByName = {}
          }

          const resolvePrice = (item) => {
            if (!item.supplier) return 0
            if (item.product) {
              const byProduct =
                priceByProduct[`${item.supplier}:${item.product}`]
              if (byProduct) return byProduct
            }
            const itemName = String(
              item.ingredientName || item.productName || ''
            )
              .toLowerCase()
              .trim()
            if (itemName) {
              const byName = priceByName[`${item.supplier}:${itemName}`]
              if (byName) return byName
            }
            return 0
          }

          const orderNumber = generateOrderNumber('PO')
          const orderItems = items.map((item) => {
            const price = resolvePrice(item)
            const quantity = Number(item.qty || 0)
            return {
              product: item.product || null,
              ingredient: item.ingredient || null,
              ingredientName: item.ingredientName || item.productName || null,
              supplier: item.supplier || null,
              quantity,
              unit: item.unit || 'pcs',
              price,
              total: quantity * price,
              receivedQuantity: 0,
              conversionToBase: 1
            }
          })
          const totalAmount = orderItems.reduce(
            (sum, it) => sum + (it.total || 0),
            0
          )
          const finalAmount = totalAmount

          const purchaseOrder = await db.purchase_order.create(
            {
              store: request.store || store || null,
              orderNumber,
              totalAmount,
              discount: 0,
              finalAmount,
              status: 'draft',
              orderDate: new Date(),
              notes: `Dari Permintaan Barang: ${request.requestNumber}`,
              createdBy: approvedBy,
              pic: null,
              dueDate: null,
              paymentMethod: 'cash',
              tenor: 0,
              dpPercent: 0,
              additionalCost: 0,
              overDeliveryTolerance: 10
            },
            { transaction }
          )

          await db.purchase_order_item.bulkCreate(
            orderItems.map((item) => ({
              ...item,
              purchaseOrder: purchaseOrder.id
            })),
            { transaction }
          )

          await request.update(
            {
              status: 'approved',
              approvedBy,
              approvedAt: new Date(),
              purchaseOrderId: purchaseOrder.id
            },
            { transaction }
          )

          await createAudit(
            req,
            'approve',
            'goods_request',
            request.id,
            'Approved goods_request: ' +
              request.id +
              ' -> PO ' +
              purchaseOrder.id
          )

          await transaction.commit()

          return res.status(200).json({
            success: true,
            message: 'Goods request approved, draft purchase order created',
            data: {
              id: request.id,
              status: 'approved',
              purchaseOrderId: purchaseOrder.id,
              orderNumber: purchaseOrder.orderNumber
            }
          })
        }

        if (status === 'cancelled' && request.status === 'approved') {
          if (request.purchaseOrderId) {
            const safePoId = String(request.purchaseOrderId).trim()
            const po = await db.purchase_order.findOne({ // codacy-ignore-line
              where: { id: safePoId },
              transaction
            })
            if (po && po.status !== 'draft' && po.status !== 'cancelled') {
              await transaction.rollback()
              return res.status(400).json({
                success: false,
                message:
                  'Cannot cancel goods request because its purchase order is no longer a draft'
              })
            }
            if (po) {
              await db.purchase_order_item.destroy({
                where: { purchaseOrder: po.id },
                transaction
              })
              await po.destroy({ transaction })
            }
          }

          await request.update(
            {
              status,
              approvedBy,
              approvedAt: new Date(),
              purchaseOrderId: null
            },
            { transaction }
          )

          await createAudit(
            req,
            status,
            'goods_request',
            request.id,
            `cancelled goods_request: ${request.id}, linked purchase order removed`
          )

          await transaction.commit()

          return res.status(200).json({
            success: true,
            message: 'Goods request cancelled, linked purchase order removed',
            data: { id: request.id, status, purchaseOrderId: null }
          })
        }

        await request.update(
          {
            status,
            approvedBy,
            approvedAt: new Date()
          },
          { transaction }
        )

        await createAudit(
          req,
          status,
          'goods_request',
          request.id,
          `${status} goods_request: ${request.id}`
        )

        await transaction.commit()

        return res.status(200).json({
          success: true,
          message: `Goods request ${status}`,
          data: { id: request.id, status }
        })
      } catch (error) {
        await transaction.rollback()
        throw error
      }
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  }
}

module.exports = goodsRequestController
