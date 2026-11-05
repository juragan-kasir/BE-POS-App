'use strict'

// Wave 4 by-id sweep (product owner, 2026-11-05: shared master data is per
// tenant). Departments and ingredient categories had no outlet column at
// all, so every tenant read, renamed and deleted the same rows.
//
// up adds a nullable "store" (FK location, ON DELETE SET NULL) plus an index
// to both tables, add-if-missing. Existing rows keep store = NULL: they are
// the shared defaults every outlet can read and only a global super admin
// can change; new rows are stamped with the creating outlet. Nothing is
// rewritten, so it replays safely.
//
// down stops before any DDL while a row carries an outlet, so rolling back
// never silently turns tenant-owned rows back into shared ones.

const TABLES = ['department', 'ingredient_category']
const COLUMN = 'store'
const indexName = (table) => `${table}_store_idx`

async function hasColumn(queryInterface, table, transaction) {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ? AND column_name = ?`,
    { replacements: [table, COLUMN], transaction }
  )
  return rows.length > 0
}

async function addStoreColumns(queryInterface) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction })
    for (const table of TABLES) {
      if (!(await hasColumn(queryInterface, table, transaction))) {
        await queryInterface.sequelize.query(
          `ALTER TABLE "${table}" ADD COLUMN "${COLUMN}" INTEGER
             REFERENCES "location"(id) ON UPDATE CASCADE ON DELETE SET NULL`,
          { transaction }
        )
      }
      await queryInterface.sequelize.query(
        `CREATE INDEX IF NOT EXISTS "${indexName(table)}" ON "${table}" ("${COLUMN}")`,
        { transaction }
      )
    }
  })
}

async function dropStoreColumns(queryInterface) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction })
    for (const table of TABLES) {
      if (!(await hasColumn(queryInterface, table, transaction))) continue
      const [[{ owned }]] = await queryInterface.sequelize.query(
        `SELECT COUNT(*)::int AS owned FROM "${table}" WHERE "${COLUMN}" IS NOT NULL`,
        { transaction }
      )
      if (owned > 0) {
        throw new Error(
          `${table}.${COLUMN}: ${owned} row(s) belong to an outlet — rolling back would make them shared again; nothing was changed`
        )
      }
    }
    for (const table of TABLES) {
      if (!(await hasColumn(queryInterface, table, transaction))) continue
      await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "${indexName(table)}"`, { transaction })
      await queryInterface.sequelize.query(`ALTER TABLE "${table}" DROP COLUMN "${COLUMN}"`, { transaction })
    }
  })
}

module.exports = {
  TABLES,
  addStoreColumns,
  dropStoreColumns,
  async up(queryInterface) {
    await addStoreColumns(queryInterface)
  },
  async down(queryInterface) {
    await dropStoreColumns(queryInterface)
  }
}
