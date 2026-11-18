'use strict'

// Who may create an outlet (POST /location/add-new-location).
//
// AUTHZ_OWNER_V2 off: exactly the existing gate (requireStoreCreator — the
// legacy super_admin path + the PR #361 first-outlet owner).
// AUTHZ_OWNER_V2 on: a canonical `outlet.create` holder (owner of the session's
// active tenant, or a platform actor) is admitted from the server-resolved
// context — the target tenant is the SESSION's active tenant, never request
// input, and the check runs before multipart parsing because it needs none.
// Anyone else falls back to the legacy gate unchanged (decision K2: the
// bridge stays until the backfill), so existing client owners keep working.
const db = require('../db/models')
const { resolveAuthorizationContext, can } = require('./authContext')
const { requireStoreCreator } = require('./firstOutletOwner')
const { isOwnerV2Enabled } = require('./ownerRoles')

const resolveSessionContext = (req) => {
  const session = req.authSession
  return resolveAuthorizationContext(db, {
    userId: req.user?.id,
    activeTenantId: session?.activeTenantId,
    activeStoreId: session?.activeStoreId,
    account: session?.user,
    authenticatedAt: session?.createdAt
  })
}

const canCreateOutlet = (ctx) => {
  if (!ctx || ctx.eligible !== true) return false
  if (ctx.activeTenantId != null) return can(ctx, 'outlet.create', { tenantId: ctx.activeTenantId })
  // Tenant-less: only a platform actor (it names the target tenant in the
  // body, which the lifecycle check validates — TARGET_TENANT_REQUIRED).
  return ctx.isPlatformAdmin === true && can(ctx, 'outlet.create', {})
}

const requireOutletCreator = (req, res, next) => {
  if (!isOwnerV2Enabled()) return requireStoreCreator(req, res, next)
  return resolveSessionContext(req)
    .then((ctx) => {
      if (canCreateOutlet(ctx)) {
        req.authContext = ctx
        req.canonicalOutletCreator = true
        return next()
      }
      return requireStoreCreator(req, res, next)
    })
    .catch(next)
}

module.exports = { requireOutletCreator, canCreateOutlet }
