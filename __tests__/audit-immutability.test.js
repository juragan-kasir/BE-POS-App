process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// AUD-2 (DR-20 immutability + redaction hardening) regression tests.
// Uses the isolated test database (jest globalSetup) with AUD_IMM_-prefixed
// fixtures, all removed in afterAll via the documented maintenance bypass.
// Never touches real data.
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')
const {
  auditLog,
  recordAudit,
  createAudit,
  redactAndAudit
} = require('../utils/auditLog')

const P = 'AUD_IMM_'
let store = null

beforeAll(async () => {
  store = await db.location.create(await withTestTenant({ name: `${P}STORE`, status: 'active' }))
})

afterAll(async () => {
  await db.auditLog.destroy({
    where: { description: { [db.Sequelize.Op.like]: `${P}%` } },
    force: true,
    __auditMaintenance: true
  })
  await db.location.destroy({ where: { id: store?.id }, force: true })
  await db.sequelize.close()
})

const baseReq = () => ({
  storeId: store.id,
  user: { id: 4242, userName: `${P}USER`, roleType: 'admin', store: store.id },
  ip: '127.0.0.1',
  get: () => 'jest-agent'
})

describe('AUD-2 immutability — audit records are append-only', () => {
  test('CREATE via recordAudit is still allowed', async () => {
    const row = await recordAudit({
      req: baseReq(),
      action: 'CREATE',
      entity: `${P}ORDER`,
      description: `${P}create-allowed`
    })
    expect(row.id).toBeGreaterThan(0)
    const found = await db.auditLog.findByPk(row.id)
    expect(found).not.toBeNull()
  })

  test('instance update is denied and the row is unchanged', async () => {
    const row = await recordAudit({
      req: baseReq(),
      action: 'CREATE',
      entity: `${P}ORDER`,
      description: `${P}instance-update`
    })
    await expect(row.update({ description: `${P}mutated` })).rejects.toThrow(
      /append-only/
    )
    const fresh = await db.auditLog.findByPk(row.id)
    expect(fresh.description).toBe(`${P}instance-update`)
  })

  test('instance destroy is denied and the row survives', async () => {
    const row = await recordAudit({
      req: baseReq(),
      action: 'CREATE',
      entity: `${P}ORDER`,
      description: `${P}instance-destroy`
    })
    await expect(row.destroy()).rejects.toThrow(/append-only/)
    expect(await db.auditLog.findByPk(row.id)).not.toBeNull()
  })

  test('instance save on an existing row is denied', async () => {
    const row = await recordAudit({
      req: baseReq(),
      action: 'CREATE',
      entity: `${P}ORDER`,
      description: `${P}instance-save`
    })
    const fetched = await db.auditLog.findByPk(row.id)
    fetched.description = `${P}mutated-save`
    await expect(fetched.save()).rejects.toThrow(/append-only/)
    expect((await db.auditLog.findByPk(row.id)).description).toBe(
      `${P}instance-save`
    )
  })

  test('static update (bulk) is denied and rows are unchanged', async () => {
    const row = await recordAudit({
      req: baseReq(),
      action: 'CREATE',
      entity: `${P}ORDER`,
      description: `${P}static-update`
    })
    await expect(
      db.auditLog.update(
        { description: `${P}mutated` },
        { where: { id: row.id } }
      )
    ).rejects.toThrow(/append-only/)
    expect((await db.auditLog.findByPk(row.id)).description).toBe(
      `${P}static-update`
    )
  })

  test('static destroy (bulk) is denied and rows survive', async () => {
    const row = await recordAudit({
      req: baseReq(),
      action: 'CREATE',
      entity: `${P}ORDER`,
      description: `${P}static-destroy`
    })
    await expect(
      db.auditLog.destroy({ where: { id: row.id }, force: true })
    ).rejects.toThrow(/append-only/)
    expect(await db.auditLog.findByPk(row.id)).not.toBeNull()
  })

  test('upsert is denied', async () => {
    const row = await recordAudit({
      req: baseReq(),
      action: 'CREATE',
      entity: `${P}ORDER`,
      description: `${P}upsert`
    })
    await expect(
      db.auditLog.upsert({ id: row.id, description: `${P}mutated-upsert` })
    ).rejects.toThrow(/append-only/)
    expect((await db.auditLog.findByPk(row.id)).description).toBe(
      `${P}upsert`
    )
  })

  test('bulkCreate without updateOnDuplicate remains allowed (append path)', async () => {
    const rows = await db.auditLog.bulkCreate([
      {
        action: 'create',
        entity: `${P}BULK`,
        description: `${P}bulk-1`,
        store: store.id
      },
      {
        action: 'create',
        entity: `${P}BULK`,
        description: `${P}bulk-2`,
        store: store.id
      }
    ])
    expect(rows).toHaveLength(2)
  })

  test('bulkCreate with updateOnDuplicate is denied', async () => {
    await expect(
      db.auditLog.bulkCreate(
        [{ action: 'create', entity: `${P}BULK`, description: `${P}bulk-3` }],
        { updateOnDuplicate: ['description'] }
      )
    ).rejects.toThrow(/append-only/)
  })

  test('denial error is deterministic and leaks no payload', async () => {
    const row = await recordAudit({
      req: baseReq(),
      action: 'CREATE',
      entity: `${P}ORDER`,
      description: `${P}error-safety`
    })
    const err = await db.auditLog
      .update({ description: 'x' }, { where: { id: row.id } })
      .catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe(
      'auditLog is append-only: UPDATE is not allowed'
    )
    expect(JSON.stringify(err.message)).not.toContain(`${P}error-safety`)
  })

  test('documented maintenance bypass allows test/migration cleanup only', async () => {
    const row = await recordAudit({
      req: baseReq(),
      action: 'CREATE',
      entity: `${P}ORDER`,
      description: `${P}maintenance`
    })
    const deleted = await db.auditLog.destroy({
      where: { id: row.id },
      force: true,
      __auditMaintenance: true
    })
    expect(deleted).toBe(1)
    expect(await db.auditLog.findByPk(row.id)).toBeNull()
  })
})

