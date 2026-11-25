'use strict'

// Bakery permissions (FE-BAKERY-App src/api/contract.ts PERMISSIONS).
//
// AUTHZ_OWNER_V2 is off, so like utils/salonCapabilities.js this is an
// interim mapping from the legacy roleType. GET /bakery/context serves the
// same list to FE-BAKERY, so menus and the server always agree.

const BAKERY_PERMISSIONS = Object.freeze([
  'catalog.read',
  'catalog.manage',
  'member.read',
  'member.manage',
  'bakery.order.read',
  'bakery.order.manage',
  'bakery.production.read',
  'bakery.settings.manage',
  'pos.sell',
  'report.read',
  'settings.manage',
  'outlet.manage'
])

const CANONICAL_BY_ROLE_TYPE = Object.freeze({
  super_admin: 'owner',
  admin: 'admin',
  kasir: 'kasir',
  user: 'staff'
})

const BAKERY_ROLE_PERMISSIONS = Object.freeze({
  owner: BAKERY_PERMISSIONS,
  admin: Object.freeze(BAKERY_PERMISSIONS.filter((p) => p !== 'outlet.manage' && p !== 'settings.manage')),
  kasir: Object.freeze([
    'bakery.order.read',
    'bakery.order.manage',
    'catalog.read',
    'member.read',
    'pos.sell',
    'bakery.production.read'
  ]),
  // Kitchen / production crew: read orders and the production plan.
  staff: Object.freeze(['bakery.order.read', 'catalog.read', 'member.read', 'bakery.production.read'])
})

const bakeryRoleOf = (user) => CANONICAL_BY_ROLE_TYPE[user?.roleType] || null

const bakeryPermissionsOf = (user) => {
  const role = bakeryRoleOf(user)
  return role ? BAKERY_ROLE_PERMISSIONS[role] : []
}

/** True when the user holds at least one of the permissions. */
const hasBakeryPermission = (user, permission) => {
  const need = Array.isArray(permission) ? permission : [permission]
  const held = bakeryPermissionsOf(user)
  return need.some((p) => held.includes(p))
}

module.exports = {
  BAKERY_PERMISSIONS,
  BAKERY_ROLE_PERMISSIONS,
  bakeryRoleOf,
  bakeryPermissionsOf,
  hasBakeryPermission
}
