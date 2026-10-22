const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('purchaseOrder.js'))
const multer = require('multer')
const purchaseOrderController = require('../controller/purchaseOrder')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const {
  createPurchaseOrderSchema,
  updatePurchaseOrderSchema
} = require('../validation/schemas')

const uploadExcel = multer({ storage: multer.memoryStorage() })

// Get PO - All authenticated users
router.get(
  '/get-all',
  authorization,
  validateStoreAccess,
  purchaseOrderController.getAll
)
router.get(
  '/get-by-id/:id',
  authorization,
  validateStoreAccess,
  purchaseOrderController.getById
)

// Create/Update/Delete - Admin & Super Admin only
router.post(
  '/create',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(createPurchaseOrderSchema),
  purchaseOrderController.create
)
router.put(
  '/update/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(updatePurchaseOrderSchema),
  purchaseOrderController.update
)
router.delete(
  '/delete/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  purchaseOrderController.delete
)

// Receive - Admin & Super Admin only
router.put(
  '/receive/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  purchaseOrderController.receive
)

// Send to Supplier - Admin & Super Admin only
router.put(
  '/send-to-supplier/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  purchaseOrderController.sendToSupplier
)

// Cancel - Admin & Super Admin only
router.put(
  '/cancel/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  purchaseOrderController.cancel
)

// Download/Upload - Super Admin only
router.get(
  '/template',
  authorization,
  validateStoreAccess,
  requireRole('super_admin'),
  purchaseOrderController.downloadTemplate
)
router.get(
  '/download',
  authorization,
  validateStoreAccess,
  requireRole('super_admin'),
  purchaseOrderController.downloadData
)
router.post(
  '/import',
  authorization,
  validateStoreAccess,
  requireRole('super_admin'),
  uploadExcel.single('file'),
  purchaseOrderController.importData
)

module.exports = router
