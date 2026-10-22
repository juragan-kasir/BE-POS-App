'use strict'

const express = require('express')
const authorization = require('../../utils/authorization')
const { authorizationContextMiddleware } = require('../../utils/authorizationContextMiddleware')
const { requireTenantAdministration } = require('../../utils/tenantAdministration')
const controller = require('../controller/tenant')

const router = express.Router()

// Tenant administration: identity → server-side context → tenant
// administration scope (every tenant for a platform actor, its own tenants
// for a store-bound super_admin that is tenant_admin; utils/tenantAdministration).
// No legacy requireRole.
const gate = [authorization, authorizationContextMiddleware, requireTenantAdministration]

router.get('/', ...gate, controller.list)
router.get('/:id', ...gate, controller.getById)
router.post('/', ...gate, controller.create)
router.patch('/:id', ...gate, controller.update)
router.delete('/:id', ...gate, controller.remove)

module.exports = router
