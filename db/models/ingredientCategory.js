'use strict'
module.exports = (sequelize, DataTypes) => {
  return sequelize.define(
    'ingredientCategory',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      name: {
        allowNull: false,
        type: DataTypes.STRING
      },
      // Owning outlet (batch B12). NULL = shared default, readable by every
      // outlet and changeable only by a global super admin.
      store: {
        type: DataTypes.INTEGER,
        allowNull: true
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
      modelName: 'ingredientCategory',
      tableName: 'ingredient_category'
    }
  )
}
