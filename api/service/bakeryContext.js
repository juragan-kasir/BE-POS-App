'use strict'

// Maps the legacy/DB role vocabulary to the bakery FE canonical roles and
// builds the AuthContext payload the FE zod contract expects.
const CANONICAL_ROLE = Object.freeze({
  super_admin: 'owner',
  platform_admin: 'owner',
  tenant_admin: 'owner',
  admin: 'admin',
  store_admin: 'admin',
  kasir: 'kasir',
  cashier: 'kasir',
  user: 'staff',
  staff: 'staff'
})

const PERMISSIONS = Object.freeze({
  owner: [
    'catalog.read',
    'catalog.manage',
    'member.read',
    'member.manage',
    'bakery.order.read',
    'bakery.order.manage',
    'bakery.production.read',
    'bakery.settings.manage',
    'report.read',
    'settings.manage',
    'outlet.manage'
  ],
  admin: [
    'catalog.read',
    'catalog.manage',
    'member.read',
    'member.manage',
    'bakery.order.read',
    'bakery.order.manage',
    'bakery.production.read',
    'bakery.settings.manage',
    'report.read',
    'settings.manage',
    'outlet.manage'
  ],
  kasir: [
    'catalog.read',
    'member.read',
    'bakery.order.read',
    'bakery.order.manage',
    'bakery.production.read',
    'pos.sell'
  ],
  staff: ['bakery.order.read', 'bakery.production.read']
})

const canonicalRoleOf = (role) => {
  const key = String(role || '')
  return CANONICAL_ROLE[key] || (PERMISSIONS[key] ? key : 'staff')
}

const permissionsFor = (role) => [...PERMISSIONS[canonicalRoleOf(role)]]

const buildAuthContext = ({ tenant, user, stores, role, settings, staffUserId = null }) => {
  const canonicalRole = canonicalRoleOf(role)
  return {
    tenant: {
      id: String(tenant?.id ?? '0'),
      name: tenant?.name || 'Bakery',
      status: tenant?.status || 'active',
      settings
    },
    user: {
      id: String(user.id),
      name: user.fullName || user.userName || 'User',
      email: user.email || null
    },
    canonicalRole,
    permissions: permissionsFor(canonicalRole),
    stores,
    onboardingRequired: stores.length === 0,
    staffUserId: staffUserId == null ? null : String(staffUserId)
  }
}

module.exports = { canonicalRoleOf, permissionsFor, buildAuthContext, PERMISSIONS }
