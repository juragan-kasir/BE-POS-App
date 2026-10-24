'use strict'

// BA DR-28 (field-length standard, 2026-10-24) step 4: widen the columns
// that are narrower than the standard, so the FE/BE limits can be raised to
// it in a later release:
//   tenant.name            VARCHAR(100) -> 150  (business name; decision 2)
//   table.area             VARCHAR(20)  -> 50   (short label)
//   stock_transfer.reason  VARCHAR(100) -> 255  (short note)
//   URL / image / path     VARCHAR(255) -> 2048
//
// Safety: widening a VARCHAR is a catalog-only change in Postgres (no table
// rewrite, no value touched). A column is only ever widened: one that is
// already as wide or wider, TEXT, missing, or in a missing table is left
// alone, so the migration replays safely. down() is a no-op — narrowing
// could refuse or truncate data written after the widening.

const TARGETS = Object.freeze([
  ['tenant', 'name', 150],
  ['table', 'area', 50],
  ['stock_transfer', 'reason', 255],
  ['best_selling', 'image', 2048],
  ['category', 'image', 2048],
  ['invoice_logo', 'image', 2048],
  ['invoice_setting', 'logo', 2048],
  ['location', 'image', 2048],
  ['product', 'image', 2048],
  ['product_bundle', 'image', 2048],
  ['social_media', 'link', 2048],
  ['supplier', 'website', 2048],
  ['user', 'image', 2048],
  ['db_backup', 'filepath', 2048],
  ['expense', 'receipt', 2048]
])

// current: Map "table.column" -> { dataType, length } for existing columns.
// Returns the [table, column, length] to widen.
const planWidening = (current) =>
  TARGETS.filter(([table, column, length]) => {
    const col = current.get(`${table}.${column}`)
    return col && col.dataType === 'character varying' && Number(col.length) < length
  })

async function currentColumns(queryInterface, transaction) {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT table_name, column_name, data_type, character_maximum_length
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (table_name, column_name) IN (${TARGETS.map(() => '(?, ?)').join(', ')})`,
    { replacements: TARGETS.flatMap(([t, c]) => [t, c]), transaction }
  )
  return new Map(
    rows.map((r) => [
      `${r.table_name}.${r.column_name}`,
      { dataType: r.data_type, length: r.character_maximum_length }
    ])
  )
}

module.exports = {
  TARGETS,
  planWidening,
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      // Never queue behind a long-running lock on a busy table.
      await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction })
      const plan = planWidening(await currentColumns(queryInterface, transaction))
      for (const [table, column, length] of plan) {
        await queryInterface.sequelize.query(
          `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE VARCHAR(${length})`,
          { transaction }
        )
      }
    })
  },
  async down() {
    // Intentionally a no-op: see the header.
  }
}
