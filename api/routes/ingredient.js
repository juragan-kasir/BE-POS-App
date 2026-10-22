const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('ingredient.js'))
const multer = require('multer')
const ingredientController = require('../controller/ingredient')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const {
  createIngredientSchema,
  updateIngredientSchema,
  adjustIngredientStockSchema
} = require('../validation/schemas')

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

router.get(
  '/get-all',
  authorization,
  validateStoreAccess,
  ingredientController.getAll
)
router.get(
  '/get-by-id/:id',
  authorization,
  validateStoreAccess,
  ingredientController.getById
)
router.post(
  '/add',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(createIngredientSchema),
  ingredientController.create
)
router.put(
  '/edit/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(updateIngredientSchema),
  ingredientController.update
)
router.put(
  '/adjust-stock/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(adjustIngredientStockSchema),
  ingredientController.adjustStock
)
router.get(
  '/stock-summary',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  ingredientController.stockSummary
)
router.delete(
  '/delete/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  ingredientController.delete
)

router.get(
  '/download-template',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  ingredientController.downloadTemplate
)
router.get(
  '/download',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  ingredientController.downloadData
)
router.get(
  '/product-names',
  authorization,
  validateStoreAccess,
  ingredientController.getProductNames
)

router.post(
  '/import',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  upload.single('file'),
  ingredientController.importData
)

module.exports = router
