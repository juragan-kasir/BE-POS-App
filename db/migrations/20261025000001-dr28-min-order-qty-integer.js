'use strict'

// BA DR-28 decision 4 (2026-10-24): supplier_product.minOrderQty is a whole
// number. VARCHAR(50) (default '1') becomes INTEGER (default 1); an empty
// value becomes 1.
//
// Fail closed: before any DDL, every non-empty value must be digits only. If
// one is not ("1.5", "10 kg"), the migration stops and names the count — no
// value is rewritten or guessed. Already INTEGER, or no table/column: no-op,
// so it replays safely. down() turns the column back into VARCHAR(50)
// holding the same digits (no information is lost either way).

const TABLE = 'supplier_product'
const COLUMN = 'minOrderQty'

async function columnType(queryInterface, table, transaction) {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ? AND column_name = ?`,
    { replacements: [table, COLUMN], transaction }
  )
  return rows[0]?.data_type || null
}

async function convertMinOrderQty(queryInterface, table = TABLE) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction })
    if ((await columnType(queryInterface, table, transaction)) !== 'character varying') return

    const [[{ invalid }]] = await queryInterface.sequelize.query(
      `SELECT COUNT(*)::int AS invalid FROM "${table}"
        WHERE "${COLUMN}" IS NOT NULL AND btrim("${COLUMN}") <> '' AND btrim("${COLUMN}") !~ '^[0-9]+$'`,
      { transaction }
    )
    if (invalid > 0) {
      throw new Error(
        `DR-28 ${table}.${COLUMN}: ${invalid} value(s) are not whole numbers — fix them first; nothing was changed`
      )
    }

    const q = (sql) => queryInterface.sequelize.query(sql, { transaction })
    await q(`ALTER TABLE "${table}" ALTER COLUMN "${COLUMN}" DROP DEFAULT`)
    await q(
      `ALTER TABLE "${table}" ALTER COLUMN "${COLUMN}" TYPE INTEGER
        USING COALESCE(NULLIF(btrim("${COLUMN}"), ''), '1')::integer`
    )
    await q(`ALTER TABLE "${table}" ALTER COLUMN "${COLUMN}" SET DEFAULT 1`)
  })
}

async function revertMinOrderQty(queryInterface, table = TABLE) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    if ((await columnType(queryInterface, table, transaction)) !== 'integer') return
    const q = (sql) => queryInterface.sequelize.query(sql, { transaction })
    await q(`ALTER TABLE "${table}" ALTER COLUMN "${COLUMN}" DROP DEFAULT`)
    await q(`ALTER TABLE "${table}" ALTER COLUMN "${COLUMN}" TYPE VARCHAR(50) USING "${COLUMN}"::text`)
    await q(`ALTER TABLE "${table}" ALTER COLUMN "${COLUMN}" SET DEFAULT '1'`)
  })
}

module.exports = {
  convertMinOrderQty,
  revertMinOrderQty,
  async up(queryInterface) {
    await convertMinOrderQty(queryInterface)
  },
  async down(queryInterface) {
    await revertMinOrderQty(queryInterface)
  }
}
