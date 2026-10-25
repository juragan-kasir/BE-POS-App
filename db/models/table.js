'use strict'
module.exports = (sequelize, DataTypes) => {
  const table = sequelize.define(
    'table',
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
      name: {
        allowNull: false,
        type: DataTypes.STRING
      },
      capacity: {
        type: DataTypes.INTEGER,
        defaultValue: 4
      },
      area: {
        type: DataTypes.STRING(50),
        defaultValue: 'indoor'
      },
      tableType: {
        type: DataTypes.STRING(20),
        defaultValue: 'regular'
      },
      status: {
        type: DataTypes.ENUM(
          'available',
          'occupied',
          'reserved',
          'maintenance'
        ),
        defaultValue: 'available'
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
      modelName: 'table',
      tableName: 'table'
    }
  )

  table.associate = (models) => {
    table.hasMany(models.order, { foreignKey: 'tableId', as: 'orders' })
    table.belongsTo(models.location, { foreignKey: 'store', as: 'storeData' })
  }

  return table
}
