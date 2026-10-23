const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('memberTier.js'))
const memberTierController = require('../controller/memberTier')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const {
  createMemberTierSchema,
  updateMemberTierSchema
} = require('../validation/schemas')

router.get(
  '/get-all',
  authorization,
  validateStoreAccess,
  memberTierController.getAll
)
router.get(
  '/detail/:id',
  authorization,
  validateStoreAccess,
  memberTierController.getDetail
)
router.post(
  '/add',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(createMemberTierSchema),
  memberTierController.create
)
router.put(
  '/edit/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(updateMemberTierSchema),
  memberTierController.update
)
router.delete(
  '/delete/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  memberTierController.delete
)
router.get(
  '/get-by-points',
  authorization,
  validateStoreAccess,
  memberTierController.getMemberTier
)
router.post(
  '/update-members',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  memberTierController.updateMemberTier
)

module.exports = router
