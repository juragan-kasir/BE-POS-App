'use strict'

// Bakery & catering pre-order API (FE-BAKERY-App, contract /bakery/*).
// Every handler goes through controller/bakery.js bakeryRoute(): bakery
// tenant + outlet resolved from the session and a bakery permission from
// utils/bakeryCapabilities.js.
const express = require('express')
const router = express.Router()
const authorization = require('../../utils/authorization')
const bakery = require('../controller/bakery')

router.use(authorization)

router.get('/context', bakery.getContext)
router.patch('/settings', bakery.updateSettings)
router.post('/stores', bakery.createStore)
router.patch('/stores/:id', bakery.updateStore)

router.get('/members', bakery.listMembers)
router.get('/products', bakery.listProducts)

router.get('/orders', bakery.listOrders)
router.post('/orders', bakery.createOrder)
router.get('/orders/:id', bakery.getOrder)
router.patch('/orders/:id/status', bakery.updateStatus)
router.post('/orders/:id/payments', bakery.addPayment)
router.post('/orders/:id/cancel', bakery.cancelOrder)
router.get('/orders/:id/wa-text', bakery.waText)

router.get('/calendar', bakery.calendar)
router.get('/production-plan', bakery.productionPlan)
router.get('/dashboard', bakery.dashboard)

module.exports = router