describe('AUD-2 redaction hardening — all write paths', () => {
  const mixedPayload = () => ({
    username: 'teddy',
    password: 'secret-password',
    TOKEN: 'secret-token',
    Secret: 'secret-secret',
    apiSecret: 'secret-apisecret',
    APIKEY: 'secret-apikey',
    clientSecret: 'secret-clientsecret',
    privateKey: 'secret-privatekey',
    productName: 'Safe Product',
    amount: 10000,
    status: 'active',
    profile: {
      apiKey: 'secret-nested-key',
      displayName: 'Safe Name'
    },
    items: [
      {
        clientSecret: 'secret-client',
        amount: 10000
      }
    ]
  })

  const expectHardened = (persisted) => {
    expect(persisted.password).toBe('[REDACTED]')
    expect(persisted.TOKEN).toBe('[REDACTED]')
    expect(persisted.Secret).toBe('[REDACTED]')
    expect(persisted.apiSecret).toBe('[REDACTED]')
    expect(persisted.APIKEY).toBe('[REDACTED]')
    expect(persisted.clientSecret).toBe('[REDACTED]')
    expect(persisted.privateKey).toBe('[REDACTED]')
    expect(persisted.username).toBe('teddy')
    expect(persisted.productName).toBe('Safe Product')
    expect(persisted.amount).toBe(10000)
    expect(persisted.status).toBe('active')
    expect(persisted.profile.apiKey).toBe('[REDACTED]')
    expect(persisted.profile.displayName).toBe('Safe Name')
    expect(persisted.items[0].clientSecret).toBe('[REDACTED]')
    expect(persisted.items[0].amount).toBe(10000)
    const dumped = JSON.stringify(persisted)
    for (const secret of [
      'secret-password',
      'secret-token',
      'secret-secret',
      'secret-apisecret',
      'secret-apikey',
      'secret-clientsecret',
      'secret-privatekey',
      'secret-nested-key',
      'secret-client'
    ]) {
      expect(dumped).not.toContain(secret)
    }
  }

  test('canonical recordAudit redacts previousState/newState/metadata', async () => {
    const row = await recordAudit({
      actor: { type: 'USER', id: 7 },
      action: 'UPDATE',
      entity: `${P}REDACT`,
      previousState: mixedPayload(),
      newState: mixedPayload(),
      metadata: mixedPayload(),
      description: `${P}canonical`
    })
    expectHardened(row.oldValues)
    expectHardened(row.newValues)
    expectHardened(row.metadata)
  })

  test('legacy createAudit redacts credentials before persistence', async () => {
    await createAudit(
      baseReq(),
      'update',
      `${P}LEGACY`,
      1,
      `${P}legacy-redacted`,
      { password: 'real-password', keep: 'yes' },
      { apiKey: 'real-api-key', keep: 'yes' }
    )
    const row = await db.auditLog.findOne({
      where: { description: `${P}legacy-redacted` }
    })
    expect(row).not.toBeNull()
    expect(row.oldValues.password).toBe('[REDACTED]')
    expect(row.newValues.apiKey).toBe('[REDACTED]')
    expect(row.oldValues.keep).toBe('yes')
    expect(JSON.stringify(row.oldValues)).not.toContain('real-password')
    expect(JSON.stringify(row.newValues)).not.toContain('real-api-key')
  })

  test('legacy low-level auditLog redacts credentials before persistence', async () => {
    await auditLog({
      store: store.id,
      userId: 9,
      userName: `${P}USER`,
      action: 'update',
      entity: `${P}LEGACY2`,
      entityId: 2,
      description: `${P}legacy2-redacted`,
      oldValues: { nested: { privateKey: 'real-private-key' }, ok: 1 },
      newValues: { clientSecret: 'real-client-secret', ok: 2 }
    })
    const row = await db.auditLog.findOne({
      where: { description: `${P}legacy2-redacted` }
    })
    expect(row).not.toBeNull()
    expect(row.oldValues.nested.privateKey).toBe('[REDACTED]')
    expect(row.newValues.clientSecret).toBe('[REDACTED]')
    expect(JSON.stringify(row)).not.toContain('real-private-key')
    expect(JSON.stringify(row)).not.toContain('real-client-secret')
  })

  test('redactAndAudit stays redacted (idempotent double-redaction)', async () => {
    await redactAndAudit(baseReq(), {
      action: 'update',
      entity: `${P}LEGACY3`,
      entityId: 3,
      description: `${P}legacy3-redacted`,
      oldValues: { password: 'pw-1', safe: 'keep' },
      newValues: { password: '[REDACTED]', safe: 'keep' }
    })
    const row = await db.auditLog.findOne({
      where: { description: `${P}legacy3-redacted` }
    })
    expect(row.oldValues.password).toBe('[REDACTED]')
    expect(row.newValues.password).toBe('[REDACTED]')
    expect(row.oldValues.safe).toBe('keep')
    expect(JSON.stringify(row)).not.toContain('pw-1')
  })
})

describe('AUD-2 transaction regression', () => {
  test('recordAudit in a rolled-back transaction does not persist', async () => {
    const t = await db.sequelize.transaction()
    await recordAudit({
      actor: { type: 'USER', id: 8 },
      action: 'CREATE',
      entity: 'ORDER',
      description: `${P}tx-rollback`,
      transaction: t
    })
    await t.rollback()
    expect(
      await db.auditLog.findOne({ where: { description: `${P}tx-rollback` } })
    ).toBeNull()
  })

  test('recordAudit in a committed transaction persists', async () => {
    const t = await db.sequelize.transaction()
    await recordAudit({
      actor: { type: 'USER', id: 8 },
      action: 'CREATE',
      entity: 'ORDER',
      description: `${P}tx-commit`,
      transaction: t
    })
    await t.commit()
    const found = await db.auditLog.findOne({
      where: { description: `${P}tx-commit` }
    })
    expect(found).not.toBeNull()
  })
})
