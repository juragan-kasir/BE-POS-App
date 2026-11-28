'use strict'

const express = require('express')
const router = express.Router()
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const bakery = require('../controller/bakery')
const {
  createBakeryOrderSchema,
  updateBakeryStatusSchema,
  addBakeryPaymentSchema,
  cancelBakeryOrderSchema,
  bakerySettingsSchema,
  bakeryStoreSchema
} = require('../validation/schemas')

router.get('/context', authorization, bakery.getContext)
router.get('/settings', authorization, validateStoreAccess, bakery.getSettings)
router.patch('/settings', authorization, validateStoreAccess, requireRole('super_admin', 'admin', 'owner'), validate(bakerySettingsSchema), bakery.updateSettings)
router.get('/stores', authorization, bakery.listStores)
router.post('/stores', authorization, requireRole('super_admin', 'admin', 'owner'), validate(bakeryStoreSchema), bakery.createStore)
router.patch('/stores/:id', authorization, requireRole('super_admin', 'admin', 'owner'), validate(bakeryStoreSchema), bakery.updateStore)
router.get('/members', authorization, validateStoreAccess, bakery.listMembers)
router.get('/products', authorization, validateStoreAccess, bakery.listProducts)

router.get('/orders', authorization, validateStoreAccess, bakery.listOrders)
router.post('/orders', authorization, validateStoreAccess, validate(createBakeryOrderSchema), bakery.createOrder)
router.get('/orders/:id', authorization, validateStoreAccess, bakery.getOrder)
router.patch('/orders/:id/status', authorization, validateStoreAccess, validate(updateBakeryStatusSchema), bakery.updateStatus)
router.post('/orders/:id/payments', authorization, validateStoreAccess, validate(addBakeryPaymentSchema), bakery.addPayment)
router.post('/orders/:id/cancel', authorization, validateStoreAccess, validate(cancelBakeryOrderSchema), bakery.cancelOrder)
router.get('/orders/:id/wa-text', authorization, validateStoreAccess, bakery.waText)
router.get('/calendar', authorization, validateStoreAccess, bakery.calendar)
router.get('/dashboard', authorization, validateStoreAccess, bakery.dashboard)
router.get('/production-plan', authorization, validateStoreAccess, bakery.productionPlan)

module.exports = router
