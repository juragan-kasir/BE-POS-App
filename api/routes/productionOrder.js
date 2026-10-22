const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('productionOrder.js'))
const productionOrderController = require('../controller/productionOrder')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const {
  createProductionOrderSchema,
  updateProductionOrderSchema
} = require('../validation/schemas')

router.get(
  '/get-all',
  authorization,
  validateStoreAccess,
  productionOrderController.getAll
)
router.get(
  '/get-by-id/:id',
  authorization,
  validateStoreAccess,
  productionOrderController.getById
)

router.post(
  '/create',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(createProductionOrderSchema),
  productionOrderController.create
)
router.put(
  '/update/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(updateProductionOrderSchema),
  productionOrderController.update
)
router.delete(
  '/delete/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  productionOrderController.delete
)

router.patch(
  '/status/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  productionOrderController.changeStatus
)

router.post(
  '/start/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  productionOrderController.startProduction
)

router.post(
  '/complete/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  productionOrderController.completeProduction
)

module.exports = router
