'use strict'
// E2E audit #8 open bill (migration 20261101000002, batch B9): one row per
// round of items added to an unpaid order. (order, idempotencyKey) is unique,
// so a retried add returns the round already recorded instead of adding the
// items again.
module.exports = (sequelize, DataTypes) => {
  const orderRound = sequelize.define(
    'order_round',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      order: {
        allowNull: false,
        type: DataTypes.INTEGER
      },
      idempotencyKey: {
        allowNull: false,
        type: DataTypes.STRING(255)
      },
      source: {
        allowNull: false,
        type: DataTypes.STRING(20)
      },
      itemCount: {
        allowNull: false,
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      createdBy: {
        allowNull: true,
        type: DataTypes.INTEGER
      }
    },
    {
      freezeTableName: true,
      modelName: 'order_round',
      tableName: 'order_round'
    }
  )
  orderRound.associate = (models) => {
    orderRound.belongsTo(models.order, { foreignKey: 'order', as: 'orderData' })
    orderRound.hasMany(models.order_item, { foreignKey: 'roundId', as: 'items' })
  }
  return orderRound
}
