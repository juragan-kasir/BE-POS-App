'use strict'
const { attachStoreTenant } = require('../../utils/storeTenant')
module.exports = (sequelize, DataTypes) => {
  const journal_entry = sequelize.define(
    'journal_entry',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      store: {
        type: DataTypes.INTEGER,
        allowNull: false
      },
      // Owning tenant = the tenant of `store` (utils/storeTenant, re-derived
      // on every write that sets the outlet). Migration 20261119000005.
      tenantId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'tenant', key: 'id' }
      },
      entryNumber: {
        allowNull: false,
        type: DataTypes.STRING(50)
      },
      date: {
        allowNull: false,
        type: DataTypes.DATEONLY
      },
      description: {
        type: DataTypes.TEXT
      },
      sourceType: {
        type: DataTypes.STRING(30),
        defaultValue: 'manual'
      },
      referenceId: {
        type: DataTypes.INTEGER,
        allowNull: true
      },
      totalDebit: {
        type: DataTypes.DECIMAL(15, 2),
        defaultValue: 0
      },
      totalCredit: {
        type: DataTypes.DECIMAL(15, 2),
        defaultValue: 0
      },
      status: {
        type: DataTypes.STRING(20),
        defaultValue: 'posted'
      },
      createdBy: {
        type: DataTypes.INTEGER
      },
      modifiedBy: {
        type: DataTypes.INTEGER
      }
    },
    {
      paranoid: true,
      freezeTableName: true,
      modelName: 'journal_entry',
      tableName: 'journal_entry'
    }
  )

  journal_entry.associate = (db) => {
    journal_entry.hasMany(db.journal_entry_line, {
      foreignKey: 'journalEntry',
      as: 'lines'
    })
  }

  return attachStoreTenant(journal_entry)
}
