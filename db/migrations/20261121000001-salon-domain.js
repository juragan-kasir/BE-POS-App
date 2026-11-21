'use strict'

// Salon & barbershop domain (S1-a, batch B26). Plan:
// docs/audits/be-owner-hierarchy-2026-11-18/SALON-BARBERSHOP-PLAN.md §3.1,
// rules: docs/product/salon/SALON-BA.md (BR-SLN-*, DR-SLN-*).
//
// Additive and guarded (add-if-missing), so it is replay-safe and can run on
// the test DB from scripts/setup-test-db.js.
//
// 1. btree_gist, for the double-booking exclusion constraint (DR-SLN-05).
// 2. tenant.salonSettings / location.salonSettings JSONB (profile, slot step,
//    deposit default, points; outlet opening hours + owner PIN hash).
// 3. order_item.staffId (DR-SLN-06: service/product attribution).
// 4. attendance.idempotencyKey / shift_swap.idempotencyKey (retry-safe
//    clock-in and swap requests from the stylist phone).
// 5. salon_* tables, every one tenantId NOT NULL (BR-SLN-020). Statuses are
//    STRING + CHECK, not ENUM: a later label is a CHECK swap, never an enum
//    literal that breaks reads before the batch runs (B15 incident).
//    salon_appointment_item carries
//      EXCLUDE USING gist ("staffId" WITH =, tstzrange("startAt","endAt") WITH &&)
//      WHERE status IN (booked, confirmed, checked_in, in_service) AND "deletedAt" IS NULL
//    so the database, not the controller, refuses a second booking of the
//    same staff minutes. endAt includes the service buffer (BR-SLN-002).
//    salon_staff_commission is an immutable ledger (DR-SLN-07): a trigger
//    refuses UPDATE/DELETE unless the session sets salon.ledger_maintenance.
//
// Commission rules by category (commission_rule in the plan) are phase 2
// (DR-SLN-09): MVP rules live on the service/product (serviceConfig) and on
// the staff profile (commissionOverride), so no table is created for them.

const BLOCKING = "'booked','confirmed','checked_in','in_service'"
const APPOINTMENT_STATUSES = `${BLOCKING},'completed','paid','no_show','cancelled'`

