'use strict'
const { attachStoreTenant } = require('../../utils/storeTenant')

module.exports = (sequelize, DataTypes) => {
  const model = sequelize.define(
    'member_tier',
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
      // on every write that sets the outlet). Migration 20261119000003.
      tenantId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'tenant', key: 'id' }
      },
      name: {
        allowNull: false,
        type: DataTypes.STRING
      },
      minPoints: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      maxPoints: {
        type: DataTypes.INTEGER,
        defaultValue: 999999
      },
      discountPercent: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      pointMultiplier: {
        type: DataTypes.DECIMAL(3, 2),
        defaultValue: 1.0
      },
      benefits: {
        type: DataTypes.JSONB,
        defaultValue: []
      },
      color: {
        type: DataTypes.STRING,
        defaultValue: '#000000'
      },
      status: {
        type: DataTypes.STRING(20),
        defaultValue: 'active'
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
      modelName: 'member_tier',
      tableName: 'member_tier'
    }
  )
  return attachStoreTenant(model)
}
