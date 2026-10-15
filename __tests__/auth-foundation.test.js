process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// AUTH-1 (DR-01/DR-02/DR-12 authorization foundation) tests.
// Proves the tenant entity, membership, store assignment, role vocabulary,
// permission baselines, and server-side authorization context against the
// isolated test database (jest globalSetup). Fixtures use the AUTH_T_ prefix
// and are removed in afterAll. Never touches real data.
const db = require('../db/models')
const {
  TARGET_ROLES,
  MEMBERSHIP_STATUS,
  LEGACY_ROLE_MAP,
  ROLE_BASELINE_PERMISSIONS,
  legacyRoleTypeToTarget,
  resolveAuthorizationContext,
  can
} = require('../utils/authContext')

const P = 'AUTH_T_'

let tenantA = null
let tenantB = null
let storeA1 = null
let storeA2 = null
let storeB1 = null
let userMulti = null
let userInactive = null
let userPlain = null
let legacySuper = null

beforeAll(async () => {
  tenantA = await db.tenant.create({ code: `${P}A`, name: `${P}Tenant A` })
  tenantB = await db.tenant.create({ code: `${P}B`, name: `${P}Tenant B` })

  storeA1 = await db.location.create({ name: `${P}STORE_A1`, status: 'active', tenantId: tenantA.id })
  storeA2 = await db.location.create({ name: `${P}STORE_A2`, status: 'active', tenantId: tenantA.id })
  storeB1 = await db.location.create({ name: `${P}STORE_B1`, status: 'active', tenantId: tenantB.id })

  userMulti = await db.user.create({
    userName: `${P}multi`,
    email: `${P}multi@test.com`,
    roleType: 'user',
    status: 'active',
    password: 'Test12345'
  })
  userInactive = await db.user.create({
    userName: `${P}inactive`,
    email: `${P}inactive@test.com`,
    roleType: 'user',
    status: 'active',
    password: 'Test12345'
  })
  userPlain = await db.user.create({
    userName: `${P}plain`,
    email: `${P}plain@test.com`,
    roleType: 'kasir',
    status: 'active',
    password: 'Test12345'
  })
  legacySuper = await db.user.create({
    userName: `${P}legacy_super`,
    email: `${P}legacy_super@test.com`,
    roleType: 'super_admin',
    status: 'active',
    password: 'Test12345'
  })

  // Same user, different roles per tenant.
  await db.tenantMembership.create({ userId: userMulti.id, tenantId: tenantA.id, role: 'tenant_admin', status: 'ACTIVE' })
  await db.tenantMembership.create({ userId: userMulti.id, tenantId: tenantB.id, role: 'store_admin', status: 'ACTIVE' })
  await db.storeAssignment.create({ userId: userMulti.id, tenantId: tenantB.id, storeId: storeB1.id })
  // Inactive membership with a (preserved) assignment.
  await db.tenantMembership.create({ userId: userInactive.id, tenantId: tenantA.id, role: 'store_admin', status: 'DEACTIVATED' })
  await db.storeAssignment.create({ userId: userInactive.id, tenantId: tenantA.id, storeId: storeA1.id })
})

afterAll(async () => {
  await db.storeAssignment.destroy({ where: { tenantId: [tenantA?.id, tenantB?.id].filter(Boolean) }, force: true })
  await db.tenantMembership.destroy({ where: { tenantId: [tenantA?.id, tenantB?.id].filter(Boolean) }, force: true })
  await db.location.destroy({ where: { id: [storeA1?.id, storeA2?.id, storeB1?.id].filter(Boolean) }, force: true })
  await db.user.destroy({
    where: { id: [userMulti?.id, userInactive?.id, userPlain?.id, legacySuper?.id].filter(Boolean) },
    force: true
  })
  await db.tenant.destroy({ where: { id: [tenantA?.id, tenantB?.id].filter(Boolean) }, force: true })
  await db.sequelize.close()
})

