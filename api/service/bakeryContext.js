'use strict'

const db = require('../../db/models')
const { bakeryRoleOf, bakeryPermissionsOf } = require('../../utils/bakeryCapabilities')

// Who is calling /bakery/*: the bakery tenant, the canonical role, the
// permissions and the outlets the actor may address. Mirrors
// api/service/salonContext.js.

class BakeryError extends Error {
  constructor(code, message, status = 400, details) {
    super(message)
    this.code = code
    this.status = status
    this.details = details
  }
}

const DEFAULT_SETTINGS = Object.freeze({
  businessType: 'bakery',
  leadTimeMinutes: 60,
  pickupOpen: '08:00',
  pickupClose: '17:00',
  deliveryEnabled: false,
  waNoteTemplate: 'Halo {customer}, pesanan {orderNo} total {total}, DP {dp}, sisa {remaining}. Ambil {schedule}.',
  waReadyTemplate: 'Halo {customer}, pesanan {orderNo} sudah siap diambil.',
  waReminderTemplate: 'Halo {customer}, mengingatkan pesanan {orderNo} dijadwalkan {schedule}.'
})

const tenantSettings = (tenant) => ({
  ...DEFAULT_SETTINGS,
  ...(tenant?.bakerySettings && typeof tenant.bakerySettings === 'object' ? tenant.bakerySettings : {}),
  businessType: 'bakery'
})

/** Contract `Tenant`. */
const publicTenant = (tenant) => ({ id: String(tenant.id), name: tenant.name, settings: tenantSettings(tenant) })

/** Contract `Store`. */
const publicStore = (location) => ({
  id: String(location.id),
  name: location.name || '',
  timezone: location.timezone || 'Asia/Jakarta',
  address: location.detailLocation || location.address || null,
  phone: location.phoneNumber || null,
  active: location.status !== 'inactive'
})

const findTenantOf = async (user) => {
  const ownStore = Number(user.store)
  if (Number.isInteger(ownStore) && ownStore > 0) {
    const location = await db.location.findByPk(ownStore, { attributes: ['id', 'tenantId'] })
    if (location?.tenantId != null) return db.tenant.findByPk(location.tenantId)
  }
  if (user.roleType === 'super_admin') return db.tenant.findOne({ where: { ownerId: user.id } })
  return null
}

/** Resolve the bakery actor once per request (cached on req.bakery). */
const resolveBakeryActor = async (req) => {
  if (req.bakery) return req.bakery
  const user = req.user
  const canonicalRole = bakeryRoleOf(user)
  if (!canonicalRole) throw new BakeryError('FORBIDDEN', 'Akun ini tidak punya akses bakery', 403)
  const tenant = await findTenantOf(user)
  if (!tenant || tenant.businessType !== 'bakery') {
    throw new BakeryError('FORBIDDEN', 'Akun ini bukan milik usaha bakery', 403)
  }
  const tenantStores = await db.location.findAll({ where: { tenantId: tenant.id }, order: [['id', 'ASC']] })
  // Owner: every outlet of the tenant. Admin / kasir / staff: their own outlet.
  const stores = canonicalRole === 'owner' ? tenantStores : tenantStores.filter((s) => Number(s.id) === Number(user.store))
  req.bakery = { user, tenant, canonicalRole, permissions: [...bakeryPermissionsOf(user)], stores }
  return req.bakery
}

/** The outlet a request acts on: `?store=`, or the actor's only outlet. */
const resolveBakeryStore = (bakery, requested) => {
  const raw = requested === undefined || requested === null || requested === '' ? null : String(requested)
  if (raw == null) {
    if (bakery.stores.length === 1) return bakery.stores[0]
    throw new BakeryError('FORBIDDEN', 'Pilih outlet terlebih dahulu', 403, { store: null })
  }
  const store = bakery.stores.find((s) => String(s.id) === raw)
  if (!store) throw new BakeryError('FORBIDDEN', 'Outlet di luar akses kamu', 403, { store: raw })
  return store
}

module.exports = {
  BakeryError,
  DEFAULT_SETTINGS,
  tenantSettings,
  publicTenant,
  publicStore,
  resolveBakeryActor,
  resolveBakeryStore
}
