'use strict'

const express = require('express')
const router = express.Router()
const authorization = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const laundry = require('../controller/laundry')
const {
  createLaundryTurnaroundSchema,
  updateLaundryTurnaroundSchema,
  laundryQuoteSchema,
  createLaundryOrderSchema,
  updateLaundryStatusSchema,
  laundryPickupSchema,
  cancelLaundryOrderSchema
} = require('../validation/schemas')

router.get('/turnaround', authorization, validateStoreAccess, laundry.listTurnarounds)
router.post('/turnaround', authorization, validateStoreAccess, validate(createLaundryTurnaroundSchema), laundry.createTurnaround)
router.put('/turnaround/:id', authorization, validateStoreAccess, validate(updateLaundryTurnaroundSchema), laundry.updateTurnaround)
router.delete('/turnaround/:id', authorization, validateStoreAccess, laundry.deleteTurnaround)

router.post('/quote', authorization, validateStoreAccess, validate(laundryQuoteSchema), laundry.quote)
router.post('/order', authorization, validateStoreAccess, validate(createLaundryOrderSchema), laundry.createOrder)
router.get('/order', authorization, validateStoreAccess, laundry.listOrders)
router.get('/order/:id', authorization, validateStoreAccess, laundry.getOrder)
router.patch('/order/:id/status', authorization, validateStoreAccess, validate(updateLaundryStatusSchema), laundry.updateStatus)
router.post('/order/:id/pickup', authorization, validateStoreAccess, validate(laundryPickupSchema), laundry.pickup)
router.post('/order/:id/cancel', authorization, validateStoreAccess, validate(cancelLaundryOrderSchema), laundry.cancelOrder)
router.get('/order/:id/wa-text', authorization, validateStoreAccess, laundry.waText)

module.exports = router
