'use strict'
module.exports = (sequelize, DataTypes) => {
  const sales_return = sequelize.define(
    'sales_return',
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
      store: {
        allowNull: false,
        type: DataTypes.INTEGER
      },
      returnNumber: {
        allowNull: false,
        type: DataTypes.STRING,
        unique: true
      },
      status: {
        type: DataTypes.ENUM('pending', 'approved', 'rejected'),
        allowNull: false,
        defaultValue: 'pending'
      },
      reason: {
        type: DataTypes.TEXT
      },
      returnedBy: {
        type: DataTypes.INTEGER
      },
      refundAmount: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      refundMethod: {
        type: DataTypes.STRING,
        defaultValue: 'cash'
      },
      createdBy: {
        type: DataTypes.INTEGER
      },
      // Populated only inside approve(), atomically with the status
      // transition — never accepted from create input, never editable
      // afterward (no edit endpoint exists).
      approvedBy: {
        type: DataTypes.INTEGER,
        allowNull: true
      },
      approvedAt: {
        type: DataTypes.DATE,
        allowNull: true
      },
      // Optional external reference (bank/gateway/receipt number) an
      // approver may record when executing the refund. Applies to any
      // refundMethod, not just non-cash. Immutable once set.
      refundReference: {
        type: DataTypes.STRING,
        allowNull: true
      },
      // Create-time idempotency — scoped (order, idempotencyKey) via a
      // partial unique index, not (store, idempotencyKey): a return is
      // always about exactly one order, which already belongs to exactly
      // one store.
      idempotencyKey: {
        type: DataTypes.STRING,
        allowNull: true
      },
      // Batch B10: false = refund only — approval restores no product or
      // ingredient stock and reverses no COGS (damaged/expired goods, a
      // cooked dish). Set at create, never edited.
      restock: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true
      }
    },
    {
      paranoid: true,
      freezeTableName: true,
      modelName: 'sales_return',
      tableName: 'sales_return'
    }
  )

  sales_return.associate = (models) => {
    sales_return.hasMany(models.sales_return_item, {
      foreignKey: 'salesReturn',
      as: 'items'
    })
    sales_return.belongsTo(models.location, {
      foreignKey: 'store',
      as: 'storeData'
    })
    sales_return.belongsTo(models.user, {
      foreignKey: 'returnedBy',
      as: 'returnedByData'
    })
    sales_return.belongsTo(models.order, {
      foreignKey: 'order',
      as: 'orderData'
    })
    sales_return.hasMany(models.transaction, {
      foreignKey: 'salesReturnId',
      as: 'refundTransactions'
    })
    sales_return.belongsTo(models.user, {
      foreignKey: 'createdBy',
      as: 'createdByUser'
    })
    sales_return.belongsTo(models.user, {
      foreignKey: 'approvedBy',
      as: 'approvedByData'
    })
  }

  return sales_return
}
