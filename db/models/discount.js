'use strict'
const { attachStoreTenant } = require('../../utils/storeTenant')

module.exports = (sequelize, DataTypes) => {
  const model = sequelize.define(
    'discount',
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
      type: {
        allowNull: false,
        type: DataTypes.ENUM('percent', 'nominal'),
        defaultValue: 'percent'
      },
      value: {
        allowNull: false,
        type: DataTypes.INTEGER
      },
      minimumOrder: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      maximumDiscount: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      startDate: {
        type: DataTypes.DATE
      },
      endDate: {
        type: DataTypes.DATE
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
      },
      // Unique per tenant (uq_discount_tenant_code), or globally among
      // tenant-less rows (uq_discount_tenantless_code) — migration 20261119000003.
      code: {
        type: DataTypes.STRING(50),
        allowNull: true
      },
      conditions: {
        type: DataTypes.JSONB,
        defaultValue: null
      }
    },
    {
      paranoid: true,
      freezeTableName: true,
      modelName: 'discount',
      tableName: 'discount'
    }
  )
  return attachStoreTenant(model)
}
