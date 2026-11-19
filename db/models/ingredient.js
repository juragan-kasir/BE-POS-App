'use strict'
const { attachStoreTenant } = require('../../utils/storeTenant')
module.exports = (sequelize, DataTypes) => {
  const Ingredient = sequelize.define(
    'ingredient',
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
      // Owning tenant = the tenant of `store` (utils/storeTenant, re-derived
      // on every write that sets the outlet). Migration 20261119000005.
      tenantId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'tenant', key: 'id' }
      },
      name: {
        allowNull: false,
        type: DataTypes.STRING
      },
      category: {
        type: DataTypes.INTEGER
      },
      supplier: {
        type: DataTypes.INTEGER
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
      costPrice: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      status: {
        type: DataTypes.STRING(20),
        defaultValue: 'active'
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
      modelName: 'ingredient',
      tableName: 'ingredient'
    }
  )

  Ingredient.associate = (models) => {
    Ingredient.belongsTo(models.supplier, {
      as: 'supplierData',
      foreignKey: 'supplier'
    })
    Ingredient.belongsTo(models.ingredientCategory, {
      as: 'categoryData',
      foreignKey: 'category'
    })
    Ingredient.belongsTo(models.location, {
      as: 'storeData',
      foreignKey: 'store'
    })
    Ingredient.hasMany(models.bom_line, {
      foreignKey: 'ingredientId',
      as: 'bomLines'
    })
  }

  return attachStoreTenant(Ingredient)
}
