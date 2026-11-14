'use strict'

module.exports = (sequelize, DataTypes) => {
  const LaundryTurnaround = sequelize.define(
    'laundry_turnaround',
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
      tenantId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'tenant', key: 'id' }
      },
      name: {
        allowNull: false,
        type: DataTypes.STRING(150)
      },
      durationHours: {
        allowNull: false,
        type: DataTypes.INTEGER,
        defaultValue: 72
      },
      surchargeType: {
        allowNull: false,
        type: DataTypes.ENUM('none', 'percent', 'fixed'),
        defaultValue: 'none'
      },
      surchargeValue: {
        allowNull: false,
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      isDefault: {
        allowNull: false,
        type: DataTypes.BOOLEAN,
        defaultValue: false
      },
      status: {
        allowNull: false,
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
      modelName: 'laundry_turnaround',
      tableName: 'laundry_turnaround'
    }
  )

  LaundryTurnaround.associate = (models) => {
    LaundryTurnaround.belongsTo(models.location, {
      foreignKey: 'store',
      as: 'storeData'
    })
    LaundryTurnaround.hasMany(models.laundry_order, {
      foreignKey: 'turnaroundId',
      as: 'orders'
    })
  }

  return LaundryTurnaround
}
