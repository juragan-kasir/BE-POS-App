process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// AUTH-1 follow-up (AUD-3 dependency hardening) tests.
// Pins the authContext invariants AUD-3 will consume:
//   F1 — auditScopeFor/assignedStoreIds never mix stores across tenants;
//   F2 — legacy super_admin is platform-scoped only when the account is
//        global (user.store null, the repo's existing CRIT-3/MED-2 rule);
//        store-bound super_admin gets no legacy platform authority;
//   F3 — a membership on a soft-deleted tenant authorizes nothing.
// Isolated test database (jest globalSetup); AUTH_H_ fixtures removed in
// afterAll. Never touches real data.
const db = require('../db/models')
const {
  resolveAuthorizationContext,
  can,
  auditScopeFor
} = require('../utils/authContext')

const P = 'AUTH_H_'

let tenantA = null
let tenantB = null
let tenantSuspended = null
let tenantDeleted = null
let storeA1 = null
let storeA2 = null
let storeB1 = null
let storeS1 = null
let storeD1 = null
const users = {}

const mkUser = async (key, roleType, extra = {}) => {
  users[key] = await db.user.create({
    userName: `${P}${key}`,
    email: `${P}${key}@test.com`,
    roleType,
    status: 'active',
    password: 'Test12345',
    ...extra
  })
  return users[key]
}

beforeAll(async () => {
  tenantA = await db.tenant.create({ code: `${P}A`, name: `${P}Tenant A` })
  tenantB = await db.tenant.create({ code: `${P}B`, name: `${P}Tenant B` })
  tenantSuspended = await db.tenant.create({ code: `${P}S`, name: `${P}Tenant S`, status: 'suspended' })
  tenantDeleted = await db.tenant.create({ code: `${P}D`, name: `${P}Tenant D` })

  storeA1 = await db.location.create({ name: `${P}STORE_A1`, status: 'active', tenantId: tenantA.id })
  storeA2 = await db.location.create({ name: `${P}STORE_A2`, status: 'active', tenantId: tenantA.id })
  storeB1 = await db.location.create({ name: `${P}STORE_B1`, status: 'active', tenantId: tenantB.id })
  storeS1 = await db.location.create({ name: `${P}STORE_S1`, status: 'active', tenantId: tenantSuspended.id })
  storeD1 = await db.location.create({ name: `${P}STORE_D1`, status: 'active', tenantId: tenantDeleted.id })

  // F1: store_admin in A (A1) and store_admin in B (B1).
  const twoStoreAdmin = await mkUser('two_store_admin', 'admin')
  await db.tenantMembership.create({ userId: twoStoreAdmin.id, tenantId: tenantA.id, role: 'store_admin', status: 'ACTIVE' })
  await db.tenantMembership.create({ userId: twoStoreAdmin.id, tenantId: tenantB.id, role: 'store_admin', status: 'ACTIVE' })
  await db.storeAssignment.create({ userId: twoStoreAdmin.id, tenantId: tenantA.id, storeId: storeA1.id })
  await db.storeAssignment.create({ userId: twoStoreAdmin.id, tenantId: tenantB.id, storeId: storeB1.id })

  // F1: store_admin in A (A1) and cashier in B (B1, no audit.read there).
  const mixed = await mkUser('store_admin_cashier', 'admin')
  await db.tenantMembership.create({ userId: mixed.id, tenantId: tenantA.id, role: 'store_admin', status: 'ACTIVE' })
  await db.tenantMembership.create({ userId: mixed.id, tenantId: tenantB.id, role: 'cashier', status: 'ACTIVE' })
  await db.storeAssignment.create({ userId: mixed.id, tenantId: tenantA.id, storeId: storeA1.id })
  await db.storeAssignment.create({ userId: mixed.id, tenantId: tenantB.id, storeId: storeB1.id })

  // F1: tenant-inconsistent assignment rows. The model hook rejects these on
  // instance create, but bulkCreate skips per-instance hooks and raw writes
  // exist — the resolver must not trust assignment.tenantId alone.
  const inconsistent = await mkUser('inconsistent', 'admin')
  await db.tenantMembership.create({ userId: inconsistent.id, tenantId: tenantA.id, role: 'store_admin', status: 'ACTIVE' })
  await db.tenantMembership.create({ userId: inconsistent.id, tenantId: tenantB.id, role: 'store_admin', status: 'ACTIVE' })
  await db.storeAssignment.create({ userId: inconsistent.id, tenantId: tenantA.id, storeId: storeA2.id })
  await db.storeAssignment.bulkCreate([
    // recorded under tenant A, but store B1 belongs to tenant B
    { userId: inconsistent.id, tenantId: tenantA.id, storeId: storeB1.id },
    // recorded under tenant B, but store A1 belongs to tenant A
    { userId: inconsistent.id, tenantId: tenantB.id, storeId: storeA1.id }
  ])

  // F1: tenant_admin in A who is also store_admin in B.
  const tenantAdmin = await mkUser('tenant_admin', 'admin')
  await db.tenantMembership.create({ userId: tenantAdmin.id, tenantId: tenantA.id, role: 'tenant_admin', status: 'ACTIVE' })
  await db.tenantMembership.create({ userId: tenantAdmin.id, tenantId: tenantB.id, role: 'store_admin', status: 'ACTIVE' })
  await db.storeAssignment.create({ userId: tenantAdmin.id, tenantId: tenantB.id, storeId: storeB1.id })

  // F1: store_admin with a membership but no assignment.
  const unassigned = await mkUser('unassigned_store_admin', 'admin')
  await db.tenantMembership.create({ userId: unassigned.id, tenantId: tenantA.id, role: 'store_admin', status: 'ACTIVE' })

  // F2: legacy super_admin variants (repo convention: store null = global).
  await mkUser('global_super', 'super_admin', { store: null })
  await mkUser('store_bound_super', 'super_admin', { store: storeA1.id })
  const boundWithMembership = await mkUser('store_bound_super_member', 'super_admin', { store: storeA1.id })
  await db.tenantMembership.create({ userId: boundWithMembership.id, tenantId: tenantA.id, role: 'tenant_admin', status: 'ACTIVE' })

  // F3: membership status × tenant state matrix (tenant_admin role each).
  const f3 = async (key, tenant, status, storeId) => {
    const u = await mkUser(key, 'admin')
    await db.tenantMembership.create({ userId: u.id, tenantId: tenant.id, role: 'tenant_admin', status })
    if (storeId) await db.storeAssignment.create({ userId: u.id, tenantId: tenant.id, storeId })
  }
  await f3('active_active', tenantA, 'ACTIVE')
  await f3('active_suspended', tenantSuspended, 'ACTIVE', storeS1.id)
  await f3('active_deleted', tenantDeleted, 'ACTIVE', storeD1.id)
  await f3('deactivated_active', tenantA, 'DEACTIVATED')
  await f3('retired_active', tenantA, 'RETIRED')
  // Soft-delete AFTER memberships/assignments exist (paranoid tenant row).
  await tenantDeleted.destroy()
})

