const express = require('express')
const router = express.Router()
const tableController = require('../controller/table')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { requireMenuAction } = require('../../utils/menuAccessMiddleware')
const { validate } = require('../middleware/validate')
const {
  createTableSchema,
  updateTableSchema
} = require('../validation/schemas')

// Get tables - All authenticated users (DR-24 C-02: menu-enforced — a
// menu-scoped role without /table view is denied even for reads)
router.get(
  '/get-tables',
  authorization,
  validateStoreAccess,
  requireMenuAction('/table', 'view'),
  tableController.getTablesByStore
)
router.get(
  '/get-tables-with-orders',
  authorization,
  validateStoreAccess,
  requireMenuAction('/table', 'view'),
  tableController.getTableWithActiveOrders
)
router.get(
  '/get-availability',
  authorization,
  validateStoreAccess,
  requireMenuAction('/table', 'view'),
  tableController.getTableAvailability
)

// Create/Update/Delete - Admin & Super Admin only
router.post(
  '/create',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  requireMenuAction('/table', 'add'),
  validate(createTableSchema),
  tableController.createTable
)
router.put(
  '/update/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  requireMenuAction('/table', 'edit'),
  validate(updateTableSchema),
  tableController.updateTable
)
router.delete(
  '/delete/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  requireMenuAction('/table', 'delete'),
  tableController.deleteTable
)

// Update status - elevated store action (DR-24 C-16 / D-03): releasing a
// table ("Set Available") by staff is admin-only. POS flows claim/release
// tables through their own order transactions; this manual override stays
// with the owner/admin, and the controller additionally requires a reason
// and records it on the audit row.
router.put(
  '/update-status/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  requireMenuAction('/table', 'edit'),
  tableController.updateTableStatus
)

module.exports = router
