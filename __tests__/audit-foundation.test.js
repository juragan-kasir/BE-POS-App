process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// AUD-1 (DR-20 foundation) contract/safety/compatibility/transaction tests.
// Uses the isolated test database (jest globalSetup) with AUD_FND_-prefixed
// fixtures, all removed in afterAll. Never touches real data.
const db = require('../db/models')
const {
  recordAudit,
  createAudit,
  redactAndAudit,
  ACTOR_TYPES,
  AUDIT_RESULTS
} = require('../utils/auditLog')

const P = 'AUD_FND_'
let store = null
let tenantA = null
let tenantB = null

beforeAll(async () => {
  store = await db.location.create({ name: `${P}STORE`, status: 'active' })
  tenantA = await db.tenant.create({ code: `${P}TA`, name: `${P}TENANT-A` })
  tenantB = await db.tenant.create({ code: `${P}TB`, name: `${P}TENANT-B` })
})

afterAll(async () => {
  await db.auditLog.destroy({
    where: { description: { [db.Sequelize.Op.like]: `${P}%` } },
    force: true,
    __auditMaintenance: true
  })
  await db.location.destroy({ where: { id: store?.id }, force: true })
  const tenantIds = [tenantA?.id, tenantB?.id].filter(Boolean)
  if (tenantIds.length) {
    await db.tenant.destroy({ where: { id: tenantIds }, force: true })
  }
  await db.sequelize.close()
})

const baseReq = () => ({
  storeId: store.id,
  user: { id: 4242, userName: `${P}USER`, roleType: 'admin', store: store.id },
  ip: '127.0.0.1',
  get: () => 'jest-agent'
})

