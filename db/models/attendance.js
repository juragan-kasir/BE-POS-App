'use strict'
module.exports = (sequelize, DataTypes) => {
  const attendance = sequelize.define(
    'attendance',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      userId: {
        allowNull: false,
        type: DataTypes.INTEGER
      },
      store: {
        type: DataTypes.INTEGER
      },
      shiftId: {
        type: DataTypes.INTEGER
      },
      type: {
        type: DataTypes.STRING(20),
        defaultValue: 'check-in'
      },
      absenAt: {
        type: DataTypes.DATE
      },
      latitude: {
        type: DataTypes.DOUBLE
      },
      longitude: {
        type: DataTypes.DOUBLE
      },
      accuracy: {
        type: DataTypes.DOUBLE
      },
      algorithm: {
        type: DataTypes.STRING(20),
        defaultValue: 'gps'
      },
      status: {
        type: DataTypes.STRING(20),
        defaultValue: 'valid'
      },
      note: {
        type: DataTypes.STRING(255)
      },
      // B26: retry-safe clock-in from the salon staff phone (unique per user).
      idempotencyKey: {
        type: DataTypes.STRING(100),
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
      modelName: 'attendance',
      tableName: 'attendance',
      timestamps: true,
      createdAt: 'createdAt',
      updatedAt: 'updatedAt',
      deletedAt: 'deletedAt'
    }
  )

  attendance.associate = (models) => {
    attendance.belongsTo(models.user, {
      foreignKey: 'userId',
      as: 'userData'
    })
    attendance.belongsTo(models.location, {
      foreignKey: 'store',
      as: 'storeData'
    })
    attendance.belongsTo(models.shift, {
      foreignKey: 'shiftId',
      as: 'shiftData'
    })
  }

  return attendance
}