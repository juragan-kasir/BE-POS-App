'use strict'
const express = require('express')
const router = express.Router()
const reportExportController = require('../controller/reportExport')
const authorization = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')

router.get('/export/:key', authorization, validateStoreAccess, reportExportController.exportOne)
router.get('/data/:key', authorization, validateStoreAccess, reportExportController.reportData)

module.exports = router
