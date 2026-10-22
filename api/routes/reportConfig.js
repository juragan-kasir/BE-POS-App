'use strict'
const express = require('express')
const { menuWriteGate } = require('../../utils/menuWriteGate')
const router = express.Router()

// Role Management checkboxes guard the writes (api/menuRouteMap.js)
router.use(menuWriteGate('reportConfig.js'))
const reportConfigController = require('../controller/reportConfig')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')

router.get('/', authorization, reportConfigController.listConfigs)
router.get('/meta', authorization, reportConfigController.getMeta)
router.get('/:key', authorization, reportConfigController.getConfig)
// report_config has no store column — it's a single set of rows shared
// by every store/tenant in the deployment (report layout/branding/
// column selection). Previously any authenticated role (including the
// lowest-privileged ones) could overwrite it for everyone; writes are
// now restricted the same way every other admin-level settings endpoint
// in this codebase already is.
router.put(
  '/:key',
  authorization,
  requireRole('super_admin', 'admin'),
  reportConfigController.upsertConfig
)

module.exports = router