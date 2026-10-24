'use strict'
module.exports = (sequelize, DataTypes) => {
  const ProductBundle = sequelize.define(
    'product_bundle',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      store: {
        type: DataTypes.JSONB
      },
      name: {
        allowNull: false,
        type: DataTypes.STRING
      },
      sku: {
        type: DataTypes.STRING,
        unique: true
      },
      description: {
        type: DataTypes.TEXT
      },
      image: {
        type: DataTypes.STRING(2048)
      },
      bundlePrice: {
        allowNull: false,
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      originalPrice: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      discountAmount: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      discountPercentage: {
        type: DataTypes.DECIMAL(5, 2),
        defaultValue: 0
      },
      minQuantity: {
        type: DataTypes.INTEGER,
        defaultValue: 1
      },
      maxQuantity: {
        type: DataTypes.INTEGER
      },
      isAvailable: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
      },
      status: {
        type: DataTypes.STRING(20),
        defaultValue: 'active'
      },
      validFrom: {
        type: DataTypes.DATE
      },
      validUntil: {
        type: DataTypes.DATE
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
      modelName: 'product_bundle',
      tableName: 'product_bundle'
    }
  )

  ProductBundle.associate = function (models) {
    ProductBundle.hasMany(models.product_bundle_item, {
      foreignKey: 'bundleId',
      as: 'items'
    })
  }

  return ProductBundle
}
