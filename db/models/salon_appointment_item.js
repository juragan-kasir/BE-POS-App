'use strict'

// One service of an appointment on one staff member. endAt includes the
// buffer; the DB exclusion constraint refuses overlapping blocking items of
// the same staff (DR-SLN-05).
module.exports = (sequelize, DataTypes) => {
  const SalonAppointmentItem = sequelize.define(
    'salon_appointment_item',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      tenantId: { allowNull: false, type: DataTypes.INTEGER, references: { model: 'tenant', key: 'id' } },
      store: { allowNull: false, type: DataTypes.INTEGER },
      appointmentId: { allowNull: false, type: DataTypes.INTEGER, references: { model: 'salon_appointment', key: 'id' } },
      productId: { allowNull: false, type: DataTypes.INTEGER, references: { model: 'product', key: 'id' } },
      serviceName: { allowNull: false, type: DataTypes.STRING(150) },
      staffId: { allowNull: false, type: DataTypes.INTEGER },
      startAt: { allowNull: false, type: DataTypes.DATE },
      endAt: { allowNull: false, type: DataTypes.DATE },
      price: { allowNull: false, type: DataTypes.INTEGER },
      durationMin: { allowNull: false, type: DataTypes.INTEGER },
      bufferMin: { allowNull: false, type: DataTypes.INTEGER, defaultValue: 0 },
      status: { allowNull: false, type: DataTypes.STRING(20), defaultValue: 'booked' }
    },
    {
      paranoid: true,
      freezeTableName: true,
      modelName: 'salon_appointment_item',
      tableName: 'salon_appointment_item'
    }
  )

  SalonAppointmentItem.associate = (models) => {
    SalonAppointmentItem.belongsTo(models.salon_appointment, { foreignKey: 'appointmentId', as: 'appointment' })
  }

  return SalonAppointmentItem
}
