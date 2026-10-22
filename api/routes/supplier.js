const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('supplier.js'))
const multer = require('multer')
const supplierController = require('../controller/supplier')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const {
  createSupplierSchema,
  updateSupplierSchema
} = require('../validation/schemas')

const uploadExcel = multer({ storage: multer.memoryStorage() })

// ── GET static routes (MUST be before /:id) ──────────────────────────
router.get('/', authorization, validateStoreAccess, supplierController.getAll)
router.get(
  '/compare',
  authorization,
  validateStoreAccess,
  supplierController.compareSuppliers
)
router.get(
  '/detail/:id',
  authorization,
  validateStoreAccess,
  supplierController.getDetail
)
router.get(
  '/product-template',
  authorization,
  validateStoreAccess,
  requireRole('super_admin'),
  supplierController.downloadProductTemplate
)
router.get(
  '/template',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  supplierController.downloadTemplate
)
router.get(
  '/download',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  supplierController.downloadData
)

// ── GET param route (MUST be last among GET routes) ───────────────────
router.get(
  '/:id',
  authorization,
  validateStoreAccess,
  supplierController.getById
)

// ── POST ──────────────────────────────────────────────────────────────
router.post(
  '/',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(createSupplierSchema),
  supplierController.create
)
router.post(
  '/import',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  uploadExcel.single('file'),
  supplierController.importData
)
router.post(
  '/:id/import-products',
  authorization,
  validateStoreAccess,
  requireRole('super_admin'),
  uploadExcel.single('file'),
  supplierController.importProducts
)

// ── PUT ───────────────────────────────────────────────────────────────
router.put(
  '/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(updateSupplierSchema),
  supplierController.update
)

// ── DELETE ────────────────────────────────────────────────────────────
router.delete(
  '/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  supplierController.delete
)

module.exports = router
