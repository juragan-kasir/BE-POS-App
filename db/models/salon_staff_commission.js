'use strict'

// Immutable commission ledger (DR-SLN-07): a refund writes a reversal row
// (negative amount, reversesId); a DB trigger refuses UPDATE/DELETE.
module.exports = (sequelize, DataTypes) => {
  const SalonStaffCommission = sequelize.define(
    'salon_staff_commission',
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
      orderItemId: { type: DataTypes.INTEGER },
      lineKey: { allowNull: false, type: DataTypes.STRING(60) },
      staffId: { allowNull: false, type: DataTypes.INTEGER },
      kind: { allowNull: false, type: DataTypes.STRING(10), validate: { isIn: [['service', 'product', 'tip']] } },
      name: { allowNull: false, type: DataTypes.STRING(150) },
      amount: { allowNull: false, type: DataTypes.INTEGER },
      status: { allowNull: false, type: DataTypes.STRING(10), validate: { isIn: [['earned', 'reversed']] } },
      reversesId: { type: DataTypes.INTEGER, references: { model: 'salon_staff_commission', key: 'id' } },
      createdBy: { type: DataTypes.INTEGER }
    },
    {
      paranoid: false,
      updatedAt: false,
      freezeTableName: true,
      modelName: 'salon_staff_commission',
      tableName: 'salon_staff_commission'
    }
  )

  return SalonStaffCommission
}
