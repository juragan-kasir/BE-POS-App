const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const multer = require('multer')
const fs = require('fs')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('invoice.js'))
const invoiceController = require('../controller/invoice')
const authorization = require('../../utils/authorization')
const { requireRole } = authorization
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const { updateInvoiceSettingSchema } = require('../validation/schemas')

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

router.get(
  '/setting',
  authorization,
  validateStoreAccess,
  invoiceController.getSetting
)
router.put(
  '/setting',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  uploadImage.single('logo'),
  validate(updateInvoiceSettingSchema),
  invoiceController.updateSetting
)
router.post(
  '/setting/reset',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  invoiceController.resetSetting
)

module.exports = router
