'use strict'

// Weekly working hours of a staff member at an outlet (BR-SLN-003).
module.exports = (sequelize, DataTypes) => {
  const SalonAvailability = sequelize.define(
    'salon_availability',
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
      weekday: { allowNull: false, type: DataTypes.SMALLINT },
      startTime: { allowNull: false, type: DataTypes.TIME },
      endTime: { allowNull: false, type: DataTypes.TIME }
    },
    {
      paranoid: false,
      freezeTableName: true,
      modelName: 'salon_availability',
      tableName: 'salon_availability'
    }
  )

  return SalonAvailability
}
