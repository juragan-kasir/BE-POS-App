'use strict'

const { canonicalRoleOf, permissionsFor, buildAuthContext } = require('../api/service/bakeryContext')

const settings = {
  businessType: 'bakery',
  leadTimeMinutes: 60,
  pickupOpen: '08:00',
  pickupClose: '17:00',
  deliveryEnabled: false,
  waNoteTemplate: 'note',
  waReadyTemplate: 'ready',
  waReminderTemplate: 'reminder'
}

describe('bakery context mapping', () => {
  test('maps legacy and canonical roles', () => {
    expect(canonicalRoleOf('super_admin')).toBe('owner')
    expect(canonicalRoleOf('platform_admin')).toBe('owner')
    expect(canonicalRoleOf('tenant_admin')).toBe('owner')
    expect(canonicalRoleOf('admin')).toBe('admin')
    expect(canonicalRoleOf('store_admin')).toBe('admin')
    expect(canonicalRoleOf('kasir')).toBe('kasir')
    expect(canonicalRoleOf('cashier')).toBe('kasir')
    expect(canonicalRoleOf('user')).toBe('staff')
    expect(canonicalRoleOf('owner')).toBe('owner')
    expect(canonicalRoleOf(undefined)).toBe('staff')
  })

  test('owner/admin can manage settings; kasir cannot', () => {
    expect(permissionsFor('super_admin')).toContain('bakery.settings.manage')
    expect(permissionsFor('admin')).toContain('bakery.order.manage')
    expect(permissionsFor('kasir')).toContain('bakery.order.manage')
    expect(permissionsFor('kasir')).not.toContain('bakery.settings.manage')
    expect(permissionsFor('user')).toEqual(['bakery.order.read', 'bakery.production.read'])
  })

  test('builds the FE AuthContext shape', () => {
    const ctx = buildAuthContext({
      tenant: { id: 7, name: 'Roti', status: 'active' },
      user: { id: 3, fullName: 'Sari', email: 's@t.test' },
      stores: [{ id: '9', name: 'Outlet', timezone: 'Asia/Jakarta', address: null, phone: null, active: true }],
      role: 'admin',
      settings
    })
    expect(ctx.tenant.id).toBe('7')
    expect(ctx.tenant.settings).toBe(settings)
    expect(ctx.user).toEqual({ id: '3', name: 'Sari', email: 's@t.test' })
    expect(ctx.canonicalRole).toBe('admin')
    expect(ctx.stores).toHaveLength(1)
    expect(ctx.onboardingRequired).toBe(false)
    expect(ctx.staffUserId).toBeNull()
  })

  test('marks onboarding when there are no stores', () => {
    const ctx = buildAuthContext({
      tenant: { id: 1, name: 'T' },
      user: { id: 2, userName: 'u' },
      stores: [],
      role: 'super_admin',
      settings
    })
    expect(ctx.onboardingRequired).toBe(true)
    expect(ctx.user.name).toBe('u')
    expect(ctx.user.email).toBeNull()
    expect(ctx.staffUserId).toBeNull()
  })
})
