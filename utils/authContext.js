'use strict'

// AUTH-1 (DR-01/DR-02/DR-12): canonical server-side authorization layer.
//
// Single coherent model — do NOT scatter `if (role === ...)` checks through
// controllers; resolve a context once via resolveAuthorizationContext() and
// decide via can(). Everything here is derived from persisted state (user,
// tenant_membership, store_assignment, location.tenantId) on every call, so
// stale/forged JWT claims can never escalate: the token only identifies the
// account (userId), never its authority.
//
// Chain: Authentication → Account eligibility → Tenant membership → Role →
// Permission → Store assignment → Resource ownership → ALLOW / DENY.
// Client-supplied tenant/store IDs are context *candidates*: the resolver
// validates them against persisted relationships and drops anything foreign.
//
// REQUEST CONTEXT CONTRACT — NOT YET DEFINED: no JWT claim, header, cookie or
// middleware supplies activeTenantId/activeStoreId today (the JWT carries only
// the legacy {id, roleType, roleId, store}). Callers may pass request values
// here ONLY as candidates; never treat them, or anything not returned in the
// resolved ctx, as authoritative. Defining that request source is a separate
// product/API decision (DR-12 Q19, DR-03 Q8), deliberately not invented here.

const TARGET_ROLES = Object.freeze([
  'platform_admin',
  'tenant_admin',
  'store_admin',
  'cashier',
  'staff'
])

// DR-03 membership lifecycle vocabulary (exact).
const MEMBERSHIP_STATUS = Object.freeze(['ACTIVE', 'DEACTIVATED', 'RETIRED'])

// Legacy → target mapping. `admin` is AMBIGUOUS by design: existing `admin`
// rows carry no tenant/store-wide marker, so the fail-safe default is the
// NARROWER store_admin scope. Tenant-wide authority requires an explicit
// tenant_admin membership — it is never inferred from the legacy string.
// `super_admin` stays as a compatibility alias for platform_admin, but the
// resolver applies it ONLY to a global account (see legacySuperAdminScopeOf).
const LEGACY_ROLE_MAP = Object.freeze({
  super_admin: 'platform_admin',
  admin: 'store_admin',
  kasir: 'cashier',
  user: 'staff'
})

const legacyRoleTypeToTarget = (roleType) =>
  LEGACY_ROLE_MAP[roleType] || 'staff'

// Minimum coherent permission vocabulary (DR-12). Role baselines only;
// tenant-scoped custom roles are a documented future stage, not this task.
// platform_admin is NOT a bypass: it holds an explicit baseline like every
// other role, and cross-tenant reach applies only where the capability is
// platform-authorized (tenant.manage, backup.manage) or where visibility is
// explicitly platform-wide (audit.read with a tenant scope).
const PERMISSIONS = Object.freeze([
  'audit.read',
  'user.manage',
  'role.manage',
  'store.manage',
  'tenant.manage',
  'backup.manage'
])

const ROLE_BASELINE_PERMISSIONS = Object.freeze({
  platform_admin: [...PERMISSIONS],
  tenant_admin: ['audit.read', 'user.manage', 'role.manage', 'store.manage'],
  store_admin: ['audit.read'],
  cashier: [],
  staff: []
})

// AUTH-1 P2: account eligibility is enablement only — `disabledAt` and
// `deletedAt` both NULL. Presence `status` (written by login/logout) is not
// authorization authority.
const isAccountEligible = (account) => account.disabledAt == null && account.deletedAt == null

// Strict positive-integer id: numbers or canonical digit strings only.
// Arrays/objects/partial numerics never coerce into an id (Number([5]) === 5).
const toId = (value) => {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? value : null
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const n = Number(value)
    return Number.isSafeInteger(n) ? n : null
  }
  return null
}

// Store-level confinement: these roles may only act within explicitly
// assigned stores. tenant_admin acts tenant-wide (assignment not required);
// platform_admin acts under platform capability.
const STORE_CONFINED_ROLES = Object.freeze(['store_admin', 'cashier', 'staff'])

// Legacy super_admin has two existing variants, told apart by the account's
// persisted `user.store` (the same value the JWT `store` claim is issued
// from): null = global, set = store-bound. This is the repository's existing
// rule (backup.js CRIT-3 canAccessBackupArtifact / MED-2
// requireGlobalSuperAdmin; BA §35.2 AS-IS), not a new meaning. Only the
// global variant keeps the platform compatibility alias; a store-bound
// super_admin gets NO legacy authority here (its tenant/store classification
// is an open DR-02 migration decision) and is governed solely by explicit
// memberships/assignments — fail closed, never widened to platform.
const legacySuperAdminScopeOf = (account) => {
  if (account.roleType !== 'super_admin') return null
  return account.store == null ? 'global' : 'store-bound'
}

