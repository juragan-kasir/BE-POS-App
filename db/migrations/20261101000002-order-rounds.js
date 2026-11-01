'use strict'

// E2E audit #8 open bill (product owner, 2026-11-01): items can be added to
// an unpaid order in rounds, by the cashier or by the QR diner. Each round is
// one order_round row; its idempotency key is unique per order, so a retried
// or double-tapped "add" never adds the same items twice. order_item.roundId
// links the items a round added (NULL = the order's first items).
//
// up creates the table and the column only when missing and rewrites
// nothing, so it replays safely. down stops before any DDL while a round
// exists, so rolling back never drops which items were added later.

const TABLE = 'order_round'
const ITEM_COLUMN = 'roundId'
const UNIQUE_INDEX = 'uq_order_round_order_idempotency'

async function tableExists(queryInterface, transaction) {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ?`,
    { replacements: [TABLE], transaction }
  )
  return rows.length > 0
}

async function itemColumnExists(queryInterface, transaction) {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'order_item' AND column_name = ?`,
    { replacements: [ITEM_COLUMN], transaction }
  )
  return rows.length > 0
}

async function addOrderRounds(queryInterface) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    const q = (sql) => queryInterface.sequelize.query(sql, { transaction })
    await q("SET LOCAL lock_timeout = '5s'")
    if (!(await tableExists(queryInterface, transaction))) {
      await q(`CREATE TABLE "${TABLE}" (
        id SERIAL PRIMARY KEY,
        "order" INTEGER NOT NULL REFERENCES "order"(id) ON UPDATE CASCADE ON DELETE CASCADE,
        "idempotencyKey" VARCHAR(255) NOT NULL,
        source VARCHAR(20) NOT NULL,
        "itemCount" INTEGER NOT NULL DEFAULT 0,
        "createdBy" INTEGER NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`)
    }
    await q(
      `CREATE UNIQUE INDEX IF NOT EXISTS "${UNIQUE_INDEX}" ON "${TABLE}" ("order", "idempotencyKey")`
    )
    if (!(await itemColumnExists(queryInterface, transaction))) {
      await q(
        `ALTER TABLE "order_item" ADD COLUMN "${ITEM_COLUMN}" INTEGER NULL
           REFERENCES "${TABLE}"(id) ON UPDATE CASCADE ON DELETE SET NULL`
      )
    }
  })
}

async function dropOrderRounds(queryInterface) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    const q = (sql) => queryInterface.sequelize.query(sql, { transaction })
    await q("SET LOCAL lock_timeout = '5s'")
    if (await tableExists(queryInterface, transaction)) {
      const [[{ rounds }]] = await q(`SELECT COUNT(*)::int AS rounds FROM "${TABLE}"`)
      if (rounds > 0) {
        throw new Error(
          `${TABLE}: ${rounds} round(s) recorded — rolling back would lose which items were added later; nothing was changed`
        )
      }
    }
    await q(`ALTER TABLE "order_item" DROP COLUMN IF EXISTS "${ITEM_COLUMN}"`)
    await q(`DROP TABLE IF EXISTS "${TABLE}"`)
  })
}

module.exports = {
  addOrderRounds,
  dropOrderRounds,
  async up(queryInterface) {
    await addOrderRounds(queryInterface)
  },
  async down(queryInterface) {
    await dropOrderRounds(queryInterface)
  }
}
