'use strict'
const { attachStoreTenant } = require('../../utils/storeTenant')
module.exports = (sequelize, DataTypes) => {
  const taxConfig = sequelize.define(
    'taxConfig',
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
      rate: {
        allowNull: false,
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      type: {
        type: DataTypes.ENUM('ppn', 'service_charge', 'other'),
        defaultValue: 'ppn'
      },
      status: {
        type: DataTypes.STRING(20),
        defaultValue: 'active'
      },
      description: {
        type: DataTypes.TEXT
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
      modelName: 'taxConfig',
      tableName: 'tax_config'
    }
  )

  return attachStoreTenant(taxConfig)
}
