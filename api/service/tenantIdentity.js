'use strict'

const CODE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/
const NAME_MAX = 150
const BUSINESS_TYPES = Object.freeze(['fnb', 'retail', 'laundry', 'salon'])

const normalizeTenantCode = (value) => {
  if (typeof value !== 'string') return null
  const code = value.trim().toLowerCase()
  return CODE_PATTERN.test(code) ? code : null
}

const normalizeTenantName = (value) => {
  if (typeof value !== 'string') return null
  const name = value.trim().replace(/\s+/g, ' ')
  return name && name.length <= NAME_MAX ? name : null
}

const normalizeBusinessType = (value) => {
  if (value == null) return 'fnb'
  const type = String(value).trim().toLowerCase()
  return BUSINESS_TYPES.includes(type) ? type : null
}

module.exports = { BUSINESS_TYPES, normalizeTenantCode, normalizeTenantName, normalizeBusinessType }