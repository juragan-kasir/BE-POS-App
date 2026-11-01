'use strict'

// E2E audit #6 (product owner, 2026-11-01): a payment records which of the
// store's payment types was used ("GoPay", "QRIS", "Debit BCA"), not only its
// canonical tender (E_WALLET, CARD). order.paymentMethodName and
// transaction.paymentMethodName hold the type's name as it was when paid
// (a snapshot, so renaming or deleting the type later never rewrites history).
//
// up only adds two nullable columns (add-if-missing): no value is rewritten
// and it replays safely. down stops before any DDL while a row still holds a
// name, so rolling back never silently drops recorded payment detail.

const COLUMN = 'paymentMethodName'
const TABLES = ['order', 'transaction']

async function hasColumn(queryInterface, table, transaction) {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ? AND column_name = ?`,
    { replacements: [table, COLUMN], transaction }
  )
  return rows.length > 0
}

async function addPaymentMethodName(queryInterface, tables = TABLES) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction })
    for (const table of tables) {
      if (await hasColumn(queryInterface, table, transaction)) continue
      await queryInterface.sequelize.query(
        `ALTER TABLE "${table}" ADD COLUMN "${COLUMN}" VARCHAR(255) NULL`,
        { transaction }
      )
    }
  })
}

async function dropPaymentMethodName(queryInterface, tables = TABLES) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction })
    for (const table of tables) {
      if (!(await hasColumn(queryInterface, table, transaction))) continue
      const [[{ named }]] = await queryInterface.sequelize.query(
        `SELECT COUNT(*)::int AS named FROM "${table}" WHERE "${COLUMN}" IS NOT NULL`,
        { transaction }
      )
      if (named > 0) {
        throw new Error(
          `${table}.${COLUMN}: ${named} row(s) hold a payment method name — rolling back would lose them; nothing was changed`
        )
      }
    }
    for (const table of tables) {
      await queryInterface.sequelize.query(
        `ALTER TABLE "${table}" DROP COLUMN IF EXISTS "${COLUMN}"`,
        { transaction }
      )
    }
  })
}

module.exports = {
  up: (queryInterface) => addPaymentMethodName(queryInterface),
  down: (queryInterface) => dropPaymentMethodName(queryInterface),
  addPaymentMethodName,
  dropPaymentMethodName
}
