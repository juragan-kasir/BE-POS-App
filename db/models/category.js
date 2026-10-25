'use strict'
module.exports = (sequelize, DataTypes) => {
  const category = sequelize.define(
    'category',
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
      description: {
        type: DataTypes.STRING
      },
      value: {
        type: DataTypes.STRING
      },
      image: {
        type: DataTypes.STRING(2048)
      },
      parentId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        defaultValue: null
      },
      color: {
        type: DataTypes.STRING(20),
        allowNull: true,
        defaultValue: '#0f172a'
      },
      sortOrder: {
        type: DataTypes.INTEGER,
        allowNull: true,
        defaultValue: 0
      },

      status: {
        type: DataTypes.STRING(20),
        defaultValue: 'active'
      },
      createdBy: {
        type: DataTypes.STRING
      },
      modifiedBy: {
        type: DataTypes.STRING
      }
    },
    {
      paranoid: true,
      freezeTableName: true,
      modelName: 'category',
      tableName: 'category'
    }
  )

  category.associate = (models) => {
    category.hasMany(models.category_store, {
      foreignKey: 'category',
      as: 'storeAssignments'
    })
    category.belongsTo(models.category, {
      foreignKey: 'parentId',
      as: 'parentCategory'
    })
    category.hasMany(models.category, {
      foreignKey: 'parentId',
      as: 'childCategories'
    })
  }

  return category
}
