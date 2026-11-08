'use strict'
module.exports = (sequelize, DataTypes) => {
  return sequelize.define(
    'order_item',
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
      product: {
        allowNull: false,
        type: DataTypes.INTEGER
      },
      productName: {
        type: DataTypes.STRING
      },
      quantity: {
        allowNull: false,
        type: DataTypes.DECIMAL(12, 3),
        // Retail R1: sold-by-weight quantities keep three decimals; read
        // back as a number (Postgres NUMERIC arrives as a string).
        get() {
          const v = this.getDataValue('quantity')
          return v === null || v === undefined ? v : Number(v)
        }
      },
      price: {
        allowNull: false,
        type: DataTypes.BIGINT
      },
      discountType: {
        type: DataTypes.ENUM('none', 'percent', 'nominal'),
        defaultValue: 'none'
      },
      discountValue: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      discountAmount: {
        type: DataTypes.BIGINT,
        defaultValue: 0
      },
      totalPrice: {
        type: DataTypes.BIGINT,
        defaultValue: 0
      },
      options: {
        type: DataTypes.JSONB,
        defaultValue: []
      },
      modifiers: {
        type: DataTypes.JSONB,
        defaultValue: []
      },
      notes: {
        type: DataTypes.TEXT
      },
      status: {
        type: DataTypes.ENUM('pending', 'preparing', 'ready', 'served'),
        defaultValue: 'pending'
      },
      createdBy: {
        type: DataTypes.INTEGER
      },
      waktuSiap: {
        type: DataTypes.DATE,
        allowNull: true
      },
      urutanSaji: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      hppSnapshot: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: true
      },
      stationDapur: {
        type: DataTypes.INTEGER,
        allowNull: true
      },
      bundleId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'product_bundle', key: 'id' }
      },
      bundleName: {
        type: DataTypes.STRING,
        allowNull: true
      },
      // Batch B9: the round that added this item to an open bill; NULL for
      // the order's first items.
      roundId: {
        type: DataTypes.INTEGER,
        allowNull: true
      }
    },
    {
      paranoid: true,
      freezeTableName: true,
      modelName: 'order_item',
      tableName: 'order_item'
    }
  )
}
