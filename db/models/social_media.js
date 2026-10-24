'use strict'
module.exports = (sequelize, DataTypes) => {
  return sequelize.define(
    'social_media',
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
      name: {
        allowNull: false,
        type: DataTypes.STRING
      },
      icon: {
        type: DataTypes.STRING
      },
      link: {
        type: DataTypes.STRING(2048)
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
      modelName: 'social_media',
      tableName: 'social_media'
    }
  )
}
