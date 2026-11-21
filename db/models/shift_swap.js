'use strict'
module.exports = (sequelize, DataTypes) => {
  const ShiftSwap = sequelize.define(
    'shift_swap',
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
      requesterId: {
        allowNull: false,
        type: DataTypes.INTEGER
      },
      targetId: {
        allowNull: false,
        type: DataTypes.INTEGER
      },
      requesterShiftId: {
        allowNull: false,
        type: DataTypes.INTEGER
      },
      targetShiftId: {
        allowNull: false,
        type: DataTypes.INTEGER
      },
      tanggal_mulai: {
        type: DataTypes.DATEONLY,
        allowNull: true
      },
      tanggal_selesai: {
        type: DataTypes.DATEONLY,
        allowNull: true
      },
      note: {
        type: DataTypes.TEXT
      },
      status: {
        type: DataTypes.STRING(20),
        defaultValue: 'pending'
      },
      decidedBy: {
        type: DataTypes.INTEGER
      },
      decidedAt: {
        type: DataTypes.DATE
      },
      // B26: retry-safe swap request (unique per requester).
      idempotencyKey: {
        type: DataTypes.STRING(100),
        allowNull: true
      },
      status_history: {
        type: DataTypes.JSONB,
        allowNull: true
      },
      expires_at: {
        type: DataTypes.DATE,
        allowNull: true
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
      modelName: 'shift_swap',
      tableName: 'shift_swap'
    }
  )

  ShiftSwap.associate = (models) => {
    ShiftSwap.belongsTo(models.user, {
      foreignKey: 'requesterId',
      as: 'requesterUser'
    })
    ShiftSwap.belongsTo(models.user, { foreignKey: 'targetId', as: 'targetUser' })
    ShiftSwap.belongsTo(models.shift, {
      foreignKey: 'requesterShiftId',
      as: 'requesterShift'
    })
    ShiftSwap.belongsTo(models.shift, {
      foreignKey: 'targetShiftId',
      as: 'targetShift'
    })
    ShiftSwap.belongsTo(models.user, {
      foreignKey: 'decidedBy',
      as: 'decidedByUser'
    })
  }

  return ShiftSwap
}