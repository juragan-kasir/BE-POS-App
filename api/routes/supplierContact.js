const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('supplierContact.js'))
const supplierContactController = require('../controller/supplierContact')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')

router.get(
  '/supplier/:supplierId',
  authorization,
  validateStoreAccess,
  supplierContactController.getAllBySupplier
)
router.get('/:id', authorization, validateStoreAccess, supplierContactController.getById)
router.post(
  '/supplier/:supplierId',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  supplierContactController.create
)
router.put(
  '/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  supplierContactController.update
)
router.delete(
  '/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  supplierContactController.delete
)

module.exports = router
