'use strict'

// Walk-in queue number per outlet per business day (BR-SLN-017).
module.exports = (sequelize, DataTypes) => {
  const SalonQueueTicket = sequelize.define(
    'salon_queue_ticket',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      tenantId: { allowNull: false, type: DataTypes.INTEGER, references: { model: 'tenant', key: 'id' } },
      store: { allowNull: false, type: DataTypes.INTEGER },
      businessDate: { allowNull: false, type: DataTypes.DATEONLY },
      seq: { allowNull: false, type: DataTypes.INTEGER },
      label: { allowNull: false, type: DataTypes.STRING(10) },
      status: { allowNull: false, type: DataTypes.STRING(10), defaultValue: 'waiting' },
      customerName: { allowNull: false, type: DataTypes.STRING(60) },
      customerPhone: { allowNull: false, type: DataTypes.STRING(20), defaultValue: '' },
      memberId: { type: DataTypes.INTEGER, references: { model: 'member', key: 'id' } },
      serviceIds: { allowNull: false, type: DataTypes.JSONB, defaultValue: [] },
      preferredStaffId: { type: DataTypes.INTEGER },
      staffId: { type: DataTypes.INTEGER },
      appointmentId: { type: DataTypes.INTEGER, references: { model: 'salon_appointment', key: 'id' } },
      idempotencyKey: { allowNull: false, type: DataTypes.STRING(100) },
      requestHash: { allowNull: false, type: DataTypes.STRING(64) },
      createdBy: { type: DataTypes.INTEGER }
    },
    {
      paranoid: false,
      freezeTableName: true,
      modelName: 'salon_queue_ticket',
      tableName: 'salon_queue_ticket'
    }
  )

  return SalonQueueTicket
}
