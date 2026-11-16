'use strict'

// Owner onboarding without an outlet (2026-11-16, owner request for the
// laundry client): a new client owner starts as a tenant_admin of their own
// tenant with NO outlet. The account is `roleType: 'admin'` with
// `store: null` — never `super_admin` + `store: null`, which the legacy rule
// treats as the global platform admin (utils/authContext
// legacySuperAdminScopeOf) and would expose every tenant. A store-less admin
// is fail-closed everywhere else ("Store assignment required", store -1
// scopes), so before the first outlet the owner sees nothing.
//
// The only thing such an owner may do is create the first outlet of their
// tenant. Creating it binds the account to that outlet and makes it the
// standard client owner (store-bound super_admin + tenant_admin, the same
// shape the onboarding flow produced before), so every existing route keeps
// working unchanged afterwards.
const db = require('../db/models')
const { resolveAuthorizationContext } = require('./authContext')
const { validateStoreAccess } = require('./storeValidation')
const { requireRole } = require('./authorization')

const isStorelessAdmin = (user) => user?.roleType === 'admin' && user.store == null

// Server-derived context only (never body/JWT): the caller must be an
// effective tenant_admin of exactly the active tenant, and not a platform actor.
const resolveFirstOutletOwner = async (req) => {
  if (!isStorelessAdmin(req.user)) return null
  const session = req.authSession
  const ctx = await resolveAuthorizationContext(db, {
    userId: req.user.id,
    activeTenantId: session?.activeTenantId,
    activeStoreId: session?.activeStoreId,
    authenticatedAt: session?.createdAt
  })
  if (
    ctx?.eligible === true &&
    ctx.isPlatformAdmin !== true &&
    ctx.activeRole === 'tenant_admin' &&
    ctx.activeTenantId != null
  ) {
    return ctx
  }
  return null
}

// Route gate for creating an outlet: a store-less tenant_admin owner, or the
// historical path (validateStoreAccess + super_admin) for everyone else.
const requireStoreCreator = (req, res, next) => {
  if (!isStorelessAdmin(req.user)) {
    return validateStoreAccess(req, res, (err) => {
      if (err) return next(err)
      return requireRole('super_admin')(req, res, next)
    })
  }
  return resolveFirstOutletOwner(req)
    .then((ctx) => {
      if (!ctx) {
        return res.status(403).json({ message: 'Akses Ditolak - Anda tidak memiliki izin' })
      }
      req.firstOutletOwner = { tenantId: Number(ctx.activeTenantId) }
      return next()
    })
    .catch(next)
}

// Binds the owner to the outlet just created. Conditional on the account
// still being store-less, so two concurrent first-outlet requests bind once.
const bindFirstOutlet = async ({ userId, storeId, transaction } = {}) => {
  const role = await db.role.findOne({
    where: { roleType: 'super_admin', store: null },
    order: [['id', 'ASC']],
    attributes: ['id'],
    transaction
  })
  const [count] = await db.user.update(
    { store: storeId, roleType: 'super_admin', ...(role ? { roleId: role.id } : {}) },
    { where: { id: userId, roleType: 'admin', store: null }, transaction }
  )
  return count === 1
}

module.exports = { isStorelessAdmin, resolveFirstOutletOwner, requireStoreCreator, bindFirstOutlet }
