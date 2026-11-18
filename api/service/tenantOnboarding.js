'use strict'

// Self-serve owner onboarding admission (spec 2026-11-16 D6, BE audit
// FIXING-PLAN W2-b / F5). Decided from server state only.
//
// A NEW owner may create a first tenant when ALL hold:
//   - AUTHZ_OWNER_V2 is on (off: the endpoint does not exist → 404);
//   - the account is eligible and not a platform actor (vendors administer
//     tenants through /tenants, they never become a business owner here);
//   - it has no ACTIVE membership, no store assignment, no persisted store and
//     is not a kasir — i.e. it carries no trace of an existing business.
//     Legacy staff without a membership (most kasir/admin accounts today) are
//     therefore NOT asked to onboard and cannot create tenants (P1-2).
// An EXISTING canonical owner may add tenants too (spec "lifecycle").
// Both are capped at MAX_TENANTS_PER_DAY new tenants per user (decision K5).
const { canonicalRoleOf, isOwnerV2Enabled } = require('../../utils/ownerRoles')

const MAX_TENANTS_PER_DAY = 3

const hasNoBusinessTrace = async (db, ctx, user) => {
  if ((ctx.memberships || []).some((m) => m.status === 'ACTIVE')) return false
  if (user?.store != null) return false
  if (user?.roleType === 'kasir') return false
  const assignments = await db.storeAssignment.count({ where: { userId: ctx.accountId } })
  return assignments === 0
}

const isNewOwnerCandidate = async (db, ctx, user) => {
  if (!isOwnerV2Enabled()) return false
  if (!ctx || ctx.eligible !== true || ctx.isPlatformAdmin === true) return false
  return hasNoBusinessTrace(db, ctx, user)
}

const isExistingOwner = (ctx) =>
  (ctx?.memberships || []).some(
    (m) => m.status === 'ACTIVE' && canonicalRoleOf(m.role) === 'owner' && (ctx.effectiveTenantIds || []).includes(m.tenantId)
  )

// /auth/context: true only for an account that should see "create your first
// business" — never for a platform actor or an existing employee.
const onboardingRequiredFor = async (db, ctx, user) => {
  if (!(await isNewOwnerCandidate(db, ctx, user))) return false
  return (ctx.effectiveTenantIds || []).length === 0
}

const requireTenantOnboarding = (db) => async (req, res, next) => {
  try {
    if (!isOwnerV2Enabled()) {
      return res.status(404).json({ message: 'Not Found', code: 'NOT_FOUND' })
    }
    const ctx = req.authContext
    if (!ctx || ctx.eligible !== true) {
      return res.status(401).json({ message: 'Unauthorized', code: 'INELIGIBLE_ACCOUNT' })
    }
    const allowed =
      ctx.isPlatformAdmin !== true && (isExistingOwner(ctx) || (await isNewOwnerCandidate(db, ctx, req.user)))
    if (!allowed) {
      return res.status(403).json({ message: 'Akses Ditolak - Anda tidak memiliki izin', code: 'FORBIDDEN' })
    }
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const recent = await db.tenant.count({
      where: { ownerId: ctx.accountId, createdAt: { [db.Sequelize.Op.gte]: since } },
      paranoid: false
    })
    if (recent >= MAX_TENANTS_PER_DAY) {
      return res.status(429).json({
        message: `Maksimal ${MAX_TENANTS_PER_DAY} bisnis baru per hari`,
        code: 'TENANT_CREATE_RATE_LIMITED'
      })
    }
    return next()
  } catch (error) {
    return next(error)
  }
}

module.exports = {
  MAX_TENANTS_PER_DAY,
  isNewOwnerCandidate,
  isExistingOwner,
  onboardingRequiredFor,
  requireTenantOnboarding
}
