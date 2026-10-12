const db = require('../db/models')
const crypto = require('crypto')

const AUDIT_ACTIONS = Object.freeze({
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  APPROVE: 'approve',
  REJECT: 'reject',
  IMPORT: 'import',
  VOID: 'void',
  PAYMENT: 'payment',
  REFUND: 'refund',
  LOGIN: 'login',
  STATUS_CHANGE: 'status_change'
})

// Recursively strips fields that must never reach the auditLog JSONB
// columns. Keyed case-insensitively so `passwordHash`, `Password`, and
// `PASSWORD` are all caught by the same entry.
const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'token',
  'accesstoken',
  'refreshtoken',
  'secret',
  'apisecret',
  'clientsecret',
  'apikey',
  'privatekey',
  'otp'
])

function redactValue(value, seen) {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, seen))
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    const out = {}
    for (const [key, val] of Object.entries(value)) {
      const lowerKey = key.toLowerCase()
      if (SENSITIVE_KEYS.has(lowerKey)) {
        out[key] = '[REDACTED]'
      } else if (lowerKey === 'cardnumber' && typeof val === 'string') {
        // AUD-2 idempotency: already-redacted markers must survive a second
        // pass (redactAndAudit() redacts, then the auditLog() choke point
        // redacts again) instead of being re-masked into '****TED]'.
        if (val === '[REDACTED]' || val.startsWith('****')) {
          out[key] = val
        } else {
          out[key] = val.length > 4 ? `****${val.slice(-4)}` : '[REDACTED]'
        }
      } else {
        out[key] = redactValue(val, seen)
      }
    }
    return out
  }
  return value
}

// Sequelize model instances must be plain-ified before redaction can
// walk their own properties rather than the model's internal shape.
function toPlain(value) {
  if (value && typeof value.toJSON === 'function') return value.toJSON()
  return value
}

// AUD-2: this is the single choke point for every legacy write — oldValues
// and newValues are redacted here via the same centralized redactValue()
// used by recordAudit(), so the ~130 existing createAudit call sites cannot
// leak credentials/secrets into audit storage. Signature and fire-and-forget
// behavior are unchanged; redactAndAudit() stays valid (re-redaction of the
// '[REDACTED]' marker is idempotent).
const auditLog = async ({
  store,
  userId,
  userName,
  action,
  entity,
  entityId,
  description,
  oldValues,
  newValues,
  ipAddress,
  userAgent,
  transaction
}) => {
  try {
    await db.auditLog.create(
      {
        store,
        userId,
        userName,
        action,
        entity,
        entityId,
        description,
        oldValues:
          redactValue(toPlain(oldValues), new WeakSet()) || null,
        newValues:
          redactValue(toPlain(newValues), new WeakSet()) || null,
        ipAddress: ipAddress || null,
        userAgent: userAgent || null
      },
      { transaction: transaction || undefined }
    )
  } catch (error) {
    console.error('Audit log error:', error)
    // FP-01: when participating in a caller-owned transaction, the failure
    // must propagate so the owner rolls back instead of reporting success
    // without its required audit record. Without a transaction the legacy
    // fire-and-forget contract is preserved. Mirrors recordAudit().
    if (transaction) throw error
  }
}

// Unchanged signature — existing ~130 call sites keep working exactly as
// they do today. Since AUD-2 the payload is redacted at the auditLog()
// choke point above, so legacy callers are safe by default. New call sites
// that already hold redacted values may still prefer redactAndAudit().
const createAudit = (
  req,
  action,
  entity,
  entityId,
  description,
  oldValues,
  newValues,
  transaction
) => {
  return auditLog({
    store: req.storeId || req.user?.store || req.cookies?.store,
    userId: req.user?.id,
    userName: req.user?.name || req.user?.username,
    action,
    entity,
    entityId,
    description,
    oldValues,
    newValues,
    ipAddress: req.ip,
    userAgent: req.get('User-Agent'),
    transaction
  })
}

// The redacting entry point. Same call shape as createAudit but takes
// a single options object (clearer at 7 positional args) and strips
// SENSITIVE_KEYS recursively from both value objects before they are
// ever serialized to JSONB.
const redactAndAudit = (
  req,
  { action, entity, entityId, description, oldValues, newValues, transaction }
) => {
  return createAudit(
    req,
    action,
    entity,
    entityId,
    description,
    redactValue(toPlain(oldValues), new WeakSet()),
    redactValue(toPlain(newValues), new WeakSet()),
    transaction
  )
}

module.exports = { auditLog, createAudit, redactAndAudit, AUDIT_ACTIONS }

