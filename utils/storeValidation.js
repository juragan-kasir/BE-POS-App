// Parse a client-supplied store value into an array of numeric store IDs
// WITHOUT relying on JavaScript coercion tricks (parseInt(array) -> first
// element, parseInt('"[5]"') -> NaN). Distinguishes scalar string/number,
// number array, JSON-string-array, comma-separated, malformed, null/empty.
//
// Returns an array of numbers (possibly empty). This is PURE NORMALIZATION —
// authorization is a separate concern (see authorizedStoreIds below).
const normalizeStoreIds = (value) => {
  if (value === undefined || value === null || value === '') return []

  // Number array (the JSON-array body shape used by multi-store forms).
  if (Array.isArray(value)) {
    return value
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n) && Number.isInteger(n) && n > 0)
  }

  // String: try JSON array first, then comma/space splits, then scalar.
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return []
    if (trimmed === 'all') return [] // handled as global by caller semantics
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        return parsed
          .map((v) => Number(v))
          .filter((n) => Number.isFinite(n) && Number.isInteger(n) && n > 0)
      }
    } catch {
      // fall through
    }
    const parts = trimmed
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.length > 1) {
      return parts
        .map(Number)
        .filter((n) => Number.isFinite(n) && Number.isInteger(n) && n > 0)
    }
    const n = Number(trimmed)
    if (Number.isFinite(n) && Number.isInteger(n) && n > 0) return [n]
    return []
  }

  // number / anything else
  const n = Number(value)
  if (Number.isFinite(n) && Number.isInteger(n) && n > 0) return [n]
  return []
}

// ---------------------------------------------------------------------------
// Canonical (F5) candidate parsing — pure normalization, NEVER authority.
// Collects every client-supplied store value (query/body/cookies, including
// the frontend activeStore display state) into a deduplicated candidate list.
// The result carries NO allow/deny verdict: callers must pass it to
// resolveCanonicalStoreScope() with the server-resolved req.authContext.
// ---------------------------------------------------------------------------
const parseStoreCandidates = (req) => {
  const raw = []
  const push = (v) => {
    raw.push(v)
  }
  if (req?.query?.store !== undefined) push(req.query.store)
  if (req?.query?.location !== undefined) push(req.query.location)
  if (req?.body?.store !== undefined) push(req.body.store)
  if (req?.body?.storeId !== undefined) push(req.body.storeId)
  if (req?.body?.location !== undefined) push(req.body.location)
  if (req?.cookies?.store !== undefined) push(req.cookies.store)
  if (req?.cookies?.activeStore !== undefined) push(req.cookies.activeStore)
  const merged = []
  for (const value of raw) {
    for (const id of normalizeStoreIds(value)) {
      if (!merged.includes(id)) merged.push(id)
    }
  }
  return { candidates: merged }
}

// ---------------------------------------------------------------------------
// Canonical (F5) store scope resolution against the server-resolved context.
// Authority comes ONLY from req.authContext (persisted membership, role,
// assignment, tenant store roster). Client candidates that are foreign,
// unassigned, nonexistent, mismatched, or ambiguously multi-store fail closed.
// Returns { ok:true, stores:[...] } or { ok:false, code, message }.
// ---------------------------------------------------------------------------
const STORE_CONFINED = Object.freeze(['store_admin', 'cashier', 'staff'])

