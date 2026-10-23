const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('member.js'))

const memberController = require('../controller/member')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const {
  createMemberSchema,
  updateMemberSchema
} = require('../validation/schemas')

// Get Members - All authenticated users
router.get(
  '/get-member',
  authorization,
  validateStoreAccess,
  memberController.getAllMember
)
router.get(
  '/get-member/:id',
  authorization,
  validateStoreAccess,
  memberController.getMemberById
)

// Add Member - Admin & Super Admin only
router.post(
  '/add-new-member',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(createMemberSchema),
  memberController.addNewMember
)

// Edit Member - Admin & Super Admin only
router.put(
  '/edit-member/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(updateMemberSchema),
  memberController.editMember
)

// Delete Member - Admin & Super Admin only
router.delete(
  '/delete-member/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  memberController.deleteMember
)

// Edit Member Point - Admin & Super Admin only (keep for backward compatibility)
router.put(
  '/edit-point-member/:phoneNumber',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  memberController.editMemberById
)

module.exports = router
