'use strict'

// AUTH-1 P2 test support. Canonical authentication requires every request to
// present a live DB authorization session owned by the JWT's `id`, and it
// authorizes from the current account row — never from JWT claims. Fixtures
// therefore mint tokens bound to a real session instead of a bare jwt.sign.
// (Kept outside __tests__/ so jest never collects it as a test file.)

const jwt = require('jsonwebtoken')

const models = () => require('../db/models')
const { createContextSession } = require('../utils/authorizationContextMiddleware')

// Drop-in for `jwt.sign(claims, secret, options)` in fixtures: creates a real
// session for `claims.id` (the user row must already exist) and signs the
// claims plus that sessionId. Any role/store claims are kept only so fixtures
// stay readable; authorization reads the DB account, not these claims.
async function signSessionToken(claims, secret = process.env.JWT_SECRET_KEY, options) {
  const session = await createContextSession(models(), { userId: claims.id })
  return jwt.sign({ ...claims, sessionId: session.sessionId }, secret, options)
}

// Creates a real user, a real session for it and a JWT carrying only the
// identity + session reference.
async function createAuthenticatedTestSession(userAttrs, { activeTenantId, activeStoreId, ttlMs } = {}) {
  const db = models()
  const user = await db.user.create(userAttrs)
  const session = await createContextSession(db, { userId: user.id, activeTenantId, activeStoreId, ttlMs })
  const token = jwt.sign({ id: user.id, sessionId: session.sessionId }, process.env.JWT_SECRET_KEY)
  return { user, session, token }
}

// Some legacy suites address stores by fixed abstract ids (1, 2). Since the
// caller's store now comes from its DB row (FK to location), those ids must
// be real locations; created once and reused across suites.
// W3-z / Z2: each fixed outlet belongs to its own fixed tenant (stores 1 and
// 2 stand for two separate businesses in these isolation suites), because a
// write against a tenant-less outlet is refused (STORE_TENANT_REQUIRED).
async function ensureLocationIds(...ids) {
  const db = models()
  for (const id of ids) {
    const code = `fixture-store-${id}`
    const [tenant] = await db.tenant.findOrCreate({ where: { code }, defaults: { code, name: `Fixture tenant store ${id}` } })
    const [location] = await db.location.findOrCreate({
      where: { id },
      defaults: { id, name: `AUTH_P2_FIXTURE_STORE_${id}`, status: 'active', tenantId: tenant.id }
    })
    if (location.tenantId == null) await location.update({ tenantId: tenant.id })
  }
}

module.exports = { signSessionToken, createAuthenticatedTestSession, ensureLocationIds }
