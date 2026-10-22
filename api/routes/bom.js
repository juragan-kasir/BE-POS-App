const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('bom.js'))
const bomController = require('../controller/bom')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const { createBomSchema, updateBomSchema } = require('../validation/schemas')

router.get(
  '/get-all',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  bomController.getAll
)
router.get(
  '/get-by-id/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  bomController.getById
)
router.get(
  '/get-by-product/:productId',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  bomController.getByProduct
)
router.post(
  '/add',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(createBomSchema),
  bomController.create
)
router.put(
  '/edit/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(updateBomSchema),
  bomController.update
)
router.delete(
  '/delete/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  bomController.delete
)

module.exports = router
