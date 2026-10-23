const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('shift.js'))

const shiftController = require('../controller/shift')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const {
  createShiftSchema,
  updateShiftSchema
} = require('../validation/schemas')

// Get All Shift - All authenticated users
router.get(
  '/get-shift',
  authorization,
  validateStoreAccess,
  shiftController.getAllShift
)

router.get(
  '/get-shift/:id',
  authorization,
  validateStoreAccess,
  shiftController.getShiftById
)

// Get Shift Dropdown
router.get(
  '/dropdown',
  authorization,
  validateStoreAccess,
  shiftController.getShiftDropdown
)

// Add/Edit/Delete Shift - Admin & Super Admin only
router.post(
  '/add-new-shift',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(createShiftSchema),
  shiftController.postNewShift
)
router.put(
  '/edit-shift/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(updateShiftSchema),
  shiftController.editShiftById
)
router.delete(
  '/delete-shift/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  shiftController.deleteShiftById
)

module.exports = router
