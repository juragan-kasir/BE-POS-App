'use strict'
module.exports = (sequelize, DataTypes) => {
  const goodsReceipt = sequelize.define(
    'goodsReceipt',
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
      receiptNumber: {
        allowNull: false,
        type: DataTypes.STRING
      },
      purchaseOrderId: {
        allowNull: false,
        type: DataTypes.INTEGER
      },
      receivedDate: {
        type: DataTypes.DATE
      },
      status: {
        type: DataTypes.ENUM('draft', 'completed', 'cancelled'),
        defaultValue: 'draft'
      },
      // P1-5: whether this receipt's stock effect has been applied. Drafts
      // start unposted and post exactly once on completion; receipts created
      // already-completed post at create. Pre-existing rows default true
      // (they posted at create under the old behavior).
      stockPosted: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
      notes: {
        type: DataTypes.TEXT
      },
      pic: {
        type: DataTypes.INTEGER
      },
      documentation: {
        type: DataTypes.TEXT,
        comment: 'JSON array of photo URLs'
      },
      suratJalan: {
        type: DataTypes.STRING
      },
      taxInvoiceNo: {
        type: DataTypes.STRING
      },
      shippingCost: {
        type: DataTypes.DECIMAL(12, 2),
        defaultValue: 0
      },
      idempotencyKey: {
        type: DataTypes.STRING,
        allowNull: true
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
      modelName: 'goodsReceipt',
      tableName: 'goods_receipt'
    }
  )

  goodsReceipt.associate = (models) => {
    goodsReceipt.hasMany(models.goodsReceiptItem, {
      foreignKey: 'goodsReceipt',
      as: 'items'
    })
    goodsReceipt.belongsTo(models.purchase_order, {
      foreignKey: 'purchaseOrderId',
      as: 'purchaseOrderData'
    })
  goodsReceipt.belongsTo(models.location, {
    foreignKey: 'store',
    as: 'storeData'
  })
  goodsReceipt.belongsTo(models.user, {
    foreignKey: 'pic',
    as: 'picData'
  })
}

  return goodsReceipt
}