afterAll(async () => {
  const tenantIds = [tenantA, tenantB, tenantSuspended, tenantDeleted].filter(Boolean).map((t) => t.id)
  const userIds = Object.values(users).map((u) => u.id)
  await db.storeAssignment.destroy({ where: { userId: userIds }, force: true })
  await db.tenantMembership.destroy({ where: { userId: userIds }, force: true })
  await db.user.destroy({ where: { id: userIds }, force: true })
  await db.location.destroy({
    where: { id: [storeA1, storeA2, storeB1, storeS1, storeD1].filter(Boolean).map((s) => s.id) },
    force: true
  })
  await db.tenant.destroy({ where: { id: tenantIds }, force: true, paranoid: false })
  await db.sequelize.close()
})

const ctxFor = (key, opts = {}) =>
  resolveAuthorizationContext(db, { userId: users[key].id, ...opts })

describe('F1 — audit/store scope never crosses tenants', () => {
  test('store_admin in A(A1) and B(B1), active A → only A1', async () => {
    const ctx = await ctxFor('two_store_admin', { activeTenantId: tenantA.id })
    expect(ctx.activeTenantId).toBe(tenantA.id)
    expect(ctx.activeRole).toBe('store_admin')
    expect(ctx.assignedStoreIds).toEqual([storeA1.id])
    expect(auditScopeFor(ctx)).toEqual({ tenantId: tenantA.id, storeIds: [storeA1.id] })
  })

  test('same user, active B → only B1', async () => {
    const ctx = await ctxFor('two_store_admin', { activeTenantId: tenantB.id })
    expect(ctx.assignedStoreIds).toEqual([storeB1.id])
    expect(auditScopeFor(ctx)).toEqual({ tenantId: tenantB.id, storeIds: [storeB1.id] })
  })

  test('store_admin@A + cashier@B, active A → B1 (no audit.read in B) never leaks into A scope', async () => {
    const ctx = await ctxFor('store_admin_cashier', { activeTenantId: tenantA.id })
    expect(ctx.assignedStoreIds).toEqual([storeA1.id])
    expect(auditScopeFor(ctx)).toEqual({ tenantId: tenantA.id, storeIds: [storeA1.id] })
    expect(can(ctx, 'audit.read', { storeId: storeB1.id })).toBe(false)
  })

  test('store_admin@A + cashier@B, active B → no audit scope at all', async () => {
    const ctx = await ctxFor('store_admin_cashier', { activeTenantId: tenantB.id })
    expect(ctx.activeRole).toBe('cashier')
    expect(auditScopeFor(ctx)).toBeNull()
  })

  test('assignment whose store belongs to another tenant is ignored (recorded under active tenant)', async () => {
    const ctx = await ctxFor('inconsistent', { activeTenantId: tenantA.id })
    // A2 is a consistent assignment; B1 (tenant B store recorded under A) and
    // A1 (tenant A store recorded under the B membership) are both excluded.
    expect(ctx.assignedStoreIds).toEqual([storeA2.id])
    expect(auditScopeFor(ctx)).toEqual({ tenantId: tenantA.id, storeIds: [storeA2.id] })
  })

  test('assignment recorded under another membership never authorizes a store in the active tenant', async () => {
    const ctx = await ctxFor('inconsistent', { activeTenantId: tenantA.id })
    expect(can(ctx, 'audit.read', { storeId: storeA1.id })).toBe(false)
    const pick = await ctxFor('inconsistent', { activeTenantId: tenantA.id, activeStoreId: storeA1.id })
    expect(pick.activeStoreId).toBeNull()
    expect(pick.reason).toBe('unassigned-store')
  })

  test('tenant-inconsistent assignment in the other direction is ignored too (active B)', async () => {
    const ctx = await ctxFor('inconsistent', { activeTenantId: tenantB.id })
    expect(ctx.assignedStoreIds).toEqual([])
    expect(auditScopeFor(ctx)).toBeNull()
  })

  test('store_admin without any assignment in the active tenant → fail closed (null)', async () => {
    const ctx = await ctxFor('unassigned_store_admin', { activeTenantId: tenantA.id })
    expect(ctx.activeRole).toBe('store_admin')
    expect(ctx.assignedStoreIds).toEqual([])
    expect(auditScopeFor(ctx)).toBeNull()
  })

  test('multiple memberships and no active tenant → fail closed', async () => {
    const ctx = await ctxFor('two_store_admin')
    expect(ctx.activeTenantId).toBeNull()
    expect(ctx.assignedStoreIds).toEqual([])
    expect(auditScopeFor(ctx)).toBeNull()
    expect([...ctx.effectiveTenantIds].sort()).toEqual([tenantA.id, tenantB.id].sort())
  })

  test('foreign active tenant → fail closed', async () => {
    const ctx = await ctxFor('two_store_admin', { activeTenantId: tenantSuspended.id })
    expect(ctx.activeTenantId).toBeNull()
    expect(ctx.reason).toBe('foreign-or-inactive-tenant')
    expect(auditScopeFor(ctx)).toBeNull()
  })

  test('tenant_admin stays tenant-wide within its own tenant and never crosses', async () => {
    const ctxA = await ctxFor('tenant_admin', { activeTenantId: tenantA.id })
    expect(auditScopeFor(ctxA)).toEqual({ tenantId: tenantA.id, storeIds: null })
    expect(ctxA.assignedStoreIds).toEqual([])
    expect(can(ctxA, 'audit.read', { storeId: storeB1.id })).toBe(false)
    expect(can(ctxA, 'audit.read', { tenantId: tenantB.id })).toBe(false)
    const ctxB = await ctxFor('tenant_admin', { activeTenantId: tenantB.id })
    expect(auditScopeFor(ctxB)).toEqual({ tenantId: tenantB.id, storeIds: [storeB1.id] })
  })
})