const id = (Sequelize) => ({ allowNull: false, autoIncrement: true, primaryKey: true, type: Sequelize.INTEGER })
const tenantFk = (Sequelize) => ({
  allowNull: false,
  type: Sequelize.INTEGER,
  references: { model: 'tenant', key: 'id' },
  onUpdate: 'CASCADE',
  onDelete: 'RESTRICT'
})
const stamps = (Sequelize, { paranoid = true } = {}) => ({
  createdAt: { allowNull: false, type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
  updatedAt: { allowNull: false, type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
  ...(paranoid ? { deletedAt: { type: Sequelize.DATE } } : {})
})

const SALON_TABLES = [
  'salon_staff_commission',
  'salon_order',
  'salon_queue_ticket',
  'salon_appointment_event',
  'salon_appointment_item',
  'salon_appointment',
  'salon_time_off',
  'salon_availability',
  'salon_staff_skill',
  'salon_staff_profile'
]

module.exports = {
  async up(queryInterface, Sequelize) {
    const q = (sql) => queryInterface.sequelize.query(sql)
    await q('CREATE EXTENSION IF NOT EXISTS btree_gist')

    const addColumnIfMissing = async (table, column, spec) => {
      const cols = await queryInterface.describeTable(table)
      if (!cols[column]) await queryInterface.addColumn(table, column, spec)
    }
    await addColumnIfMissing('tenant', 'salonSettings', { type: Sequelize.JSONB, allowNull: true })
    await addColumnIfMissing('location', 'salonSettings', { type: Sequelize.JSONB, allowNull: true })
    await addColumnIfMissing('order_item', 'staffId', { type: Sequelize.INTEGER, allowNull: true })
    await q('CREATE INDEX IF NOT EXISTS "order_item_staff_created_idx" ON "order_item" ("staffId", "createdAt") WHERE "staffId" IS NOT NULL')
    await addColumnIfMissing('attendance', 'idempotencyKey', { type: Sequelize.STRING(100), allowNull: true })
    await q('CREATE UNIQUE INDEX IF NOT EXISTS "uq_attendance_user_idempotency" ON "attendance" ("userId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL')
    await addColumnIfMissing('shift_swap', 'idempotencyKey', { type: Sequelize.STRING(100), allowNull: true })
    await q('CREATE UNIQUE INDEX IF NOT EXISTS "uq_shift_swap_requester_idempotency" ON "shift_swap" ("requesterId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL')

    const tables = await queryInterface.showAllTables()
    const create = async (name, columns, after) => {
      if (tables.includes(name)) return
      await queryInterface.createTable(name, columns)
      for (const sql of after) await q(sql)
    }

    await create('salon_staff_profile', {
      id: id(Sequelize),
      tenantId: tenantFk(Sequelize),
      store: { allowNull: false, type: Sequelize.INTEGER },
      userId: { allowNull: false, type: Sequelize.INTEGER, references: { model: 'user', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT' },
      positionId: { type: Sequelize.INTEGER, references: { model: 'position', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      level: { allowNull: false, type: Sequelize.STRING(10), defaultValue: 'junior' },
      colorTag: { allowNull: false, type: Sequelize.STRING(7), defaultValue: '#10b981' },
      acceptsOnline: { allowNull: false, type: Sequelize.BOOLEAN, defaultValue: true },
      active: { allowNull: false, type: Sequelize.BOOLEAN, defaultValue: true },
      commissionOverride: { type: Sequelize.JSONB, allowNull: true },
      createdBy: { type: Sequelize.INTEGER },
      modifiedBy: { type: Sequelize.INTEGER },
      ...stamps(Sequelize)
    }, [
      `ALTER TABLE "salon_staff_profile" ADD CONSTRAINT "salon_staff_profile_level_check" CHECK (level IN ('junior','senior','master'))`,
      `ALTER TABLE "salon_staff_profile" ADD CONSTRAINT "salon_staff_profile_color_check" CHECK ("colorTag" ~ '^#[0-9a-fA-F]{6}$')`,
      'CREATE UNIQUE INDEX "uq_salon_staff_profile_store_user" ON "salon_staff_profile" ("store", "userId") WHERE "deletedAt" IS NULL',
      'CREATE INDEX "salon_staff_profile_tenant_idx" ON "salon_staff_profile" ("tenantId")'
    ])

    await create('salon_staff_skill', {
      id: id(Sequelize),
      tenantId: tenantFk(Sequelize),
      store: { allowNull: false, type: Sequelize.INTEGER },
      userId: { allowNull: false, type: Sequelize.INTEGER },
      productId: { allowNull: false, type: Sequelize.INTEGER, references: { model: 'product', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      durationOverride: { type: Sequelize.INTEGER, allowNull: true },
      priceOverride: { type: Sequelize.INTEGER, allowNull: true },
      ...stamps(Sequelize, { paranoid: false })
    }, [
      'CREATE UNIQUE INDEX "uq_salon_staff_skill" ON "salon_staff_skill" ("store", "userId", "productId")',
      `ALTER TABLE "salon_staff_skill" ADD CONSTRAINT "salon_staff_skill_values_check" CHECK (("durationOverride" IS NULL OR "durationOverride" BETWEEN 5 AND 600) AND ("priceOverride" IS NULL OR "priceOverride" >= 0))`
    ])

    await create('salon_availability', {
      id: id(Sequelize),
      tenantId: tenantFk(Sequelize),
      store: { allowNull: false, type: Sequelize.INTEGER },
      userId: { allowNull: false, type: Sequelize.INTEGER },
      weekday: { allowNull: false, type: Sequelize.SMALLINT },
      startTime: { allowNull: false, type: Sequelize.TIME },
      endTime: { allowNull: false, type: Sequelize.TIME },
      ...stamps(Sequelize, { paranoid: false })
    }, [
      `ALTER TABLE "salon_availability" ADD CONSTRAINT "salon_availability_window_check" CHECK (weekday BETWEEN 0 AND 6 AND "endTime" > "startTime")`,
      'CREATE INDEX "salon_availability_staff_idx" ON "salon_availability" ("store", "userId", weekday)'
    ])

    await create('salon_time_off', {
      id: id(Sequelize),
      tenantId: tenantFk(Sequelize),
      store: { allowNull: false, type: Sequelize.INTEGER },
      userId: { allowNull: false, type: Sequelize.INTEGER },
      startAt: { allowNull: false, type: Sequelize.DATE },
      endAt: { allowNull: false, type: Sequelize.DATE },
      reason: { allowNull: false, type: Sequelize.STRING(120), defaultValue: '' },
      createdBy: { type: Sequelize.INTEGER },
      ...stamps(Sequelize)
    }, [
      `ALTER TABLE "salon_time_off" ADD CONSTRAINT "salon_time_off_range_check" CHECK ("endAt" > "startAt")`,
      'CREATE INDEX "salon_time_off_staff_idx" ON "salon_time_off" ("store", "userId", "startAt") WHERE "deletedAt" IS NULL'
    ])

    await create('salon_appointment', {
      id: id(Sequelize),
      tenantId: tenantFk(Sequelize),
      store: { allowNull: false, type: Sequelize.INTEGER },
      number: { allowNull: false, type: Sequelize.STRING(30) },
      memberId: { type: Sequelize.INTEGER, references: { model: 'member', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      customerName: { allowNull: false, type: Sequelize.STRING(60) },
      customerPhone: { allowNull: false, type: Sequelize.STRING(20), defaultValue: '' },
      status: { allowNull: false, type: Sequelize.STRING(20), defaultValue: 'booked' },
      source: { allowNull: false, type: Sequelize.STRING(10), defaultValue: 'phone' },
      startAt: { allowNull: false, type: Sequelize.DATE },
      endAt: { allowNull: false, type: Sequelize.DATE },
      depositAmount: { allowNull: false, type: Sequelize.INTEGER, defaultValue: 0 },
      depositMethod: { type: Sequelize.STRING(20), allowNull: true },
      depositReference: { type: Sequelize.STRING(60), allowNull: true },
      depositCashRegisterId: { type: Sequelize.INTEGER, allowNull: true },
      depositStatus: { allowNull: false, type: Sequelize.STRING(10), defaultValue: 'none' },
      orderId: { type: Sequelize.INTEGER, references: { model: 'order', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      notes: { allowNull: false, type: Sequelize.STRING(300), defaultValue: '' },
      idempotencyKey: { allowNull: false, type: Sequelize.STRING(100) },
      requestHash: { allowNull: false, type: Sequelize.STRING(64) },
      createdBy: { type: Sequelize.INTEGER },
      modifiedBy: { type: Sequelize.INTEGER },
      ...stamps(Sequelize)
    }, [
      `ALTER TABLE "salon_appointment" ADD CONSTRAINT "salon_appointment_status_check" CHECK (status IN (${APPOINTMENT_STATUSES}))`,
      `ALTER TABLE "salon_appointment" ADD CONSTRAINT "salon_appointment_source_check" CHECK (source IN ('walk_in','phone','online'))`,
      `ALTER TABLE "salon_appointment" ADD CONSTRAINT "salon_appointment_deposit_check" CHECK ("depositAmount" >= 0 AND "depositStatus" IN ('none','held','applied','forfeited'))`,
      `ALTER TABLE "salon_appointment" ADD CONSTRAINT "salon_appointment_range_check" CHECK ("endAt" > "startAt")`,
      'CREATE UNIQUE INDEX "uq_salon_appointment_store_idempotency" ON "salon_appointment" ("store", "idempotencyKey")',
      'CREATE UNIQUE INDEX "uq_salon_appointment_store_number" ON "salon_appointment" ("store", "number")',
      'CREATE INDEX "salon_appointment_store_start_idx" ON "salon_appointment" ("store", "startAt") WHERE "deletedAt" IS NULL',
      'CREATE INDEX "salon_appointment_member_idx" ON "salon_appointment" ("memberId") WHERE "memberId" IS NOT NULL'
    ])

    await create('salon_appointment_item', {
      id: id(Sequelize),
      tenantId: tenantFk(Sequelize),
      store: { allowNull: false, type: Sequelize.INTEGER },
      appointmentId: { allowNull: false, type: Sequelize.INTEGER, references: { model: 'salon_appointment', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      productId: { allowNull: false, type: Sequelize.INTEGER, references: { model: 'product', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT' },
      serviceName: { allowNull: false, type: Sequelize.STRING(150) },
      staffId: { allowNull: false, type: Sequelize.INTEGER },
      startAt: { allowNull: false, type: Sequelize.DATE },
      endAt: { allowNull: false, type: Sequelize.DATE },
      price: { allowNull: false, type: Sequelize.INTEGER },
      durationMin: { allowNull: false, type: Sequelize.INTEGER },
      bufferMin: { allowNull: false, type: Sequelize.INTEGER, defaultValue: 0 },
      status: { allowNull: false, type: Sequelize.STRING(20), defaultValue: 'booked' },
      ...stamps(Sequelize)
    }, [
      `ALTER TABLE "salon_appointment_item" ADD CONSTRAINT "salon_appointment_item_status_check" CHECK (status IN (${APPOINTMENT_STATUSES}))`,
      `ALTER TABLE "salon_appointment_item" ADD CONSTRAINT "salon_appointment_item_range_check" CHECK ("endAt" > "startAt" AND price >= 0 AND "durationMin" > 0)`,
      `ALTER TABLE "salon_appointment_item" ADD CONSTRAINT "salon_appointment_item_no_double_booking" EXCLUDE USING gist ("staffId" WITH =, tstzrange("startAt", "endAt") WITH &&) WHERE (status IN (${BLOCKING}) AND "deletedAt" IS NULL)`,
      'CREATE INDEX "salon_appointment_item_appointment_idx" ON "salon_appointment_item" ("appointmentId")',
      'CREATE INDEX "salon_appointment_item_staff_start_idx" ON "salon_appointment_item" ("store", "staffId", "startAt")'
    ])

    await create('salon_appointment_event', {
      id: id(Sequelize),
      tenantId: tenantFk(Sequelize),
      appointmentId: { allowNull: false, type: Sequelize.INTEGER, references: { model: 'salon_appointment', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      status: { allowNull: false, type: Sequelize.STRING(20) },
      reason: { type: Sequelize.STRING(200), allowNull: true },
      createdBy: { type: Sequelize.INTEGER },
      createdAt: { allowNull: false, type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    }, [
      `ALTER TABLE "salon_appointment_event" ADD CONSTRAINT "salon_appointment_event_status_check" CHECK (status IN (${APPOINTMENT_STATUSES}))`,
      'CREATE INDEX "salon_appointment_event_appointment_idx" ON "salon_appointment_event" ("appointmentId", "createdAt")'
    ])

    await create('salon_queue_ticket', {
      id: id(Sequelize),
      tenantId: tenantFk(Sequelize),
      store: { allowNull: false, type: Sequelize.INTEGER },
      businessDate: { allowNull: false, type: Sequelize.DATEONLY },
      seq: { allowNull: false, type: Sequelize.INTEGER },
      label: { allowNull: false, type: Sequelize.STRING(10) },
      status: { allowNull: false, type: Sequelize.STRING(10), defaultValue: 'waiting' },
      customerName: { allowNull: false, type: Sequelize.STRING(60) },
      customerPhone: { allowNull: false, type: Sequelize.STRING(20), defaultValue: '' },
      memberId: { type: Sequelize.INTEGER, references: { model: 'member', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      serviceIds: { allowNull: false, type: Sequelize.JSONB, defaultValue: [] },
      preferredStaffId: { type: Sequelize.INTEGER, allowNull: true },
      staffId: { type: Sequelize.INTEGER, allowNull: true },
      appointmentId: { type: Sequelize.INTEGER, references: { model: 'salon_appointment', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      idempotencyKey: { allowNull: false, type: Sequelize.STRING(100) },
      requestHash: { allowNull: false, type: Sequelize.STRING(64) },
      createdBy: { type: Sequelize.INTEGER },
      ...stamps(Sequelize, { paranoid: false })
    }, [
      `ALTER TABLE "salon_queue_ticket" ADD CONSTRAINT "salon_queue_ticket_status_check" CHECK (status IN ('waiting','serving','done','skipped') AND seq > 0)`,
      'CREATE UNIQUE INDEX "uq_salon_queue_store_day_seq" ON "salon_queue_ticket" ("store", "businessDate", seq)',
      'CREATE UNIQUE INDEX "uq_salon_queue_store_idempotency" ON "salon_queue_ticket" ("store", "idempotencyKey")'
    ])

    await create('salon_order', {
      id: id(Sequelize),
      tenantId: tenantFk(Sequelize),
      store: { allowNull: false, type: Sequelize.INTEGER },
      orderId: { allowNull: false, type: Sequelize.INTEGER, references: { model: 'order', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      appointmentId: { type: Sequelize.INTEGER, references: { model: 'salon_appointment', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      quote: { allowNull: false, type: Sequelize.JSONB },
      depositApplied: { allowNull: false, type: Sequelize.INTEGER, defaultValue: 0 },
      tipTotal: { allowNull: false, type: Sequelize.INTEGER, defaultValue: 0 },
      status: { allowNull: false, type: Sequelize.STRING(10), defaultValue: 'paid' },
      refund: { type: Sequelize.JSONB, allowNull: true },
      idempotencyKey: { allowNull: false, type: Sequelize.STRING(100) },
      requestHash: { allowNull: false, type: Sequelize.STRING(64) },
      createdBy: { type: Sequelize.INTEGER },
      ...stamps(Sequelize, { paranoid: false })
    }, [
      `ALTER TABLE "salon_order" ADD CONSTRAINT "salon_order_status_check" CHECK (status IN ('paid','refunded'))`,
      'CREATE UNIQUE INDEX "uq_salon_order_order" ON "salon_order" ("orderId")',
      'CREATE UNIQUE INDEX "uq_salon_order_store_idempotency" ON "salon_order" ("store", "idempotencyKey")',
      'CREATE UNIQUE INDEX "uq_salon_order_appointment" ON "salon_order" ("appointmentId") WHERE "appointmentId" IS NOT NULL',
      'CREATE INDEX "salon_order_store_created_idx" ON "salon_order" ("store", "createdAt")'
    ])

    await create('salon_staff_commission', {
      id: id(Sequelize),
      tenantId: tenantFk(Sequelize),
      store: { allowNull: false, type: Sequelize.INTEGER },
      orderId: { allowNull: false, type: Sequelize.INTEGER, references: { model: 'order', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT' },
      orderItemId: { type: Sequelize.INTEGER, allowNull: true },
      lineKey: { allowNull: false, type: Sequelize.STRING(60) },
      staffId: { allowNull: false, type: Sequelize.INTEGER },
      kind: { allowNull: false, type: Sequelize.STRING(10) },
      name: { allowNull: false, type: Sequelize.STRING(150) },
      amount: { allowNull: false, type: Sequelize.INTEGER },
      status: { allowNull: false, type: Sequelize.STRING(10) },
      reversesId: { type: Sequelize.INTEGER, references: { model: 'salon_staff_commission', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT' },
      createdBy: { type: Sequelize.INTEGER },
      createdAt: { allowNull: false, type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    }, [
      `ALTER TABLE "salon_staff_commission" ADD CONSTRAINT "salon_staff_commission_kind_check" CHECK (kind IN ('service','product','tip') AND status IN ('earned','reversed'))`,
      `ALTER TABLE "salon_staff_commission" ADD CONSTRAINT "salon_staff_commission_sign_check" CHECK ((status = 'earned' AND amount >= 0 AND "reversesId" IS NULL) OR (status = 'reversed' AND amount <= 0 AND "reversesId" IS NOT NULL))`,
      'CREATE UNIQUE INDEX "uq_salon_staff_commission_reversal" ON "salon_staff_commission" ("reversesId") WHERE "reversesId" IS NOT NULL',
      'CREATE INDEX "salon_staff_commission_staff_idx" ON "salon_staff_commission" ("store", "staffId", "createdAt")',
      'CREATE INDEX "salon_staff_commission_order_idx" ON "salon_staff_commission" ("orderId")',
      `CREATE OR REPLACE FUNCTION salon_staff_commission_immutable() RETURNS trigger AS $$
       BEGIN
         IF current_setting('salon.ledger_maintenance', true) = 'on' THEN
           RETURN COALESCE(NEW, OLD);
         END IF;
         RAISE EXCEPTION 'salon_staff_commission is immutable: write a reversal row instead (DR-SLN-07)';
       END
       $$ LANGUAGE plpgsql`,
      `CREATE TRIGGER salon_staff_commission_immutable BEFORE UPDATE OR DELETE ON "salon_staff_commission"
       FOR EACH ROW EXECUTE FUNCTION salon_staff_commission_immutable()`
    ])
  },

  // Refuses (no DDL) while any salon row exists: dropping would lose bookings
  // and the commission ledger. Columns added to shared tables stay (nullable,
  // unread once the code is rolled back).
  async down(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql)
    const tables = await queryInterface.showAllTables()
    for (const name of SALON_TABLES) {
      if (!tables.includes(name)) continue
      const [[{ n }]] = await q(`SELECT COUNT(*)::int AS n FROM "${name}"`)
      if (n > 0) throw new Error(`[salon-domain down] ${name} has ${n} rows; refusing to drop salon tables`)
    }
    for (const name of SALON_TABLES) {
      if (tables.includes(name)) await q(`DROP TABLE IF EXISTS "${name}" CASCADE`)
    }
    await q('DROP FUNCTION IF EXISTS salon_staff_commission_immutable()')
  }
}
