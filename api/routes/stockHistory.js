const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('stockHistory.js'))
const stockHistoryController = require('../controller/stockHistory')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')

router.get(
  '/get-all',
  authorization,
  validateStoreAccess,
  stockHistoryController.getAll
)
router.get(
  '/get-by-product/:productId',
  authorization,
  validateStoreAccess,
  stockHistoryController.getByProduct
)
router.get(
  '/low-stock',
  authorization,
  validateStoreAccess,
  stockHistoryController.getLowStock
)
router.get(
  '/low-stock-all',
  authorization,
  requireRole('super_admin', 'admin'),
  validateStoreAccess,
  stockHistoryController.getLowStockAll
)
router.post(
  '/auto-generate-po',
  authorization,
  requireRole('super_admin', 'admin'),
  validateStoreAccess,
  stockHistoryController.autoGeneratePOFromLowStock
)

module.exports = router