describe('AUD-1 contract', () => {
  test('successful event persists with id, server timestamp, actor, scope', async () => {
    const before = Date.now()
    const row = await recordAudit({
      req: baseReq(),
      action: 'CREATE',
      entity: `${P}ORDER`,
      entityId: 7,
      description: `${P}success`
    })
    expect(row.id).toBeGreaterThan(0)
    expect(new Date(row.createdAt).getTime()).toBeGreaterThanOrEqual(before)
    expect(row.actorType).toBe('USER')
    expect(row.userId).toBe(4242)
    expect(row.result).toBe('SUCCESS')
    expect(row.store).toBe(store.id)
    expect(row.tenantId).toBeNull()
  })

  test('FAILURE and DENIED results persist', async () => {
    const f = await recordAudit({
      actor: { type: 'USER', id: 1 },
      action: 'PAY',
      entity: 'PAYMENT',
      result: 'FAILURE',
      description: `${P}failure`
    })
    const d = await recordAudit({
      actor: { type: 'USER', id: 1 },
      action: 'GRANT_ROLE',
      entity: 'ROLE',
      result: 'DENIED',
      reason: 'INSUFFICIENT_SCOPE',
      description: `${P}denied`
    })
    expect(f.result).toBe(AUDIT_RESULTS.FAILURE)
    expect(d.result).toBe(AUDIT_RESULTS.DENIED)
    expect(d.reason).toBe('INSUFFICIENT_SCOPE')
  })

  test('SYSTEM / JOB / INTEGRATION actors work and are not human users', async () => {
    for (const type of ['SYSTEM', 'JOB', 'INTEGRATION']) {
      const row = await recordAudit({
        actor: { type, id: null, name: type },
        action: 'EXPORT',
        entity: 'EXPORT',
        source: 'SCHEDULER',
        description: `${P}sys-${type}`
      })
      expect(row.actorType).toBe(type)
      expect(row.userId).toBeNull()
      expect(row.source).toBe('SCHEDULER')
    }
    expect(ACTOR_TYPES.SYSTEM).toBe('SYSTEM')
  })

  test('tenant + store + platform scopes', async () => {
    const tenantScoped = await recordAudit({
      actor: { type: 'USER', id: 2 },
      action: 'UPDATE',
      entity: 'STORE',
      tenantId: tenantA.id,
      storeId: store.id,
      description: `${P}tenant`
    })
    expect(tenantScoped.tenantId).toBe(tenantA.id)
    expect(tenantScoped.store).toBe(store.id)
    const platform = await recordAudit({
      actor: { type: 'SYSTEM' },
      action: 'DELETE',
      entity: 'SYSTEM',
      tenantId: null,
      storeId: null,
      description: `${P}platform`
    })
    expect(platform.tenantId).toBeNull()
    expect(platform.store).toBeNull()
  })

  test('resource identity, request ids, reason, metadata and state', async () => {
    const explicit = await recordAudit({
      actor: { type: 'USER', id: 3 },
      action: 'ADJUST',
      entity: 'INVENTORY',
      entityId: 99,
      requestId: `${P}REQ-1`,
      reason: 'USER_REQUEST',
      previousState: { stock: 10 },
      newState: { stock: 9 },
      metadata: { channel: 'API' },
      description: `${P}resource`
    })
    expect(explicit.entity).toBe('INVENTORY')
    expect(explicit.entityId).toBe(99)
    expect(explicit.requestId).toBe(`${P}REQ-1`)
    expect(explicit.oldValues).toEqual({ stock: 10 })
    expect(explicit.newValues).toEqual({ stock: 9 })
    expect(explicit.metadata).toEqual({ channel: 'API' })
    const auto = await recordAudit({
      actor: { type: 'USER', id: 3 },
      action: 'ADJUST',
      entity: 'INVENTORY',
      description: `${P}auto-req`
    })
    expect(auto.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })

  test('contract violations throw fail-fast', async () => {
    await expect(recordAudit({})).rejects.toThrow('action')
    await expect(recordAudit({ action: 'X' })).rejects.toThrow('entity')
    await expect(
      recordAudit({ action: 'X', entity: 'USER', actor: { type: 'HUMAN' } })
    ).rejects.toThrow('actorType')
    await expect(
      recordAudit({ action: 'X', entity: 'USER', result: 'MAYBE' })
    ).rejects.toThrow('result')
  })
})

describe('AUD-1 safety', () => {
  test('credential fields are redacted from state and metadata', async () => {
    const row = await recordAudit({
      actor: { type: 'USER', id: 4 },
      action: 'UPDATE',
      entity: 'USER',
      previousState: { password: 's3cret', nested: { accessToken: 'abc' } },
      newState: { passwordHash: 'h', ok: 1 },
      metadata: { secret: 's', apiSecret: 'k' },
      description: `${P}redact`
    })
    expect(row.oldValues).toEqual({
      password: '[REDACTED]',
      nested: { accessToken: '[REDACTED]' }
    })
    expect(row.newValues.passwordHash).toBe('[REDACTED]')
    expect(row.metadata).toEqual({ secret: '[REDACTED]', apiSecret: '[REDACTED]' })
  })

  test('reason is truncated, never a raw dump', async () => {
    const row = await recordAudit({
      actor: { type: 'USER', id: 4 },
      action: 'UPDATE',
      entity: 'USER',
      reason: 'x'.repeat(2000),
      description: `${P}reason`
    })
    expect(row.reason).toHaveLength(500)
  })

  test('client-supplied body tenant/store never becomes authority', async () => {
    const sneaky = {
      ...baseReq(),
      body: { tenantId: 9999, store: 8888, storeId: 8888 },
      params: { tenantId: 7777 },
      query: { store: 6666 }
    }
    delete sneaky.storeId
    sneaky.user = { id: 5, userName: `${P}SNEAKY` }
    const row = await recordAudit({
      req: sneaky,
      action: 'UPDATE',
      entity: 'USER',
      description: `${P}sneaky`
    })
    expect(row.tenantId).toBeNull()
    expect(row.store).toBeNull()
  })

  test('explicit server-side scope wins over request context', async () => {
    const row = await recordAudit({
      req: baseReq(),
      action: 'UPDATE',
      entity: 'USER',
      tenantId: tenantB.id,
      storeId: null,
      description: `${P}explicit`
    })
    expect(row.tenantId).toBe(tenantB.id)
    expect(row.store).toBeNull()
  })
})

describe('AUD-1 compatibility', () => {
  test('legacy createAudit and redactAndAudit still work', async () => {
    await createAudit(
      baseReq(),
      'update',
      `${P}LEGACY`,
      1,
      `${P}legacy`,
      { a: 1 },
      { a: 2 }
    )
    await redactAndAudit(baseReq(), {
      action: 'update',
      entity: `${P}LEGACY2`,
      entityId: 2,
      description: `${P}legacy2`,
      oldValues: { password: 'pw' },
      newValues: { ok: true }
    })
    const rows = await db.auditLog.findAll({
      where: { description: [`${P}legacy`, `${P}legacy2`] }
    })
    expect(rows).toHaveLength(2)
    // Legacy rows remain readable under the new model with safe defaults.
    for (const r of rows) {
      expect(r.actorType).toBe('USER')
      expect(r.result).toBe('SUCCESS')
      expect(r.tenantId).toBeNull()
    }
    const redacted = rows.find((r) => r.description === `${P}legacy2`)
    expect(redacted.oldValues).toEqual({ password: '[REDACTED]' })
  })
})

describe('AUD-1 transaction readiness', () => {
  test('participates in caller transaction: rollback removes the row', async () => {
    const t = await db.sequelize.transaction()
    await recordAudit({
      actor: { type: 'USER', id: 6 },
      action: 'CREATE',
      entity: 'ORDER',
      description: `${P}rollback`,
      transaction: t
    })
    await t.rollback()
    const found = await db.auditLog.findOne({
      where: { description: `${P}rollback` }
    })
    expect(found).toBeNull()
  })

  test('participates in caller transaction: commit persists the row', async () => {
    const t = await db.sequelize.transaction()
    await recordAudit({
      actor: { type: 'USER', id: 6 },
      action: 'CREATE',
      entity: 'ORDER',
      description: `${P}commit`,
      transaction: t
    })
    await t.commit()
    const found = await db.auditLog.findOne({
      where: { description: `${P}commit` }
    })
    expect(found).not.toBeNull()
    expect(found.result).toBe('SUCCESS')
  })
})
