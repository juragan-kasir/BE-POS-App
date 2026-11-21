'use strict'

// Leave / time off (BR-SLN-008).
module.exports = (sequelize, DataTypes) => {
  const SalonTimeOff = sequelize.define(
    'salon_time_off',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      tenantId: { allowNull: false, type: DataTypes.INTEGER, references: { model: 'tenant', key: 'id' } },
      store: { allowNull: false, type: DataTypes.INTEGER },
      userId: { allowNull: false, type: DataTypes.INTEGER },
      startAt: { allowNull: false, type: DataTypes.DATE },
      endAt: { allowNull: false, type: DataTypes.DATE },
      reason: { allowNull: false, type: DataTypes.STRING(120), defaultValue: '' },
      createdBy: { type: DataTypes.INTEGER }
    },
    {
      paranoid: true,
      freezeTableName: true,
      modelName: 'salon_time_off',
      tableName: 'salon_time_off'
    }
  )

  return SalonTimeOff
}
