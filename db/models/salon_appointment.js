'use strict'

// Booking or walk-in. Status machine: SALON-BA §4.3. Idempotent per
// (store, idempotencyKey) with requestHash for IDEMPOTENCY_MISMATCH (BR-SLN-006).
module.exports = (sequelize, DataTypes) => {
  const SalonAppointment = sequelize.define(
    'salon_appointment',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      tenantId: { allowNull: false, type: DataTypes.INTEGER, references: { model: 'tenant', key: 'id' } },
      store: { allowNull: false, type: DataTypes.INTEGER },
      number: { allowNull: false, type: DataTypes.STRING(30) },
      memberId: { type: DataTypes.INTEGER, references: { model: 'member', key: 'id' } },
      customerName: { allowNull: false, type: DataTypes.STRING(60) },
      customerPhone: { allowNull: false, type: DataTypes.STRING(20), defaultValue: '' },
      status: { allowNull: false, type: DataTypes.STRING(20), defaultValue: 'booked' },
      source: { allowNull: false, type: DataTypes.STRING(10), defaultValue: 'phone' },
      startAt: { allowNull: false, type: DataTypes.DATE },
      endAt: { allowNull: false, type: DataTypes.DATE },
      depositAmount: { allowNull: false, type: DataTypes.INTEGER, defaultValue: 0 },
      depositMethod: { type: DataTypes.STRING(20) },
      depositReference: { type: DataTypes.STRING(60) },
      depositCashRegisterId: { type: DataTypes.INTEGER },
      depositStatus: { allowNull: false, type: DataTypes.STRING(10), defaultValue: 'none' },
      orderId: { type: DataTypes.INTEGER, references: { model: 'order', key: 'id' } },
      notes: { allowNull: false, type: DataTypes.STRING(300), defaultValue: '' },
      idempotencyKey: { allowNull: false, type: DataTypes.STRING(100) },
      requestHash: { allowNull: false, type: DataTypes.STRING(64) },
      createdBy: { type: DataTypes.INTEGER },
      modifiedBy: { type: DataTypes.INTEGER }
    },
    {
      paranoid: true,
      freezeTableName: true,
      modelName: 'salon_appointment',
      tableName: 'salon_appointment'
    }
  )

  SalonAppointment.associate = (models) => {
    SalonAppointment.hasMany(models.salon_appointment_item, { foreignKey: 'appointmentId', as: 'items' })
    SalonAppointment.hasMany(models.salon_appointment_event, { foreignKey: 'appointmentId', as: 'events' })
    SalonAppointment.belongsTo(models.member, { foreignKey: 'memberId', as: 'memberData' })
    SalonAppointment.belongsTo(models.location, { foreignKey: 'store', as: 'storeData' })
  }

  return SalonAppointment
}