// `account` (optional): the caller's account row already loaded by canonical
// authentication for this request; reused instead of a second read when it
// is the same account.
// `transaction` (optional): a caller's open Sequelize transaction; every read
// below runs inside it (same connection, sees its uncommitted writes). The
// resolver never opens a transaction or takes locks itself; omitted, reads
// run exactly as before.
// `authenticatedAt` (optional, T-03B DR-03 Q8): the resolving session's
// DB-clock authentication instant. A membership reactivated after it
// (`reactivatedAt > authenticatedAt`) is NOT effective for that session: an
// old session never regains authority from a reactivation alone. Omitted,
// no freshness constraint applies (non-session callers keep their semantics).
const resolveAuthorizationContext = async (
  db,
  { userId, activeTenantId, activeStoreId, account: loadedAccount, transaction, authenticatedAt } = {}
) => {
  const ctx = {
    accountId: toId(userId),
    accountStatus: null,
    eligible: false,
    memberships: [],
    effectiveTenantIds: [],
    activeTenantId: null,
    activeRole: null,
    permissions: [],
    assignedStoreIds: [],
    tenantStoreIds: [],
    activeStoreId: null,
    isPlatformAdmin: false,
    viaLegacyClaims: false,
    legacySuperAdminScope: null,
    reason: null
  }

  if (!ctx.accountId) {
    ctx.reason = 'unknown-account'
    return ctx
  }

  const account =
    loadedAccount && Number(loadedAccount.id) === ctx.accountId
      ? loadedAccount
      : await db.user.findByPk(ctx.accountId, {
          attributes: ['id', 'status', 'roleType', 'store', 'disabledAt', 'deletedAt'],
          transaction
        })
  if (!account) {
    ctx.reason = 'unknown-account'
    return ctx
  }
  ctx.accountStatus = account.status ?? null
  // A disabled or soft-deleted account establishes no canonical context,
  // matching the login gate and canonical authentication.
  if (!isAccountEligible(account)) {
    ctx.reason = 'ineligible-account'
    return ctx
  }
  ctx.eligible = true

  ctx.legacySuperAdminScope = legacySuperAdminScopeOf(account)
  const legacyIsPlatform = ctx.legacySuperAdminScope === 'global'

  const memberships = await db.tenantMembership.findAll({
    where: { userId: ctx.accountId },
    include: [
      {
        model: db.tenant,
        as: 'tenant',
        attributes: ['id', 'status', 'deletedAt'],
        required: false
      }
    ],
    transaction
  })
  ctx.memberships = memberships.map((m) => ({
    tenantId: m.tenantId,
    role: m.role,
    status: m.status
  }))

  // Effective = ACTIVE membership, with a role in the target vocabulary, on
  // a tenant that explicitly exists, is not soft-deleted and is 'active'.
  // Validated field by field — never inferred from how the ORM join happens
  // to resolve a deleted tenant (null include) — and never trusting the
  // model's isIn validator (bulkCreate/raw writes skip it). Fail closed.
  // With `authenticatedAt`, a membership reactivated after the session
  // authenticated is excluded (an unparseable instant excludes every
  // reactivated membership — fail closed). Both instants are microsecond DB
  // timestamps that arrive here truncated to milliseconds, so an equal
  // millisecond is treated as NOT fresh: a session authenticated strictly
  // before a reactivation can never pass on truncation; the only cost is a
  // sub-millisecond fail-closed window for a login in that same millisecond.
  const authenticatedMs = authenticatedAt == null ? null : new Date(authenticatedAt).getTime()
  const freshForSession = (m) =>
    authenticatedMs == null || m.reactivatedAt == null || new Date(m.reactivatedAt).getTime() < authenticatedMs
  const effective = memberships.filter(
    (m) =>
      m.status === 'ACTIVE' &&
      TARGET_ROLES.includes(m.role) &&
      m.tenant != null &&
      m.tenant.deletedAt == null &&
      m.tenant.status === 'active' &&
      freshForSession(m)
  )
  const effectiveTenantIds = new Set(effective.map((m) => m.tenantId))
  ctx.effectiveTenantIds = [...effectiveTenantIds]

  if (effective.some((m) => m.role === 'platform_admin') || legacyIsPlatform) {
    ctx.isPlatformAdmin = true
  }

  // Active tenant: requested must be effective; unrequested defaults only
  // when the actor has exactly one effective membership (server-derived,
  // never client-invented). Platform actors may also operate tenant-less.
  const requestedTenant = toId(activeTenantId)
  if (requestedTenant != null) {
    if (!effectiveTenantIds.has(requestedTenant)) {
      ctx.reason = 'foreign-or-inactive-tenant'
      return finalizePlatformFallback(ctx, legacyIsPlatform)
    }
    ctx.activeTenantId = requestedTenant
  } else if (effective.length === 1) {
    ctx.activeTenantId = effective[0].tenantId
  } else if (effective.length > 1 && toId(account.store) != null) {
    // Several effective memberships (e.g. a client's super admin that created
    // a second tenant): default to the tenant of the account's own persisted
    // store when it is one of them — still server-derived, never client input.
    const home = await db.location.findByPk(toId(account.store), { attributes: ['id', 'tenantId'], transaction })
    const homeTenantId = toId(home?.tenantId)
    if (homeTenantId != null && effectiveTenantIds.has(homeTenantId)) ctx.activeTenantId = homeTenantId
  }

  const activeMembership = effective.find((m) => m.tenantId === ctx.activeTenantId)
  if (activeMembership) {
    ctx.activeRole = activeMembership.role
    ctx.permissions = [...(ROLE_BASELINE_PERMISSIONS[activeMembership.role] || [])]
  } else if (ctx.isPlatformAdmin) {
    // Platform context without a tenant membership: explicit baseline, and
    // flagged as legacy-derived when it comes from the old roleType string.
    ctx.activeRole = 'platform_admin'
    ctx.permissions = [...ROLE_BASELINE_PERMISSIONS.platform_admin]
    ctx.viaLegacyClaims = legacyIsPlatform && !effective.some((m) => m.role === 'platform_admin')
  }

  // Tenant store roster for scope checks (active tenant only).
  if (ctx.activeTenantId != null) {
    const stores = await db.location.findAll({
      where: { tenantId: ctx.activeTenantId },
      attributes: ['id'],
      transaction
    })
    ctx.tenantStoreIds = stores.map((s) => Number(s.id))
  }

  // Effective assignments: ONLY those recorded under the active (effective)
  // membership AND whose store persistently belongs to the active tenant.
  // Assignments under other memberships never leak into this context, and a
  // tenant-inconsistent row (hook bypassed via bulk/raw writes) is ignored.
  // No active tenant → no assignments (DR-03: deactivation invalidates
  // assignments without deleting them, via the effective-membership gate).
  if (activeMembership) {
    const assignments = await db.storeAssignment.findAll({
      where: { userId: ctx.accountId, tenantId: ctx.activeTenantId },
      attributes: ['storeId', 'tenantId'],
      transaction
    })
    ctx.assignedStoreIds = assignments
      .map((a) => Number(a.storeId))
      .filter((id) => ctx.tenantStoreIds.includes(id))
  }

  // Active store: must belong to the active tenant AND satisfy assignment
  // rules for the active role. Anything foreign → null (denied selection).
  const requestedStore = toId(activeStoreId)
  if (requestedStore != null) {
    const inTenant =
      ctx.activeTenantId != null && ctx.tenantStoreIds.includes(requestedStore)
    const platformWide = ctx.isPlatformAdmin && ctx.activeTenantId == null
    if (!inTenant && !platformWide) {
      ctx.reason = 'foreign-store'
      return ctx
    }
    // Platform-wide selection still has to name a store that exists.
    if (!inTenant && !(await db.location.findByPk(requestedStore, { attributes: ['id'], transaction }))) {
      ctx.reason = 'foreign-store'
      return ctx
    }
    if (
      inTenant &&
      STORE_CONFINED_ROLES.includes(ctx.activeRole) &&
      !ctx.assignedStoreIds.includes(requestedStore)
    ) {
      ctx.reason = 'unassigned-store'
      return ctx
    }
    ctx.activeStoreId = requestedStore
  }

  return ctx
}

