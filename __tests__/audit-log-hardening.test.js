process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { redactAndAudit, createAudit, AUDIT_ACTIONS } = require('../utils/auditLog')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let store = null
let storeOther = null
let category = null
let productAdjust = null
let productTransfer = null
let productPrice = null
let adminUser = null
let superAdminUser = null
let cashierUser = null
let adminToken = null
let superAdminToken = null
let cashierToken = null
let tenant = null

beforeAll(async () => {
  // K1/K2 (GAP-2): the transfer audit cases below send between two stores as
  // a store-bound (non-platform) admin, which the tenant lattice only allows
  // within one tenant. Both fixtures are tenant-bound accordingly; the audit
  // assertions are unchanged.
  tenant = await db.tenant.create({ code: `AUDIT_TENANT_${Date.now()}`, name: 'AUDIT Tenant' })
  store = await db.location.create({
    name: 'AUDIT_HARDEN_STORE',
    status: 'active',
    tenantId: tenant.id
  })
  storeOther = await db.location.create({
    name: 'AUDIT_HARDEN_STORE_OTHER',
    status: 'active',
    tenantId: tenant.id
  })
  category = await db.category.create({ name: 'AUDIT_HARDEN_CATEGORY' })

  productAdjust = await db.product.create({
    nameProduct: 'AUDIT_HARDEN_ADJUST_PRODUCT',
    category: category.id,
    price: 3000,
    stock: 20
  })
  productTransfer = await db.product.create({
    nameProduct: 'AUDIT_HARDEN_TRANSFER_PRODUCT',
    category: category.id,
    price: 4000,
    stock: 15
  })
  productPrice = await db.product.create({
    nameProduct: 'AUDIT_HARDEN_PRICE_PRODUCT',
    category: category.id,
    price: 5000,
    stock: 5
  })
  await db.product_store_stock.create({
    product: productTransfer.id,
    store: store.id,
    stock: 15
  })

  adminUser = await db.user.create({
    userName: 'admin_audit_harden',
    email: 'admin_audit_harden@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active',
    password: 'DoNotLeakThisPassword123'
  })
  superAdminUser = await db.user.create({
    userName: 'superadmin_audit_harden',
    email: 'superadmin_audit_harden@test.com',
    roleType: 'super_admin',
    userType: 'admin',
    status: 'active'
  })
  cashierUser = await db.user.create({
    userName: 'cashier_audit_harden',
    email: 'cashier_audit_harden@test.com',
    roleType: 'kasir',
    userType: 'kasir',
    store: store.id,
    status: 'active'
  })

  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  superAdminToken = await signSessionToken(
    { id: superAdminUser.id, userName: superAdminUser.userName, roleType: 'super_admin' },
    JWT_SECRET
  )
  cashierToken = await signSessionToken(
    { id: cashierUser.id, userName: cashierUser.userName, roleType: 'kasir', store: store.id },
    JWT_SECRET
  )
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed rates for
  // both stores so these audit assertions exercise configured tax.
  for (const s of [store, storeOther]) {
    await db.taxConfig.create({
      name: `AUDIT_HARDEN_PPN_${s.id}`,
      rate: 11,
      type: 'ppn',
      status: 'active',
      store: s.id
    })
  }
})

