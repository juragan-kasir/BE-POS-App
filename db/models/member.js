'use strict'
module.exports = (sequelize, DataTypes) => {
  return sequelize.define(
    'member',
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
      phoneNumber: {
        allowNull: false,
        type: DataTypes.STRING
      },
      email: {
        type: DataTypes.STRING
      },
      address: {
        type: DataTypes.STRING
      },
      tier: {
        type: DataTypes.INTEGER
      },
      totalPoints: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      lifetimePoints: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      dateOfBirth: {
        type: DataTypes.DATEONLY
      },
      gender: {
        type: DataTypes.STRING
      },
      notes: {
        type: DataTypes.TEXT
      },
      status: {
        type: DataTypes.STRING(20),
        defaultValue: 'active'
      },
      // Laundry credit customer marker. POS members default to non-credit.
      isCredit: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      creditLimit: {
        type: DataTypes.BIGINT,
        allowNull: true
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
      modelName: 'member',
      tableName: 'member'
    }
  )
}
