'use strict'

// TASK 3 — authorization context endpoints.
//
//   GET    /auth/context         — current session + resolved canonical context
//   POST   /auth/context/tenant  — { tenantId }: atomic tenant switch (clears store)
//   POST   /auth/context/store   — { storeId }: atomic store switch within active tenant
//   DELETE /auth/context         — revoke the selected session
//
// Client values are candidates: every switch is validated against persisted
// membership/assignment/lifecycle state before it is persisted. Deterministic
// error codes; no partial mutation on failure.
const db = require('../../db/models')
const { resolveAuthorizationContext } = require('../../utils/authContext')
const {
  loadContextSession,
  revokeContextSession,
  switchSessionTenant,
  switchSessionStore
} = require('../../utils/authorizationContextMiddleware')
const { disconnectSession } = require('../service/socket')
const { tenantAdministrationScope } = require('../../utils/tenantAdministration')

const sessionOf = (req) => req.authSession || null

const administrationOf = (scope) => (scope ? (scope.all ? 'all' : 'own') : null)

exports.getContext = async (req, res) => {
  const session = sessionOf(req)
  const ctx = req.authContext || (await resolveAuthorizationContext(db, { userId: req.user?.id }))
  return res.status(200).json({
    message: 'Success',
    data: {
      session: session
        ? {
            sessionId: undefined,
            activeTenantId: session.activeTenantId,
            activeStoreId: session.activeStoreId,
            version: session.version,
            expiresAt: session.expiresAt
          }
        : null,
      context: {
        activeTenantId: ctx.activeTenantId,
        activeStoreId: ctx.activeStoreId,
        activeRole: ctx.activeRole,
        permissions: ctx.permissions,
        assignedStoreIds: ctx.assignedStoreIds,
        isPlatformAdmin: ctx.isPlatformAdmin,
        // 'all' (platform), 'own' (a client's super admin: its own tenants
        // only) or null — what the /tenants page may administer.
        tenantAdministration: administrationOf(tenantAdministrationScope(ctx, req.user)),
        reason: ctx.reason
      }
    }
  })
}

exports.selectTenant = async (req, res) => {
  const session = sessionOf(req)
  if (!session) {
    return res.status(401).json({ message: 'Session required', code: 'SESSION_REQUIRED' })
  }
  const { tenantId } = req.body || {}
  try {
    const updated = await switchSessionTenant(db, session.sessionId, req.user.id, tenantId)
    const ctx = await resolveAuthorizationContext(db, {
      userId: req.user.id,
      activeTenantId: updated.activeTenantId
    })
    req.authContext = ctx
    return res.status(200).json({
      message: 'Tenant context updated',
      data: {
        activeTenantId: updated.activeTenantId,
        activeStoreId: updated.activeStoreId,
        version: updated.version,
        activeRole: ctx.activeRole
      }
    })
  } catch (err) {
    const msg = String(err.message || '')
    if (msg.startsWith('CONTEXT_TENANT_FORBIDDEN')) {
      return res.status(403).json({ message: 'Tenant not authorized', code: 'FOREIGN_TENANT', reason: msg })
    }
    if (msg === 'CONTEXT_TENANT_INVALID') {
      return res.status(400).json({ message: 'tenantId tidak valid', code: 'INVALID_TENANT_ID' })
    }
    if (msg === 'CONTEXT_SESSION_NOT_FOUND' || msg === 'CONTEXT_SESSION_EXPIRED') {
      return res.status(401).json({ message: 'Session revoked or expired', code: 'SESSION_INVALID' })
    }
    throw err
  }
}

exports.selectStore = async (req, res) => {
  const session = sessionOf(req)
  if (!session) {
    return res.status(401).json({ message: 'Session required', code: 'SESSION_REQUIRED' })
  }
  const { storeId } = req.body || {}
  try {
    const updated = await switchSessionStore(db, session.sessionId, req.user.id, storeId)
    const ctx = await resolveAuthorizationContext(db, {
      userId: req.user.id,
      activeTenantId: updated.activeTenantId,
      activeStoreId: updated.activeStoreId
    })
    req.authContext = ctx
    return res.status(200).json({
      message: 'Store context updated',
      data: {
        activeTenantId: updated.activeTenantId,
        activeStoreId: updated.activeStoreId,
        version: updated.version,
        activeRole: ctx.activeRole
      }
    })
  } catch (err) {
    const msg = String(err.message || '')
    if (msg.startsWith('CONTEXT_STORE_FORBIDDEN')) {
      return res.status(403).json({ message: 'Store not authorized', code: 'FOREIGN_STORE', reason: msg })
    }
    if (msg === 'CONTEXT_STORE_INVALID') {
      return res.status(400).json({ message: 'storeId tidak valid', code: 'INVALID_STORE_ID' })
    }
    if (msg === 'CONTEXT_TENANT_REQUIRED') {
      return res.status(409).json({ message: 'Select a tenant first', code: 'TENANT_NOT_SELECTED' })
    }
    if (msg === 'CONTEXT_SESSION_NOT_FOUND' || msg === 'CONTEXT_SESSION_EXPIRED' || msg === 'CONTEXT_STALE') {
      return res.status(401).json({ message: 'Session revoked or expired', code: 'SESSION_INVALID' })
    }
    throw err
  }
}

exports.clearContext = async (req, res) => {
  const session = sessionOf(req)
  const sessionId = session ? session.sessionId : req.user?.sessionId
  if (sessionId) {
    await revokeContextSession(db, sessionId, req.user?.id)
    // AUTH-1 P4: the revocation is committed; drop this session's live sockets.
    disconnectSession(sessionId)
  }
  res.clearCookie('token')
  return res.status(200).json({ message: 'Context cleared' })
}

// Test seam: resolve without HTTP.
exports.__loadSession = loadContextSession
