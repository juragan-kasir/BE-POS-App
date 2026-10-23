const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('accountsReceivable.js'))
const arController = require('../controller/accountsReceivable')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const {
  createAccountsReceivableSchema,
  updateAccountsReceivableSchema
} = require('../validation/schemas')

router.get('/list', authorization, validateStoreAccess, arController.list)
router.get(
  '/aging',
  authorization,
  validateStoreAccess,
  arController.agingReport
)
router.get('/:id', authorization, validateStoreAccess, arController.getById)
router.post(
  '/create',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(createAccountsReceivableSchema),
  arController.create
)
router.post(
  '/:id/pay',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  arController.recordPayment
)
router.put(
  '/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(updateAccountsReceivableSchema),
  arController.update
)
router.delete(
  '/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  arController.delete
)

module.exports = router
