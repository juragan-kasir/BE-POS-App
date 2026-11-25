'use strict'

const db = require('../../db/models')
const { salonRoleOf, salonPermissionsOf } = require('../../utils/salonCapabilities')

// Who is calling a /salon/* route: their salon tenant, canonical role,
// permissions and the outlets they may address (BR-SLN-020). Everything is
// read from the authenticated user, never from request input.
//
// Tenant: the tenant of the user's outlet, or — for an owner who has not
// created an outlet yet (onboarding) — the tenant they own. Only a tenant
// with businessType 'salon' can use the salon API.

class SalonError extends Error {
  constructor(code, message, status = 409, details) {
    super(message)
    this.code = code
    this.status = status
    this.details = details
  }
}

const DEFAULT_TENANT_SETTINGS = Object.freeze({
  salonProfile: 'salon',
  slotStepMin: 15,
  depositDefault: 0,
  pointsPer: 10000
})
const DEFAULT_OPEN_TIME = '09:00'
const DEFAULT_CLOSE_TIME = '21:00'

const tenantSettings = (tenant) => ({
  ...DEFAULT_TENANT_SETTINGS,
  ...(tenant?.salonSettings && typeof tenant.salonSettings === 'object' ? tenant.salonSettings : {})
})

/** Contract `Tenant` (FE-SALON-App src/api/contract.ts). */
const publicTenant = (tenant) => ({
  id: String(tenant.id),
  name: tenant.name,
  businessType: 'salon',
  settings: tenantSettings(tenant)
})

/** Contract `Store`. Opening hours live in location.salonSettings. */
const publicStore = (location) => {
  const settings = location.salonSettings || {}
  return {
    id: String(location.id),
    name: location.name || '',
    address: location.detailLocation || location.address || '',
    phone: location.phoneNumber || '',
    timezone: location.timezone || 'Asia/Jakarta',
    openTime: settings.openTime || DEFAULT_OPEN_TIME,
    closeTime: settings.closeTime || DEFAULT_CLOSE_TIME,
    active: location.status !== 'inactive',
    // From the model getter: whether a refund owner PIN is set (never the hash).
    hasOwnerPin: Boolean(settings.hasOwnerPin)
  }
}

const findTenantOf = async (user) => {
  const ownStore = Number(user.store)
  if (Number.isInteger(ownStore) && ownStore > 0) {
    const location = await db.location.findByPk(ownStore, { attributes: ['id', 'tenantId'] })
    if (location?.tenantId != null) return db.tenant.findByPk(location.tenantId)
  }
  if (user.roleType === 'super_admin') return db.tenant.findOne({ where: { ownerId: user.id } })
  return null
}

/**
 * Resolve the salon actor once per request (cached on req.salon).
 * Throws SalonError FORBIDDEN when the user has no salon tenant or role.
 */
const resolveSalonActor = async (req) => {
  if (req.salon) return req.salon
  const user = req.user
  const canonicalRole = salonRoleOf(user)
  if (!canonicalRole) throw new SalonError('FORBIDDEN', 'Akun ini tidak punya akses salon', 403)
  const tenant = await findTenantOf(user)
  if (!tenant || tenant.businessType !== 'salon') {
    throw new SalonError('FORBIDDEN', 'Akun ini bukan milik usaha salon', 403)
  }
  const tenantStores = await db.location.findAll({
    where: { tenantId: tenant.id },
    order: [['id', 'ASC']]
  })
  // Owner: every outlet of the tenant. Admin / kasir / staff: their own outlet.
  const stores = canonicalRole === 'owner'
    ? tenantStores
    : tenantStores.filter((s) => Number(s.id) === Number(user.store))
  req.salon = {
    user,
    tenant,
    canonicalRole,
    permissions: [...salonPermissionsOf(user)],
    stores
  }
  return req.salon
}

/**
 * The outlet a request acts on: `?store=` (or body.store), which must be one
 * of the actor's outlets. Without one, a single-outlet actor uses theirs.
 */
const resolveSalonStore = (salon, requested) => {
  const raw = requested === undefined || requested === null || requested === '' ? null : String(requested)
  if (raw == null) {
    if (salon.stores.length === 1) return salon.stores[0]
    throw new SalonError('FORBIDDEN', 'Pilih outlet terlebih dahulu', 403, { store: null })
  }
  const store = salon.stores.find((s) => String(s.id) === raw)
  if (!store) throw new SalonError('FORBIDDEN', 'Outlet di luar akses kamu', 403, { store: raw })
  return store
}

module.exports = {
  SalonError,
  DEFAULT_TENANT_SETTINGS,
  tenantSettings,
  publicTenant,
  publicStore,
  resolveSalonActor,
  resolveSalonStore
}
