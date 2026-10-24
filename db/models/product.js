'use strict'
module.exports = (sequelize, DataTypes) => {
  const product = sequelize.define(
    'product',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      nameProduct: {
        allowNull: false,
        type: DataTypes.STRING
      },
      sku: {
        type: DataTypes.STRING,
        unique: true
      },
      image: {
        type: DataTypes.STRING(2048)
      },
      images: {
        type: DataTypes.JSONB,
        defaultValue: []
      },
      barcode: {
        type: DataTypes.STRING
      },
      brand: {
        type: DataTypes.STRING
      },

      category: {
        allowNull: false,
        type: DataTypes.INTEGER
      },
      description: {
        type: DataTypes.TEXT
      },
      price: {
        allowNull: false,
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      costPrice: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      isOption: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
      },
      options: {
        type: DataTypes.JSONB,
        defaultValue: []
      },
      hasModifiers: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
      },
      modifiers: {
        type: DataTypes.JSONB,
        defaultValue: []
      },
      stock: {
        type: DataTypes.DECIMAL(10, 4),
        defaultValue: 0
      },
      minStock: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      unit: {
        type: DataTypes.STRING,
        defaultValue: 'pcs'
      },
      baseUnit: {
        type: DataTypes.STRING(20),
        defaultValue: 'pcs'
      },
      conversionFactor: {
        type: DataTypes.FLOAT,
        defaultValue: 1
      },
      status: {
        type: DataTypes.STRING(20),
        defaultValue: 'active'
      },
      isAvailable: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
      },
      point: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      redeemPoints: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      tax: {
        type: DataTypes.JSONB,
        defaultValue: null
      },
      priceTiers: {
        type: DataTypes.JSONB,
        defaultValue: []
      },
      currencyId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'currency', key: 'id' }
      },
      currencyCode: {
        type: DataTypes.STRING(10),
        allowNull: true
      },
      createdBy: {
        type: DataTypes.INTEGER
      },
      modifiedBy: {
        type: DataTypes.INTEGER
      },
      tipeProduk: {
        type: DataTypes.STRING(20),
        defaultValue: 'menu'
      },
      hppPerPorsi: {
        type: DataTypes.DECIMAL(15, 2),
        defaultValue: 0
      },
      foodCostPersen: {
        type: DataTypes.DECIMAL(5, 2),
        defaultValue: 0
      },
      marginPersen: {
        type: DataTypes.DECIMAL(5, 2),
        defaultValue: 0
      },
      isAvailableHariIni: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
      },
      composition: {
        type: DataTypes.JSONB,
        defaultValue: []
      },
      estimationTime: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      // F7: explicit fulfillment-strategy flag, independent of whether a
      // BOM happens to exist for this product — 'stocked' (default) means
      // BOM is ignored entirely at checkout, regardless of whether one is
      // defined. Allowed values: 'stocked' | 'make_to_order' | 'hybrid',
      // enforced at the application boundary (validation schema/checkout
      // logic), not a DB-level enum or constraint.
      inventoryMode: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'stocked'
      }
    },
    {
      paranoid: true,
      freezeTableName: true,
      modelName: 'product',
      tableName: 'product'
    }
  )

  product.associate = (models) => {
    product.belongsTo(models.category, {
      foreignKey: 'category',
      as: 'categoryData'
    })
    product.hasMany(models.stock_history, {
      foreignKey: 'product',
      as: 'stockHistories'
    })
    product.hasMany(models.stock_transfer_item, {
      foreignKey: 'product',
      as: 'stockTransferItems'
    })
    product.hasMany(models.purchase_return_item, {
      foreignKey: 'product',
      as: 'purchaseReturnItems'
    })
    product.hasMany(models.sales_return_item, {
      foreignKey: 'product',
      as: 'salesReturnItems'
    })
    product.hasMany(models.product_batch, {
      foreignKey: 'product',
      as: 'batches'
    })
    product.hasMany(models.product_store_price, {
      foreignKey: 'product',
      as: 'storePrices'
    })
    product.hasMany(models.bom_header, {
      foreignKey: 'productId',
      as: 'bomHeaders'
    })
    product.hasMany(models.product_store_stock, {
      foreignKey: 'product',
      as: 'storeStocks'
    })
    product.hasMany(models.product_bundle_item, {
      foreignKey: 'product',
      as: 'bundleItems'
    })
    product.hasMany(models.product_store, {
      foreignKey: 'product',
      as: 'storeAssignments'
    })
    product.hasMany(models.supplier_product, {
      foreignKey: 'productId',
      as: 'supplierProducts'
    })
  }

  return product
}
