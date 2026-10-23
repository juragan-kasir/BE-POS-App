const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('employee.js'))
const employeeController = require('../controller/employee')
const employeePerformanceController = require('../controller/employeePerformance')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const {
  createEmployeeSchema,
  updateUserSchema
} = require('../validation/schemas')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const multer = require('multer')

const uploadDir = '/tmp/uploads'

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}

const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
])
const DOCUMENT_TYPES = new Set([
  ...IMAGE_TYPES,
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv'
])

const safeUploadName = (originalName) => {
  const base = path.basename(String(originalName || 'upload'))
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  return cleaned || 'upload'
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir)
  },
  filename: function (req, file, cb) {
    const suffix = crypto.randomBytes(8).toString('hex')
    cb(null, `${Date.now()}-${suffix}-${safeUploadName(file.originalname)}`)
  }
})

const fileFilter = (req, file, cb) => {
  const allowed = file.fieldname === 'image' ? IMAGE_TYPES : DOCUMENT_TYPES
  if (allowed.has(file.mimetype)) return cb(null, true)

  const error = new Error('Tipe file tidak diizinkan')
  error.status = 400
  return cb(error)
}

const upload = multer({
  storage: storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024, files: 11, fields: 80 }
}).fields([
  { name: 'image', maxCount: 1 },
  { name: 'documents', maxCount: 10 }
])

const cleanupUploadedFiles = (req, res, next) => {
  const files = [
    ...(Array.isArray(req.files?.image) ? req.files.image : []),
    ...(Array.isArray(req.files?.documents) ? req.files.documents : [])
  ]

  if (files.length > 0) {
    res.on('finish', () => {
      for (const file of files) {
        if (!file?.path || path.dirname(file.path) !== uploadDir) continue
        fs.promises.unlink(file.path).catch(() => {})
      }
    })
  }

  next()
}

router.post(
  '/add-employee',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  upload,
  cleanupUploadedFiles,
  validate(createEmployeeSchema),
  employeeController.addEmployee
)

router.get(
  '/get-employee',
  authorization,
  validateStoreAccess,
  employeeController.getAllEmployee
)

router.get(
  '/get-employee/:id',
  authorization,
  validateStoreAccess,
  employeeController.getEmployeeById
)

router.get(
  '/get-employee-detail/:employeeID',
  authorization,
  validateStoreAccess,
  employeeController.getEmployeeByEmployeeID
)

router.put(
  '/edit-employee',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  upload,
  cleanupUploadedFiles,
  validate(updateUserSchema),
  employeeController.updateEmployee
)

router.delete(
  '/delete-employee/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  employeeController.deleteEmployee
)

// Employee performance (previously mounted under a second /employee router)
router.get(
  '/performance',
  authorization,
  validateStoreAccess,
  employeePerformanceController.getPerformance
)

router.get(
  '/:id/performance',
  authorization,
  validateStoreAccess,
  employeePerformanceController.getEmployeePerformance
)

router.get(
  '/top-performers',
  authorization,
  validateStoreAccess,
  employeePerformanceController.getTopPerformers
)

module.exports = router