afterAll(async () => {
  await db.taxConfig.destroy({
    where: { store: [store?.id, storeOther?.id].filter(Boolean) },
    force: true
  })
  await db.auditLog.destroy({
    where: { store: [store?.id, storeOther?.id] },
    force: true,
    __auditMaintenance: true
  })
  await db.auditLog.destroy({ where: { entity: 'unit_test_redaction' }, force: true, __auditMaintenance: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: [store?.id, storeOther?.id] }, force: true })
  await db.best_selling.destroy({
    where: { productId: [productAdjust?.id, productTransfer?.id, productPrice?.id] },
    force: true
  })
  await db.stock_transfer_item.destroy({ where: {}, force: true })
  await db.stock_transfer.destroy({
    where: { fromStore: [store?.id, storeOther?.id] },
    force: true
  })
  await db.cashRegister.destroy({ where: { store: [store?.id, storeOther?.id] }, force: true })
  await db.product_store_price.destroy({ where: { product: productPrice?.id }, force: true })
  await db.stock_history.destroy({
    where: { product: [productAdjust?.id, productTransfer?.id, productPrice?.id] },
    force: true
  })
  await db.product_store_stock.destroy({
    where: { product: [productAdjust?.id, productTransfer?.id, productPrice?.id] },
    force: true
  })
  await db.product.destroy({
    where: { id: [productAdjust?.id, productTransfer?.id, productPrice?.id] },
    force: true
  })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({
    where: { id: [adminUser?.id, superAdminUser?.id, cashierUser?.id].filter(Boolean) },
    force: true
  })
  await db.location.destroy({ where: { id: [store?.id, storeOther?.id] }, force: true })
  await db.tenant.destroy({ where: { id: tenant?.id }, force: true })
})

// A minimal fake request, shaped like what createAudit()/redactAndAudit()
// actually read (req.storeId, req.user, req.ip, req.get) — used for the
// mechanism-level tests below that don't need a real HTTP round trip.
const fakeReq = (overrides = {}) => ({
  storeId: store.id,
  user: { id: adminUser.id, name: 'Audit Harden Admin' },
  cookies: {},
  ip: '127.0.0.1',
  get: () => 'jest-audit-hardening-agent',
  ...overrides
})

