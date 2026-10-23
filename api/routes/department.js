const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const multer = require('multer')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('department.js'))

const departmentController = require('../controller/department')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const {
  createDepartmentSchema,
  updateDepartmentSchema
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

router.get(
  '/get-department',
  authorization,
  validateStoreAccess,
  departmentController.getAllDepartment
)

router.get(
  '/get-department-all',
  authorization,
  validateStoreAccess,
  departmentController.getAllDepartmentInTable
)

router.get(
  '/get-department/:id',
  authorization,
  validateStoreAccess,
  departmentController.getDepartmentById
)

router.post(
  '/add-new-department',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(createDepartmentSchema),
  departmentController.addNewDepartment
)

router.put(
  '/edit-department/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(updateDepartmentSchema),
  departmentController.editDepartmentById
)

router.delete(
  '/delete-department/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  departmentController.deleteDepartmentById
)

// Excel upload/download routes
router.get(
  '/download-template',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  departmentController.downloadTemplate
)

router.get(
  '/download',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  departmentController.downloadData
)

router.post(
  '/upload',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  upload.single('file'),
  departmentController.uploadExcel
)

module.exports = router
