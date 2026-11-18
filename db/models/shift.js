'use strict'
const { attachStoreTenant } = require('../../utils/storeTenant')
module.exports = (sequelize, DataTypes) => {
  return attachStoreTenant(sequelize.define(
    'shift',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      store: {
        type: DataTypes.INTEGER
      },
      // Owning tenant = the tenant of `store` (utils/storeTenant, re-derived
      // on every write that sets the outlet). Migration 20261119000004.
      tenantId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'tenant', key: 'id' }
      },
      name: {
        allowNull: false,
        type: DataTypes.STRING
      },
      startTime: {
        allowNull: false,
        type: DataTypes.TIME
      },
      endTime: {
        allowNull: false,
        type: DataTypes.TIME
      },
      tipe_shift: {
        type: DataTypes.STRING(20),
        defaultValue: ''
      },
      tanggal_mulai: {
        type: DataTypes.DATEONLY,
        allowNull: true
      },
      tanggal_selesai: {
        type: DataTypes.DATEONLY,
        allowNull: true
      },
      karyawan: {
        type: DataTypes.JSONB,
        defaultValue: []
      },
      status: {
        type: DataTypes.STRING(20),
        defaultValue: 'active'
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
      modelName: 'shift',
      tableName: 'shift'
    }
  ))

  Shift.associate = (models) => {
    Shift.belongsTo(models.user, { foreignKey: 'createdBy', as: 'createdByUser' })
    Shift.belongsTo(models.user, { foreignKey: 'modifiedBy', as: 'modifiedByUser' })
  }

  return Shift
}
