'use strict'
module.exports = (sequelize, DataTypes) => {
  return sequelize.define(
    'invoice_setting',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      store: {
        type: DataTypes.INTEGER,
        allowNull: false,
        unique: true
      },
      showStoreName: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
      },
      showAddress: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
      },
      showMemberInfo: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
      },
      showLogo: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
      },
      showSocialMedia: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
      },
      socialMediaVisibility: {
        type: DataTypes.TEXT,
        allowNull: true
      },
      addressFieldsVisibility: {
        type: DataTypes.TEXT,
        allowNull: true
      },
      memberFieldsVisibility: {
        type: DataTypes.TEXT,
        allowNull: true
      },
      logo: {
        type: DataTypes.STRING(2048),
        allowNull: true
      },
      footer: {
        type: DataTypes.STRING,
        allowNull: true
      },
      paperSize: {
        type: DataTypes.STRING(20),
        allowNull: true,
        defaultValue: '58mm'
      },
      fontSize: {
        type: DataTypes.STRING(20),
        allowNull: true,
        defaultValue: 'normal'
      },
      fontFamily: {
        type: DataTypes.STRING(30),
        allowNull: true,
        defaultValue: 'monospace'
      },
      lineSpacing: {
        type: DataTypes.STRING(20),
        allowNull: true,
        defaultValue: 'normal'
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
      modelName: 'invoice_setting',
      tableName: 'invoice_setting'
    }
  )
}
