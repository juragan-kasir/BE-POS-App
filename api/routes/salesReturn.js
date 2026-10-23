const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('salesReturn.js'))
const salesReturnController = require('../controller/salesReturn')
const authorization = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { requireCapability } = require('../../utils/financialCapabilities')
const { validate } = require('../middleware/validate')
const {
  salesReturnIdParamsSchema,
  approveSalesReturnSchema
} = require('../validation/schemas')

router.get(
  '/get-all',
  authorization,
  validateStoreAccess,
  salesReturnController.getAll
)

router.get(
  '/get-by-id/:id',
  authorization,
  validateStoreAccess,
  salesReturnController.getById
)

router.patch(
  '/approve/:id',
  authorization,
  validateStoreAccess,
  requireCapability('refund.approve', { entity: 'sales_return', entityIdFrom: (req) => req.params.id }),
  validate(salesReturnIdParamsSchema, 'params'),
  validate(approveSalesReturnSchema),
  salesReturnController.approve
)

router.patch(
  '/reject/:id',
  authorization,
  validateStoreAccess,
  requireCapability('refund.approve', { entity: 'sales_return', entityIdFrom: (req) => req.params.id }),
  validate(salesReturnIdParamsSchema, 'params'),
  salesReturnController.reject
)

module.exports = router
