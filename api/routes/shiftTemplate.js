const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('shiftTemplate.js'))

const shiftTemplateController = require('../controller/shiftTemplate')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const {
  createShiftTemplateSchema,
  updateShiftTemplateSchema
} = require('../validation/schemas')

router.get(
  '/get-shift-template',
  authorization,
  validateStoreAccess,
  shiftTemplateController.getAllShiftTemplate
)

router.get(
  '/get-shift-template-all',
  authorization,
  validateStoreAccess,
  shiftTemplateController.getAllShiftTemplateInTable
)

router.get(
  '/get-shift-template/:id',
  authorization,
  validateStoreAccess,
  shiftTemplateController.getShiftTemplateById
)

router.post(
  '/add-new-shift-template',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(createShiftTemplateSchema),
  shiftTemplateController.addNewShiftTemplate
)

router.put(
  '/edit-shift-template/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(updateShiftTemplateSchema),
  shiftTemplateController.editShiftTemplateById
)

router.delete(
  '/delete-shift-template/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  shiftTemplateController.deleteShiftTemplateById
)

module.exports = router
