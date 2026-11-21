'use strict'

// Salon view of a POS order (DR-SLN-06): the quote snapshot, applied deposit,
// tip and refund. The money itself lives in order / order_item / transaction.
module.exports = (sequelize, DataTypes) => {
  const SalonOrder = sequelize.define(
    'salon_order',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      tenantId: { allowNull: false, type: DataTypes.INTEGER, references: { model: 'tenant', key: 'id' } },
      store: { allowNull: false, type: DataTypes.INTEGER },
      orderId: { allowNull: false, type: DataTypes.INTEGER, references: { model: 'order', key: 'id' } },
      appointmentId: { type: DataTypes.INTEGER, references: { model: 'salon_appointment', key: 'id' } },
      quote: { allowNull: false, type: DataTypes.JSONB },
      depositApplied: { allowNull: false, type: DataTypes.INTEGER, defaultValue: 0 },
      tipTotal: { allowNull: false, type: DataTypes.INTEGER, defaultValue: 0 },
      status: { allowNull: false, type: DataTypes.STRING(10), defaultValue: 'paid' },
      refund: { type: DataTypes.JSONB },
      idempotencyKey: { allowNull: false, type: DataTypes.STRING(100) },
      requestHash: { allowNull: false, type: DataTypes.STRING(64) },
      createdBy: { type: DataTypes.INTEGER }
    },
    {
      paranoid: false,
      freezeTableName: true,
      modelName: 'salon_order',
      tableName: 'salon_order'
    }
  )

  SalonOrder.associate = (models) => {
    SalonOrder.belongsTo(models.order, { foreignKey: 'orderId', as: 'orderData' })
    SalonOrder.belongsTo(models.salon_appointment, { foreignKey: 'appointmentId', as: 'appointment' })
  }

  return SalonOrder
}
