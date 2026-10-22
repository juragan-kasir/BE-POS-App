const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('type-payment.js'))
const multer = require('multer')

const typePaymentController = require('../controller/type-payment')
const authorization = require('../../utils/authorization')
const { requireRole } = authorization
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const {
  createTypePaymentSchema,
  updateTypePaymentSchema
} = require('../validation/schemas')

const uploadExcel = multer({ storage: multer.memoryStorage() })

// get Type Payment By Location And Active
router.get(
  '/get-type-payment',
  authorization,
  validateStoreAccess,
  typePaymentController.getAllTypePaymentByLocationAndActive
)

// Get All Type Payment
router.get(
  '/get-list-type-payment',
  authorization,
  validateStoreAccess,
  typePaymentController.getAllTypePayment
)

// Get Type Payment By Id
router.get(
  '/get-by-id/:id',
  authorization,
  validateStoreAccess,
  typePaymentController.getTypePaymentById
)

// Add Type Payment
router.post(
  '/add-new-type-payment',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(createTypePaymentSchema),
  typePaymentController.postNewTypePayment
)

// Edit Type Payment
router.put(
  '/edit-type-payment/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(updateTypePaymentSchema),
  typePaymentController.editTypePaymentById
)

// Delete Type Payment
router.delete(
  '/delete-type-payment/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  typePaymentController.deleteTypePaymentById
)

// Download Template
router.get(
  '/template',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  typePaymentController.downloadTemplate
)

// Download Data
router.get(
  '/download',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  typePaymentController.downloadData
)

// Import Data
router.post(
  '/import',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  uploadExcel.single('file'),
  typePaymentController.importData
)

module.exports = router
