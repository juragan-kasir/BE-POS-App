'use strict'

// W3-6 (BE audit S-06, FIXING-PLAN K8): document_counter backs
// utils/documentNumber — one row per (outlet, document type, outlet-local
// business day) holding the last issued sequence. store 0 = documents
// written without an outlet. Additive: no existing table or number changes;
// old rows keep their old-format numbers, which can never collide with the
// new <PREFIX>-<storeId>-<YYMMDD>-<seq> format.
module.exports = {
  async up(queryInterface, Sequelize) {
    const exists = await queryInterface.sequelize.query(
      `SELECT to_regclass('public.document_counter') IS NOT NULL AS ok`,
      { type: queryInterface.sequelize.QueryTypes.SELECT }
    )
    if (exists[0].ok) return
    await queryInterface.createTable('document_counter', {
      store: { type: Sequelize.INTEGER, allowNull: false, primaryKey: true },
      docType: { type: Sequelize.STRING(30), allowNull: false, primaryKey: true },
      counterDate: { type: Sequelize.DATEONLY, allowNull: false, primaryKey: true },
      lastValue: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('NOW()') }
    })
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS document_counter')
  }
}
