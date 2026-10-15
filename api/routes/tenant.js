'use strict'

const express = require('express')
const authorization = require('../../utils/authorization')
const { requireCanonicalPermission } = require('../../utils/authorization')
const { authorizationContextMiddleware } = require('../../utils/authorizationContextMiddleware')
const controller = require('../controller/tenant')

const router = express.Router()

// Platform tenant administration: identity → server-side context →
// tenant.manage (held only by platform actors). No legacy requireRole.
const gate = [authorization, authorizationContextMiddleware, requireCanonicalPermission('tenant.manage')]

router.get('/', ...gate, controller.list)
router.get('/:id', ...gate, controller.getById)
router.post('/', ...gate, controller.create)
router.patch('/:id', ...gate, controller.update)

module.exports = router