describe('redactAndAudit — recursive redaction, verified at the persisted row', () => {
  test('redacts a top-level password field', async () => {
    await redactAndAudit(fakeReq(), {
      action: AUDIT_ACTIONS.UPDATE,
      entity: 'unit_test_redaction',
      entityId: 1,
      description: 'password redaction',
      oldValues: { password: 'oldSecret123', name: 'ok' },
      newValues: { password: 'newSecret456', name: 'still ok' }
    })

    const row = await db.auditLog.findOne({
      where: { entity: 'unit_test_redaction', entityId: 1 },
      order: [['id', 'DESC']]
    })
    expect(row).not.toBeNull()
    expect(row.oldValues.password).toBe('[REDACTED]')
    expect(row.newValues.password).toBe('[REDACTED]')
    expect(row.oldValues.name).toBe('ok')
    expect(JSON.stringify(row.oldValues)).not.toContain('oldSecret123')
    expect(JSON.stringify(row.newValues)).not.toContain('newSecret456')
  })

  test('redacts passwordHash, token, accessToken, refreshToken, secret, and otp on the same object', async () => {
    await redactAndAudit(fakeReq(), {
      action: AUDIT_ACTIONS.UPDATE,
      entity: 'unit_test_redaction',
      entityId: 2,
      description: 'multi-key redaction',
      newValues: {
        passwordHash: 'hash-value',
        token: 'tok-value',
        accessToken: 'at-value',
        refreshToken: 'rt-value',
        secret: 'sec-value',
        otp: '123456',
        safeField: 'keep-me'
      }
    })

    const row = await db.auditLog.findOne({
      where: { entity: 'unit_test_redaction', entityId: 2 },
      order: [['id', 'DESC']]
    })
    expect(row.newValues.passwordHash).toBe('[REDACTED]')
    expect(row.newValues.token).toBe('[REDACTED]')
    expect(row.newValues.accessToken).toBe('[REDACTED]')
    expect(row.newValues.refreshToken).toBe('[REDACTED]')
    expect(row.newValues.secret).toBe('[REDACTED]')
    expect(row.newValues.otp).toBe('[REDACTED]')
    expect(row.newValues.safeField).toBe('keep-me')
  })

  test('masks cardNumber to the last 4 digits', async () => {
    await redactAndAudit(fakeReq(), {
      action: AUDIT_ACTIONS.PAYMENT,
      entity: 'unit_test_redaction',
      entityId: 3,
      description: 'card masking',
      newValues: { cardNumber: '4111111111111111', shortCard: '' }
    })

    const row = await db.auditLog.findOne({
      where: { entity: 'unit_test_redaction', entityId: 3 },
      order: [['id', 'DESC']]
    })
    expect(row.newValues.cardNumber).toBe('****1111')
    expect(JSON.stringify(row.newValues)).not.toContain('4111111111111111')
  })

  test('a cardNumber of 4 characters or fewer is fully redacted, not partially exposed', async () => {
    await redactAndAudit(fakeReq(), {
      action: AUDIT_ACTIONS.PAYMENT,
      entity: 'unit_test_redaction',
      entityId: 4,
      description: 'short card masking',
      newValues: { cardNumber: '1234' }
    })

    const row = await db.auditLog.findOne({
      where: { entity: 'unit_test_redaction', entityId: 4 },
      order: [['id', 'DESC']]
    })
    expect(row.newValues.cardNumber).toBe('[REDACTED]')
  })

  test('redacts a sensitive key nested inside an object', async () => {
    await redactAndAudit(fakeReq(), {
      action: AUDIT_ACTIONS.UPDATE,
      entity: 'unit_test_redaction',
      entityId: 5,
      description: 'nested redaction',
      newValues: { payment: { token: 'nested-secret', amount: 100 } }
    })

    const row = await db.auditLog.findOne({
      where: { entity: 'unit_test_redaction', entityId: 5 },
      order: [['id', 'DESC']]
    })
    expect(row.newValues.payment.token).toBe('[REDACTED]')
    expect(row.newValues.payment.amount).toBe(100)
  })

  test('redacts a sensitive key nested inside array elements', async () => {
    await redactAndAudit(fakeReq(), {
      action: AUDIT_ACTIONS.UPDATE,
      entity: 'unit_test_redaction',
      entityId: 6,
      description: 'array-nested redaction',
      newValues: { items: [{ secret: 'a' }, { secret: 'b' }, { keep: 'c' }] }
    })

    const row = await db.auditLog.findOne({
      where: { entity: 'unit_test_redaction', entityId: 6 },
      order: [['id', 'DESC']]
    })
    expect(row.newValues.items[0].secret).toBe('[REDACTED]')
    expect(row.newValues.items[1].secret).toBe('[REDACTED]')
    expect(row.newValues.items[2].keep).toBe('c')
  })

  test('does not throw on a circular reference and marks it instead of hanging', async () => {
    const circular = { name: 'loopy' }
    circular.self = circular

    await expect(
      redactAndAudit(fakeReq(), {
        action: AUDIT_ACTIONS.UPDATE,
        entity: 'unit_test_redaction',
        entityId: 7,
        description: 'circular safety',
        newValues: circular
      })
    ).resolves.not.toThrow()

    const row = await db.auditLog.findOne({
      where: { entity: 'unit_test_redaction', entityId: 7 },
      order: [['id', 'DESC']]
    })
    expect(row.newValues.name).toBe('loopy')
    expect(row.newValues.self).toBe('[circular]')
  })

  test('plainifies a real Sequelize model instance via toJSON before redacting — the password hash never reaches the stored row', async () => {
    // the hash is excluded from default reads (P0-1); load it explicitly so
    // the instance really carries it
    const freshUser = await db.user.scope('withCredentials').findByPk(adminUser.id)
    expect(freshUser.password).toBeTruthy() // sanity: the hash exists on the instance

    await redactAndAudit(fakeReq(), {
      action: AUDIT_ACTIONS.UPDATE,
      entity: 'unit_test_redaction',
      entityId: 8,
      description: 'sequelize instance redaction',
      newValues: freshUser
    })

    const row = await db.auditLog.findOne({
      where: { entity: 'unit_test_redaction', entityId: 8 },
      order: [['id', 'DESC']]
    })
    // user.toJSON() drops credentials before redaction even sees them (P0-1)
    expect(row.newValues).not.toHaveProperty('password')
    expect(row.newValues.userName).toBe(adminUser.userName)
    expect(JSON.stringify(row.newValues)).not.toContain(freshUser.password)
  })

  test('handles null and undefined value objects without error', async () => {
    await expect(
      redactAndAudit(fakeReq(), {
        action: AUDIT_ACTIONS.DELETE,
        entity: 'unit_test_redaction',
        entityId: 9,
        description: 'null/undefined safety',
        oldValues: null,
        newValues: undefined
      })
    ).resolves.not.toThrow()

    const row = await db.auditLog.findOne({
      where: { entity: 'unit_test_redaction', entityId: 9 },
      order: [['id', 'DESC']]
    })
    expect(row.oldValues).toBeNull()
    expect(row.newValues).toBeNull()
  })
})