describe('F2 — legacy super_admin scope follows the global/store-bound account rule', () => {
  test('global super_admin (user.store null) keeps the platform compatibility alias', async () => {
    const ctx = await ctxFor('global_super')
    expect(ctx.isPlatformAdmin).toBe(true)
    expect(ctx.viaLegacyClaims).toBe(true)
    expect(ctx.activeRole).toBe('platform_admin')
    expect(auditScopeFor(ctx)).toEqual({ tenantId: null, storeIds: null })
    expect(ctx.legacySuperAdminScope).toBe('global')
  })

  test('store-bound super_admin (user.store set) gets NO platform authority', async () => {
    const ctx = await ctxFor('store_bound_super')
    expect(ctx.eligible).toBe(true)
    expect(ctx.isPlatformAdmin).toBe(false)
    expect(ctx.viaLegacyClaims).toBe(false)
    expect(ctx.activeRole).toBeNull()
    expect(ctx.permissions).toEqual([])
    expect(can(ctx, 'tenant.manage')).toBe(false)
    expect(can(ctx, 'backup.manage')).toBe(false)
    expect(can(ctx, 'audit.read', {})).toBe(false)
    expect(auditScopeFor(ctx)).toBeNull()
    expect(ctx.legacySuperAdminScope).toBe('store-bound')
  })

  test('store-bound super_admin requesting a foreign tenant gets no platform fallback', async () => {
    const ctx = await ctxFor('store_bound_super', { activeTenantId: tenantB.id })
    expect(ctx.isPlatformAdmin).toBe(false)
    expect(ctx.activeRole).toBeNull()
    expect(ctx.permissions).toEqual([])
    expect(auditScopeFor(ctx)).toBeNull()
  })

  test('store-bound super_admin with an explicit membership is governed by that membership only', async () => {
    const ctx = await ctxFor('store_bound_super_member', { activeTenantId: tenantA.id })
    expect(ctx.isPlatformAdmin).toBe(false)
    expect(ctx.activeRole).toBe('tenant_admin')
    expect(auditScopeFor(ctx)).toEqual({ tenantId: tenantA.id, storeIds: null })
    expect(can(ctx, 'tenant.manage')).toBe(false)
    expect(can(ctx, 'audit.read', { tenantId: tenantB.id })).toBe(false)
  })

  test('non-super_admin accounts never carry a legacy super_admin scope', async () => {
    const ctx = await ctxFor('tenant_admin', { activeTenantId: tenantA.id })
    expect(ctx.legacySuperAdminScope).toBeNull()
  })
})

