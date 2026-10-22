const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('supplierCategory.js'))
const supplierCategoryController = require('../controller/supplierCategory')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')

router.get('/', authorization, validateStoreAccess, supplierCategoryController.getAll)
router.get('/:id', authorization, validateStoreAccess, supplierCategoryController.getById)
router.post(
  '/',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  supplierCategoryController.create
)
router.put(
  '/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  supplierCategoryController.update
)
router.delete(
  '/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  supplierCategoryController.delete
)

module.exports = router
