'use strict'

// W3-6b (BE audit S-06, FIXING-PLAN K8): queue numbers come from the per
// outlet, per business-day counter (document_counter, docType 'queue') and
// stay short for the customer ("Q001"). The old Q<HHmm>-<3 random digits>
// was unique GLOBALLY across every outlet of every tenant, forever: 1,44
// million values, after which inserts failed with 500.
//
// 1. queue."storeId" INTEGER + queue."businessDate" DATEONLY (nullable). The
//    `store` column is JSONB (array or a bare number) and the business day
//    depends on the outlet's timezone, so neither can back an index directly.
// 2. Backfill: storeId = first outlet in `store`; businessDate = checkedInAt
//    (or createdAt) on that outlet's calendar (location.timezone, default
//    Asia/Jakarta). `store` itself is normalized to a one-element array — the
//    shape getQueueList/updateQueue match with @>.
// 3. queue_queue_number (global UNIQUE on "queueNumber") →
//    uq_queue_store_day_number ("storeId", "businessDate", "queueNumber")
//    WHERE "deletedAt" IS NULL.
//
// Guarded and replay-safe. down() refuses (no DDL) while a live queue number
// is used twice, because the global unique could not be restored.
const NEW_UNIQUE = 'uq_queue_store_day_number'

module.exports = {
  async up(queryInterface, Sequelize) {
    const columns = await queryInterface.describeTable('queue')
    if (!columns.storeId) {
      await queryInterface.addColumn('queue', 'storeId', { type: Sequelize.INTEGER, allowNull: true })
    }
    if (!columns.businessDate) {
      await queryInterface.addColumn('queue', 'businessDate', { type: Sequelize.DATEONLY, allowNull: true })
    }

    await queryInterface.sequelize.query(`
      UPDATE queue
         SET store = jsonb_build_array(store)
       WHERE jsonb_typeof(store) IN ('number', 'string')`)

    await queryInterface.sequelize.query(`
      UPDATE queue q
         SET "storeId" = (q.store->>0)::int
       WHERE q."storeId" IS NULL
         AND jsonb_typeof(q.store) = 'array'
         AND jsonb_array_length(q.store) > 0
         AND (q.store->>0) ~ '^[0-9]+$'`)

    await queryInterface.sequelize.query(`
      UPDATE queue q
         SET "businessDate" = (COALESCE(q."checkedInAt", q."createdAt") AT TIME ZONE src.tz)::date
        FROM (
          SELECT q2.id,
                 CASE WHEN EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = l.timezone)
                      THEN l.timezone ELSE 'Asia/Jakarta' END AS tz
            FROM queue q2
            LEFT JOIN location l ON l.id = q2."storeId"
        ) src
       WHERE src.id = q.id AND q."businessDate" IS NULL`)

    await queryInterface.sequelize.query('DROP INDEX IF EXISTS "queue_queue_number"')
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "${NEW_UNIQUE}" ON "queue" ("storeId", "businessDate", "queueNumber") WHERE "deletedAt" IS NULL`
    )
  },

  async down(queryInterface) {
    const [[dup]] = await queryInterface.sequelize.query(
      `SELECT COUNT(*)::int AS n FROM (SELECT "queueNumber" FROM queue WHERE "deletedAt" IS NULL GROUP BY "queueNumber" HAVING COUNT(*) > 1) d`
    )
    if (dup.n > 0) {
      throw new Error(`queue-daily-number down: ${dup.n} live queue number(s) are used more than once; the global unique cannot be restored`)
    }
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "${NEW_UNIQUE}"`)
    await queryInterface.sequelize.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS "queue_queue_number" ON "queue" ("queueNumber") WHERE "deletedAt" IS NULL'
    )
    const columns = await queryInterface.describeTable('queue')
    if (columns.businessDate) await queryInterface.removeColumn('queue', 'businessDate')
    if (columns.storeId) await queryInterface.removeColumn('queue', 'storeId')
  }
}
