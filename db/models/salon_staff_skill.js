'use strict'

// A service a staff member performs, with optional duration/price override
// (BR-SLN-003, BR-SLN-005).
module.exports = (sequelize, DataTypes) => {
  const SalonStaffSkill = sequelize.define(
    'salon_staff_skill',
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
      productId: { allowNull: false, type: DataTypes.INTEGER, references: { model: 'product', key: 'id' } },
      durationOverride: { type: DataTypes.INTEGER },
      priceOverride: { type: DataTypes.INTEGER }
    },
    {
      paranoid: false,
      freezeTableName: true,
      modelName: 'salon_staff_skill',
      tableName: 'salon_staff_skill'
    }
  )

  SalonStaffSkill.associate = (models) => {
    SalonStaffSkill.belongsTo(models.product, { foreignKey: 'productId', as: 'productData' })
  }

  return SalonStaffSkill
}
