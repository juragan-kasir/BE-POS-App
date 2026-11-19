'use strict'
const { attachStoreTenant } = require('../../utils/storeTenant')
module.exports = (sequelize, DataTypes) => {
  const cashMovement = sequelize.define(
    'cashMovement',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      // Denormalized from cash_register.store at creation time — always
      // server-resolved from the locked register row, never accepted from
      // the client. See cashRegister.js controller: the request body's
      // `store`, if any, is never even destructured. NOT NULL + RESTRICT
      // at the DB level (see the matching migration) because a financial-
      // ledger row must never lose its store attribution.
      store: {
        allowNull: false,
        type: DataTypes.INTEGER
      },
      // Owning tenant = the tenant of `store` (utils/storeTenant, re-derived
      // on every write that sets the outlet). Migration 20261119000004.
      tenantId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'tenant', key: 'id' }
      },
      cashRegisterId: {
        allowNull: false,
        type: DataTypes.INTEGER
      },
      type: {
        allowNull: false,
        type: DataTypes.ENUM('cash_in', 'cash_out')
      },
      reasonCode: {
        allowNull: false,
        type: DataTypes.ENUM(
          'float_topup',
          'bank_drop',
          'petty_cash',
          'owner_draw',
          'change_fund',
          'correction',
          'other'
        )
      },
      amount: {
        allowNull: false,
        type: DataTypes.INTEGER
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true
      },
      status: {
        allowNull: false,
        type: DataTypes.ENUM(
          'pending_approval',
          'active',
          'rejected',
          'reversed'
        )
      },
      reversalOfId: {
        type: DataTypes.INTEGER,
        allowNull: true
      },
      createdBy: {
        type: DataTypes.INTEGER,
        allowNull: true
      },
      approvedBy: {
        type: DataTypes.INTEGER,
        allowNull: true
      },
      approvedAt: {
        type: DataTypes.DATE,
        allowNull: true
      },
      idempotencyKey: {
        type: DataTypes.STRING,
        allowNull: true
      }
    },
    {
      paranoid: false,
      freezeTableName: true,
      modelName: 'cashMovement',
      tableName: 'cash_movement'
    }
  )

  cashMovement.associate = (models) => {
    cashMovement.belongsTo(models.location, {
      foreignKey: 'store',
      as: 'storeData'
    })
    cashMovement.belongsTo(models.cashRegister, {
      foreignKey: 'cashRegisterId',
      as: 'register'
    })
    cashMovement.belongsTo(models.cashMovement, {
      foreignKey: 'reversalOfId',
      as: 'reversalOf'
    })
    cashMovement.belongsTo(models.user, {
      foreignKey: 'createdBy',
      as: 'createdByData'
    })
    cashMovement.belongsTo(models.user, {
      foreignKey: 'approvedBy',
      as: 'approvedByData'
    })
  }

  return attachStoreTenant(cashMovement)
}
