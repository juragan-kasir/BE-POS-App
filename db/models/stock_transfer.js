'use strict'
module.exports = (sequelize, DataTypes) => {
  const stock_transfer = sequelize.define(
    'stock_transfer',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      transferNumber: {
        allowNull: false,
        type: DataTypes.STRING,
        unique: true
      },
      fromStore: {
        allowNull: false,
        type: DataTypes.INTEGER
      },
      toStore: {
        allowNull: false,
        type: DataTypes.INTEGER
      },
      status: {
        type: DataTypes.ENUM(
          'sent',
          'received',
          'cancelled',
          'pending',
          'approved',
          'rejected'
        ),
        defaultValue: 'sent'
      },
      reason: {
        type: DataTypes.STRING(255),
        allowNull: true
      },
      expectedArrival: {
        type: DataTypes.DATEONLY,
        allowNull: true
      },
      notes: {
        type: DataTypes.TEXT
      },
      transferredBy: {
        type: DataTypes.STRING
      },
      idempotencyKey: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'Phase 39 Batch 1: client-supplied idempotency key for transfer-send (partial unique index on fromStore+key)'
      },
      createdBy: {
        type: DataTypes.INTEGER
      }
    },
    {
      paranoid: true,
      freezeTableName: true,
      modelName: 'stock_transfer',
      tableName: 'stock_transfer'
    }
  )

  stock_transfer.associate = (models) => {
    stock_transfer.hasMany(models.stock_transfer_item, {
      foreignKey: 'stockTransfer',
      as: 'items'
    })
    stock_transfer.belongsTo(models.location, {
      foreignKey: 'fromStore',
      as: 'fromStoreData'
    })
    stock_transfer.belongsTo(models.location, {
      foreignKey: 'toStore',
      as: 'toStoreData'
    })
    stock_transfer.belongsTo(models.user, {
      foreignKey: 'createdBy',
      as: 'transferredByData'
    })
  }

  return stock_transfer
}
