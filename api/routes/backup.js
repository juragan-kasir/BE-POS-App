const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('backup.js'))
const backupController = require('../controller/backup')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { createUserEndpointLimiter } = require('../../utils/rateLimiters')

const backupTransferLimiter = createUserEndpointLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5
})

router.get(
  '/schedule',
  authorization,
  requireRole('super_admin'),
  backupController.getSchedule
)
router.put(
  '/schedule',
  authorization,
  requireRole('super_admin'),
  backupController.setSchedule
)
router.post(
  '/create',
  authorization,
  validateStoreAccess,
  requireRole('super_admin'),
  backupController.createBackup
)
router.get(
  '/list',
  authorization,
  validateStoreAccess,
  requireRole('super_admin'),
  backupController.listBackups
)
router.get(
  '/download/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin'),
  backupTransferLimiter,
  backupController.downloadBackup
)
router.post(
  '/restore/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin'),
  backupTransferLimiter,
  backupController.restoreBackup
)
router.delete(
  '/delete/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin'),
  backupController.deleteBackup
)

module.exports = router
