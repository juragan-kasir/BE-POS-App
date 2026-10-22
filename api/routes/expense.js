const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('expense.js'))
const expenseController = require('../controller/expense')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const {
  createExpenseSchema,
  updateExpenseSchema,
  bulkCreateExpensesSchema,
  generateSalarySchema,
  markExpensePaidSchema
} = require('../validation/schemas')

// Get expenses - All authenticated users
router.get(
  '/get-all',
  authorization,
  validateStoreAccess,
  expenseController.getAll
)
router.get(
  '/get-by-id/:id',
  authorization,
  validateStoreAccess,
  expenseController.getById
)
router.get(
  '/get-summary',
  authorization,
  validateStoreAccess,
  expenseController.getSummary
)
router.get(
  '/upcoming-payments',
  authorization,
  validateStoreAccess,
  expenseController.getUpcomingPayments
)

// Create/Edit/Delete expense - Admin & Super Admin only
router.post(
  '/add',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(createExpenseSchema),
  expenseController.create
)
router.put(
  '/edit/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(updateExpenseSchema),
  expenseController.update
)

// Atomic bulk create (single transaction) - Admin & Super Admin only
router.post(
  '/bulk-create',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(bulkCreateExpensesSchema),
  expenseController.bulkCreate
)
router.delete(
  '/delete/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  expenseController.delete
)

// Approve/Reject - Admin & Super Admin only
router.put(
  '/approve/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  expenseController.approve
)
router.put(
  '/reject/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  expenseController.reject
)

// Mark expense as paid/unpaid - Admin & Super Admin only
router.put(
  '/mark-paid/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(markExpensePaidSchema),
  expenseController.markPaid
)
router.put(
  '/mark-unpaid/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  expenseController.markUnpaid
)

// Archive/restore expense - Admin & Super Admin only
router.put(
  '/set-active/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  expenseController.setActive
)

// Generate salary expenses - Admin & Super Admin only
router.post(
  '/generate-salary',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(generateSalarySchema),
  expenseController.generateSalary
)

module.exports = router
