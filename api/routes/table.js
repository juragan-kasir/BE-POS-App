const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('table.js'))
const tableController = require('../controller/table')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const {
  createTableSchema,
  updateTableSchema
} = require('../validation/schemas')

// Get tables - All authenticated users. Reads stay open (the cashier picks
// tables at checkout); writes follow the /table-list menu (menuWriteGate).
router.get(
  '/get-tables',
  authorization,
  validateStoreAccess,
  tableController.getTablesByStore
)
router.get(
  '/get-tables-with-orders',
  authorization,
  validateStoreAccess,
  tableController.getTableWithActiveOrders
)
router.get(
  '/get-availability',
  authorization,
  validateStoreAccess,
  tableController.getTableAvailability
)

// Create/Update/Delete - Admin & Super Admin only
router.post(
  '/create',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(createTableSchema),
  tableController.createTable
)
router.put(
  '/update/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(updateTableSchema),
  tableController.updateTable
)
router.delete(
  '/delete/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
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
  tableController.updateTableStatus
)

module.exports = router