// Platform fallback keeps cross-tenant platform capability usable when no
// tenant membership authorizes the request, without granting tenant scope.
const finalizePlatformFallback = (ctx, legacyIsPlatform) => {
  if (ctx.isPlatformAdmin) {
    ctx.activeRole = 'platform_admin'
    ctx.permissions = [...ROLE_BASELINE_PERMISSIONS.platform_admin]
    ctx.viaLegacyClaims = legacyIsPlatform
  }
  return ctx
}

// Pure synchronous decision on a resolved context. Scope is matched against
// server-resolved sets only — caller-supplied IDs outside the context can
// never satisfy it.
const can = (ctx, permission, scope = {}) => {
  if (!ctx || ctx.eligible !== true) return false
  if (!PERMISSIONS.includes(permission)) return false
  if (!ctx.permissions.includes(permission)) return false

  // A scope id that is present but malformed denies — it must never
  // degrade into "unscoped" and skip the tenant/store checks below.
  const tenantId = scope.tenantId != null ? toId(scope.tenantId) : null
  const storeId = scope.storeId != null ? toId(scope.storeId) : null
  if (scope.tenantId != null && tenantId == null) return false
  if (scope.storeId != null && storeId == null) return false

  // Platform capability: platform-level permissions need no tenant scope;
  // scoped reads are allowed cross-tenant (that IS the platform capability),
  // constrained to the active tenant when one is selected.
  if (ctx.isPlatformAdmin) {
    if (permission === 'tenant.manage' || permission === 'backup.manage') return true
    if (tenantId != null && ctx.activeTenantId != null && tenantId !== ctx.activeTenantId) return false
    if (storeId != null && ctx.activeTenantId != null && !ctx.tenantStoreIds.includes(storeId)) return false
    return true
  }

  // Non-platform actors require an effective tenant context for any decision.
  if (ctx.activeTenantId == null) return false
  if (tenantId != null && tenantId !== ctx.activeTenantId) return false
  if (storeId != null && !ctx.tenantStoreIds.includes(storeId)) return false

  // Store-confined roles must name an assigned store for resource decisions —
  // a tenant-wide grant can never flow from a store_admin context.
  if (STORE_CONFINED_ROLES.includes(ctx.activeRole)) {
    if (storeId == null) return false
    if (!ctx.assignedStoreIds.includes(storeId)) return false
  }

  return true
}

