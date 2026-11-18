'use strict'
const { attachStoreTenant } = require('../../utils/storeTenant')
module.exports = (sequelize, DataTypes) => {
  const Position = sequelize.define(
    'position',
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
      departmentId: {
        type: DataTypes.INTEGER
      },
      description: {
        type: DataTypes.STRING
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
      modelName: 'position',
      tableName: 'position'
    }
  )

  Position.associate = (models) => {
    Position.belongsTo(models.department, {
      foreignKey: 'departmentId',
      as: 'departmentData'
    })
  }

  return attachStoreTenant(Position)
}
