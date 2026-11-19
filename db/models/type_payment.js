'use strict'
const { attachStoreTenant } = require('../../utils/storeTenant')
module.exports = (sequelize, DataTypes) => {
  return attachStoreTenant(sequelize.define(
    'type_payment',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      store: {
        type: DataTypes.INTEGER
      },
      // Owning tenant = the tenant of `store` (utils/storeTenant, re-derived
      // on every write that sets the outlet). Migration 20261119000005.
      tenantId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'tenant', key: 'id' }
      },
      name: {
        allowNull: false,
        type: DataTypes.STRING
      },
      icon: {
        type: DataTypes.STRING
      },
      type: {
        type: DataTypes.ENUM('cash', 'debit', 'credit', 'e-wallet', 'other'),
        defaultValue: 'cash'
      },
      feeType: {
        type: DataTypes.STRING(20),
        defaultValue: 'fixed'
      },
      fee: {
        type: DataTypes.DECIMAL(10, 2),
        defaultValue: 0
      },
      tenor: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      sortOrder: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      status: {
        type: DataTypes.STRING(20),
        defaultValue: 'active'
      },
      isSystem: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
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
      modelName: 'type_payment',
      tableName: 'type_payment'
    }
  ))
}
