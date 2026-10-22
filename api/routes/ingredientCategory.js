const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('ingredientCategory.js'))
const multer = require('multer')
const ingredientCategoryController = require('../controller/ingredientCategory')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const {
  createIngredientCategorySchema,
  updateIngredientCategorySchema
} = require('../validation/schemas')

const uploadExcel = multer({ storage: multer.memoryStorage() })

router.get(
  '/get-all',
  authorization,
  validateStoreAccess,
  ingredientCategoryController.getAll
)
router.get(
  '/get-by-id/:id',
  authorization,
  validateStoreAccess,
  ingredientCategoryController.getById
)
router.post(
  '/add',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(createIngredientCategorySchema),
  ingredientCategoryController.create
)
router.put(
  '/edit/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(updateIngredientCategorySchema),
  ingredientCategoryController.update
)
router.delete(
  '/delete/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  ingredientCategoryController.delete
)

// Excel download/upload
router.get(
  '/template',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  ingredientCategoryController.downloadTemplate
)
router.get(
  '/download',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  ingredientCategoryController.downloadData
)
router.post(
  '/import',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  uploadExcel.single('file'),
  ingredientCategoryController.importData
)

module.exports = router
