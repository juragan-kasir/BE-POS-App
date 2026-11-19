'use strict'
module.exports = (sequelize, DataTypes) => {
  const Queue = sequelize.define(
    'queue',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      store: {
        type: DataTypes.JSONB
      },
      // W3-6b (batch B25): first outlet of `store` and its business day;
      // unique ("storeId", "businessDate", "queueNumber") among live rows.
      storeId: {
        type: DataTypes.INTEGER
      },
      businessDate: {
        type: DataTypes.DATEONLY
      },
      queueNumber: {
        allowNull: false,
        type: DataTypes.STRING(20)
      },
      customerName: {
        allowNull: false,
        type: DataTypes.STRING
      },
      customerPhone: {
        type: DataTypes.STRING
      },
      partySize: {
        allowNull: false,
        type: DataTypes.INTEGER,
        defaultValue: 1
      },
      priority: {
        type: DataTypes.ENUM(
          'normal',
          'vip',
          'elderly',
          'pregnant',
          'disabled'
        ),
        defaultValue: 'normal'
      },
      estimatedWaitMinutes: {
        type: DataTypes.INTEGER
      },
      actualWaitMinutes: {
        type: DataTypes.INTEGER
      },
      tableId: {
        type: DataTypes.INTEGER
      },
      notes: {
        type: DataTypes.TEXT
      },
      status: {
        type: DataTypes.ENUM(
          'waiting',
          'seated',
          'cancelled',
          'no_show',
          'expired'
        ),
        defaultValue: 'waiting'
      },
      checkedInAt: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW
      },
      seatedAt: {
        type: DataTypes.DATE
      },
      cancelledAt: {
        type: DataTypes.DATE
      },
      assignedTo: {
        type: DataTypes.INTEGER
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
      modelName: 'queue',
      tableName: 'queue'
    }
  )

  Queue.associate = function (models) {
    Queue.belongsTo(models.table, { foreignKey: 'tableId', as: 'table' })
    Queue.belongsTo(models.user, {
      foreignKey: 'assignedTo',
      as: 'assignedUser'
    })
    Queue.belongsTo(models.user, {
      foreignKey: 'createdBy',
      as: 'createdByUser'
    })
  }

  return Queue
}