describe('AUTH-1 tenant entity', () => {
  test('tenant code is unique', async () => {
    await expect(db.tenant.create({ code: `${P}A`, name: 'dup' })).rejects.toThrow()
  })

  test('store belongs to exactly one tenant', async () => {
    const fresh = await db.location.findByPk(storeA1.id)
    expect(fresh.tenantId).toBe(tenantA.id)
  })

  test('cross-tenant store assignment is rejected', async () => {
    // storeA1 belongs to tenantA; assigning it under tenantB must fail.
    await expect(
      db.storeAssignment.create({ userId: userMulti.id, tenantId: tenantB.id, storeId: storeA1.id })
    ).rejects.toThrow(/tenant/i)
  })
})

describe('AUTH-1 membership', () => {
  test('one user can belong to multiple tenants with different roles', async () => {
    const ctxA = await resolveAuthorizationContext(db, { userId: userMulti.id, activeTenantId: tenantA.id })
    const ctxB = await resolveAuthorizationContext(db, { userId: userMulti.id, activeTenantId: tenantB.id })
    expect(ctxA.eligible).toBe(true)
    expect(ctxA.activeRole).toBe('tenant_admin')
    expect(ctxB.activeRole).toBe('store_admin')
  })

  test('membership user+tenant is unique', async () => {
    await expect(
      db.tenantMembership.create({ userId: userMulti.id, tenantId: tenantA.id, role: 'staff', status: 'ACTIVE' })
    ).rejects.toThrow()
  })

  test('DEACTIVATED membership authorizes nothing (assignment preserved but ineffective)', async () => {
    const ctx = await resolveAuthorizationContext(db, { userId: userInactive.id, activeTenantId: tenantA.id })
    expect(ctx.eligible).toBe(true)
    expect(ctx.activeTenantId).toBeNull()
    expect(can(ctx, 'audit.read', { tenantId: tenantA.id, storeId: storeA1.id })).toBe(false)
    // Assignment row itself is preserved (DR-03).
    const kept = await db.storeAssignment.findOne({ where: { userId: userInactive.id, storeId: storeA1.id } })
    expect(kept).not.toBeNull()
  })

  test('RETIRED membership authorizes nothing', async () => {
    const m = await db.tenantMembership.findOne({ where: { userId: userInactive.id, tenantId: tenantA.id } })
    await m.update({ status: 'RETIRED' })
    const ctx = await resolveAuthorizationContext(db, { userId: userInactive.id, activeTenantId: tenantA.id })
    expect(ctx.activeTenantId).toBeNull()
    await m.update({ status: 'DEACTIVATED' })
  })
})

describe('AUTH-1 store assignment', () => {
  test('assigned store is allowed for store_admin', async () => {
    const ctx = await resolveAuthorizationContext(db, {
      userId: userMulti.id,
      activeTenantId: tenantB.id,
      activeStoreId: storeB1.id
    })
    expect(ctx.activeStoreId).toBe(storeB1.id)
  })

  test('unassigned store in the same tenant is denied for store_admin', async () => {
    const other = await db.location.create({ name: `${P}STORE_B2`, status: 'active', tenantId: tenantB.id })
    try {
      const ctx = await resolveAuthorizationContext(db, {
        userId: userMulti.id,
        activeTenantId: tenantB.id,
        activeStoreId: other.id
      })
      expect(ctx.activeStoreId).toBeNull()
    } finally {
      await db.location.destroy({ where: { id: other.id }, force: true })
    }
  })

  test('tenant_admin may resolve any store within its tenant without assignment', async () => {
    const ctx = await resolveAuthorizationContext(db, {
      userId: userMulti.id,
      activeTenantId: tenantA.id,
      activeStoreId: storeA2.id
    })
    expect(ctx.activeStoreId).toBe(storeA2.id)
  })

  test('active store must belong to the active tenant', async () => {
    const ctx = await resolveAuthorizationContext(db, {
      userId: userMulti.id,
      activeTenantId: tenantA.id,
      activeStoreId: storeB1.id
    })
    expect(ctx.activeStoreId).toBeNull()
  })
})

