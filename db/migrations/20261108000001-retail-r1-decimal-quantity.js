'use strict'

// Retail R1 (owner decision 2026-11-08): sell by weight or volume. A product
// flagged allowDecimalQty may be sold in fractions (three decimals, gram /
// milliliter precision), so every quantity column on the sale, return and
// sales-report path becomes NUMERIC. Existing whole numbers convert exactly.
const COLUMNS = [
  ['order_item', 'quantity', 'NUMERIC(12,3)'],
  ['order', 'totalQuantity', 'NUMERIC(14,3)'],
  ['sales_return_item', 'qty', 'NUMERIC(12,3)'],
  ['product_sales_summary', 'quantity_sold', 'NUMERIC(14,3)'],
  ['category_sales_summary', 'quantity_sold', 'NUMERIC(14,3)'],
  ['best_selling', 'totalSelling', 'NUMERIC(14,3)']
]

const ORIGINAL = {
  'order_item.quantity': 'INTEGER',
  'order.totalQuantity': 'INTEGER',
  'sales_return_item.qty': 'INTEGER',
  'product_sales_summary.quantity_sold': 'INTEGER',
  'category_sales_summary.quantity_sold': 'INTEGER',
  'best_selling.totalSelling': 'BIGINT'
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      'ALTER TABLE "product" ADD COLUMN IF NOT EXISTS "allowDecimalQty" BOOLEAN NOT NULL DEFAULT false'
    )
    for (const [table, column, type] of COLUMNS) {
      await queryInterface.sequelize.query(
        `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE ${type} USING "${column}"::${type}`
      )
    }
  },

  async down(queryInterface) {
    // Refuses to narrow back to whole numbers while any fractional value
    // exists: that would silently change recorded sales.
    for (const [table, column] of COLUMNS) {
      const [[row]] = await queryInterface.sequelize.query(
        `SELECT count(*)::int AS n FROM "${table}" WHERE "${column}" <> trunc("${column}")`
      )
      if (row.n > 0) {
        throw new Error(
          `down refused: ${table}.${column} holds ${row.n} fractional value(s)`
        )
      }
    }
    for (const [table, column] of COLUMNS) {
      const type = ORIGINAL[`${table}.${column}`]
      await queryInterface.sequelize.query(
        `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE ${type} USING "${column}"::${type}`
      )
    }
    await queryInterface.sequelize.query(
      'ALTER TABLE "product" DROP COLUMN IF EXISTS "allowDecimalQty"'
    )
  }
}
