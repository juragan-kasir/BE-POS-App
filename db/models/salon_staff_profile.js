'use strict'

// Salon staff profile (one per outlet per user): level for level prices,
// colour in the calendar, commission override (DR-SLN-09). Staff = a user.
module.exports = (sequelize, DataTypes) => {
  const SalonStaffProfile = sequelize.define(
    'salon_staff_profile',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      tenantId: { allowNull: false, type: DataTypes.INTEGER, references: { model: 'tenant', key: 'id' } },
      store: { allowNull: false, type: DataTypes.INTEGER },
      userId: { allowNull: false, type: DataTypes.INTEGER, references: { model: 'user', key: 'id' } },
      positionId: { type: DataTypes.INTEGER, references: { model: 'position', key: 'id' } },
      level: { allowNull: false, type: DataTypes.STRING(10), defaultValue: 'junior', validate: { isIn: [['junior', 'senior', 'master']] } },
      colorTag: { allowNull: false, type: DataTypes.STRING(7), defaultValue: '#10b981' },
      acceptsOnline: { allowNull: false, type: DataTypes.BOOLEAN, defaultValue: true },
      active: { allowNull: false, type: DataTypes.BOOLEAN, defaultValue: true },
      commissionOverride: { type: DataTypes.JSONB },
      createdBy: { type: DataTypes.INTEGER },
      modifiedBy: { type: DataTypes.INTEGER }
    },
    {
      paranoid: true,
      freezeTableName: true,
      modelName: 'salon_staff_profile',
      tableName: 'salon_staff_profile'
    }
  )

  SalonStaffProfile.associate = (models) => {
    SalonStaffProfile.belongsTo(models.user, { foreignKey: 'userId', as: 'userData' })
    SalonStaffProfile.belongsTo(models.position, { foreignKey: 'positionId', as: 'positionData' })
    SalonStaffProfile.belongsTo(models.location, { foreignKey: 'store', as: 'storeData' })
  }

  return SalonStaffProfile
}
