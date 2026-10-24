'use strict'
module.exports = (sequelize, DataTypes) => {
  const supplierProduct = sequelize.define(
    'supplier_product',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      supplier: {
        allowNull: false,
        type: DataTypes.INTEGER
      },
      productId: {
        type: DataTypes.INTEGER,
        allowNull: true
      },
      name: {
        allowNull: false,
        type: DataTypes.TEXT
      },
      price: {
        type: DataTypes.BIGINT,
        defaultValue: 0
      },
      unit: {
        type: DataTypes.STRING(20),
        defaultValue: 'pcs'
      },
      leadTime: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      leadTimeUnit: {
        type: DataTypes.STRING(10),
        defaultValue: 'hari'
      },
      qualityRating: {
        type: DataTypes.DECIMAL(5, 2),
        defaultValue: 0
      },
      // BA DR-28 decision 4: a whole number (migration 20261025000001)
      minOrderQty: {
        type: DataTypes.INTEGER,
        defaultValue: 1
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true
      },
      lastPrice: {
        type: DataTypes.BIGINT,
        defaultValue: 0
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
      modelName: 'supplier_product',
      tableName: 'supplier_product'
    }
  )

  supplierProduct.associate = (models) => {
    supplierProduct.belongsTo(models.supplier, {
      foreignKey: 'supplier',
      as: 'supplierData'
    })
    supplierProduct.belongsTo(models.product, {
      foreignKey: 'productId',
      as: 'productData'
    })
  }

  return supplierProduct
}
