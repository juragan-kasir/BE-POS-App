'use strict'

module.exports = (sequelize, DataTypes) => {
  const BakeryOrder = sequelize.define(
    'bakery_order',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      orderId: {
        allowNull: false,
        type: DataTypes.INTEGER,
        unique: true,
        references: { model: 'order', key: 'id' }
      },
      store: {
        allowNull: false,
        type: DataTypes.INTEGER
      },
      tenantId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'tenant', key: 'id' }
      },
      processStatus: {
        allowNull: false,
        type: DataTypes.ENUM(
          'PENDING_CONFIRMATION',
          'CONFIRMED',
          'IN_PRODUCTION',
          'READY',
          'PICKED_UP',
          'DELIVERED',
          'CANCELLED'
        ),
        defaultValue: 'PENDING_CONFIRMATION'
      },
      fulfillmentType: {
        allowNull: false,
        type: DataTypes.ENUM('pickup', 'delivery'),
        defaultValue: 'pickup'
      },
      scheduledAt: {
        allowNull: false,
        type: DataTypes.DATE
      },
      customerNote: {
        type: DataTypes.TEXT
      },
      adminNote: {
        type: DataTypes.TEXT
      },
      deliveryAddress: {
        type: DataTypes.TEXT
      },
      deliveryNote: {
        type: DataTypes.TEXT
      },
      readyAt: {
        type: DataTypes.DATE
      },
      pickedUpAt: {
        type: DataTypes.DATE
      },
      deliveredAt: {
        type: DataTypes.DATE
      },
      cancelledAt: {
        type: DataTypes.DATE
      },
      cancelledReason: {
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
      modelName: 'bakery_order',
      tableName: 'bakery_order'
    }
  )

  BakeryOrder.associate = (models) => {
    BakeryOrder.belongsTo(models.order, {
      foreignKey: 'orderId',
      as: 'orderData'
    })
    BakeryOrder.belongsTo(models.location, {
      foreignKey: 'store',
      as: 'storeData'
    })
    BakeryOrder.hasMany(models.bakery_status_history, {
      foreignKey: 'bakeryOrderId',
      as: 'history'
    })
  }

  return BakeryOrder
}