describe('AUTH-1 roles & permissions', () => {
  test('target vocabulary is exposed and legacy mapping is explicit', async () => {
    expect(TARGET_ROLES).toEqual(expect.arrayContaining(['platform_admin', 'tenant_admin', 'store_admin', 'cashier', 'staff']))
    expect(LEGACY_ROLE_MAP.super_admin).toBe('platform_admin')
    expect(LEGACY_ROLE_MAP.kasir).toBe('cashier')
    expect(LEGACY_ROLE_MAP.user).toBe('staff')
    // admin is ambiguous by design — never silently widened.
    expect(LEGACY_ROLE_MAP.admin).toBe('store_admin')
    expect(legacyRoleTypeToTarget('admin')).toBe('store_admin')
  })

  test('tenant_admin has audit.read in-tenant, not platform permissions', async () => {
    const ctx = await resolveAuthorizationContext(db, { userId: userMulti.id, activeTenantId: tenantA.id })
    expect(can(ctx, 'audit.read', { tenantId: tenantA.id })).toBe(true)
    expect(can(ctx, 'tenant.manage', {})).toBe(false)
    expect(can(ctx, 'backup.manage', {})).toBe(false)
  })

  test('sensitive permission does not cross tenant scope', async () => {
    const ctx = await resolveAuthorizationContext(db, { userId: userMulti.id, activeTenantId: tenantA.id })
    expect(can(ctx, 'audit.read', { tenantId: tenantB.id })).toBe(false)
    expect(can(ctx, 'user.manage', { tenantId: tenantB.id })).toBe(false)
  })

  test('tenant_admin cannot escalate to platform_admin', async () => {
    const ctx = await resolveAuthorizationContext(db, { userId: userMulti.id, activeTenantId: tenantA.id })
    expect(ctx.isPlatformAdmin).toBe(false)
    expect(can(ctx, 'tenant.manage', {})).toBe(false)
  })

  test('legacy super_admin resolves to platform_admin without membership', async () => {
    const ctx = await resolveAuthorizationContext(db, { userId: legacySuper.id })
    expect(ctx.isPlatformAdmin).toBe(true)
    expect(ctx.eligible).toBe(true)
  })

  test('cashier and staff are denied audit administration by default', async () => {
    const cashierCtx = await resolveAuthorizationContext(db, { userId: userPlain.id })
    expect(can(cashierCtx, 'audit.read', {})).toBe(false)
    expect(ROLE_BASELINE_PERMISSIONS.cashier).toEqual([])
    expect(ROLE_BASELINE_PERMISSIONS.staff).toEqual([])
  })
})

