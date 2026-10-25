'use strict'
const { lastFourDigits } = require('../../utils/cardNumber')
module.exports = (sequelize, DataTypes) => {
  const transaction = sequelize.define(
    'transaction',
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
      typePayment: {
        allowNull: false,
        type: DataTypes.STRING
      },
      amount: {
        allowNull: false,
        type: DataTypes.BIGINT
      },
      cardNumber: {
        type: DataTypes.STRING,
        // BA DR-28: only the last 4 digits are ever stored
        set(value) {
          this.setDataValue('cardNumber', lastFourDigits(value))
        }
      },
      cardType: {
        type: DataTypes.STRING
      },
      referenceNumber: {
        type: DataTypes.STRING
      },
      notes: {
        type: DataTypes.TEXT
      },
      createdBy: {
        type: DataTypes.INTEGER
      },
      salesReturnId: {
        type: DataTypes.INTEGER
      },
      // Cash tender only. Net cash retained in the drawer for this row is
      // (cashReceived - changeGiven) — NOT cashReceived alone. Null for
      // non-cash tenders. See cashRegister.cashSalesReceived for the
      // aggregate formula that consumes these two fields.
      cashReceived: {
        type: DataTypes.BIGINT,
        allowNull: true
      },
      changeGiven: {
        type: DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0
      },
      // PAYMENT P1 Register & Settlement Attribution (migration
      // 20261013000001): per-record receiving/refunding register (MC-4).
      // Nullable — legacy rows stay NULL, never backfilled. New applicable
      // rows must set it (application phase); order.cashRegisterId remains
      // legacy order-context data and is NOT authoritative per-record.
      cashRegisterId: {
        type: DataTypes.INTEGER,
        allowNull: true
      },
      // PAYMENT P1 (migration 20261013000001): split-plan linkage,
      // event -> plan. Nullable — legacy split-pay rows stay NULL, never
      // inferred from notes text. ON DELETE SET NULL (never CASCADE).
      splitBillId: {
        type: DataTypes.INTEGER,
        allowNull: true
      }
    },
    {
      paranoid: true,
      freezeTableName: true,
      modelName: 'transaction',
      tableName: 'transaction'
    }
  )

  transaction.associate = (models) => {
    transaction.belongsTo(models.order, {
      foreignKey: 'order',
      as: 'orderDetail'
    })
    transaction.belongsTo(models.sales_return, {
      foreignKey: 'salesReturnId',
      as: 'salesReturn'
    })
    transaction.belongsTo(models.cashRegister, {
      foreignKey: 'cashRegisterId',
      as: 'register'
    })
    transaction.belongsTo(models.split_bill, {
      foreignKey: 'splitBillId',
      as: 'splitBill'
    })
  }

  return transaction
}