// Resource ownership: decide on a concrete persisted object by its OWN
// tenantId/storeId (read from the loaded row — never from request input).
// Same chain as can(), plus: a resource carrying no ownership at all is
// visible only to a platform actor outside any tenant context — an
// unowned row can never fall through as "unscoped" for tenant/store actors.
const canAccessResource = (ctx, permission, resource = {}) => {
  const { tenantId = null, storeId = null } = resource || {}
  if (tenantId == null && storeId == null) {
    if (!ctx || ctx.isPlatformAdmin !== true || ctx.activeTenantId != null) return false
    return can(ctx, permission, {})
  }
  return can(ctx, permission, { tenantId, storeId })
}

// AUD-3 readiness: derive the tenant-aware audit visibility scope from a
// resolved context. storeIds === null means tenant-wide (all stores of
// tenantId — resolve them via ctx.tenantStoreIds, NEVER treat it as
// "unfiltered", since auditLog.tenantId is mostly NULL); a {tenantId: null,
// storeIds: null} result is platform scope only; null return means no audit
// visibility at all. Store-scoped results only ever contain stores
// of the active tenant (re-checked against tenantStoreIds as defense in
// depth); an empty store set fails closed to null so no consumer can mistake
// "[]" for "unfiltered". (Wiring this into the audit controller is AUD-3
// follow-up, not AUTH-1.)
const auditScopeFor = (ctx) => {
  if (!ctx || ctx.eligible !== true) return null
  if (!ctx.permissions.includes('audit.read')) return null
  if (ctx.isPlatformAdmin && ctx.activeTenantId == null) {
    return { tenantId: null, storeIds: null }
  }
  if (ctx.activeTenantId == null) return null
  if (STORE_CONFINED_ROLES.includes(ctx.activeRole)) {
    const storeIds = ctx.assignedStoreIds.filter((id) => ctx.tenantStoreIds.includes(id))
    if (storeIds.length === 0) return null
    return { tenantId: ctx.activeTenantId, storeIds }
  }
  return { tenantId: ctx.activeTenantId, storeIds: null }
}

module.exports = {
  TARGET_ROLES,
  MEMBERSHIP_STATUS,
  LEGACY_ROLE_MAP,
  PERMISSIONS,
  ROLE_BASELINE_PERMISSIONS,
  legacyRoleTypeToTarget,
  resolveAuthorizationContext,
  can,
  canAccessResource,
  auditScopeFor
}
