'use strict'
const { attachStoreTenant } = require('../../utils/storeTenant')
module.exports = (sequelize, DataTypes) => {
  const Role = sequelize.define(
    'role',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      store: {
        type: DataTypes.INTEGER,
        allowNull: true
      },
      // Owning tenant = the tenant of `store` (utils/storeTenant, re-derived
      // on every write that sets the outlet). Migration 20261119000005.
      tenantId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'tenant', key: 'id' }
      },
      name: {
        allowNull: false,
        type: DataTypes.STRING
      },
      roleType: {
        type: DataTypes.ENUM('super_admin', 'admin', 'kasir', 'user'),
        defaultValue: 'user'
      },
      accessMenu: {
        type: DataTypes.JSONB,
        defaultValue: []
      },
      status: {
        type: DataTypes.STRING(20),
        defaultValue: 'active'
      },
      isSystem: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
      },
      createdBy: {
        type: DataTypes.INTEGER
      },
      modifiedBy: {
        type: DataTypes.INTEGER
      }
    },
    {
      paranoid: true,
      freezeTableName: true,
      modelName: 'role',
      tableName: 'role'
    }
  )

  Role.associate = (models) => {
    Role.belongsTo(models.location, { foreignKey: 'store', as: 'storeData' })
    Role.hasMany(models.user, { foreignKey: 'roleId', as: 'users' })
  }

  return attachStoreTenant(Role)
}