describe('AUTH-1 context & attack matrix', () => {
  test('client-supplied tenant/store IDs never grant authorization by themselves', async () => {
    // userPlain has NO memberships: even explicitly requesting tenantA/storeA1
    // must not authorize.
    const ctx = await resolveAuthorizationContext(db, {
      userId: userPlain.id,
      activeTenantId: tenantA.id,
      activeStoreId: storeA1.id
    })
    expect(ctx.activeTenantId).toBeNull()
    expect(ctx.activeStoreId).toBeNull()
    expect(can(ctx, 'audit.read', { tenantId: tenantA.id, storeId: storeA1.id })).toBe(false)
  })

  test('foreign activeTenant request is denied', async () => {
    const ctx = await resolveAuthorizationContext(db, { userId: userMulti.id, activeTenantId: 999999 })
    expect(ctx.activeTenantId).toBeNull()
  })

  // AUTH-1 P2: eligibility is enablement (disabledAt/deletedAt); presence
  // `status` is not authorization authority.
  test('disabled account is ineligible even with active membership', async () => {
    await db.user.update({ disabledAt: new Date() }, { where: { id: userMulti.id } })
    try {
      const ctx = await resolveAuthorizationContext(db, { userId: userMulti.id, activeTenantId: tenantA.id })
      expect(ctx.eligible).toBe(false)
      expect(can(ctx, 'audit.read', { tenantId: tenantA.id })).toBe(false)
    } finally {
      await db.user.update({ disabledAt: null }, { where: { id: userMulti.id } })
    }
  })

  test('presence status "inactive" alone does not make an enabled account ineligible', async () => {
    await db.user.update({ status: 'inactive' }, { where: { id: userMulti.id } })
    try {
      const ctx = await resolveAuthorizationContext(db, { userId: userMulti.id, activeTenantId: tenantA.id })
      expect(ctx.eligible).toBe(true)
    } finally {
      await db.user.update({ status: 'active' }, { where: { id: userMulti.id } })
    }
  })

  test('stale/forged JWT claims cannot escalate: context resolves from DB, not the token', async () => {
    const { signSessionToken } = require('../test-helpers/authSession')
    const forged = await signSessionToken(
      { id: userPlain.id, userName: 'x', roleType: 'super_admin', store: storeA1.id },
      process.env.JWT_SECRET_KEY || 'secret-key-user'
    )
    const authorization = require('../utils/authorization')
    const req = { headers: { authorization: `Bearer ${forged}` }, cookies: {} }
    await new Promise((resolve) => authorization(req, {}, resolve))
    // Middleware decodes claims, but the authorization decision ignores them:
    const ctx = await resolveAuthorizationContext(db, { userId: req.user.id })
    expect(ctx.isPlatformAdmin).toBe(false)
    expect(can(ctx, 'audit.read', {})).toBe(false)
  })

  test('membership status vocabulary matches DR-03', async () => {
    expect(MEMBERSHIP_STATUS).toEqual(expect.arrayContaining(['ACTIVE', 'DEACTIVATED', 'RETIRED']))
  })
})

describe('AUTH-1 AUD-3 readiness: tenant-aware scope derivation', () => {
  test('tenant_admin derives tenant-wide scope; store_admin derives assigned-store scope', async () => {
    const { auditScopeFor } = require('../utils/authContext')
    const tenantCtx = await resolveAuthorizationContext(db, { userId: userMulti.id, activeTenantId: tenantA.id })
    expect(auditScopeFor(tenantCtx)).toEqual({ tenantId: tenantA.id, storeIds: null })
    const storeCtx = await resolveAuthorizationContext(db, { userId: userMulti.id, activeTenantId: tenantB.id })
    expect(auditScopeFor(storeCtx)).toEqual({ tenantId: tenantB.id, storeIds: [storeB1.id] })
  })

  test('no scope is derived without an effective membership', async () => {
    const { auditScopeFor } = require('../utils/authContext')
    const ctx = await resolveAuthorizationContext(db, { userId: userPlain.id })
    expect(auditScopeFor(ctx)).toBeNull()
  })
})

