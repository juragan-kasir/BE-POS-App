const { redactAndAudit, AUDIT_ACTIONS } = require('./auditLog')

// DR-23 §J (BA §35.10) interim compatibility mapping from the legacy
// roleType to the target financial capabilities. Not the final membership
// architecture (DR-12): it may be stricter than the target, never weaker.
//   super_admin / admin → every capability below
//   kasir → cashier baseline (payment.collect) + default grants for
//           split.manage, order.cancel (N = 0) and refund.request;
//           no void and no refund approval
//   user  → staff: no sales or settlement rights by default
const CAPABILITY_ROLES = Object.freeze({
  'payment.collect': Object.freeze(['super_admin', 'admin', 'kasir']),
  'split.manage': Object.freeze(['super_admin', 'admin', 'kasir']),
  'order.cancel': Object.freeze(['super_admin', 'admin', 'kasir']),
  'order.void': Object.freeze(['super_admin', 'admin']),
  'refund.request': Object.freeze(['super_admin', 'admin', 'kasir']),
  'refund.approve': Object.freeze(['super_admin', 'admin'])
})

const hasCapability = (user, capability) =>
  Boolean(user && (CAPABILITY_ROLES[capability] || []).includes(user.roleType))

// DR-20: authorization denials are audited. Written outside any business
// transaction (nothing to roll back on a denial).
const auditCapabilityDenial = (req, { capability, entity, entityId, action }) =>
  redactAndAudit(req, {
    action: action || AUDIT_ACTIONS.UPDATE,
    entity,
    entityId: entityId ?? null,
    description: `${capability} denied for role ${req.user?.roleType || 'unknown'}`,
    newValues: { result: 'DENIED', capability, roleType: req.user?.roleType || null }
  })

const denialBody = (capability) => ({
  error: `This action requires the ${capability} capability`,
  code: 'FORBIDDEN'
})

// Route-level gate. `entity` / `entityIdFrom` only shape the denial audit.
const requireCapability = (capability, { entity, entityIdFrom } = {}) =>
  async (req, res, next) => {
    if (!req.authSession || !req.user) {
      return res.status(401).json({ message: 'User Belum Login' })
    }
    if (hasCapability(req.user, capability)) return next()
    await auditCapabilityDenial(req, {
      capability,
      entity: entity || 'authorization',
      entityId: entityIdFrom ? entityIdFrom(req) : null
    })
    return res.status(403).json(denialBody(capability))
  }

module.exports = {
  CAPABILITY_ROLES,
  hasCapability,
  auditCapabilityDenial,
  denialBody,
  requireCapability
}