describe('F3 — membership effectiveness requires a live, active tenant', () => {
  test('ACTIVE membership + active tenant → effective', async () => {
    const ctx = await ctxFor('active_active', { activeTenantId: tenantA.id })
    expect(ctx.activeTenantId).toBe(tenantA.id)
    expect(ctx.activeRole).toBe('tenant_admin')
    expect(auditScopeFor(ctx)).toEqual({ tenantId: tenantA.id, storeIds: null })
    expect(ctx.effectiveTenantIds).toEqual([tenantA.id])
  })

  test('ACTIVE membership + suspended tenant → denied', async () => {
    const ctx = await ctxFor('active_suspended', { activeTenantId: tenantSuspended.id })
    expect(ctx.activeTenantId).toBeNull()
    expect(ctx.reason).toBe('foreign-or-inactive-tenant')
    expect(ctx.assignedStoreIds).toEqual([])
    expect(can(ctx, 'audit.read', { tenantId: tenantSuspended.id })).toBe(false)
    expect(auditScopeFor(ctx)).toBeNull()
    expect(ctx.effectiveTenantIds).toEqual([])
  })

  test('ACTIVE membership + soft-deleted tenant → denied (explicit request)', async () => {
    const ctx = await ctxFor('active_deleted', { activeTenantId: tenantDeleted.id })
    expect(ctx.activeTenantId).toBeNull()
    expect(ctx.activeRole).toBeNull()
    expect(ctx.permissions).toEqual([])
    expect(ctx.reason).toBe('foreign-or-inactive-tenant')
    expect(ctx.assignedStoreIds).toEqual([])
    expect(can(ctx, 'user.manage', { tenantId: tenantDeleted.id })).toBe(false)
    expect(auditScopeFor(ctx)).toBeNull()
    expect(ctx.effectiveTenantIds).toEqual([])
  })

  test('ACTIVE membership + soft-deleted tenant → no implicit default tenant either', async () => {
    const ctx = await ctxFor('active_deleted')
    expect(ctx.activeTenantId).toBeNull()
    expect(auditScopeFor(ctx)).toBeNull()
    // The membership row itself is preserved, not deleted.
    const kept = await db.tenantMembership.findOne({ where: { userId: users.active_deleted.id } })
    expect(kept).not.toBeNull()
    expect(ctx.effectiveTenantIds).toEqual([])
  })

  test('DEACTIVATED membership + active tenant → denied', async () => {
    const ctx = await ctxFor('deactivated_active', { activeTenantId: tenantA.id })
    expect(ctx.activeTenantId).toBeNull()
    expect(auditScopeFor(ctx)).toBeNull()
    expect(ctx.effectiveTenantIds).toEqual([])
  })

  test('RETIRED membership + active tenant → denied', async () => {
    const ctx = await ctxFor('retired_active', { activeTenantId: tenantA.id })
    expect(ctx.activeTenantId).toBeNull()
    expect(auditScopeFor(ctx)).toBeNull()
    expect(ctx.effectiveTenantIds).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// AUTH-1 remediation/finalization — additional fail-closed invariants.
// ---------------------------------------------------------------------------

describe('Legacy roleType never grants authority by itself', () => {
  let legacyAdmin = null
  let forgedTarget = null
  beforeAll(async () => {
    legacyAdmin = await mkUser('legacy_admin_nomember', 'admin', { store: storeA1.id })
    forgedTarget = await mkUser('forged_target', 'kasir', { store: storeA1.id })
  })

  const forgeAndResolve = async (user, claims, opts = {}) => {
    const { signSessionToken } = require('../test-helpers/authSession')
    const token = await signSessionToken(
      { id: user.id, userName: 'x', ...claims },
      process.env.JWT_SECRET_KEY || 'secret-key-user'
    )
    const authorization = require('../utils/authorization')
    const req = { headers: { authorization: `Bearer ${token}` }, cookies: {} }
    await new Promise((resolve) => authorization(req, {}, resolve))
    expect(req.user.id).toBe(user.id)
    // Only the account id leaves the token; everything else is DB state.
    return resolveAuthorizationContext(db, { userId: req.user.id, ...opts })
  }

  test('legacy admin without membership → no role, no permission, no audit scope', async () => {
    const ctx = await ctxFor('legacy_admin_nomember')
    expect(ctx.eligible).toBe(true)
    expect(ctx.isPlatformAdmin).toBe(false)
    expect(ctx.activeRole).toBeNull()
    expect(ctx.permissions).toEqual([])
    expect(can(ctx, 'audit.read', { storeId: storeA1.id })).toBe(false)
    expect(auditScopeFor(ctx)).toBeNull()
    expect(ctx.legacySuperAdminScope).toBeNull()
  })

  test('unknown legacy roleType cannot be persisted (user.roleType is a DB ENUM)', async () => {
    await expect(
      db.user.create({ userName: `${P}unknown_role`, email: `${P}unknown_role@test.com`, roleType: 'owner', status: 'active', password: 'Test12345' })
    ).rejects.toThrow()
  })

  test('unknown legacy roleType reaching the resolver (stub row) → no authority', async () => {
    const stub = {
      user: { findByPk: async () => ({ id: 1, status: 'active', roleType: 'owner', store: null }) },
      tenantMembership: { findAll: async () => [] },
      storeAssignment: { findAll: async () => [] },
      location: { findAll: async () => [] }
    }
    const ctx = await resolveAuthorizationContext(stub, { userId: 1, activeTenantId: 1 })
    expect(ctx.eligible).toBe(true)
    expect(ctx.legacySuperAdminScope).toBeNull()
    expect(ctx.isPlatformAdmin).toBe(false)
    expect(ctx.activeRole).toBeNull()
    expect(ctx.permissions).toEqual([])
    expect(auditScopeFor(ctx)).toBeNull()
  })

  test('forged super_admin + store:null claims on a kasir account → no platform', async () => {
    const ctx = await forgeAndResolve(forgedTarget, { roleType: 'super_admin', roleId: 1, store: null })
    expect(ctx.isPlatformAdmin).toBe(false)
    expect(ctx.legacySuperAdminScope).toBeNull()
    expect(can(ctx, 'tenant.manage')).toBe(false)
    expect(auditScopeFor(ctx)).toBeNull()
  })

  test('forged store:null claim on a store-bound super_admin → still store-bound (DB store wins)', async () => {
    const ctx = await forgeAndResolve(users.store_bound_super, { roleType: 'super_admin', store: null })
    expect(ctx.isPlatformAdmin).toBe(false)
    expect(ctx.legacySuperAdminScope).toBe('store-bound')
    expect(auditScopeFor(ctx)).toBeNull()
  })

  test('forged tenant/store claims on a membership-less legacy admin → nothing', async () => {
    const ctx = await forgeAndResolve(legacyAdmin, { roleType: 'super_admin', store: null }, {
      activeTenantId: tenantA.id,
      activeStoreId: storeA1.id
    })
    expect(ctx.activeTenantId).toBeNull()
    expect(ctx.activeStoreId).toBeNull()
    expect(ctx.reason).toBe('foreign-or-inactive-tenant')
    expect(auditScopeFor(ctx)).toBeNull()
  })

  test('legacy vocabulary mapping stays explicit; unknown maps to the zero-permission staff baseline', () => {
    const { legacyRoleTypeToTarget, ROLE_BASELINE_PERMISSIONS } = require('../utils/authContext')
    expect(legacyRoleTypeToTarget('admin')).toBe('store_admin')
    expect(legacyRoleTypeToTarget('owner')).toBe('staff')
    expect(ROLE_BASELINE_PERMISSIONS.staff).toEqual([])
  })
})

describe('Unknown membership role never becomes effective', () => {
  let odd = null
  beforeAll(async () => {
    odd = await mkUser('unknown_membership_role', 'admin')
    // bulkCreate skips model validation by default — the resolver must not
    // rely on the model's isIn validator to keep foreign vocabulary out.
    // 'manager' is outside the vocabulary in every mode. ('owner' used to be
    // the example; it is canonical vocabulary under AUTHZ_OWNER_V2, and its
    // flag-OFF inertness is pinned in owner-v2-flag-off.test.js.)
    await db.tenantMembership.bulkCreate([
      { userId: odd.id, tenantId: tenantA.id, role: 'manager', status: 'ACTIVE' }
    ])
  })

  test('ACTIVE membership with a role outside the target vocabulary → denied', async () => {
    const ctx = await ctxFor('unknown_membership_role', { activeTenantId: tenantA.id })
    expect(ctx.activeTenantId).toBeNull()
    expect(ctx.activeRole).toBeNull()
    expect(ctx.permissions).toEqual([])
    expect(ctx.reason).toBe('foreign-or-inactive-tenant')
    expect(ctx.effectiveTenantIds).toEqual([])
  })
})

describe('Tenant liveness is validated explicitly, not via the ORM join side effect', () => {
  // Stub db: the tenant row is present but carries deletedAt — as it would
  // if the include were ever loaded non-paranoid. Must still deny.
  const stubDb = (tenant) => ({
    user: { findByPk: async () => ({ id: 1, status: 'active', roleType: 'admin', store: null }) },
    tenantMembership: {
      findAll: async () => [{ userId: 1, tenantId: 7, role: 'tenant_admin', status: 'ACTIVE', tenant }]
    },
    storeAssignment: { findAll: async () => [] },
    location: { findAll: async () => [{ id: 70 }] }
  })

  test('tenant row with deletedAt set → not effective', async () => {
    const ctx = await resolveAuthorizationContext(
      stubDb({ id: 7, status: 'active', deletedAt: new Date() }),
      { userId: 1, activeTenantId: 7 }
    )
    expect(ctx.activeTenantId).toBeNull()
    expect(ctx.effectiveTenantIds).toEqual([])
    expect(auditScopeFor(ctx)).toBeNull()
  })

  test('tenant row missing entirely (null include) → not effective', async () => {
    const ctx = await resolveAuthorizationContext(stubDb(null), { userId: 1, activeTenantId: 7 })
    expect(ctx.activeTenantId).toBeNull()
    expect(ctx.effectiveTenantIds).toEqual([])
  })

  test('live active tenant row (deletedAt null) → effective', async () => {
    const ctx = await resolveAuthorizationContext(
      stubDb({ id: 7, status: 'active', deletedAt: null }),
      { userId: 1, activeTenantId: 7 }
    )
    expect(ctx.activeTenantId).toBe(7)
    expect(ctx.effectiveTenantIds).toEqual([7])
  })

  test('resolver asks the DB for tenant deletedAt explicitly', async () => {
    let includeAttrs = null
    const db2 = stubDb({ id: 7, status: 'active', deletedAt: null })
    const orig = db2.tenantMembership.findAll
    db2.tenantMembership.findAll = async (opts) => {
      includeAttrs = opts.include[0].attributes
      return orig(opts)
    }
    await resolveAuthorizationContext(db2, { userId: 1, activeTenantId: 7 })
    expect(includeAttrs).toEqual(expect.arrayContaining(['id', 'status', 'deletedAt']))
  })
})

describe('Active store candidates are validated against persisted state', () => {
  test('foreign active store (other tenant) → denied with reason', async () => {
    const ctx = await ctxFor('tenant_admin', { activeTenantId: tenantA.id, activeStoreId: storeB1.id })
    expect(ctx.activeStoreId).toBeNull()
    expect(ctx.reason).toBe('foreign-store')
  })

  test('unassigned store in own tenant → excluded for store_admin', async () => {
    const ctx = await ctxFor('two_store_admin', { activeTenantId: tenantA.id, activeStoreId: storeA2.id })
    expect(ctx.activeStoreId).toBeNull()
    expect(ctx.reason).toBe('unassigned-store')
    expect(ctx.assignedStoreIds).toEqual([storeA1.id])
    expect(ctx.assignedStoreIds).not.toContain(storeA2.id)
    expect(can(ctx, 'audit.read', { storeId: storeA2.id })).toBe(false)
  })

  test('platform actor cannot select a store that does not exist', async () => {
    const ctx = await ctxFor('global_super', { activeStoreId: 2147483000 })
    expect(ctx.isPlatformAdmin).toBe(true)
    expect(ctx.activeStoreId).toBeNull()
    expect(ctx.reason).toBe('foreign-store')
  })

  test('platform actor may select an existing store platform-wide', async () => {
    const ctx = await ctxFor('global_super', { activeStoreId: storeB1.id })
    expect(ctx.activeStoreId).toBe(storeB1.id)
  })
})

describe('can() fails closed on malformed scope ids', () => {
  test('tenant_admin: malformed tenantId/storeId never pass as "unscoped"', async () => {
    const ctx = await ctxFor('tenant_admin', { activeTenantId: tenantA.id })
    expect(can(ctx, 'user.manage', { tenantId: tenantA.id })).toBe(true)
    expect(can(ctx, 'user.manage', { tenantId: 'abc' })).toBe(false)
    expect(can(ctx, 'user.manage', { tenantId: -1 })).toBe(false)
    expect(can(ctx, 'user.manage', { tenantId: 0 })).toBe(false)
    expect(can(ctx, 'audit.read', { storeId: `${storeB1.id}abc` })).toBe(false)
    // Number([x]) === x — an array must not coerce into a valid own-tenant id.
    expect(can(ctx, 'audit.read', { storeId: storeA2.id })).toBe(true)
    expect(can(ctx, 'audit.read', { storeId: [storeA2.id] })).toBe(false)
    expect(can(ctx, 'audit.read', { storeId: `${storeA2.id}` })).toBe(true)
  })

  test('platform actor: malformed scope ids are denied too', async () => {
    const ctx = await ctxFor('global_super')
    expect(can(ctx, 'audit.read', { tenantId: tenantB.id })).toBe(true)
    expect(can(ctx, 'audit.read', { tenantId: 'abc' })).toBe(false)
    expect(can(ctx, 'audit.read', { storeId: {} })).toBe(false)
  })
})

describe('canAccessResource — canonical resource-ownership primitive', () => {
  const { canAccessResource } = require('../utils/authContext')

  test('tenant_admin: own-tenant resources only; unowned resources denied', async () => {
    const ctx = await ctxFor('tenant_admin', { activeTenantId: tenantA.id })
    expect(canAccessResource(ctx, 'audit.read', { storeId: storeA2.id })).toBe(true)
    expect(canAccessResource(ctx, 'audit.read', { tenantId: tenantA.id })).toBe(true)
    expect(canAccessResource(ctx, 'audit.read', { tenantId: tenantA.id, storeId: storeA1.id })).toBe(true)
    expect(canAccessResource(ctx, 'audit.read', { storeId: storeB1.id })).toBe(false)
    expect(canAccessResource(ctx, 'audit.read', { tenantId: tenantB.id })).toBe(false)
    expect(canAccessResource(ctx, 'audit.read', { tenantId: tenantA.id, storeId: storeB1.id })).toBe(false)
    expect(canAccessResource(ctx, 'audit.read', { tenantId: null, storeId: null })).toBe(false)
    expect(canAccessResource(ctx, 'audit.read', {})).toBe(false)
    expect(canAccessResource(ctx, 'audit.read')).toBe(false)
  })

  test('store_admin: assigned store only', async () => {
    const ctx = await ctxFor('two_store_admin', { activeTenantId: tenantA.id })
    expect(canAccessResource(ctx, 'audit.read', { storeId: storeA1.id })).toBe(true)
    expect(canAccessResource(ctx, 'audit.read', { storeId: storeA2.id })).toBe(false)
    expect(canAccessResource(ctx, 'audit.read', { storeId: storeB1.id })).toBe(false)
    expect(canAccessResource(ctx, 'audit.read', { tenantId: tenantA.id })).toBe(false)
    expect(canAccessResource(ctx, 'audit.read', {})).toBe(false)
  })

  test('global platform actor: owned or unowned resources; malformed ids denied', async () => {
    const ctx = await ctxFor('global_super')
    expect(canAccessResource(ctx, 'audit.read', {})).toBe(true)
    expect(canAccessResource(ctx, 'audit.read', { storeId: storeB1.id })).toBe(true)
    expect(canAccessResource(ctx, 'audit.read', { tenantId: 'abc' })).toBe(false)
  })

  test('store-bound super_admin / no-context accounts: nothing', async () => {
    expect(canAccessResource(await ctxFor('store_bound_super'), 'audit.read', { storeId: storeA1.id })).toBe(false)
    expect(canAccessResource(await ctxFor('store_bound_super'), 'audit.read', {})).toBe(false)
    expect(canAccessResource(await ctxFor('legacy_admin_nomember'), 'audit.read', {})).toBe(false)
    expect(canAccessResource(null, 'audit.read', {})).toBe(false)
  })
})

describe('Role matrix: cashier / staff have no audit administration', () => {
  beforeAll(async () => {
    const cashier = await mkUser('cashier_a', 'kasir')
    await db.tenantMembership.create({ userId: cashier.id, tenantId: tenantA.id, role: 'cashier', status: 'ACTIVE' })
    await db.storeAssignment.create({ userId: cashier.id, tenantId: tenantA.id, storeId: storeA1.id })
    const staff = await mkUser('staff_a', 'user')
    await db.tenantMembership.create({ userId: staff.id, tenantId: tenantA.id, role: 'staff', status: 'ACTIVE' })
    await db.storeAssignment.create({ userId: staff.id, tenantId: tenantA.id, storeId: storeA1.id })
  })

  test.each(['cashier_a', 'staff_a'])('%s: assigned store, still no audit scope or admin permission', async (key) => {
    const ctx = await ctxFor(key, { activeTenantId: tenantA.id, activeStoreId: storeA1.id })
    expect(ctx.activeStoreId).toBe(storeA1.id)
    expect(ctx.permissions).toEqual([])
    expect(auditScopeFor(ctx)).toBeNull()
    for (const p of ['audit.read', 'user.manage', 'role.manage', 'store.manage', 'tenant.manage', 'backup.manage']) {
      expect(can(ctx, p, { storeId: storeA1.id })).toBe(false)
    }
  })
})
