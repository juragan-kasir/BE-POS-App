'use strict'

// E2E audit fix (product owner, 2026-11-01): a sales return states whether the
// goods go back into sellable stock. sales_return.restock = false means refund
// only — approval restores no product or ingredient stock and reverses no
// COGS (damaged, defective or expired goods, a cooked dish).
//
// up adds the column add-if-missing with DEFAULT TRUE: every existing return
// was restocked on approval, so true is what they already did; nothing is
// rewritten and it replays safely. down stops before any DDL while a return is
// recorded as not restocked, so rolling back never silently turns a write-off
// back into a restock.

const TABLE = 'sales_return'
const COLUMN = 'restock'

async function hasColumn(queryInterface, transaction) {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ? AND column_name = ?`,
    { replacements: [TABLE, COLUMN], transaction }
  )
  return rows.length > 0
}

async function addRestock(queryInterface) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction })
    if (await hasColumn(queryInterface, transaction)) return
    await queryInterface.sequelize.query(
      `ALTER TABLE "${TABLE}" ADD COLUMN "${COLUMN}" BOOLEAN NOT NULL DEFAULT TRUE`,
      { transaction }
    )
  })
}

async function dropRestock(queryInterface) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction })
    if (!(await hasColumn(queryInterface, transaction))) return
    const [[{ writeOffs }]] = await queryInterface.sequelize.query(
      `SELECT COUNT(*)::int AS "writeOffs" FROM "${TABLE}" WHERE "${COLUMN}" = FALSE`,
      { transaction }
    )
    if (writeOffs > 0) {
      throw new Error(
        `${TABLE}.${COLUMN}: ${writeOffs} return(s) are recorded as not restocked — rolling back would lose that; nothing was changed`
      )
    }
    await queryInterface.sequelize.query(`ALTER TABLE "${TABLE}" DROP COLUMN "${COLUMN}"`, {
      transaction
    })
  })
}

module.exports = {
  addRestock,
  dropRestock,
  async up(queryInterface) {
    await addRestock(queryInterface)
  },
  async down(queryInterface) {
    await dropRestock(queryInterface)
  }
}