// AUTH-2: operational store lifecycle + product/store tenant ownership.
// Tenant ownership and lifecycle are decided ONLY from a resolved
// authorization context and persisted rows. user.store, JWT store claims,
// cookies, query strings and body fields are never ownership evidence —
// `tenantId` in a request is a target-tenant CANDIDATE, validated against
// the context, not authority.
describe('AUTH-2 store lifecycle vocabulary', () => {
  const {
    STORE_LIFECYCLE_STATUSES,
    OPERATIONAL_STORE_STATUSES,
    assertOperationalStoreTenant,
    assertSellableProductAssignment
  } = require('../api/validation/schemas')

  const platformContext = (activeTenantId = null) => ({
    eligible: true,
    isPlatformAdmin: true,
    activeTenantId
  })
  const tenantContext = (activeTenantId) => ({
    eligible: true,
    isPlatformAdmin: false,
    activeTenantId
  })

  test('lifecycle vocabulary separates operational from non-operational stores', () => {
    expect(STORE_LIFECYCLE_STATUSES).toEqual(
      expect.arrayContaining(['active', 'inactive', 'draft', 'closed', 'retired', 'quarantined'])
    )
    expect(OPERATIONAL_STORE_STATUSES).toEqual(['active'])
    for (const status of ['inactive', 'draft', 'closed', 'retired', 'quarantined']) {
      expect(STORE_LIFECYCLE_STATUSES).toContain(status)
      expect(OPERATIONAL_STORE_STATUSES).not.toContain(status)
    }
  })

  test('operational store without tenant is rejected', () => {
    const result = assertOperationalStoreTenant(platformContext(null), {
      requestedStatus: 'active'
    })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('TARGET_TENANT_REQUIRED')

    const tenantless = assertOperationalStoreTenant(tenantContext(null), {
      requestedStatus: 'active'
    })
    expect(tenantless.ok).toBe(false)
    expect(tenantless.code).toBe('TENANT_SCOPE_REQUIRED')
  })

  test('platform-authorized store creation requires an explicit target tenant', () => {
    const withoutTarget = assertOperationalStoreTenant(platformContext(null), {
      requestedStatus: 'active'
    })
    expect(withoutTarget.ok).toBe(false)

    const withTarget = assertOperationalStoreTenant(platformContext(null), {
      requestedStatus: 'active',
      tenantId: 7
    })
    expect(withTarget.ok).toBe(true)
    expect(withTarget.tenantId).toBe(7)

    const platformWithTenantContext = assertOperationalStoreTenant(
      platformContext(tenantA.id),
      { requestedStatus: 'active' }
    )
    expect(platformWithTenantContext.ok).toBe(true)
    expect(platformWithTenantContext.tenantId).toBe(tenantA.id)
  })

  test('inactive/closed/retired/quarantined store cannot become active by request', () => {
    for (const status of ['inactive', 'closed']) {
      const result = assertOperationalStoreTenant(platformContext(tenantA.id), {
        currentStatus: status,
        requestedStatus: 'active'
      })
      expect(result.ok).toBe(false)
      expect(result.code).toBe('STORE_ACTIVATION_NOT_PERMITTED')
    }
    for (const status of ['retired', 'quarantined']) {
      const result = assertOperationalStoreTenant(platformContext(tenantA.id), {
        currentStatus: status,
        requestedStatus: 'active'
      })
      expect(result.ok).toBe(false)
      expect(result.code).toBe('STORE_STATUS_IRREVERSIBLE')
    }
  })

  test('retired and quarantined are irreversible even toward a non-operational status', () => {
    for (const status of ['retired', 'quarantined']) {
      const result = assertOperationalStoreTenant(platformContext(tenantA.id), {
        currentStatus: status,
        requestedStatus: 'inactive'
      })
      expect(result.ok).toBe(false)
      expect(result.code).toBe('STORE_STATUS_IRREVERSIBLE')
    }
  })

  test('draft store may be published and an already active store stays active', () => {
    const publish = assertOperationalStoreTenant(platformContext(tenantA.id), {
      currentStatus: 'draft',
      requestedStatus: 'active'
    })
    expect(publish.ok).toBe(true)
    expect(publish.becomesOperational).toBe(true)

    const stayActive = assertOperationalStoreTenant(platformContext(tenantA.id), {
      currentStatus: 'active',
      requestedStatus: 'active'
    })
    expect(stayActive.ok).toBe(true)
    expect(stayActive.becomesOperational).toBe(false)
  })

  test('non-operational store may stay tenantless during the migration window', () => {
    const result = assertOperationalStoreTenant(platformContext(null), {
      requestedStatus: 'draft'
    })
    expect(result.ok).toBe(true)
    expect(result.tenantId).toBeNull()
  })

  test('a platform actor activating a store that already has a tenant targets that tenant', () => {
    const publish = assertOperationalStoreTenant(platformContext(null), {
      currentStatus: 'draft',
      requestedStatus: 'active',
      persistedTenantId: tenantA.id
    })
    expect(publish.ok).toBe(true)
    expect(publish.tenantId).toBe(tenantA.id)
    expect(publish.becomesOperational).toBe(true)

    // restating the same owner is fine; naming another is still refused
    const same = assertOperationalStoreTenant(platformContext(null), {
      currentStatus: 'draft',
      requestedStatus: 'active',
      persistedTenantId: tenantA.id,
      tenantId: tenantA.id
    })
    expect(same.ok).toBe(true)
    const other = assertOperationalStoreTenant(platformContext(null), {
      currentStatus: 'draft',
      requestedStatus: 'active',
      persistedTenantId: tenantA.id,
      tenantId: tenantB.id
    })
    expect(other.code).toBe('TENANT_REASSIGNMENT_NOT_PERMITTED')
  })

  test('existing tenant ownership is never rewritten by a request', () => {
    const result = assertOperationalStoreTenant(platformContext(tenantB.id), {
      currentStatus: 'active',
      requestedStatus: 'active',
      persistedTenantId: tenantA.id
    })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('TENANT_REASSIGNMENT_NOT_PERMITTED')
  })

  test('a requested tenant outside the resolved context is a scope mismatch', () => {
    const result = assertOperationalStoreTenant(tenantContext(tenantA.id), {
      currentStatus: 'active',
      requestedStatus: 'active',
      tenantId: tenantB.id
    })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('TENANT_SCOPE_MISMATCH')
  })

  test('unresolved or ineligible context rejects every store lifecycle change', () => {
    expect(assertOperationalStoreTenant(null, { requestedStatus: 'draft' }).code).toBe(
      'CONTEXT_UNRESOLVED'
    )
    expect(
      assertOperationalStoreTenant({ eligible: false }, { requestedStatus: 'active', tenantId: 1 }).code
    ).toBe('CONTEXT_UNRESOLVED')
  })

  test('unknown lifecycle status and malformed tenant ids are rejected deterministically', () => {
    expect(
      assertOperationalStoreTenant(platformContext(tenantA.id), { requestedStatus: 'zombie' }).code
    ).toBe('UNKNOWN_STORE_STATUS')
    expect(
      assertOperationalStoreTenant(platformContext(null), {
        requestedStatus: 'active',
        tenantId: '5;drop'
      }).code
    ).toBe('INVALID_TENANT_ID')
    expect(
      assertOperationalStoreTenant(platformContext(null), {
        requestedStatus: 'active',
        tenantId: -1
      }).code
    ).toBe('INVALID_TENANT_ID')
  })

  test('client-supplied store evidence is never ownership evidence', () => {
    // A forged context carrying a foreign store/tenant claim outside the
    // resolved context cannot authorize a lifecycle change.
    const result = assertOperationalStoreTenant(
      { ...tenantContext(tenantA.id), userStore: tenantB.id, jwtStore: tenantB.id },
      { requestedStatus: 'active', store: 999, tenantId: tenantA.id }
    )
    expect(result.ok).toBe(true)
    expect(result.tenantId).toBe(tenantA.id)
  })

  test('unassigned product cannot silently become globally sellable', () => {
    const sellable = { status: 'active', isAvailable: true }
    expect(
      assertSellableProductAssignment({ assignmentProvided: true, storeIds: [], ...sellable }).ok
    ).toBe(false)
    expect(
      assertSellableProductAssignment({ assignmentProvided: true, storeIds: [], ...sellable }).code
    ).toBe('PRODUCT_UNASSIGNED_NOT_SELLABLE')
    expect(
      assertSellableProductAssignment({ assignmentProvided: true, storeIds: [storeA1.id], ...sellable }).ok
    ).toBe(true)
    expect(
      assertSellableProductAssignment({
        assignmentProvided: true,
        storeIds: [],
        status: 'draft',
        isAvailable: true
      }).ok
    ).toBe(true)
  })

  test('omitting the assignment never widens to every store', () => {
    const result = assertSellableProductAssignment({
      assignmentProvided: false,
      storeIds: [],
      status: 'active',
      isAvailable: true
    })
    expect(result.ok).toBe(true)
    expect(result.code).toBe('ASSIGNMENT_UNCHANGED')
    expect(result.globallySellable).toBe(false)
  })
})

