'use strict'
// Bakery pre-order view of a POS order (batch B28): schedule, pickup or
// delivery, notes and the process status. The money lives in order /
// order_item / transaction, like laundry_order.
module.exports = (sequelize, DataTypes) => {
  const BakeryOrder = sequelize.define(
    'bakery_order',
    {
      id: { allowNull: false, autoIncrement: true, primaryKey: true, type: DataTypes.INTEGER },
      tenantId: { allowNull: false, type: DataTypes.INTEGER, references: { model: 'tenant', key: 'id' } },
      store: { allowNull: false, type: DataTypes.INTEGER, references: { model: 'location', key: 'id' } },
      orderId: { allowNull: false, type: DataTypes.INTEGER, references: { model: 'order', key: 'id' } },
      memberId: { type: DataTypes.INTEGER },
      fulfillmentType: { allowNull: false, type: DataTypes.STRING(10), validate: { isIn: [['pickup', 'delivery']] } },
      scheduledAt: { allowNull: false, type: DataTypes.DATE },
      deliveryAddress: { type: DataTypes.STRING(500) },
      deliveryNote: { type: DataTypes.STRING(300) },
      customerNote: { type: DataTypes.STRING(500) },
      adminNote: { type: DataTypes.STRING(500) },
      processStatus: { allowNull: false, type: DataTypes.STRING(25), defaultValue: 'PENDING_CONFIRMATION' },
      idempotencyKey: { allowNull: false, type: DataTypes.STRING(100) },
      requestHash: { allowNull: false, type: DataTypes.STRING(64) },
      createdBy: { type: DataTypes.INTEGER },
      modifiedBy: { type: DataTypes.INTEGER }
    },
    { paranoid: false, freezeTableName: true, modelName: 'bakery_order', tableName: 'bakery_order' }
  )
  BakeryOrder.associate = (models) => {
    BakeryOrder.belongsTo(models.order, { foreignKey: 'orderId', as: 'orderData' })
    BakeryOrder.hasMany(models.bakery_status_history, { foreignKey: 'bakeryOrderId', as: 'history' })
  }
  return BakeryOrder
}
