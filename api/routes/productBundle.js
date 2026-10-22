const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('productBundle.js'))
const fs = require('fs')
const multer = require('multer')
const bundleController = require('../controller/productBundle')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')

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

// ponytail: image bundle diupload multipart 'image' — sama seperti location
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }
}).single('image')

router.get(
  '/get-all',
  authorization,
  validateStoreAccess,
  bundleController.getAll
)

// F-1: public — customer QR app (no login) needs active bundles for its
// store. Mirrors promo.js's '/customer-active' (no auth, no requireRole);
// store-scoping is enforced inside the controller, not by this middleware
// chain. Must stay before '/get-by-id/:id' would be irrelevant here since
// this is a distinct static path, but kept adjacent to get-all for
// readability.
router.get('/customer-active', bundleController.getCustomerActive)

router.get(
  '/get-by-id/:id',
  authorization,
  validateStoreAccess,
  bundleController.getById
)

router.post(
  '/create',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  upload,
  bundleController.create
)

router.put(
  '/update/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  upload,
  bundleController.update
)

router.delete(
  '/delete/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  bundleController.delete
)

router.patch(
  '/status/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  bundleController.changeStatus
)

module.exports = router