// ---------------------------------------------------------------------------
// AUD-1 (DR-20 foundation): canonical audit creation contract.
// ---------------------------------------------------------------------------
// recordAudit() is the single forward-looking entry point. It does NOT
// replace createAudit/redactAndAudit (both keep working unchanged for the
// existing ~130 call sites); it adds the DR-20 minimum context that the
// legacy helpers cannot express: actor type, tenant scope, result,
// request/correlation id, reason, source, and metadata.
//
// TRUST BOUNDARY (AUD-1):
// - Scope (tenantId/storeId) comes ONLY from explicit arguments or from
//   trusted server-side request context (req.storeId, req.user). This
//   helper NEVER reads req.body / req.query / req.params for scope, so a
//   client-supplied tenant/store id can never silently become authority.
// - tenantId has no JWT claim yet (DR-01 NOT IMPLEMENTED): callers must pass
//   it explicitly from server-side mapping, or leave it null. Null means
//   "platform/global or unknown scope" — never a guessed tenant.
// - Timestamps are server-generated (Sequelize createdAt). There is no
//   timestamp parameter by design: client time is never accepted.
// - Credential-bearing payloads are redacted via redactValue() before
//   persistence (same key families as the existing helper). Reason strings
//   are truncated to REASON_MAX_LENGTH. AUD-2 hardened the legacy auditLog()
//   choke point with the same centralized redaction; JSON-string payloads
//   are intentionally NOT parsed (no silent reinterpretation of caller data).
// - Contract violations (bad actorType/result, missing action) throw
//   synchronously so programmer errors fail fast in tests/CI.
//
// TRANSACTION BEHAVIOR:
// - When options.transaction is provided, the create participates in the
//   caller transaction and errors PROPAGATE (so a later AUD-4 atomicity
//   design can roll the business action back on audit failure).
// - Without a transaction, errors are swallowed after console.error,
//   matching the legacy fire-and-forget behavior. Returns the created row
//   on success, null when the write was skipped on error.

const ACTOR_TYPES = Object.freeze({
  USER: 'USER',
  SYSTEM: 'SYSTEM',
  JOB: 'JOB',
  INTEGRATION: 'INTEGRATION'
})

const AUDIT_RESULTS = Object.freeze({
  SUCCESS: 'SUCCESS',
  FAILURE: 'FAILURE',
  DENIED: 'DENIED'
})

const REASON_MAX_LENGTH = 500

const resolveScopeFromReq = (req) => {
  if (!req) return { storeId: null }
  // Trusted server-side context only: middleware/JWT-derived values.
  // Body, query, and params are deliberately never consulted here.
  const storeId =
    req.storeId != null
      ? parseInt(req.storeId, 10)
      : req.user?.store != null
        ? parseInt(req.user.store, 10)
        : null
  return { storeId: Number.isFinite(storeId) ? storeId : null }
}

const resolveActorFromReq = (req) => {
  if (!req?.user) return { id: null, name: null }
  return {
    id: req.user.id != null ? req.user.id : null,
    name: req.user.userName || req.user.username || req.user.fullName || null
  }
}

const recordAudit = async ({
  actor,
  req,
  action,
  entity,
  entityId = null,
  description = null,
  tenantId = null,
  storeId,
  result = AUDIT_RESULTS.SUCCESS,
  requestId = null,
  reason = null,
  previousState = null,
  newState = null,
  source = null,
  metadata = null,
  transaction = null
} = {}) => {
  if (typeof action !== 'string' || action.trim() === '') {
    throw new Error('recordAudit: action must be a non-empty string')
  }
  // The legacy auditLog table requires entity NOT NULL, so resource-less
  // events carry a domain label (e.g. 'AUTH', 'SYSTEM') instead of null.
  // entityId stays nullable for events without a concrete resource row.
  if (typeof entity !== 'string' || entity.trim() === '') {
    throw new Error('recordAudit: entity must be a non-empty string')
  }
  const actorType =
    actor?.type != null ? String(actor.type).toUpperCase() : ACTOR_TYPES.USER
  if (!Object.values(ACTOR_TYPES).includes(actorType)) {
    throw new Error(`recordAudit: unknown actorType "${actor?.type}"`)
  }
  const normalizedResult = String(result || '').toUpperCase()
  if (!Object.values(AUDIT_RESULTS).includes(normalizedResult)) {
    throw new Error(`recordAudit: unknown result "${result}"`)
  }

  const reqActor = resolveActorFromReq(req)
  const reqScope = resolveScopeFromReq(req)
  const seen = new WeakSet()

  const row = {
    store: storeId !== undefined ? storeId : reqScope.storeId,
    userId: actor?.id !== undefined ? actor.id : reqActor.id,
    userName: actor?.name !== undefined ? actor.name : reqActor.name,
    action: action.trim(),
    entity: entity.trim(),
    entityId: entityId != null ? entityId : null,
    description: description != null ? String(description) : null,
    oldValues: previousState != null ? redactValue(toPlain(previousState), seen) : null,
    newValues: newState != null ? redactValue(toPlain(newState), new WeakSet()) : null,
    ipAddress: req?.ip || null,
    userAgent:
      typeof req?.get === 'function' ? req.get('User-Agent') : null,
    actorType,
    tenantId: tenantId != null ? tenantId : null,
    result: normalizedResult,
    requestId:
      requestId != null && String(requestId) !== ''
        ? String(requestId).slice(0, 64)
        : crypto.randomUUID(),
    reason:
      reason != null ? String(reason).slice(0, REASON_MAX_LENGTH) : null,
    source: source != null ? String(source).slice(0, 30) : null,
    metadata:
      metadata != null ? redactValue(toPlain(metadata), new WeakSet()) : null
  }

  try {
    const created = await db.auditLog.create(row, {
      transaction: transaction || undefined
    })
    return created
  } catch (error) {
    if (transaction) throw error
    console.error('Audit log error:', error)
    return null
  }
}

module.exports.recordAudit = recordAudit
module.exports.ACTOR_TYPES = ACTOR_TYPES
module.exports.AUDIT_RESULTS = AUDIT_RESULTS
module.exports.REASON_MAX_LENGTH = REASON_MAX_LENGTH
