'use strict'
// Status trail of a bakery pre-order (batch B28). idempotencyKey makes a
// retried status click a replay instead of a second row.
module.exports = (sequelize, DataTypes) => {
  const BakeryStatusHistory = sequelize.define(
    'bakery_status_history',
    {
      id: { allowNull: false, autoIncrement: true, primaryKey: true, type: DataTypes.INTEGER },
      tenantId: { allowNull: false, type: DataTypes.INTEGER, references: { model: 'tenant', key: 'id' } },
      bakeryOrderId: { allowNull: false, type: DataTypes.INTEGER, references: { model: 'bakery_order', key: 'id' } },
      fromStatus: { type: DataTypes.STRING(25) },
      toStatus: { allowNull: false, type: DataTypes.STRING(25) },
      reason: { type: DataTypes.STRING(300) },
      idempotencyKey: { type: DataTypes.STRING(100) },
      createdBy: { type: DataTypes.INTEGER }
    },
    { paranoid: false, updatedAt: false, freezeTableName: true, modelName: 'bakery_status_history', tableName: 'bakery_status_history' }
  )
  return BakeryStatusHistory
}
