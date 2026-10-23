const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const multer = require('multer')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('position.js'))

const positionController = require('../controller/position')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const {
  createPositionSchema,
  updatePositionSchema
} = require('../validation/schemas')

// Configure multer for file uploads
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
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
})

// Get All position
router.get(
  '/get-position',
  authorization,
  validateStoreAccess,
  positionController.getAllPosition
)

// Get position by ID
router.get(
  '/get-position/:id',
  authorization,
  validateStoreAccess,
  positionController.getPositionById
)

// Get positions by department
router.get(
  '/get-position-by-department/:departmentId',
  authorization,
  validateStoreAccess,
  positionController.getPositionByDepartment
)

// Get All List To Table
router.get(
  '/get-position-all',
  authorization,
  validateStoreAccess,
  positionController.getAllPositionInTable
)

// Add position
router.post(
  '/add-new-position',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(createPositionSchema),
  positionController.addNewPosition
)

// Edit position
router.put(
  '/edit-position/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(updatePositionSchema),
  positionController.editPositionById
)

// Delete position
router.delete(
  '/delete-position/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  positionController.deletePositionById
)

// Excel upload/download routes
router.get(
  '/download-template',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  positionController.downloadTemplate
)

router.get(
  '/download',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  positionController.downloadData
)

router.post(
  '/upload',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  upload.single('file'),
  positionController.uploadExcel
)

module.exports = router
