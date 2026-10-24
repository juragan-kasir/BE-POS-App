'use strict'
module.exports = (sequelize, DataTypes) => {
  const dbBackup = sequelize.define(
    'db_backup',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      filename: {
        allowNull: false,
        type: DataTypes.STRING
      },
      filepath: {
        allowNull: false,
        type: DataTypes.STRING(2048)
      },
      size: {
        type: DataTypes.BIGINT,
        defaultValue: 0
      },
      format: {
        type: DataTypes.STRING(20),
        defaultValue: 'custom'
      },
      status: {
        type: DataTypes.STRING(20),
        defaultValue: 'success'
      },
      trigger: {
        type: DataTypes.STRING(20),
        defaultValue: 'manual'
      },
      store: {
        type: DataTypes.INTEGER
      },
      metadata: {
        type: DataTypes.JSONB,
        defaultValue: {}
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
      modelName: 'db_backup',
      tableName: 'db_backup'
    }
  )
  return dbBackup
}
