'use strict'

const db = require('../../db/models')
const { createTenantWithOwner } = require('../service/tenantOwnershipService')
const {
  normalizeTenantCode,
  normalizeTenantName,
  normalizeBusinessType
} = require('../service/tenantIdentity')

const fail = (status, code, field, message) => ({ status, body: { success: false, code, field, message } })

exports.createTenant = async (req, res) => {
  const body = req.body || {}
  const code = normalizeTenantCode(body.code)
  if (code == null) {
    return res.status(400).json(fail(400, 'INVALID_CODE', 'code', 'code must be 1-50 lowercase letters, digits or inner hyphens').body)
  }
  const name = normalizeTenantName(body.name)
  if (name == null) {
    return res.status(400).json(fail(400, 'INVALID_NAME', 'name', 'name is required (max 150 characters)').body)
  }
  const businessType = normalizeBusinessType(body.businessType)
  if (businessType == null) {
    return res.status(400).json(fail(400, 'INVALID_BUSINESS_TYPE', 'businessType', 'businessType must be fnb, retail, laundry or salon').body)
  }

  try {
    const { tenant } = await createTenantWithOwner(db, {
      userId: req.user.id,
      code,
      name,
      businessType,
      req,
      sessionId: req.authSession?.sessionId
    })
    return res.status(201).json({
      success: true,
      message: 'Tenant created',
      data: {
        id: tenant.id,
        code: tenant.code,
        name: tenant.name,
        businessType: tenant.businessType,
        ownerId: tenant.ownerId
      }
    })
  } catch (err) {
    if (err.code === 'TENANT_CODE_TAKEN') {
      return res.status(409).json({ success: false, code: 'TENANT_CODE_TAKEN', field: 'code', message: err.message })
    }
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ success: false, code: 'TENANT_CODE_TAKEN', field: 'code', message: 'this tenant code is already used' })
    }
    console.error('[onboarding] create tenant failed:', err)
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Internal Server Error' })
  }
}