describe('Transaction atomicity — the mechanism every F1 call site relies on', () => {
  // Every new F1 call site (pos.js's five functions, order.js's void entry)
  // writes its audit call as the LAST statement inside its Sequelize
  // transaction, once the business mutation already succeeded — by design,
  // nothing runs after it except the transaction's own commit. That means
  // there is no later business-logic step available to fail against in
  // order to prove "the audit row rolls back with everything else" per
  // call site. Instead, this test proves the underlying mechanism directly:
  // createAudit()/auditLog() honor the `transaction` option exactly like
  // every other db.*.create() call in this codebase, using a real
  // Sequelize transaction and a real rollback — not a mocked audit
  // function standing in for the assertion.
  test('an audit row created inside a transaction that later throws is rolled back, not persisted', async () => {
    const before = await db.auditLog.count({ where: { entity: 'unit_test_redaction', entityId: 999 } })

    await expect(
      db.sequelize.transaction(async (t) => {
        await createAudit(
          fakeReq(),
          AUDIT_ACTIONS.UPDATE,
          'unit_test_redaction',
          999,
          'should not survive rollback',
          null,
          { willRollBack: true },
          t
        )
        throw new Error('forced failure after audit write, before commit')
      })
    ).rejects.toThrow('forced failure after audit write, before commit')

    const after = await db.auditLog.count({ where: { entity: 'unit_test_redaction', entityId: 999 } })
    expect(after).toBe(before)
  })

  test('an audit row created inside a transaction that commits successfully IS persisted', async () => {
    await db.sequelize.transaction(async (t) => {
      await createAudit(
        fakeReq(),
        AUDIT_ACTIONS.UPDATE,
        'unit_test_redaction',
        1000,
        'should survive commit',
        null,
        { committed: true },
        t
      )
    })

    const row = await db.auditLog.findOne({
      where: { entity: 'unit_test_redaction', entityId: 1000 }
    })
    expect(row).not.toBeNull()
    expect(row.newValues.committed).toBe(true)
  })
})

