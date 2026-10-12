process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// FP-01: legacy audit helpers must propagate failures when a transaction
// is supplied, so the owning business transaction can roll back.
// Uses the isolated test database (jest globalSetup) with FP_TX_-prefixed
// fixtures, all removed in afterAll via the documented maintenance bypass.
// Never touches real data.
const db = require('../db/models')
const { auditLog, createAudit } = require('../utils/auditLog')

const P = 'FP_TX_'
let store = null

beforeAll(async () => {
  store = await db.location.create({ name: `${P}STORE`, status: 'active' })
})

afterAll(async () => {
  await db.auditLog.destroy({
    where: { description: { [db.Sequelize.Op.like]: `${P}%` } },
    force: true,
    __auditMaintenance: true
  })
  await db.location.destroy({
    where: { name: { [db.Sequelize.Op.like]: `${P}%` } },
    force: true
  })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

const baseReq = () => ({
  storeId: store.id,
  user: { id: 4242, userName: `${P}USER`, roleType: 'admin', store: store.id },
  ip: '127.0.0.1',
  get: () => 'jest-agent'
})

// Deterministic failure mechanism: `action` is NOT NULL (VARCHAR(20)) on
// the auditLog model and the legacy path performs no argument validation,
// so `action: null` always rejects at persistence time without mocks,
// timing, or external services.
const failingAuditWith = (tx) =>
  auditLog({
    store: store.id,
    userId: 4242,
    userName: `${P}USER`,
    action: null,
    entity: `${P}ENTITY`,
    entityId: 1,
    description: `${P}failing-op`,
    oldValues: { ok: 1 },
    newValues: { ok: 2 },
    ipAddress: '127.0.0.1',
    userAgent: 'jest-agent',
    transaction: tx
  })

describe('FP-01 legacy audit failure propagation with transaction', () => {
  test('Test A: failing legacy audit with a transaction rejects and rolls back the owning business mutation', async () => {
    // Ownership boundary mirrors the controller pattern
    // (db.sequelize.transaction callback owning both the business write
    // and the legacy audit write): the whole unit must reject and persist
    // nothing — no business row, no audit row.
    await expect(
      db.sequelize.transaction(async (t) => {
        await db.location.create(
          { name: `${P}BUSINESS_ROW`, status: 'active' },
          { transaction: t }
        )
        await createAudit(
          baseReq(),
          null,
          `${P}ENTITY`,
          1,
          `${P}failing-op`,
          { ok: 1 },
          { ok: 2 },
          t
        )
      })
    ).rejects.toThrow()

    expect(
      await db.location.findOne({ where: { name: `${P}BUSINESS_ROW` } })
    ).toBeNull()
    expect(
      await db.auditLog.findOne({ where: { description: `${P}failing-op` } })
    ).toBeNull()
  })

  test('Test A2: low-level auditLog with a transaction rejects instead of resolving', async () => {
    const t = await db.sequelize.transaction()
    try {
      await expect(failingAuditWith(t)).rejects.toThrow()
    } finally {
      await t.rollback()
    }
    expect(
      await db.auditLog.findOne({ where: { description: `${P}failing-op` } })
    ).toBeNull()
  })

  test('Test B: failing legacy audit without a transaction preserves fire-and-forget behavior', async () => {
    // Compatibility contract: without a transaction the helper must not
    // throw to its caller — it resolves (undefined) after logging.
    await expect(failingAuditWith(undefined)).resolves.toBeUndefined()
    expect(
      await db.auditLog.findOne({ where: { description: `${P}failing-op` } })
    ).toBeNull()
  })

  test('Test C: successful legacy audit with a transaction commits with the owner and is invisible before commit', async () => {
    const t = await db.sequelize.transaction()
    await auditLog({
      store: store.id,
      userId: 4242,
      userName: `${P}USER`,
      action: 'update',
      entity: `${P}ENTITY`,
      entityId: 7,
      description: `${P}tx-commit`,
      oldValues: { ok: 1 },
      newValues: { ok: 2 },
      ipAddress: '127.0.0.1',
      userAgent: 'jest-agent',
      transaction: t
    })
    // Not committed independently: invisible outside the owner tx.
    expect(
      await db.auditLog.findOne({ where: { description: `${P}tx-commit` } })
    ).toBeNull()
    await t.commit()
    expect(
      await db.auditLog.findOne({ where: { description: `${P}tx-commit` } })
    ).not.toBeNull()
  })

  test('Test C2: successful legacy audit with a transaction disappears on owner rollback', async () => {
    const t = await db.sequelize.transaction()
    await auditLog({
      store: store.id,
      userId: 4242,
      userName: `${P}USER`,
      action: 'update',
      entity: `${P}ENTITY`,
      entityId: 8,
      description: `${P}tx-rollback`,
      oldValues: { ok: 1 },
      newValues: { ok: 2 },
      ipAddress: '127.0.0.1',
      userAgent: 'jest-agent',
      transaction: t
    })
    await t.rollback()
    expect(
      await db.auditLog.findOne({ where: { description: `${P}tx-rollback` } })
    ).toBeNull()
  })
})

// Test D (endpoint-level decideVariance with forced audit failure) lives
// in __tests__/cash-variance-audit-failure.test.js: it runs against the
// merged BE-1 transactional decideVariance, forces only that endpoint's
// decision audit write to fail, and asserts a non-2xx response with the
// decision still pending and zero committed decision audits. Test A above
// additionally exercises the same ownership-boundary pattern (caller-owned
// transaction + business mutation + legacy audit with that transaction)
// at helper level.
