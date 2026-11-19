'use strict'

// W3-z / Z1 (BE audit README): every operational outlet in production belongs
// to a tenant (location.tenantId), and Z3 makes the database enforce that a
// row owned by an outlet carries its tenant. Test fixtures used to create
// tenant-less outlets (≈300 files), which production can no longer produce
// for an active outlet.
//
// withTestTenant() puts a fixture outlet in the test file's own tenant: one
// tenant per test file (jest gives every file a fresh module registry). That
// keeps the old semantics — all fixture outlets of a file shared the same
// (NULL) tenant, so multi-outlet flows inside one business keep working —
// while files never share a tenant with each other. A test that needs
// separate tenants, or a draft outlet without one, passes `tenantId` itself
// (a tenant id, or null) and the attributes are returned unchanged.
let fileTenantId = null
let pending = null

const fileTenant = async () => {
  if (fileTenantId != null) return fileTenantId
  if (!pending) {
    // Required lazily: test files set NODE_ENV before loading db/models.
    const db = require('../db/models')
    const code = `fx-${process.pid}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
    pending = db.tenant
      .create({ code, name: `Fixture tenant ${code}`, status: 'active' })
      .then((tenant) => {
        fileTenantId = tenant.id
        return fileTenantId
      })
      .finally(() => {
        pending = null
      })
  }
  return pending
}

const withTestTenant = async (attrs = {}) => {
  if (attrs && Object.prototype.hasOwnProperty.call(attrs, 'tenantId')) return attrs
  return { ...attrs, tenantId: await fileTenant() }
}

module.exports = { withTestTenant, fileTenant }