const resolveCanonicalStoreScope = (req, candidateIds) => {
  const ctx = req?.authContext
  if (!ctx || ctx.eligible !== true) {
    return { ok: false, code: 'CONTEXT_UNRESOLVED', message: 'authorization context is unresolved' }
  }
  const list = Array.isArray(candidateIds) ? candidateIds : []
  const candidates = [...new Set(
    list.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0)
  )]

  // Platform actors outside any tenant operate under explicit platform
  // capability (checked separately via can()); scope resolution passes the
  // candidates through without tenant confinement.
  if (ctx.isPlatformAdmin && ctx.activeTenantId == null) {
    return { ok: true, stores: candidates, code: 'PLATFORM_SCOPE' }
  }

  if (ctx.activeTenantId == null) {
    return { ok: false, code: 'TENANT_SCOPE_REQUIRED', message: 'an active tenant is required' }
  }

  const tenantStores = (ctx.tenantStoreIds || []).map(Number)
  const assigned = (ctx.assignedStoreIds || []).map(Number)
  const confined = STORE_CONFINED.includes(ctx.activeRole)

  if (candidates.length === 0) {
    // No candidate: pin to the session selection for confined roles.
    if (confined) {
      if (ctx.activeStoreId != null && assigned.includes(Number(ctx.activeStoreId))) {
        return { ok: true, stores: [Number(ctx.activeStoreId)], code: 'SESSION_PINNED' }
      }
      return { ok: false, code: 'STORE_SCOPE_REQUIRED', message: 'an assigned store is required' }
    }
    return { ok: true, stores: [], code: 'TENANT_SCOPE' }
  }

  for (const id of candidates) {
    if (!tenantStores.includes(id)) {
      return { ok: false, code: 'FOREIGN_STORE', message: `store ${id} is not in the active tenant` }
    }
  }
  if (confined) {
    if (candidates.length > 1) {
      return { ok: false, code: 'MULTI_STORE_FORBIDDEN', message: 'multiple stores are not permitted for this role' }
    }
    for (const id of candidates) {
      if (!assigned.includes(id)) {
        return { ok: false, code: 'UNASSIGNED_STORE', message: `store ${id} is not assigned` }
      }
    }
  }
  return { ok: true, stores: candidates, code: 'CANONICAL_SCOPE' }
}
//
// For a NON-super-admin with authoritative store req.storeId (the JWT `store`
// claim pinned by validateStoreAccess):
//   requestedStores MUST be a subset of {req.storeId}.
// Since a single-store tenant can only ever be authorized for exactly its own
// store, ANY element that is not exactly req.storeId — or ANY representation
// that does not collapse to {req.storeId} — makes the WHOLE request
// unauthorized and MUST be rejected with no partial mutation.
//
// Returns either:
//   { ok: true, stores: [req.storeId] }   (the caller may proceed, pinned to own)
//   { ok: false }                         (reject the entire request; caller
//                                          must write nothing, emit nothing)
//
// For super_admin the caller owns multi-store/global semantics and should NOT
// use this helper — it guards the single-store tenant default only.
const authorizedStoreIds = (req) => {
  const userRole = req.user?.roleType
  const userStore = Number(req.user?.store)
  if (userRole !== 'super_admin' && Number.isFinite(userStore) && userStore > 0) {
    // Single-store tenant: authoritative writes may go to exactly {req.storeId}.
    const hasBodyStore =
      req.body &&
      (req.body.store !== undefined || req.body.storeId !== undefined || req.body.location !== undefined)
    const hasQueryStore =
      req.query && (req.query.store !== undefined || req.query.location !== undefined)
    const supplied = hasBodyStore
      ? req.body.store !== undefined
        ? req.body.store
        : req.body.storeId !== undefined
          ? req.body.storeId
          : req.body.location
      : hasQueryStore
        ? req.query.store !== undefined
          ? req.query.store
          : req.query.location
        : undefined

    // Omitted / empty / 'all' store -> default to own store. This is the
    // safe, non-expanding interpretation: it never lets a single-store tenant
    // touch a foreign or global/null-store namespace.
    if (supplied === undefined || supplied === null || supplied === '' || supplied === 'all') {
      return { ok: true, stores: [userStore] }
    }

    const candidates = normalizeStoreIds(supplied)
    // Fail closed on any ambiguity for a single-store tenant.
    if (candidates.length === 0) return { ok: false }
    for (const c of candidates) {
      if (c !== userStore) return { ok: false }
    }
    return { ok: true, stores: [userStore] }
  }
  // super_admin or unassigned (unassigned is already 403'd by middleware) —
  // leave multi-store handling to the controllers/super_admin path.
  return {
    ok: true,
    stores: normalizeStoreIds(
      req.body?.store ?? req.body?.storeId ?? req.query?.store
    )
  }
}

// Scalar-store convenience over authorizedStoreIds: returns the single store id
// an authorized write may target. For non-super-admin it is exactly req.storeId;
// for super_admin it is the client scalar (or null when absent). Rejects
// ambiguous/foreign/multi-store representations for non-super-admin.
const authorizedWriteStore = (req) => {
  if (req.user?.roleType !== 'super_admin') {
    const r = authorizedStoreIds(req)
    if (!r.ok || r.stores.length === 0) return { ok: false }
    return { ok: true, storeId: r.stores[0] }
  }
  const raw =
    req.body?.store !== undefined
      ? req.body.store
      : req.body?.storeId !== undefined
        ? req.body.storeId
        : req.query?.store
  const n = Number(raw)
  return {
    ok: true,
    storeId: raw === undefined || raw === null || raw === '' || !Number.isFinite(n)
      ? null
      : n
  }
}