describe('Cash register — fire-and-forget audit calls (no transaction wrapper until F2)', () => {
  let openedRegisterId = null

  test('POST /cash-register/open records a create audit entry', async () => {
    const res = await request(app)
      .post('/cash-register/open')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ store: store.id, openingBalance: 100000, shift: 1 })

    expect(res.status).toBe(201)
    openedRegisterId = res.body.data.id

    const row = await db.auditLog.findOne({
      where: { entity: 'cash_register', entityId: openedRegisterId, action: 'create' }
    })
    expect(row).not.toBeNull()
    expect(row.store).toBe(store.id)
  })

  test('PUT /cash-register/close/:id records an update audit entry', async () => {
    const res = await request(app)
      .put(`/cash-register/close/${openedRegisterId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ store: store.id, closingBalance: 100000 })

    expect(res.status).toBe(200)

    const row = await db.auditLog.findOne({
      where: { entity: 'cash_register', entityId: openedRegisterId, action: 'update' }
    })
    expect(row).not.toBeNull()
    expect(row.newValues.status).toBe('closed')
  })
})

describe('POS controllers — transactional audit calls', () => {
  test('POST /pos/adjust records an audit entry with correct oldValues/newValues', async () => {
    const res = await request(app)
      .post('/pos/adjust')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ productId: productAdjust.id, qty: 5, reason: 'Audit hardening test' })

    expect(res.status).toBe(200)

    const row = await db.auditLog.findOne({
      where: { entity: 'stock_adjustment', entityId: productAdjust.id, action: 'update' }
    })
    expect(row).not.toBeNull()
    expect(row.oldValues.stock).toBe(20)
    expect(row.newValues.stock).toBe(25)
  })

  test('POST /pos/transfer records a create audit entry', async () => {
    const res = await request(app)
      .post('/pos/transfer')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        fromStore: store.id,
        toStore: storeOther.id,
        items: [{ productId: productTransfer.id, qty: 3 }]
      })

    expect(res.status).toBe(201)
    const transferId = res.body.data.id

    const row = await db.auditLog.findOne({
      where: { entity: 'stock_transfer', entityId: transferId, action: 'create' }
    })
    expect(row).not.toBeNull()
  })

  test('POST /pos/transfer/:id/receive records an update audit entry', async () => {
    const createRes = await request(app)
      .post('/pos/transfer')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        fromStore: store.id,
        toStore: storeOther.id,
        items: [{ productId: productTransfer.id, qty: 2 }]
      })
    const transferId = createRes.body.data.id

    const res = await request(app)
      .put(`/pos/transfer/${transferId}/receive`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({})

    expect(res.status).toBe(200)

    const row = await db.auditLog.findOne({
      where: { entity: 'stock_transfer', entityId: transferId, action: 'update', description: 'Stock transfer received' }
    })
    expect(row).not.toBeNull()
  })

  test('POST /pos/transfer/:id/cancel records an update audit entry', async () => {
    const createRes = await request(app)
      .post('/pos/transfer')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        fromStore: store.id,
        toStore: storeOther.id,
        items: [{ productId: productTransfer.id, qty: 1 }]
      })
    const transferId = createRes.body.data.id

    const res = await request(app)
      .put(`/pos/transfer/${transferId}/cancel`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({})

    expect(res.status).toBe(200)

    const row = await db.auditLog.findOne({
      where: { entity: 'stock_transfer', entityId: transferId, action: 'update', description: 'Stock transfer cancelled' }
    })
    expect(row).not.toBeNull()
  })

  test('PUT /pos/product/update-price-by-store records an audit entry', async () => {
    // C-11: the 'base' price is the authoritative product.price that applies to
    // every store — a tenant admin must not be able to globally re-price it
    // (403), only super_admin may. Both assertions below lock in that boundary
    // and verify the legitimate super_admin path still records an audit entry.
    const forbidden = await request(app)
      .put('/pos/product/update-price-by-store')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        productId: productPrice.id,
        storePrices: [{ storeId: 'base', price: 6000 }]
      })

    expect(forbidden.status).toBe(403)

    const res = await request(app)
      .put('/pos/product/update-price-by-store')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        productId: productPrice.id,
        storePrices: [{ storeId: 'base', price: 6000 }]
      })

    expect(res.status).toBe(200)

    const row = await db.auditLog.findOne({
      where: { entity: 'product_price', entityId: productPrice.id, action: 'update' }
    })
    expect(row).not.toBeNull()
    expect(row.newValues.storePrices).toBeDefined()
  })
})

describe('Order void — additive to the existing generic status-update audit', () => {
  test('voiding a previously-paid order produces both a generic update entry and a specific void entry', async () => {
    // DR-23 (BA §35.10 G): a PAID order is reversed by an elevated void whose
    // cash refund is attributed to the open register (sale made inside it).
    const register = await db.cashRegister.create({
      store: store.id,
      user: adminUser.id,
      status: 'open',
      openingBalance: 0,
      openedAt: new Date()
    })
    const createRes = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send(withIdempotencyKey({
        store: store.id,
        items: [{ product: productAdjust.id, quantity: 1 }],
        paymentMethod: 'cash',
        cashierName: 'Audit Hardening Cashier'
      }))
    expect(createRes.status).toBe(201)
    const orderId = createRes.body.data.id

    const cancelRes = await request(app)
      .put('/order/update-status')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ id: orderId, status: 'void', store: store.id, reason: 'Audit test void reason' })
    expect(cancelRes.status).toBe(200)

    const genericRow = await db.auditLog.findOne({
      where: { entity: 'order', entityId: orderId, action: 'update' }
    })
    const voidRow = await db.auditLog.findOne({
      where: { entity: 'order', entityId: orderId, action: 'void' }
    })

    expect(genericRow).not.toBeNull()
    expect(voidRow).not.toBeNull()
    expect(voidRow.newValues.paymentStatus).toBe('refunded')
    expect(voidRow.oldValues.status).toBe('paid')

    await db.order.update({ cashRegisterId: null }, { where: { id: orderId } })
    await db.cashRegister.destroy({ where: { id: register.id }, force: true })
  })

  test('a non-cancelling status transition (e.g. confirmed) does not create a void entry', async () => {
    // P1 (DR-PAY-ATTR-02): counter creation under test requires an open register.
    await db.cashRegister.create({ store: store.id, user: adminUser.id, status: 'open', openingBalance: 0, openedAt: new Date() })
    const createRes = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send(withIdempotencyKey({
        store: store.id,
        items: [{ product: productAdjust.id, quantity: 1 }],
        cashierName: 'Audit Hardening Cashier'
      }))
    expect(createRes.status).toBe(201)
    const orderId = createRes.body.data.id

    const updateRes = await request(app)
      .put('/order/update-status')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({ id: orderId, status: 'confirmed', store: store.id })
    expect(updateRes.status).toBe(200)

    const voidRow = await db.auditLog.findOne({
      where: { entity: 'order', entityId: orderId, action: 'void' }
    })
    expect(voidRow).toBeNull()
  })
})

describe('Audit log endpoint — tenant isolation and authorization', () => {
  test('a super_admin querying store-scoped logs never sees another store\'s rows mixed in when filtering by store', async () => {
    // Seed one row unambiguously owned by storeOther via the real helper,
    // then confirm filtering by `store` excludes it from `store`'s results.
    await createAudit(
      { storeId: storeOther.id, user: { id: superAdminUser.id }, cookies: {}, ip: '127.0.0.1', get: () => 'test' },
      AUDIT_ACTIONS.CREATE,
      'tenant_isolation_probe',
      4242,
      'belongs to storeOther only'
    )

    const res = await request(app)
      .get('/audit-log')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .query({ store: store.id, entity: 'tenant_isolation_probe' })

    expect(res.status).toBe(200)
    const leaked = res.body.data.find((row) => row.entityId === 4242)
    expect(leaked).toBeUndefined()

    const ownStoreRes = await request(app)
      .get('/audit-log')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .query({ store: storeOther.id, entity: 'tenant_isolation_probe' })
    expect(ownStoreRes.body.data.some((row) => row.entityId === 4242)).toBe(true)

    await db.auditLog.destroy({ where: { entity: 'tenant_isolation_probe' }, force: true, __auditMaintenance: true })
  })

  test('a cashier-role request to GET /audit-log is rejected with 403', async () => {
    const res = await request(app)
      .get('/audit-log')
      .set('Authorization', `Bearer ${cashierToken}`)
      .query({ store: store.id })

    expect(res.status).toBe(403)
  })

  test('a cashier-role request to GET /audit-log/:entity/:entityId is rejected with 403', async () => {
    const res = await request(app)
      .get('/audit-log/order/1')
      .set('Authorization', `Bearer ${cashierToken}`)

    expect(res.status).toBe(403)
  })

  test('a super_admin request to GET /audit-log succeeds', async () => {
    const res = await request(app)
      .get('/audit-log')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .query({ store: store.id })

    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
  })
})