describe('AUTH-2 product_store tenant consistency', () => {
  let prodOne = null
  let prodTwo = null

  beforeAll(async () => {
    const category = await db.category.create({ name: `${P}AUTH2_CAT`, status: 'active' })
    prodOne = await db.product.create({ nameProduct: `${P}AUTH2_PROD_1`, category: category.id, price: 1000 })
    prodTwo = await db.product.create({ nameProduct: `${P}AUTH2_PROD_2`, category: category.id, price: 1000 })
  })

  afterAll(async () => {
    await db.product_store.destroy({
      where: { product: [prodOne?.id, prodTwo?.id].filter(Boolean) },
      force: true
    })
    await db.product.destroy({
      where: { id: [prodOne?.id, prodTwo?.id].filter(Boolean) },
      force: true
    })
    await db.category.destroy({ where: { name: `${P}AUTH2_CAT` }, force: true })
  })

  test('product_store cannot cross tenant boundaries', async () => {
    await db.product_store.create({ product: prodOne.id, store: storeA1.id })
    await expect(
      db.product_store.create({ product: prodOne.id, store: storeB1.id })
    ).rejects.toThrow(/cross-tenant/i)
  })

  test('a single cross-tenant bulk assignment is rejected', async () => {
    await expect(
      db.product_store.bulkCreate([
        { product: prodTwo.id, store: storeA1.id },
        { product: prodTwo.id, store: storeB1.id }
      ])
    ).rejects.toThrow(/cross-tenant/i)
  })

  test('a migration-state store cannot be mixed with an owned store', async () => {
    const migrationStore = await db.location.create({
      name: `${P}STORE_MIGRATION`,
      status: 'draft'
    })
    try {
      await db.product_store.create({ product: prodTwo.id, store: storeA1.id })
      await expect(
        db.product_store.create({ product: prodTwo.id, store: migrationStore.id })
      ).rejects.toThrow(/tenant/i)
    } finally {
      await db.product_store.destroy({ where: { product: prodTwo.id }, force: true })
      await db.location.destroy({ where: { id: migrationStore.id }, force: true })
    }
  })

  test('a store that does not exist is rejected', async () => {
    await expect(
      db.product_store.create({ product: prodTwo.id, store: 99999999 })
    ).rejects.toThrow(/does not exist/i)
  })

  test('the pre-cutover all-migration-state assignment stays writable', async () => {
    const a = await db.location.create({ name: `${P}STORE_MS_A`, status: 'draft' })
    const b = await db.location.create({ name: `${P}STORE_MS_B`, status: 'draft' })
    try {
      await db.product_store.bulkCreate([
        { product: prodTwo.id, store: a.id },
        { product: prodTwo.id, store: b.id }
      ])
      const rows = await db.product_store.findAll({ where: { product: prodTwo.id } })
      expect(rows.map((r) => r.store).sort()).toEqual([a.id, b.id].sort())
    } finally {
      await db.product_store.destroy({ where: { product: prodTwo.id }, force: true })
      await db.location.destroy({ where: { id: [a.id, b.id] }, force: true })
    }
  })

  test('historical rows and existing ownership survive a failed cross-tenant write', async () => {
    const before = await db.product_store.findAll({
      where: { product: prodOne.id },
      attributes: ['store']
    })
    await expect(
      db.product_store.bulkCreate([
        { product: prodOne.id, store: storeB1.id },
        { product: prodOne.id, store: storeA2.id }
      ])
    ).rejects.toThrow(/cross-tenant/i)
    const after = await db.product_store.findAll({
      where: { product: prodOne.id },
      attributes: ['store']
    })
    expect(after.map((r) => r.store)).toEqual(before.map((r) => r.store))
  })
})