const validateStoreAccess = (req, res, next) => {
  // F5 canonical path: when the server-side context is attached, candidates
  // are validated against it — legacy JWT/cookie values grant nothing.
  if (req?.authContext) {
    const { candidates } = parseStoreCandidates(req)
    // No candidates at all: preserve the historical default-to-own behavior
    // ONLY as a pinned session value, still validated canonically below.
    const scope = resolveCanonicalStoreScope(
      req,
      candidates.length > 0 ? candidates : req.authContext.activeStoreId != null ? [req.authContext.activeStoreId] : []
    )
    if (!scope.ok) {
      return res.status(403).json({
        message: 'Anda hanya dapat mengakses data di toko Anda',
        code: scope.code
      })
    }
    req.storeId = scope.stores[0] ?? req.authContext.activeStoreId ?? null
    return next()
  }

  // Legacy branch: role/store come from the account hydrated by canonical
  // `authorization` (current DB state), never from JWT claims. Without an
  // authenticated session there is nothing trustworthy to check — fail closed.
  if (!req?.authSession || !req.user) {
    return res.status(401).json({ message: 'User Belum Login' })
  }
  const userRole = req.user.roleType
  const userStore = req.user.store
  
  // Collect ALL store candidates from all parameters (not just the first)
  // to detect conflicts like ?store=10&location=11
  const allCandidates = []
  if (req.query?.store !== undefined) allCandidates.push(...normalizeStoreIds(req.query.store))
  if (req.query?.location !== undefined) allCandidates.push(...normalizeStoreIds(req.query.location))
  if (req.body?.store !== undefined) allCandidates.push(...normalizeStoreIds(req.body.store))
  if (req.body?.storeId !== undefined) allCandidates.push(...normalizeStoreIds(req.body.storeId))
  if (req.body?.location !== undefined) allCandidates.push(...normalizeStoreIds(req.body.location))
  
  // Deduplicate and check for conflicts
  const uniqueCandidates = [...new Set(allCandidates)]
  
  if (userRole === 'super_admin') {
    req.storeId = uniqueCandidates[0] ?? null
    return next()
  }
  
  // If multiple distinct stores were supplied, fail closed (ambiguous/conflicting)
  if (uniqueCandidates.length > 1) {
    return res.status(403).json({
      message: 'Anda hanya dapat mengakses data di toko Anda'
    })
  }
  
  const supplied = uniqueCandidates[0] ?? null

  // Defense-in-depth: normalize WITHOUT parseInt coercion tricks. This closes
  // the latent array/JSON-string collapse gap (parseInt([own,foreign]) -> own,
  // parseInt('"[5]"') -> NaN) so a non-super-admin can never slip an ambiguous
  // multi-store representation past the middleware into a downstream controller.
  const requestedStores = normalizeStoreIds(supplied)
  const requestedStore = requestedStores[0] ?? null

  if (userRole === 'super_admin') {
    req.storeId = requestedStore
    return next()
  }

  // admin / kasir / user — always scoped to their own store.
  // If a store was supplied, EVERY represented store must equal the caller's
  // own store (a single-store tenant is authorized for exactly its own store).
  if (supplied !== undefined && supplied !== null && supplied !== '') {
    if (requestedStores.length === 0) {
      return res.status(403).json({
        message: 'Anda hanya dapat mengakses data di toko Anda'
      })
    }
    for (const c of requestedStores) {
      if (c !== Number(userStore)) {
        return res.status(403).json({
          message: 'Anda hanya dapat mengakses data di toko Anda'
        })
      }
    }
  }

  // N-11 (security): fail-closed for unassigned accounts. A non-super-admin
  // token without a numeric `store` claim used to fall through every
  // `req.storeId || req.cookies.store || req.user?.store` chain into the
  // attacker-controlled cookie/query value, silently granting cross-tenant
  // access. Require a real store claim up front so such accounts can never
  // reach tenant-scoped data under any client-supplied store.
  req.storeId = userStore
  if (!Number.isFinite(Number(userStore)) || Number(userStore) <= 0) {
    return res.status(403).json({
      message: 'Store assignment required'
    })
  }
  return next()
}

const validateStoreId = (storeId, userStore, userRole) => {
  if (userRole === 'super_admin') {
    return true
  }
  return parseInt(storeId) === userStore
}

module.exports = {
  validateStoreAccess,
  validateStoreId,
  normalizeStoreIds,
  authorizedStoreIds,
  authorizedWriteStore,
  parseStoreCandidates,
  resolveCanonicalStoreScope
}
