const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('inventory.js'))
const inventoryController = require('../controller/inventory')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')

// Forecast & stockout prediction
router.get(
  '/forecast',
  authorization,
  validateStoreAccess,
  inventoryController.getForecasts
)
router.post(
  '/forecast/run',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  inventoryController.runForecast
)

// Dead stock detection
router.get(
  '/dead-stock',
  authorization,
  validateStoreAccess,
  inventoryController.getDeadStock
)

// Expiring soon alerts
router.get(
  '/expiring-soon',
  authorization,
  validateStoreAccess,
  inventoryController.getExpiringSoon
)

// COGS / valuation
router.get(
  '/valuation',
  authorization,
  validateStoreAccess,
  inventoryController.getValuation
)

// Supplier performance (PO/GR based)
router.get(
  '/supplier-performance',
  authorization,
  validateStoreAccess,
  inventoryController.getSupplierPerformance
)

// Batch management
router.get(
  '/batch',
  authorization,
  validateStoreAccess,
  inventoryController.getBatches
)
router.get(
  '/batch/:id',
  authorization,
  validateStoreAccess,
  inventoryController.getBatchById
)
router.post(
  '/batch/writeoff',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  inventoryController.postWriteOffExpired
)

// Stock reconciliation (global vs per-store)
router.get(
  '/reconcile',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  inventoryController.getReconcile
)
router.post(
  '/reconcile/fix',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  inventoryController.postReconcile
)

module.exports = router
