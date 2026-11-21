'use strict'

const { salonRoute } = require('./http')
const { publicTenant, publicStore } = require('../../service/salonContext')

// GET /salon/context — contract `AuthContext` for FE-SALON-App: the menu is
// built from these permissions (SALON-BA §3), never from the role string.
exports.getContext = salonRoute({}, async ({ user, salon }) => {
  const db = require('../../../db/models')
  const staffProfile = await db.salon_staff_profile.findOne({
    where: { userId: user.id, tenantId: salon.tenant.id, active: true },
    attributes: ['userId']
  })
  return {
    user: {
      id: String(user.id),
      name: user.fullName || user.userName,
      username: user.userName
    },
    tenant: publicTenant(salon.tenant),
    canonicalRole: salon.canonicalRole,
    permissions: salon.permissions,
    stores: salon.stores.map(publicStore),
    staffUserId: staffProfile ? String(staffProfile.userId) : null,
    onboardingRequired: salon.canonicalRole === 'owner' && salon.stores.length === 0
  }
})
