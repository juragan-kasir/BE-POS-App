const express = require('express')
const router = express.Router()
const locationController = require('../controller/location')
const authorization = require('../../utils/authorization')
const { requireRole, requireCanonicalPermission } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const {
  authorizationContextMiddleware
} = require('../../utils/authorizationContextMiddleware')
const { validate } = require('../middleware/validate')
const {
  createLocationSchema,
  updateLocationSchema,
  storeConfigurationSchema
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
}).single('image')

// Public - Get all active locations (for registration dropdown) - NO auth required
router.get('/get-location-public', locationController.getAllLocationPublic)

// Get all locations in table - Super Admin sees all; admin sees own store
// only (controller scopes non-super_admin by req.user.store).
router.get(
  '/get-location-all',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  locationController.getAllLocationInTable
)

// Get location detail - all authenticated users
router.get(
  '/get-location-detail/:locationId',
  authorization,
  validateStoreAccess,
  locationController.getLocationById
)

// Generate location ID - Super Admin only
router.get(
  '/generate-id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin'),
  locationController.generateLocationId
)

// Add new location - Super Admin only
router.post(
  '/add-new-location',
  authorization,
  validateStoreAccess,
  requireRole('super_admin'),
  upload,
  validate(createLocationSchema),
  locationController.addNewLocation
)

// Edit location - Super Admin only
router.put(
  '/edit-location',
  authorization,
  validateStoreAccess,
  requireRole('super_admin'),
  upload,
  validate(updateLocationSchema),
  locationController.editLocationById
)

// W3 store configuration - canonical tenant/store scope only. No legacy
// requireRole/validateStoreAccess gate: admission is decided by
// requireCanonicalPermission('store.manage') against the persisted target
// row. upload precedes the permission gate so multipart bodies are parsed
// for scope resolution; no mutation occurs before the gate.
router.put(
  '/store-configuration',
  authorization,
  authorizationContextMiddleware,
  upload,
  (req, res, next) =>
    requireCanonicalPermission(
      'store.manage',
      locationController.storeConfigurationScope
    )(req, res, next),
  validate(storeConfigurationSchema),
  locationController.updateStoreConfiguration
)

// W3 read follow-up - canonical store-configuration reads, admitted exactly
// like the W3 mutation (store.manage against persisted ownership). No legacy
// requireRole/validateStoreAccess gate and no req.storeId pinning.
router.get(
  '/store-configuration',
  authorization,
  authorizationContextMiddleware,
  (req, res, next) =>
    requireCanonicalPermission(
      'store.manage',
      locationController.storeConfigurationListScope
    )(req, res, next),
  locationController.listStoreConfigurations
)

router.get(
  '/store-configuration/:id',
  authorization,
  authorizationContextMiddleware,
  (req, res, next) =>
    requireCanonicalPermission(
      'store.manage',
      locationController.storeConfigurationReadScope
    )(req, res, next),
  locationController.getStoreConfiguration
)

// DR-24 C-04 (DR-05 §35.7): outlet closure by archive — reversible and
// audited, with fail-closed preconditions (open registers, unsettled orders,
// in-transit transfers). Admin acts on its own store only (D-09); the
// platform super_admin on any. The destructive /delete-location is unchanged.
router.post(
  '/archive-location',
  authorization,
  requireRole('super_admin', 'admin'),
  locationController.archiveLocationById
)

router.post(
  '/reactivate-location',
  authorization,
  requireRole('super_admin', 'admin'),
  locationController.reactivateLocationById
)

// Delete location - Super Admin only
router.delete(
  '/delete-location',
  authorization,
  validateStoreAccess,
  requireRole('super_admin'),
  locationController.deleteLocationById
)

module.exports = router
