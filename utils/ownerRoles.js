'use strict'

// Owner → tenant → outlet hierarchy (spec 2026-11-16, BE audit FIXING-PLAN
// W2-b). Canonical role vocabulary + the AUTHZ_OWNER_V2 feature flag.
//
// Flag OFF (default): nothing here changes authorization — the resolver keeps
// the legacy vocabulary and baselines exactly as before.
// Flag ON: the canonical roles owner/admin/kasir become effective with their
// own baselines; the legacy aliases (tenant_admin/store_admin/cashier/staff)
// keep their legacy baselines until the backfill converts them explicitly
// (decision K1) — an existing user never gains or loses authority just
// because the flag flipped.

const CANONICAL_ROLES = Object.freeze(['owner', 'admin', 'kasir', 'staff'])

// Roles that exist only in the new vocabulary (staff is shared with legacy).
const V2_ONLY_ROLES = Object.freeze(['owner', 'admin', 'kasir'])

const ROLE_ALIASES = Object.freeze({
  platform_admin: 'platform_admin',
  owner: 'owner',
  tenant_admin: 'owner',
  admin: 'admin',
  store_admin: 'admin',
  kasir: 'kasir',
  cashier: 'kasir',
  staff: 'staff'
})

const canonicalRoleOf = (role) => ROLE_ALIASES[String(role || '').toLowerCase()] || null

// Read at call time so tests (and an ops toggle) take effect without reload.
const isOwnerV2Enabled = () => process.env.AUTHZ_OWNER_V2 === 'true'

module.exports = {
  CANONICAL_ROLES,
  V2_ONLY_ROLES,
  ROLE_ALIASES,
  canonicalRoleOf,
  isOwnerV2Enabled
}
