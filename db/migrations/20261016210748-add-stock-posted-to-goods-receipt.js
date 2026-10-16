'use strict'

// P1-5: posting-on-complete for goods receipts.
//
// `goods_receipt.stockPosted`: whether this receipt's stock effect (product /
// ingredient stock, per-store shadows, batches, PO receivedQuantity) has
// been applied. Drafts created after this change start unposted (false) and
// post exactly once on the draft -> completed transition; receipts created
// already-completed post at create (true).
//
// Deploy boundary: pre-existing rows (drafts included — they posted at
// create under the old behavior) default to TRUE, so completing or
// cancelling an old draft keeps the old accounting (no double-post, and
// cancellations still reverse). Only newly created drafts start FALSE.
//
// Safety: guarded add-if-missing / remove-if-exists only; pre-existing
// columns and values are never touched.

async function tableExists(queryInterface, table) {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT to_regclass('public.${table}') IS NOT NULL AS exists`
  )
  return rows[0].exists
}

async function existingColumns(queryInterface, table) {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = '${table}' AND table_schema = 'public'`
  )
  return rows.map((r) => r.column_name)
}

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await tableExists(queryInterface, 'goods_receipt'))) return
    const existing = await existingColumns(queryInterface, 'goods_receipt')
    if (!existing.includes('stockPosted')) {
      await queryInterface.addColumn('goods_receipt', 'stockPosted', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
      })
    }
  },

  async down(queryInterface) {
    if (!(await tableExists(queryInterface, 'goods_receipt'))) return
    const existing = await existingColumns(queryInterface, 'goods_receipt')
    if (existing.includes('stockPosted')) {
      await queryInterface.removeColumn('goods_receipt', 'stockPosted')
    }
  }
}
