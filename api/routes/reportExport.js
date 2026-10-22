'use strict'
const express = require('express')
const router = express.Router()
const reportExportController = require('../controller/reportExport')
const authorization = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { createUserEndpointLimiter } = require('../../utils/rateLimiters')

const reportExportLimiter = createUserEndpointLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20
})

router.get(
  '/export/:key',
  authorization,
  validateStoreAccess,
  reportExportLimiter,
  reportExportController.exportOne
)
router.get(
  '/data/:key',
  authorization,
  validateStoreAccess,
  reportExportLimiter,
  reportExportController.reportData
)

module.exports = router
