const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('delivery.js'))
const deliveryController = require('../controller/delivery')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const {
  createDeliveryOrderSchema,
  updateDeliveryStatusSchema,
  assignDriverSchema,
  cancelDeliverySchema,
  createDriverSchema,
  updateDriverSchema,
  updateDriverStatusSchema,
  marketplaceConfigSchema
} = require('../validation/schemas')

// ─── Delivery Orders ─────────────────────────────────────────────

router.get(
  '/orders',
  authorization,
  validateStoreAccess,
  deliveryController.getDeliveryOrders
)

router.get(
  '/orders/stats',
  authorization,
  validateStoreAccess,
  deliveryController.getDeliveryStats
)

router.get(
  '/orders/:id',
  authorization,
  validateStoreAccess,
  deliveryController.getDeliveryOrderById
)

router.post(
  '/orders',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(createDeliveryOrderSchema),
  deliveryController.createDeliveryOrder
)

router.put(
  '/orders/status',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(updateDeliveryStatusSchema),
  deliveryController.updateDeliveryStatus
)

router.put(
  '/orders/:orderId/assign-driver',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(assignDriverSchema),
  deliveryController.assignDriver
)

router.put(
  '/orders/:id/cancel',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(cancelDeliverySchema),
  deliveryController.cancelDeliveryOrder
)

// ─── Drivers ─────────────────────────────────────────────────────

router.get(
  '/drivers',
  authorization,
  validateStoreAccess,
  deliveryController.getDrivers
)

router.get(
  '/drivers/stats',
  authorization,
  validateStoreAccess,
  deliveryController.getDeliveryStats
)

router.get(
  '/drivers/:id',
  authorization,
  validateStoreAccess,
  deliveryController.getDriverById
)

router.post(
  '/drivers',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(createDriverSchema),
  deliveryController.createDriver
)

router.put(
  '/drivers/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(updateDriverSchema),
  deliveryController.updateDriver
)

router.delete(
  '/drivers/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  deliveryController.deleteDriver
)

router.put(
  '/drivers/:id/status',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(updateDriverStatusSchema),
  deliveryController.updateDriverStatus
)

// ─── Marketplace Config ──────────────────────────────────────────

router.get(
  '/marketplace-config',
  authorization,
  validateStoreAccess,
  requireRole('super_admin'),
  deliveryController.getMarketplaceConfig
)

router.post(
  '/marketplace-config',
  authorization,
  validateStoreAccess,
  requireRole('super_admin'),
  validate(marketplaceConfigSchema),
  deliveryController.saveMarketplaceConfig
)

// ─── Stats ───────────────────────────────────────────────────────

router.get(
  '/stats',
  authorization,
  validateStoreAccess,
  deliveryController.getDeliveryStats
)

module.exports = router
