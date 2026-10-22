const express = require('express')
const multer = require('multer')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('category.js'))

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'application/octet-stream'
    ]
    if (
      allowedMimes.includes(file.mimetype) ||
      file.originalname.endsWith('.xlsx') ||
      file.originalname.endsWith('.xls')
    ) {
      cb(null, true)
    } else {
      cb(new Error('File harus berupa Excel (.xlsx atau .xls)'), false)
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 }
})

const fs = require('fs')
const uploadDir = '/tmp/uploads'
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}

const uploadImage = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const unique = Date.now() + '-' + Math.round(Math.random() * 1e9)
      cb(null, unique + '-' + file.originalname)
    }
  }),
  fileFilter: (req, file, cb) => cb(null, true),
  limits: { fileSize: 5 * 1024 * 1024 }
})

const categoryController = require('../controller/category')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const {
  createCategorySchema,
  updateCategorySchema
} = require('../validation/schemas')

// Get All List To Table
router.get(
  '/get-category-all',
  authorization,
  validateStoreAccess,
  categoryController.getAllCategoryInTable
)

// Get Category By Id - All authenticated users
router.get(
  '/get-category/:id',
  authorization,
  validateStoreAccess,
  categoryController.getCategoryById
)

// Add New Category - Admin & Super Admin only
router.post(
  '/add-new-category',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  uploadImage.single('image'),
  validate(createCategorySchema),
  categoryController.addNewCategory
)

// Edit Category - Admin & Super Admin only
router.put(
  '/edit-category/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  uploadImage.single('image'),
  validate(updateCategorySchema),
  categoryController.editCategoryById
)

// Delete Category - Admin & Super Admin only
router.delete(
  '/delete-category/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  categoryController.deleteCategoryById
)

// Download Excel Template - Admin & Super Admin only
router.get(
  '/download-template',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  categoryController.exportCategory
)

// Download Excel Data - Admin & Super Admin only
router.get(
  '/download',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  categoryController.downloadData
)

// Upload Excel - Admin & Super Admin only
router.post(
  '/upload-excel',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  upload.single('file'),
  categoryController.importCategory
)

module.exports = router
