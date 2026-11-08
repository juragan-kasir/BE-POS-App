'use strict'
const { normalizeStoreIds } = require('./storeValidation')

// PGA-03 / ADR-02: a promo campaign belongs to one tenant (promo_campaign.
// tenantId, batch B11). `store: null` means every outlet of that tenant.
// A campaign whose tenantId is NULL is tenant-less: it is seen only by
// outlets that have no tenant either (pre-tenant deployments), never by an
// outlet of a tenant.

const { storeTenantId, storesTenantIds } = require('./tenantScope')

// The caller's tenant boundary for promo campaigns:
//   { global: true }          store-less vendor super_admin / platform actor
//   { global: false, tenantId } everyone else (tenantId null = an outlet
//                              without a tenant)
async function callerPromoTenant(req) {
  const ctx = req?.authContext
  if (ctx) {
    if (ctx.isPlatformAdmin && ctx.activeTenantId == null) return { global: true }
    return { global: false, tenantId: ctx.activeTenantId ?? null }
  }
  const own = Number(req?.user?.store)
  if (req?.user?.roleType === 'super_admin' && (!Number.isInteger(own) || own <= 0)) {
    return { global: true }
  }
  return { global: false, tenantId: await storeTenantId(own) }
}

// `where` narrowed to the caller's tenant (unchanged for a global caller).
async function promoTenantWhere(req, where = {}) {
  const scope = await callerPromoTenant(req)
  if (scope.global) return { ...where }
  return { ...where, tenantId: scope.tenantId }
}

// Which tenant a new or edited campaign belongs to, from the outlets it
// names (`store`) and the caller. Returns { ok: true, tenantId } or
// { ok: false, status, code, message }.
async function resolveCampaignTenant(req, store) {
  const scope = await callerPromoTenant(req)
  const storeIds = normalizeStoreIds(store)
  const tenants = await storesTenantIds(storeIds)
  if (tenants.length > 1) {
    return {
      ok: false,
      status: 400,
      code: 'PROMO_STORES_SPAN_TENANTS',
      message: 'Outlet promo harus berasal dari satu bisnis yang sama'
    }
  }
  const storesTenant = tenants.length === 1 ? tenants[0] : undefined

  if (scope.global) {
    // ADR-02: the platform vendor does not run merchant promotions.
    if (storesTenant != null) {
      return {
        ok: false,
        status: 403,
        code: 'PROMO_VENDOR_FORBIDDEN',
        message: 'Akun platform tidak dapat membuat promo untuk merchant'
      }
    }
    return { ok: true, tenantId: null }
  }

  if (storesTenant !== undefined && storesTenant !== scope.tenantId) {
    return {
      ok: false,
      status: 403,
      code: 'FOREIGN_STORE',
      message: 'Anda hanya dapat membuat promo untuk outlet bisnis Anda'
    }
  }
  return { ok: true, tenantId: scope.tenantId }
}

module.exports = {
  storeTenantId,
  storesTenantIds,
  callerPromoTenant,
  promoTenantWhere,
  resolveCampaignTenant
}
