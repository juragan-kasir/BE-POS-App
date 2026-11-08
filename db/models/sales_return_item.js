'use strict'
module.exports = (sequelize, DataTypes) => {
  const sales_return_item = sequelize.define(
    'sales_return_item',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      salesReturn: {
        allowNull: false,
        type: DataTypes.INTEGER
      },
      product: {
        allowNull: false,
        type: DataTypes.INTEGER
      },
      qty: {
        allowNull: false,
        type: DataTypes.DECIMAL(12, 3),
        // Retail R1: sold-by-weight quantities keep three decimals; read
        // back as a number (Postgres NUMERIC arrives as a string).
        get() {
          const v = this.getDataValue('qty')
          return v === null || v === undefined ? v : Number(v)
        }
      },
      unit: {
        type: DataTypes.STRING,
        defaultValue: 'pcs'
      },
      orderItem: {
        type: DataTypes.INTEGER
      },
      price: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      conversionToBase: {
        type: DataTypes.DECIMAL(10, 4),
        defaultValue: 1
      },
      notes: {
        type: DataTypes.TEXT
      }
    },
    {
      paranoid: true,
      freezeTableName: true,
      modelName: 'sales_return_item',
      tableName: 'sales_return_item'
    }
  )

  sales_return_item.associate = (models) => {
    sales_return_item.belongsTo(models.sales_return, {
      foreignKey: 'salesReturn',
      as: 'return'
    })
    sales_return_item.belongsTo(models.product, {
      foreignKey: 'product',
      as: 'productData'
    })
  }

  return sales_return_item
}
