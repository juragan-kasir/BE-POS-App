'use strict'

const express = require('express')
const authorization = require('../../utils/authorization')
const { authorizationContextMiddleware } = require('../../utils/authorizationContextMiddleware')
const { requireTenantOnboarding } = require('../service/tenantOnboarding')
const { validate } = require('../middleware/validate')
const { onboardingTenantSchema } = require('../validation/schemas')
const controller = require('../controller/onboarding')
const db = require('../../db/models')

const router = express.Router()

router.post(
  '/tenants',
  authorization,
  authorizationContextMiddleware,
  requireTenantOnboarding(db),
  validate(onboardingTenantSchema),
  controller.createTenant
)

module.exports = router