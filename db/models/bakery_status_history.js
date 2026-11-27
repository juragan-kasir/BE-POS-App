'use strict'

module.exports = (sequelize, DataTypes) => {
  const BakeryStatusHistory = sequelize.define(
    'bakery_status_history',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      bakeryOrderId: {
        allowNull: false,
        type: DataTypes.INTEGER
      },
      fromStatus: {
        type: DataTypes.STRING(30)
      },
      toStatus: {
        allowNull: false,
        type: DataTypes.STRING(30)
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
      modelName: 'bakery_status_history',
      tableName: 'bakery_status_history'
    }
  )

  BakeryStatusHistory.associate = (models) => {
    BakeryStatusHistory.belongsTo(models.bakery_order, {
      foreignKey: 'bakeryOrderId',
      as: 'bakeryOrder'
    })
    if (models.user) {
      BakeryStatusHistory.belongsTo(models.user, {
        foreignKey: 'actorId',
        as: 'actorData'
      })
    }
  }

  return BakeryStatusHistory
}
