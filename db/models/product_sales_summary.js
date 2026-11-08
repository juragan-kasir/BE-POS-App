'use strict'
module.exports = (sequelize, DataTypes) => {
  const product_sales_summary = sequelize.define(
    'product_sales_summary',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      store: {
        allowNull: false,
        type: DataTypes.INTEGER
      },
      product: {
        allowNull: false,
        type: DataTypes.INTEGER
      },
      report_date: {
        allowNull: false,
        type: DataTypes.DATEONLY
      },
      quantity_sold: {
        defaultValue: 0,
        type: DataTypes.DECIMAL(14, 3),
        // Retail R1: sold-by-weight quantities keep three decimals; read
        // back as a number (Postgres NUMERIC arrives as a string).
        get() {
          const v = this.getDataValue('quantity_sold')
          return v === null || v === undefined ? v : Number(v)
        }
      },
      revenue: {
        type: DataTypes.DECIMAL(15, 2),
        defaultValue: 0
      },
      cost: {
        type: DataTypes.DECIMAL(15, 2),
        defaultValue: 0
      },
      profit: {
        type: DataTypes.DECIMAL(15, 2),
        defaultValue: 0
      },
      transactions: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      }
    },
    {
      freezeTableName: true,
      modelName: 'product_sales_summary',
      tableName: 'product_sales_summary',
      indexes: [
        { fields: ['store', 'product', 'report_date'] },
        { fields: ['report_date'] }
      ]
    }
  )

  product_sales_summary.associate = (models) => {
    product_sales_summary.belongsTo(models.location, {
      foreignKey: 'store',
      as: 'storeData'
    })
    product_sales_summary.belongsTo(models.product, {
      foreignKey: 'product',
      as: 'productData'
    })
  }

  return product_sales_summary
}
