'use strict'

module.exports = {
  up: async (queryInterface) => {
    // P3 (product-grade audit 2026-11-02): 'partial' used to carry two
    // different money states. Split them so reports and the FE no longer
    // have to infer the state from `status`. 'partial' stays in the enum
    // for historical rows; new writes use the precise values.
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_order_paymentStatus"
      ADD VALUE IF NOT EXISTS 'partially_paid'
    `)
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_order_paymentStatus"
      ADD VALUE IF NOT EXISTS 'partially_refunded'
    `)
  },

  down: async () => {
    // PostgreSQL cannot remove enum values without recreating the type and
    // every column that uses it. Historical 'partial' rows remain readable.
  }
}
