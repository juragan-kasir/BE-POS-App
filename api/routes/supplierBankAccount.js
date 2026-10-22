const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('supplierBankAccount.js'))
const supplierBankAccountController = require('../controller/supplierBankAccount')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')

router.get(
  '/supplier/:supplierId',
  authorization,
  validateStoreAccess,
  supplierBankAccountController.getAllBySupplier
)
router.get('/:id', authorization, validateStoreAccess, supplierBankAccountController.getById)
router.post(
  '/supplier/:supplierId',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  supplierBankAccountController.create
)
router.put(
  '/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  supplierBankAccountController.update
)
router.delete(
  '/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  supplierBankAccountController.delete
)

module.exports = router
