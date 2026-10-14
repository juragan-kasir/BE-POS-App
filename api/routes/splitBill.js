const express = require('express')
const router = express.Router()
const splitBillController = require('../controller/splitBill')
const authorization = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { requireCapability } = require('../../utils/financialCapabilities')
const { validate } = require('../middleware/validate')
const { createSplitBillSchema } = require('../validation/schemas')

router.post(
  '/create',
  authorization,
  validateStoreAccess,
  requireCapability('split.manage', { entity: 'split_bill' }),
  validate(createSplitBillSchema),
  splitBillController.create
)
router.get(
  '/get-by-order/:orderId',
  authorization,
  validateStoreAccess,
  splitBillController.getByOrder
)
router.put(
  '/pay/:id',
  authorization,
  validateStoreAccess,
  requireCapability('payment.collect', { entity: 'split_bill', entityIdFrom: (req) => req.params.id }),
  splitBillController.pay
)
router.delete(
  '/cancel/:id',
  authorization,
  validateStoreAccess,
  requireCapability('split.manage', { entity: 'split_bill', entityIdFrom: (req) => req.params.id }),
  splitBillController.cancel
)
router.post(
  '/merge',
  authorization,
  validateStoreAccess,
  requireCapability('split.manage', { entity: 'split_bill' }),
  splitBillController.merge
)

module.exports = router
