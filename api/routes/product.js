const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('product.js'))
const productController = require('../controller/product')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const {
  createProductSchema,
  updateProductSchema
} = require('../validation/schemas')
const fs = require('fs')
const multer = require('multer')

const uploadDir = '/tmp/uploads'

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir)
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname)
  }
})

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }
}).fields([
  { name: 'image', maxCount: 1 },
  { name: 'images', maxCount: 10 }
])

const uploadImport = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
  }),
  limits: { fileSize: 5 * 1024 * 1024 }
}).fields([
  { name: 'file', maxCount: 1 },
  { name: 'images', maxCount: 50 }
])

// Product Template - Admin & Super Admin only
router.get(
  '/template',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  productController.downloadTemplate
)
router.get(
  '/download',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  productController.downloadData
)
router.post(
  '/import',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  uploadImport,
  productController.importProduct
)

// Product CRUD
// Read products - All authenticated users
router.get(
  '/get-product',
  authorization,
  validateStoreAccess,
  productController.getAllProduct
)
router.get(
  '/get-product-by-super-admin',
  authorization,
  validateStoreAccess,
  productController.getProductByLocationSuperAdmin
)
// Recipe portions + limiting ingredients for the cashier grid.
router.get(
  '/recipe-availability',
  authorization,
  validateStoreAccess,
  productController.getRecipeAvailability
)
router.get(
  '/get-product-all',
  authorization,
  validateStoreAccess,
  productController.getAllProductInTable
)

// Create/Update/Delete - Admin & Super Admin only
router.post(
  '/add-product',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  upload,
  validate(createProductSchema),
  productController.postAddProduct
)
router.put(
  '/edit-product',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  upload,
  validate(updateProductSchema),
  productController.editProductByLocationAndId
)
router.delete(
  '/delete-product/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  productController.deleteProductByIdAndLocation
)

router.get(
  '/get-by-id/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  productController.getProductById
)

module.exports = router
