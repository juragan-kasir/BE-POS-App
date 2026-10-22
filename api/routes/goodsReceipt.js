const express = require('express')
const fs = require('fs')
const multer = require('multer')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('goodsReceipt.js'))
const goodsReceiptController = require('../controller/goodsReceipt')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const {
  createGoodsReceiptSchema,
  updateGoodsReceiptSchema
} = require('../validation/schemas')

// ponytail: documentation photo uploads (up to 5, stored to /tmp then Cloudinary)
const uploadDir = '/tmp/uploads'
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir)
  },
  filename: function (req, file, cb) {
    cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, '-')}`)
  }
})
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true)
    else cb(new Error('Only image files are allowed'))
  }
})

router.get(
  '/get-all',
  authorization,
  validateStoreAccess,
  goodsReceiptController.getAll
)
router.get(
  '/get-by-id/:id',
  authorization,
  validateStoreAccess,
  goodsReceiptController.getById
)
router.get(
  '/by-po/:poId',
  authorization,
  validateStoreAccess,
  goodsReceiptController.getByPO
)
router.get(
  '/export',
  authorization,
  validateStoreAccess,
  goodsReceiptController.exportExcel
)

router.post(
  '/create',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  upload.array('file', 5),
  validate(createGoodsReceiptSchema),
  goodsReceiptController.create
)
router.put(
  '/update/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  upload.array('file', 5),
  validate(updateGoodsReceiptSchema),
  goodsReceiptController.update
)
router.delete(
  '/delete/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  goodsReceiptController.delete
)

router.patch(
  '/status/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  goodsReceiptController.changeStatus
)

module.exports = router
