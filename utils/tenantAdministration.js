'use strict'

// Who may use /tenants, and over which tenants.
//
// - A platform actor (tenant.manage) administers every tenant.
// - A store-bound super_admin holding an ACTIVE tenant_admin membership — a
//   client's own super admin, e.g. bakso_admin — administers only the tenants
//   it is tenant_admin of: list, create (it becomes tenant_admin of the new
//   tenant), rename and delete-when-empty. Suspend/resume stays platform-only.
// - Everyone else (including a plain admin that is tenant_admin) administers
//   nothing here.
//
// Decided from the server-resolved authorization context only.
const tenantAdministrationScope = (ctx, user) => {
  if (!ctx || ctx.eligible !== true) return null
  if (Array.isArray(ctx.permissions) && ctx.permissions.includes('tenant.manage')) {
    return { all: true, tenantIds: [] }
  }
  if (user?.roleType !== 'super_admin') return null
  const effective = new Set((ctx.effectiveTenantIds || []).map(Number))
  const tenantIds = (ctx.memberships || [])
    .filter((m) => m.role === 'tenant_admin' && m.status === 'ACTIVE' && effective.has(Number(m.tenantId)))
    .map((m) => Number(m.tenantId))
  return tenantIds.length > 0 ? { all: false, tenantIds } : null
}

// Mounted after `authorization` + `authorizationContextMiddleware`.
const requireTenantAdministration = (req, res, next) => {
  const scope = tenantAdministrationScope(req.authContext, req.user)
  if (!scope) {
    return res.status(403).json({ message: 'Akses Ditolak - Anda tidak memiliki izin', code: 'FORBIDDEN' })
  }
  req.tenantAdministration = scope
  return next()
}

module.exports = { tenantAdministrationScope, requireTenantAdministration }
