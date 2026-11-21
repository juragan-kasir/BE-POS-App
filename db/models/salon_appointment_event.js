'use strict'

// Status history of an appointment (append-only).
module.exports = (sequelize, DataTypes) => {
  const SalonAppointmentEvent = sequelize.define(
    'salon_appointment_event',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      tenantId: { allowNull: false, type: DataTypes.INTEGER, references: { model: 'tenant', key: 'id' } },
      appointmentId: { allowNull: false, type: DataTypes.INTEGER, references: { model: 'salon_appointment', key: 'id' } },
      status: { allowNull: false, type: DataTypes.STRING(20) },
      reason: { type: DataTypes.STRING(200) },
      createdBy: { type: DataTypes.INTEGER }
    },
    {
      paranoid: false,
      updatedAt: false,
      freezeTableName: true,
      modelName: 'salon_appointment_event',
      tableName: 'salon_appointment_event'
    }
  )

  SalonAppointmentEvent.associate = (models) => {
    SalonAppointmentEvent.belongsTo(models.salon_appointment, { foreignKey: 'appointmentId', as: 'appointment' })
  }

  return SalonAppointmentEvent
}
