const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('accounting.js'))
const accountingController = require('../controller/accounting')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')

router.get(
  '/accounts',
  authorization,
  requireRole('super_admin', 'admin'),
  validateStoreAccess,
  accountingController.listAccounts
)
router.post(
  '/accounts',
  authorization,
  requireRole('super_admin', 'admin'),
  validateStoreAccess,
  accountingController.createAccount
)
router.put(
  '/accounts/:id',
  authorization,
  requireRole('super_admin', 'admin'),
  validateStoreAccess,
  accountingController.updateAccount
)
router.delete(
  '/accounts/:id',
  authorization,
  requireRole('super_admin', 'admin'),
  validateStoreAccess,
  accountingController.deleteAccount
)

router.get(
  '/journals',
  authorization,
  requireRole('super_admin', 'admin'),
  validateStoreAccess,
  accountingController.listJournals
)
router.post(
  '/journals',
  authorization,
  requireRole('super_admin', 'admin'),
  validateStoreAccess,
  accountingController.createManualJournal
)
router.delete(
  '/journals/:id',
  authorization,
  requireRole('super_admin', 'admin'),
  validateStoreAccess,
  accountingController.deleteJournal
)

router.get(
  '/overview',
  authorization,
  requireRole('super_admin', 'admin'),
  validateStoreAccess,
  accountingController.getOverview
)

router.get(
  '/trial-balance',
  authorization,
  requireRole('super_admin', 'admin'),
  validateStoreAccess,
  accountingController.getTrialBalance
)
router.get(
  '/income-statement',
  authorization,
  requireRole('super_admin', 'admin'),
  validateStoreAccess,
  accountingController.getIncomeStatement
)
router.get(
  '/balance-sheet',
  authorization,
  requireRole('super_admin', 'admin'),
  validateStoreAccess,
  accountingController.getBalanceSheet
)

module.exports = router
