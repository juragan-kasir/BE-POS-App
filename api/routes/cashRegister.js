const express = require('express')
const router = express.Router()
const cashRegisterController = require('../controller/cashRegister')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const {
  createCashRegisterSchema,
  updateCashRegisterSchema,
  createCashMovementSchema,
  decideCashMovementSchema,
  reverseCashMovementSchema,
  decideVarianceSchema
} = require('../validation/schemas')

router.post(
  '/open',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(createCashRegisterSchema),
  cashRegisterController.open
)
router.put(
  '/close/:id',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(updateCashRegisterSchema),
  cashRegisterController.close
)
router.get(
  '/current',
  authorization,
  validateStoreAccess,
  cashRegisterController.getCurrent
)
router.get(
  '/table-reset-preview',
  authorization,
  validateStoreAccess,
  cashRegisterController.getTableResetPreview
)
router.get(
  '/open-registers',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  cashRegisterController.getOpenRegisters
)
router.get(
  '/history',
  authorization,
  validateStoreAccess,
  cashRegisterController.getHistory
)
router.get(
  '/x-report',
  authorization,
  validateStoreAccess,
  cashRegisterController.getXReport
)
router.get(
  '/z-report/:id',
  authorization,
  validateStoreAccess,
  cashRegisterController.getZReport
)

// ===================== Cash Movement (F2) =====================
router.get(
  '/:id/movements',
  authorization,
  validateStoreAccess,
  cashRegisterController.listMovements
)
router.post(
  '/:id/movement',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(createCashMovementSchema),
  cashRegisterController.createMovement
)
router.post(
  '/movement/:id/decide',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(decideCashMovementSchema),
  cashRegisterController.decideMovement
)
router.post(
  '/movement/:id/reverse',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  validate(reverseCashMovementSchema),
  cashRegisterController.reverseMovement
)
router.put(
  '/:id/decide-variance',
  authorization,
  validateStoreAccess,
  requireRole('super_admin'),
  validate(decideVarianceSchema),
  cashRegisterController.decideVariance
)

module.exports = router
