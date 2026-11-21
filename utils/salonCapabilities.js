'use strict'

// Salon permissions (SALON-BARBERSHOP-PLAN §3.2, SALON-BA §3, DR-SLN-08).
//
// AUTHZ_OWNER_V2 is off in production, so no context holds the V2
// permissions and authContext.can() cannot gate salon routes yet. Like
// utils/financialCapabilities.js (DR-23 §J), this is an interim mapping from
// the legacy roleType; GET /salon/context serves the same list to FE-SALON so
// menus and the server always agree. Mirrors FE-SALON-App ROLE_PERMISSIONS.

const SALON_PERMISSIONS = Object.freeze([
  'catalog.read',
  'catalog.manage',
  'employee.read',
  'employee.manage',
  'member.read',
  'member.manage',
  'appointment.read',
  'appointment.manage',
  'commission.read',
  'commission.manage',
  'pos.sell',
  'pos.refund',
  'shift.manage',
  'report.read',
  'settings.manage',
  'outlet.manage'
])

// roleType → salon canonical role.
const CANONICAL_BY_ROLE_TYPE = Object.freeze({
  super_admin: 'owner',
  admin: 'admin',
  kasir: 'kasir',
  user: 'staff'
})

const SALON_ROLE_PERMISSIONS = Object.freeze({
  owner: SALON_PERMISSIONS,
  admin: Object.freeze(SALON_PERMISSIONS.filter((p) => p !== 'outlet.manage' && p !== 'settings.manage')),
  kasir: Object.freeze([
    'catalog.read',
    'employee.read',
    'member.read',
    'member.manage',
    'appointment.read',
    'appointment.manage',
    'pos.sell',
    'shift.manage'
  ]),
  // Stylist / barber / therapist: own schedule and own commission only
  // (DR-SLN-15). "Own" is enforced by the /salon/me handlers.
  staff: Object.freeze(['appointment.read', 'commission.read'])
})

const salonRoleOf = (user) => CANONICAL_BY_ROLE_TYPE[user?.roleType] || null

const salonPermissionsOf = (user) => {
  const role = salonRoleOf(user)
  return role ? SALON_ROLE_PERMISSIONS[role] : []
}

/** True when the user holds at least one of the permissions. */
const hasSalonPermission = (user, permission) => {
  const need = Array.isArray(permission) ? permission : [permission]
  const held = salonPermissionsOf(user)
  return need.some((p) => held.includes(p))
}

module.exports = {
  SALON_PERMISSIONS,
  SALON_ROLE_PERMISSIONS,
  CANONICAL_BY_ROLE_TYPE,
  salonRoleOf,
  salonPermissionsOf,
  hasSalonPermission
}
