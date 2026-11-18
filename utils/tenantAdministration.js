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
const { canonicalRoleOf, isOwnerV2Enabled } = require('./ownerRoles')

const tenantAdministrationScope = (ctx, user) => {
  if (!ctx || ctx.eligible !== true) return null
  if (isOwnerV2Enabled()) return canonicalTenantAdministrationScope(ctx, user)
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

// AUTHZ_OWNER_V2: decided by the platform grant and canonical ownership only —
// never by user.roleType and never by a tenant permission (BE audit P0-1).
// Platform: every tenant. A V2 `owner` membership: only the effective tenants
// it owns. The legacy `tenant_admin` alias keeps its legacy rule until the
// backfill converts it (decision K1): only a store-bound super_admin (a
// client's own super admin, e.g. bakso_admin) administers its tenants.
// Everyone else: nothing.
const administersAsOwner = (membership, user) =>
  membership.role === 'owner' ||
  (canonicalRoleOf(membership.role) === 'owner' && user?.roleType === 'super_admin')

const canonicalTenantAdministrationScope = (ctx, user) => {
  if (ctx.isPlatformAdmin === true) return { all: true, tenantIds: [] }
  const effective = new Set((ctx.effectiveTenantIds || []).map(Number))
  const tenantIds = (ctx.memberships || [])
    .filter((m) => m.status === 'ACTIVE' && administersAsOwner(m, user) && effective.has(Number(m.tenantId)))
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
