const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('purchasePayment.js'))
const purchasePaymentController = require('../controller/purchasePayment')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const { createPurchasePaymentSchema } = require('../validation/schemas')

router.get(
  '/detail/:id',
  authorization,
  validateStoreAccess,
  purchasePaymentController.getById
)
router.get(
  '/by-po/:poId',
  authorization,
  validateStoreAccess,
  purchasePaymentController.getByPO
)
router.get(
  '/by-supplier/:supplierId',
  authorization,
  validateStoreAccess,
  purchasePaymentController.getBySupplier
)
router.get(
  '/ap-dashboard',
  authorization,
  validateStoreAccess,
  purchasePaymentController.apDashboard
)
router.get(
  '/list',
  authorization,
  validateStoreAccess,
  purchasePaymentController.list
)
router.post(
  '/create',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(createPurchasePaymentSchema),
  purchasePaymentController.record
)
router.delete(
  '/delete/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  purchasePaymentController.delete
)

module.exports = router
