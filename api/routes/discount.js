const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('discount.js'))
const multer = require('multer')

const discountController = require('../controller/discount')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const {
  createDiscountSchema,
  updateDiscountSchema
} = require('../validation/schemas')

const uploadExcel = multer({ storage: multer.memoryStorage() })

// Get All Discount - All authenticated users
router.get(
  '/get-discount-by-location',
  authorization,
  validateStoreAccess,
  discountController.getAllDiscountByLocationAndActive
)
router.get(
  '/get-discount',
  authorization,
  validateStoreAccess,
  discountController.getAllDiscount
)

// Add Discount - Admin & Super Admin only
router.post(
  '/add-new-discount',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(createDiscountSchema),
  discountController.postNewDiscount
)

// Edit Discount - Admin & Super Admin only
router.put(
  '/edit-discount/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(updateDiscountSchema),
  discountController.editDiscountById
)

// Delete Discount - Admin & Super Admin only
router.delete(
  '/delete-discount/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  discountController.deleteDiscountById
)

// Download Template - Super Admin only
router.get(
  '/template',
  authorization,
  validateStoreAccess,
  requireRole('super_admin'),
  discountController.downloadTemplate
)

// Download Excel Data - Super Admin only
router.get(
  '/download',
  authorization,
  validateStoreAccess,
  requireRole('super_admin'),
  discountController.downloadData
)

// Upload Excel - Super Admin only
router.post(
  '/import',
  authorization,
  validateStoreAccess,
  requireRole('super_admin'),
  uploadExcel.single('file'),
  discountController.importData
)

// Get Discount By ID
router.get(
  '/get-discount/:id',
  authorization,
  validateStoreAccess,
  discountController.getDiscountById
)

// Lookup promo by code - no auth required (POS checkout)
router.get('/lookup-by-code/:code', discountController.lookupByCode)

module.exports = router
