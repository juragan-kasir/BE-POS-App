'use strict'

// Salon & barbershop API (SALON-BARBERSHOP-PLAN §3.2). Every handler goes
// through controller/salon/http.js salonRoute(), which resolves the salon
// tenant + outlet from the session and checks the salon permission.
const express = require('express')
const router = express.Router()
const authorization = require('../../utils/authorization')
const context = require('../controller/salon/context')

router.use(authorization)

router.get('/context', context.getContext)

module.exports = router
