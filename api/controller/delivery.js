const db = require('../../db/models')
const { Op } = require('sequelize')
const { enrichAuditFields } = require('../../utils/auditFields')
const { emitToStore } = require('../service/socket')
const { scalarStoreScope, nullableArrayStoreScope } = require('../../utils/tenantScope')
const { authorizedStoreIds } = require('../../utils/storeValidation')

const generateDeliveryNumber = () => {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const random = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, '0')
  return `DLV-${year}${month}${day}-${random}`
}

const deliveryController = {
  // ─── Delivery Orders ─────────────────────────────────────────────

  async getDeliveryOrders(req, res) {
    try {
      const { search, status, source, page = 1, limit = 10 } = req.query
      const store = req.query.store

      const where = {}
      if (req.user?.roleType !== 'super_admin') {
        if (req.user?.store) {
          where.store = Number(req.user.store)
        }
      } else if (store && store !== '') {
        where.store = Number(store)
      }

      if (status && status !== 'all') {
        where.status = status
      }
      if (source && source !== 'all') {
        where.source = source
      }
      if (search) {
        where[Op.or] = [
          { orderNumber: { [Op.iLike]: `%${search}%` } },
          { customerName: { [Op.iLike]: `%${search}%` } },
          { driverName: { [Op.iLike]: `%${search}%` } }
        ]
      }

      const offset = (parseInt(page) - 1) * parseInt(limit)

      const [
        orders,
        total,
        pendingCount,
        assignedCount,
        inTransitCount,
        deliveredCount
      ] = await Promise.all([
        db.delivery_order.findAll({
          where,
          order: [['createdAt', 'DESC']],
          limit: parseInt(limit),
          offset,
          include: [
            {
              model: db.order,
              as: 'orderData',
              attributes: ['id', 'orderNumber', 'totalPrice', 'status']
            },
            {
              model: db.driver,
              as: 'driver',
              attributes: ['id', 'name', 'phone', 'vehicleType', 'vehiclePlate']
            }
          ]
        }),
        db.delivery_order.count({ where }),
        db.delivery_order.count({ where: { ...where, status: 'pending' } }),
        db.delivery_order.count({ where: { ...where, status: 'assigned' } }),
        db.delivery_order.count({ where: { ...where, status: 'in_transit' } }),
        db.delivery_order.count({ where: { ...where, status: 'delivered' } })
      ])

      await enrichAuditFields(db, orders)

      return res.status(200).json({
        success: true,
        message: 'Success get delivery orders',
        data: orders,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit))
        },
        stats: {
          total,
          pending: pendingCount,
          assigned: assignedCount,
          inTransit: inTransitCount,
          delivered: deliveredCount
        }
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async getDeliveryOrderById(req, res) {
    try {
      const { id } = req.params

      // Same IDOR fix as updateDeliveryStatus — was findByPk(id) with no
      // store filter, leaking another store's customer name/phone/address.
      const order = await db.delivery_order.findOne({
        where: scalarStoreScope(req, { id }),
        include: [
          {
            model: db.order,
            as: 'orderData',
            include: [{ model: db.order_item, as: 'items' }]
          },
          { model: db.driver, as: 'driver' },
          {
            model: db.delivery_status_history,
            as: 'statusHistory',
            order: [['createdAt', 'DESC']]
          },
          { model: db.location, as: 'storeData', attributes: ['id', 'name'] }
        ]
      })

      if (!order) {
        return res
          .status(404)
          .json({ success: false, message: 'Delivery order not found' })
      }

      await enrichAuditFields(db, [order])

      return res.status(200).json({
        success: true,
        message: 'Success get delivery order detail',
        data: order
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async createDeliveryOrder(req, res) {
    try {
      const {
        order: orderId,
        store,
        customerName,
        customerPhone,
        deliveryAddress,
        deliveryNotes,
        destinationLat,
        destinationLng,
        deliveryFee,
        totalDistance,
        source
      } = req.body

      const orderNumber = generateDeliveryNumber()

      const deliveryOrder = await db.delivery_order.create({
        orderNumber,
        order: orderId || null,
        store,
        customerName,
        customerPhone: customerPhone || null,
        deliveryAddress,
        deliveryNotes: deliveryNotes || null,
        destinationLat: destinationLat || null,
        destinationLng: destinationLng || null,
        status: 'pending',
        deliveryFee: deliveryFee || 0,
        totalDistance: totalDistance || null,
        source: source || 'pos',
        createdBy: req.user?.id
      })

      await db.delivery_status_history.create({
        deliveryOrder: deliveryOrder.id,
        status: 'pending',
        notes: 'Delivery order created',
        changedBy: req.user?.id,
        changedByName: req.user?.fullName || req.user?.userName
      })

      if (store) {
        emitToStore(store, 'new-delivery-order', deliveryOrder)
      }

      return res.status(201).json({
        success: true,
        message: 'Delivery order created successfully',
        data: deliveryOrder
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async updateDeliveryStatus(req, res) {
    try {
      const { id, status, note, changedBy, changedByName } = req.body

      // IDOR fix: was findByPk(id) with no store filter, so any store
      // could flip another store's delivery status. `store` here is a
      // plain INTEGER column (one delivery belongs to one store).
      const deliveryOrder = await db.delivery_order.findOne({
        where: scalarStoreScope(req, { id })
      })
      if (!deliveryOrder) {
        return res
          .status(404)
          .json({ success: false, message: 'Delivery order not found' })
      }

      const previousStatus = deliveryOrder.status

      const updateData = { status, modifiedBy: req.user?.id }
      if (status === 'delivered') {
        updateData.actualDeliveryTime = new Date()
      }
      if (status === 'cancelled') {
        updateData.cancellationReason = note
      }

      await deliveryOrder.update(updateData)

      await db.delivery_status_history.create({
        deliveryOrder: id,
        status,
        notes: note || `Status changed from ${previousStatus} to ${status}`,
        changedBy: changedBy || req.user?.id,
        changedByName: changedByName || req.user?.fullName || req.user?.userName
      })

      if (status === 'delivered' && deliveryOrder.driverId) {
        const activeDeliveries = await db.delivery_order.count({
          where: {
            driverId: deliveryOrder.driverId,
            status: { [Op.notIn]: ['delivered', 'cancelled'] }
          }
        })
        if (activeDeliveries === 0) {
          await db.driver.update(
            { status: 'active' },
            { where: { id: deliveryOrder.driverId } }
          )
        }
      }

      if (deliveryOrder.store) {
        emitToStore(deliveryOrder.store, 'delivery-status-updated', {
          id: deliveryOrder.id,
          orderNumber: deliveryOrder.orderNumber,
          status,
          previousStatus
        })
      }

      return res.status(200).json({
        success: true,
        message: 'Delivery status updated successfully',
        data: deliveryOrder
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async assignDriver(req, res) {
    try {
      const { orderId } = req.params
      const { driverId, driverName } = req.body

      // Same IDOR fix as updateDeliveryStatus.
      const deliveryOrder = await db.delivery_order.findOne({
        where: scalarStoreScope(req, { id: orderId })
      })
      if (!deliveryOrder) {
        return res
          .status(404)
          .json({ success: false, message: 'Delivery order not found' })
      }

      // IDOR fix: was findByPk(driverId) with no store filter. driver.store
      // is a JSONB array with the same null/[]-is-global convention as
      // supplier.store (verified via getDrivers' own list query below).
      const driver = await db.driver.findOne({
        where: nullableArrayStoreScope(req, { id: driverId })
      })
      if (!driver) {
        return res
          .status(404)
          .json({ success: false, message: 'Driver not found' })
      }

      const finalName = driverName || driver.name

      await deliveryOrder.update({
        driverId,
        driverName: finalName,
        status: 'assigned',
        modifiedBy: req.user?.id
      })

      await db.driver.update({ status: 'busy' }, { where: { id: driverId } })

      await db.delivery_status_history.create({
        deliveryOrder: orderId,
        status: 'assigned',
        notes: `Assigned to driver ${finalName}`,
        changedBy: req.user?.id,
        changedByName: req.user?.fullName || req.user?.userName
      })

      if (deliveryOrder.store) {
        emitToStore(deliveryOrder.store, 'delivery-assigned', {
          id: deliveryOrder.id,
          orderNumber: deliveryOrder.orderNumber,
          driverId,
          driverName: finalName
        })
      }

      return res.status(200).json({
        success: true,
        message: 'Driver assigned successfully',
        data: deliveryOrder
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async cancelDeliveryOrder(req, res) {
    try {
      const { id } = req.params
      const { reason } = req.body

      // Same IDOR fix as updateDeliveryStatus.
      const deliveryOrder = await db.delivery_order.findOne({
        where: scalarStoreScope(req, { id })
      })
      if (!deliveryOrder) {
        return res
          .status(404)
          .json({ success: false, message: 'Delivery order not found' })
      }

      if (deliveryOrder.status === 'delivered') {
        return res
          .status(400)
          .json({ success: false, message: 'Cannot cancel delivered order' })
      }

      await deliveryOrder.update({
        status: 'cancelled',
        cancellationReason: reason,
        modifiedBy: req.user?.id
      })

      if (deliveryOrder.driverId) {
        const activeDeliveries = await db.delivery_order.count({
          where: {
            driverId: deliveryOrder.driverId,
            status: { [Op.notIn]: ['delivered', 'cancelled'] }
          }
        })
        if (activeDeliveries === 0) {
          await db.driver.update(
            { status: 'active' },
            { where: { id: deliveryOrder.driverId } }
          )
        }
      }

      await db.delivery_status_history.create({
        deliveryOrder: id,
        status: 'cancelled',
        notes: reason || 'Order cancelled',
        changedBy: req.user?.id,
        changedByName: req.user?.fullName || req.user?.userName
      })

      if (deliveryOrder.store) {
        emitToStore(deliveryOrder.store, 'delivery-cancelled', {
          id: deliveryOrder.id,
          orderNumber: deliveryOrder.orderNumber,
          reason
        })
      }

      return res.status(200).json({
        success: true,
        message: 'Delivery order cancelled successfully',
        data: deliveryOrder
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  // ─── Drivers ─────────────────────────────────────────────────────

  async getDrivers(req, res) {
    try {
      const { search, status, page = 1, limit = 10 } = req.query
      const store = req.query.store

      const where = {}
      if (req.user?.roleType !== 'super_admin') {
        if (req.user?.store) {
          const storeId = Number(req.user.store)
          where[Op.or] = [
            { store: null },
            { store: { [Op.contains]: [storeId] } },
            db.sequelize.literal('"driver"."store" = \'[]\'::jsonb')
          ]
        }
      } else if (store && store !== '') {
        const storeId = Number(store)
        where[Op.or] = [
          { store: null },
          { store: { [Op.contains]: [storeId] } },
          db.sequelize.literal('"driver"."store" = \'[]\'::jsonb')
        ]
      }

      if (search) {
        const searchClause = [
          { name: { [Op.iLike]: `%${search}%` } },
          { phone: { [Op.iLike]: `%${search}%` } },
          { vehiclePlate: { [Op.iLike]: `%${search}%` } }
        ]
        if (where[Op.or]) {
          where[Op.and] = [{ [Op.or]: where[Op.or] }, { [Op.or]: searchClause }]
          delete where[Op.or]
        } else {
          where[Op.or] = searchClause
        }
      }
      if (status && status !== 'all') {
        where.status = status
      }

      const offset = (parseInt(page) - 1) * parseInt(limit)

      const [
        drivers,
        total,
        activeCount,
        busyCount,
        inactiveCount,
        offlineCount,
        draftCount
      ] = await Promise.all([
        db.driver.findAll({
          where,
          order: [['createdAt', 'DESC']],
          limit: parseInt(limit),
          offset
        }),
        db.driver.count({ where }),
        db.driver.count({ where: { ...where, status: 'active' } }),
        db.driver.count({ where: { ...where, status: 'busy' } }),
        db.driver.count({ where: { ...where, status: 'inactive' } }),
        db.driver.count({ where: { ...where, status: 'offline' } }),
        db.driver.count({ where: { ...where, status: 'draft' } })
      ])

      await enrichAuditFields(db, drivers)

      return res.status(200).json({
        success: true,
        message: 'Success get drivers',
        data: drivers,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit))
        },
        stats: {
          total,
          active: activeCount,
          busy: busyCount,
          inactive: inactiveCount,
          offline: offlineCount,
          draft: draftCount
        }
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async getDriverById(req, res) {
    try {
      const { id } = req.params

      // IDOR fix: was findByPk(id) with no store filter, reachable by any
      // authenticated role (no requireRole on this route).
      const driver = await db.driver.findOne({
        where: nullableArrayStoreScope(req, { id })
      })
      if (!driver) {
        return res
          .status(404)
          .json({ success: false, message: 'Driver not found' })
      }

      const activeDeliveries = await db.delivery_order.count({
        where: {
          driverId: id,
          status: { [Op.notIn]: ['delivered', 'cancelled'] }
        }
      })

      const completedDeliveries = await db.delivery_order.count({
        where: { driverId: id, status: 'delivered' }
      })

      await enrichAuditFields(db, [driver])

      return res.status(200).json({
        success: true,
        message: 'Success get driver detail',
        data: {
          ...driver.toJSON(),
          activeDeliveries,
          completedDeliveries
        }
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async createDriver(req, res) {
    try {
      const {
        name,
        store,
        phone,
        email,
        vehicleType,
        vehiclePlate,
        status,
        notes
      } = req.body

      let driverStore
      if (req.user?.roleType === 'super_admin') {
        driverStore = store || null
      } else {
        // C-4: single-store tenant — reject ambiguous/foreign/multi-store;
        // default to own store as a JSONB array (driver.store convention).
        const authz = authorizedStoreIds(req)
        if (!authz.ok) {
          return res.status(403).json({
            success: false,
            message: 'Anda hanya dapat mengakses data di toko Anda'
          })
        }
        driverStore = [authz.stores[0]]
      }

      const driver = await db.driver.create({
        name,
        store: driverStore,
        phone: phone || null,
        email: email || null,
        vehicleType: vehicleType || null,
        vehiclePlate: vehiclePlate || null,
        status: status || 'active',
        notes: notes || null,
        createdBy: req.user?.id
      })

      return res.status(201).json({
        success: true,
        message: 'Driver created successfully',
        data: driver
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async updateDriver(req, res) {
    try {
      const { id } = req.params
      const {
        name,
        store,
        phone,
        email,
        vehicleType,
        vehiclePlate,
        status,
        notes
      } = req.body

      // Same IDOR fix as getDriverById.
      const driver = await db.driver.findOne({
        where: nullableArrayStoreScope(req, { id })
      })
      if (!driver) {
        return res
          .status(404)
          .json({ success: false, message: 'Driver not found' })
      }

      // C-4: a store admin must not reassign an (owned) driver into a foreign /
      // global namespace. Super_admin may legitimately manage multi-store.
      let effectiveStore = driver.store
      if (store !== undefined) {
        if (req.user?.roleType === 'super_admin') {
          effectiveStore = store
        } else {
          const authz = authorizedStoreIds(req)
          if (!authz.ok) {
            return res.status(403).json({
              success: false,
              message: 'Anda hanya dapat mengakses data di toko Anda'
            })
          }
          effectiveStore = [authz.stores[0]]
        }
      }

      await driver.update({
        name: name !== undefined ? name : driver.name,
        store: store !== undefined ? effectiveStore : driver.store,
        phone: phone !== undefined ? phone : driver.phone,
        email: email !== undefined ? email : driver.email,
        vehicleType:
          vehicleType !== undefined ? vehicleType : driver.vehicleType,
        vehiclePlate:
          vehiclePlate !== undefined ? vehiclePlate : driver.vehiclePlate,
        status: status !== undefined ? status : driver.status,
        notes: notes !== undefined ? notes : driver.notes,
        modifiedBy: req.user?.id
      })

      return res.status(200).json({
        success: true,
        message: 'Driver updated successfully',
        data: driver
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async deleteDriver(req, res) {
    try {
      const { id } = req.params

      // Same IDOR fix as getDriverById.
      const driver = await db.driver.findOne({
        where: nullableArrayStoreScope(req, { id })
      })
      if (!driver) {
        return res
          .status(404)
          .json({ success: false, message: 'Driver not found' })
      }

      const activeDeliveries = await db.delivery_order.count({
        where: {
          driverId: id,
          status: { [Op.notIn]: ['delivered', 'cancelled'] }
        }
      })
      if (activeDeliveries > 0) {
        return res.status(400).json({
          success: false,
          message: 'Cannot delete driver with active deliveries'
        })
      }

      await driver.destroy()

      return res.status(200).json({
        success: true,
        message: 'Driver deleted successfully'
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async updateDriverStatus(req, res) {
    try {
      const { id } = req.params
      const { status } = req.body

      // Same IDOR fix as getDriverById.
      const driver = await db.driver.findOne({
        where: nullableArrayStoreScope(req, { id })
      })
      if (!driver) {
        return res
          .status(404)
          .json({ success: false, message: 'Driver not found' })
      }

      await driver.update({ status, modifiedBy: req.user?.id })

      return res.status(200).json({
        success: true,
        message: 'Driver status updated successfully',
        data: driver
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  // ─── Marketplace Config ──────────────────────────────────────────

  async getMarketplaceConfig(req, res) {
    try {
      const store = req.query.store
      if (!store) {
        return res
          .status(400)
          .json({ success: false, message: 'Store is required' })
      }

      return res.status(200).json({
        success: true,
        message: 'Success get marketplace config',
        data: {
          store: Number(store),
          gofood: { enabled: false, merchantId: null, apiKey: null },
          grabfood: { enabled: false, merchantId: null, apiKey: null },
          shopeefood: { enabled: false, merchantId: null, apiKey: null }
        }
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async saveMarketplaceConfig(req, res) {
    try {
      return res.status(200).json({
        success: true,
        message: 'Marketplace config saved (stub — integration coming soon)',
        data: req.body
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  // ─── Stats ───────────────────────────────────────────────────────

  async getDeliveryStats(req, res) {
    try {
      const store = req.query.store
      const where = {}
      if (store && store !== '' && req.user?.roleType === 'super_admin') {
        where.store = Number(store)
      } else if (req.user?.roleType !== 'super_admin' && req.user?.store) {
        where.store = Number(req.user.store)
      }

      const [
        total,
        pending,
        assigned,
        pickedUp,
        inTransit,
        delivered,
        cancelled
      ] = await Promise.all([
        db.delivery_order.count({ where }),
        db.delivery_order.count({ where: { ...where, status: 'pending' } }),
        db.delivery_order.count({ where: { ...where, status: 'assigned' } }),
        db.delivery_order.count({ where: { ...where, status: 'picked_up' } }),
        db.delivery_order.count({ where: { ...where, status: 'in_transit' } }),
        db.delivery_order.count({ where: { ...where, status: 'delivered' } }),
        db.delivery_order.count({ where: { ...where, status: 'cancelled' } })
      ])

      const totalDrivers = await db.driver.count({
        where:
          store && store !== ''
            ? {
                [Op.or]: [
                  { store: null },
                  { store: { [Op.contains]: [Number(store)] } },
                  db.sequelize.literal('"driver"."store" = \'[]\'::jsonb')
                ]
              }
            : {}
      })

      const activeDrivers = await db.driver.count({
        where: {
          status: 'active',
          ...(store && store !== ''
            ? {
                [Op.or]: [
                  { store: null },
                  { store: { [Op.contains]: [Number(store)] } },
                  db.sequelize.literal('"driver"."store" = \'[]\'::jsonb')
                ]
              }
            : {})
        }
      })

      return res.status(200).json({
        success: true,
        message: 'Success get delivery stats',
        data: {
          total,
          pending,
          assigned,
          pickedUp,
          inTransit,
          delivered,
          cancelled,
          totalDrivers,
          activeDrivers
        }
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  }
}

module.exports = deliveryController
