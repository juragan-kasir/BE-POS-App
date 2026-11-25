'use strict'

// Bakery & catering pre-order domain (batch B28). FE contract:
// FE-BAKERY-App src/api/contract.ts (/bakery/*).
//
// Additive and guarded (add-if-missing), so it is replay-safe and can run on
// the test DB from scripts/setup-test-db.js.
//
// 1. tenant.bakerySettings JSONB (lead time, pickup window, delivery, WA
//    templates). Null for other business types.
// 2. bakery_order: the pre-order view of a POS `order` (the money lives in
//    order / order_item / transaction, like laundry_order): schedule,
//    pickup/delivery, notes, process status. tenantId NOT NULL. Status is
//    STRING + CHECK, not ENUM (B15 incident).
// 3. bakery_status_history: every status change, with the idempotency key of
//    the request that made it (a retried click is a replay, not a 2nd row).

const STATUSES = "'PENDING_CONFIRMATION','CONFIRMED','IN_PRODUCTION','READY','PICKED_UP','DELIVERED','CANCELLED'"
const TABLES = ['bakery_status_history', 'bakery_order']

const id = (Sequelize) => ({ allowNull: false, autoIncrement: true, primaryKey: true, type: Sequelize.INTEGER })
const tenantFk = (Sequelize) => ({
  allowNull: false,
  type: Sequelize.INTEGER,
  references: { model: 'tenant', key: 'id' },
  onUpdate: 'CASCADE',
  onDelete: 'RESTRICT'
})

module.exports = {
  async up(queryInterface, Sequelize) {
    const q = (sql) => queryInterface.sequelize.query(sql)
    const tenantCols = await queryInterface.describeTable('tenant')
    if (!tenantCols.bakerySettings) {
      await queryInterface.addColumn('tenant', 'bakerySettings', { type: Sequelize.JSONB, allowNull: true })
    }

    const tables = await queryInterface.showAllTables()
    if (!tables.includes('bakery_order')) {
      await queryInterface.createTable('bakery_order', {
        id: id(Sequelize),
        tenantId: tenantFk(Sequelize),
        store: { allowNull: false, type: Sequelize.INTEGER, references: { model: 'location', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT' },
        orderId: { allowNull: false, type: Sequelize.INTEGER, references: { model: 'order', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        memberId: { type: Sequelize.INTEGER, allowNull: true },
        fulfillmentType: { allowNull: false, type: Sequelize.STRING(10) },
        scheduledAt: { allowNull: false, type: Sequelize.DATE },
        deliveryAddress: { type: Sequelize.STRING(500), allowNull: true },
        deliveryNote: { type: Sequelize.STRING(300), allowNull: true },
        customerNote: { type: Sequelize.STRING(500), allowNull: true },
        adminNote: { type: Sequelize.STRING(500), allowNull: true },
        processStatus: { allowNull: false, type: Sequelize.STRING(25), defaultValue: 'PENDING_CONFIRMATION' },
        idempotencyKey: { allowNull: false, type: Sequelize.STRING(100) },
        requestHash: { allowNull: false, type: Sequelize.STRING(64) },
        createdBy: { type: Sequelize.INTEGER },
        modifiedBy: { type: Sequelize.INTEGER },
        createdAt: { allowNull: false, type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
        updatedAt: { allowNull: false, type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
      })
    }
    if (!tables.includes('bakery_status_history')) {
      await queryInterface.createTable('bakery_status_history', {
        id: id(Sequelize),
        tenantId: tenantFk(Sequelize),
        bakeryOrderId: { allowNull: false, type: Sequelize.INTEGER, references: { model: 'bakery_order', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        fromStatus: { type: Sequelize.STRING(25), allowNull: true },
        toStatus: { allowNull: false, type: Sequelize.STRING(25) },
        reason: { type: Sequelize.STRING(300), allowNull: true },
        idempotencyKey: { type: Sequelize.STRING(100), allowNull: true },
        createdBy: { type: Sequelize.INTEGER },
        createdAt: { allowNull: false, type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
      })
    }

    // Constraints and indexes on their own guards: a table created earlier
    // (e.g. from the model on a test DB) still gets every one of them.
    const addCheck = async (table, name, expr) => {
      const [rows] = await q(`SELECT 1 FROM pg_constraint WHERE conname = '${name}' AND conrelid = '"${table}"'::regclass`)
      if (!rows.length) await q(`ALTER TABLE "${table}" ADD CONSTRAINT "${name}" CHECK (${expr})`)
    }
    await addCheck('bakery_order', 'bakery_order_status_check', `"processStatus" IN (${STATUSES}) AND "fulfillmentType" IN ('pickup','delivery')`)
    await addCheck('bakery_status_history', 'bakery_status_history_status_check', `"toStatus" IN (${STATUSES}) AND ("fromStatus" IS NULL OR "fromStatus" IN (${STATUSES}))`)
    await q('CREATE UNIQUE INDEX IF NOT EXISTS "uq_bakery_order_order" ON "bakery_order" ("orderId")')
    await q('CREATE UNIQUE INDEX IF NOT EXISTS "uq_bakery_order_store_idempotency" ON "bakery_order" ("store", "idempotencyKey")')
    await q('CREATE INDEX IF NOT EXISTS "bakery_order_store_scheduled_idx" ON "bakery_order" ("store", "scheduledAt")')
    await q('CREATE INDEX IF NOT EXISTS "bakery_order_tenant_idx" ON "bakery_order" ("tenantId")')
    await q('CREATE UNIQUE INDEX IF NOT EXISTS "uq_bakery_status_history_idempotency" ON "bakery_status_history" ("bakeryOrderId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL')
    await q('CREATE INDEX IF NOT EXISTS "bakery_status_history_order_idx" ON "bakery_status_history" ("bakeryOrderId")')
  },

  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql)
    const tables = await queryInterface.showAllTables()
    for (const name of TABLES) {
      if (!tables.includes(name)) continue
      const [[{ n }]] = await q(`SELECT COUNT(*)::int AS n FROM "${name}"`)
      if (n > 0) throw new Error(`[bakery-domain down] ${name} has ${n} rows; refusing to drop bakery tables`)
    }
    for (const name of TABLES) {
      if (tables.includes(name)) await q(`DROP TABLE IF EXISTS "${name}" CASCADE`)
    }
    const cols = await queryInterface.describeTable('tenant')
    if (cols.bakerySettings) await queryInterface.removeColumn('tenant', 'bakerySettings')
  }
}

module.exports.TABLES = TABLES
