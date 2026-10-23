const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')

const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('social-media.js'))

const SocialMediaController = require('../controller/social-media')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const {
  createSocialMediaSchema,
  updateSocialMediaSchema
} = require('../validation/schemas')

// Get Social Media
router.get(
  '/get-social-media',
  authorization,
  validateStoreAccess,
  SocialMediaController.getAllSocialMedia
)

// Post Social Media
router.post(
  '/add-social-media',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(createSocialMediaSchema),
  SocialMediaController.addNewSocialMedia
)

// Edit Social Media
router.put(
  '/edit-social-media/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(updateSocialMediaSchema),
  SocialMediaController.editSocialMediaById
)

// Delete Social Media
router.delete(
  '/delete-social-media/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  SocialMediaController.deleteSocialMediaById
)

module.exports = router
