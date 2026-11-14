'use strict'

module.exports = (sequelize, DataTypes) => {
  const LaundryStatusHistory = sequelize.define(
    'laundry_status_history',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      laundryOrderId: {
        allowNull: false,
        type: DataTypes.INTEGER
      },
      fromStatus: {
        type: DataTypes.STRING(20)
      },
      toStatus: {
        allowNull: false,
        type: DataTypes.STRING(20)
      },
      actorId: {
        type: DataTypes.INTEGER
      },
      reason: {
        type: DataTypes.TEXT
      }
    },
    {
      freezeTableName: true,
      modelName: 'laundry_status_history',
      tableName: 'laundry_status_history'
    }
  )

  LaundryStatusHistory.associate = (models) => {
    LaundryStatusHistory.belongsTo(models.laundry_order, {
      foreignKey: 'laundryOrderId',
      as: 'laundryOrder'
    })
  }

  return LaundryStatusHistory
}
