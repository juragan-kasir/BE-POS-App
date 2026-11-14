'use strict'

module.exports = (sequelize, DataTypes) => {
  const LaundryOrder = sequelize.define(
    'laundry_order',
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
          'RECEIVED',
          'WASHING',
          'IRONING',
          'READY',
          'PICKED_UP',
          'CANCELLED'
        ),
        defaultValue: 'RECEIVED'
      },
      turnaroundId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'laundry_turnaround', key: 'id' }
      },
      receivedAt: {
        allowNull: false,
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
      },
      dueAt: {
        type: DataTypes.DATE
      },
      pieceCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      conditionTags: {
        type: DataTypes.JSONB,
        defaultValue: []
      },
      conditionNote: {
        type: DataTypes.TEXT
      },
      rackCode: {
        type: DataTypes.STRING(50)
      },
      readyAt: {
        type: DataTypes.DATE
      },
      readyNotifiedAt: {
        type: DataTypes.DATE
      },
      pickedUpAt: {
        type: DataTypes.DATE
      },
      pickedUpBy: {
        type: DataTypes.INTEGER
      },
      pickupPieceCount: {
        type: DataTypes.INTEGER
      },
      pickupNote: {
        type: DataTypes.TEXT
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
      modelName: 'laundry_order',
      tableName: 'laundry_order'
    }
  )

  LaundryOrder.associate = (models) => {
    LaundryOrder.belongsTo(models.order, {
      foreignKey: 'orderId',
      as: 'orderData'
    })
    LaundryOrder.belongsTo(models.location, {
      foreignKey: 'store',
      as: 'storeData'
    })
    LaundryOrder.belongsTo(models.laundry_turnaround, {
      foreignKey: 'turnaroundId',
      as: 'turnaround'
    })
    LaundryOrder.hasMany(models.laundry_status_history, {
      foreignKey: 'laundryOrderId',
      as: 'history'
    })
  }

  return LaundryOrder
}
