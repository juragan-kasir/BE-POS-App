process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const db = require('../db/models')
const { recordAudit, createAudit } = require('../utils/auditLog')

const P = 'AUDIT_DB_'
let tenant = null
let store = null

const requestContext = () => ({
  user: { id: 4242, userName: `${P}USER`, roleType: 'admin' },
  authContext: { activeTenantId: tenant.id },
  storeId: store.id,
  ip: '127.0.0.1',
  get: () => 'jest-agent'
})

const makeAudit = (description, tenantId = null) =>
  db.auditLog.create({
    store: store.id,
    userId: 4242,
    userName: `${P}USER`,
    action: 'create',
    entity: `${P}ENTITY`,
    description,
    tenantId
  })

const withAuditMaintenanceOff = async (fn) => {
  const transaction = await db.sequelize.transaction()
  try {
    await db.sequelize.query("SET LOCAL app.audit_maintenance = 'off'", {
      transaction
    })
    return await fn(transaction)
  } finally {
    await transaction.rollback()
  }
}

beforeAll(async () => {
  tenant = await db.tenant.create({
    code: `${P}${Date.now()}`,
    name: `${P}TENANT`
  })
  store = await db.location.create({
    name: `${P}STORE`,
    status: 'active',
    tenantId: tenant.id
  })
})

afterAll(async () => {
  await db.auditLog.destroy({
    where: { description: { [db.Sequelize.Op.like]: `${P}%` } },
    force: true,
    __auditMaintenance: true
  })
  await db.location.destroy({ where: { id: store?.id }, force: true })
  await db.tenant.destroy({ where: { id: tenant?.id }, force: true })
  await db.sequelize.close()
})

describe('auditLog database backstop', () => {
  test('raw SQL UPDATE is rejected and the row is unchanged', async () => {
    const row = await makeAudit(`${P}raw-update`)

    await withAuditMaintenanceOff(async (transaction) => {
      await expect(
        db.sequelize.query(
          'UPDATE "auditLog" SET "description" = :description WHERE id = :id',
          {
            replacements: { description: `${P}mutated`, id: row.id },
            transaction
          }
        )
      ).rejects.toThrow(/append-only/)
    })

    expect((await db.auditLog.findByPk(row.id)).description).toBe(
      `${P}raw-update`
    )
  })

  test('raw SQL DELETE is rejected and the row survives', async () => {
    const row = await makeAudit(`${P}raw-delete`)

    await withAuditMaintenanceOff(async (transaction) => {
      await expect(
        db.sequelize.query('DELETE FROM "auditLog" WHERE id = :id', {
          replacements: { id: row.id },
          transaction
        })
      ).rejects.toThrow(/append-only/)
    })

    expect(await db.auditLog.findByPk(row.id)).not.toBeNull()
  })

  test('a tenantId that does not reference a tenant is rejected by the FK', async () => {
    const result = await makeAudit(`${P}bad-tenant`, 999999999)
      .then((row) => row)
      .catch((error) => error)

    if (result instanceof Error) {
      expect(result.name).toBe('SequelizeForeignKeyConstraintError')
      return
    }

    await result.destroy({ force: true, __auditMaintenance: true })
    throw new Error('auditLog accepted a tenantId with no matching tenant')
  })
})

describe('auditLog tenant backfill migration', () => {
  test('is idempotent and backfills tenantId from the store', async () => {
    const row = await makeAudit(`${P}migration-backfill`, null)
    const migration = require('../db/migrations/20261023000001-harden-audit-log')
    const queryInterface = db.sequelize.getQueryInterface()

    await migration.up(queryInterface, db.Sequelize)
    await migration.up(queryInterface, db.Sequelize)

    await row.reload()
    expect(row.tenantId).toBe(tenant.id)
  })
})

describe('auditLog tenant propagation', () => {
  test('recordAudit falls back to the auth context tenant', async () => {
    const row = await recordAudit({
      req: requestContext(),
      action: 'create',
      entity: `${P}RECORD`,
      description: `${P}record-tenant`
    })

    expect(row.tenantId).toBe(tenant.id)
  })

  test('legacy createAudit also records the auth context tenant', async () => {
    await createAudit(
      requestContext(),
      'create',
      `${P}LEGACY`,
      null,
      `${P}legacy-tenant`
    )

    const row = await db.auditLog.findOne({
      where: { description: `${P}legacy-tenant` }
    })
    expect(row).not.toBeNull()
    expect(row.tenantId).toBe(tenant.id)
  })
})
