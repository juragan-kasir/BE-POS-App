'use strict'

// AUD-2 (DR-20 immutability): audit records are append-only on the normal
// application path. CREATE stays allowed; every ORM mutation path throws a
// deterministic error that carries no row payload and no SQL.
//
// MAINTENANCE EXCEPTION (documented, tightly scoped): test cleanup and
// offline migrations may pass `__auditMaintenance: true` in the Sequelize
// options object (e.g. `auditLog.destroy({ where, __auditMaintenance: true })`).
// No controller, job, or audit helper sets this flag, it cannot be set from
// any client request, and schema migrations bypass the ORM entirely via
// queryInterface so they never need it either.
const denyAuditMutation = (options, operation) => {
  if (options && options.__auditMaintenance === true) return
  throw new Error(`auditLog is append-only: ${operation} is not allowed`)
}

module.exports = (sequelize, DataTypes) => {
  const AuditLog = sequelize.define(
    'auditLog',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      store: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'location', key: 'id' }
      },
      userId: {
        type: DataTypes.INTEGER,
        allowNull: true
      },
      userName: {
        type: DataTypes.STRING(100),
        allowNull: true
      },
      action: {
        type: DataTypes.STRING(20),
        allowNull: false
      },
      entity: {
        type: DataTypes.STRING(50),
        allowNull: false
      },
      entityId: {
        type: DataTypes.INTEGER,
        allowNull: true
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true
      },
      oldValues: {
        type: DataTypes.JSONB,
        allowNull: true
      },
      newValues: {
        type: DataTypes.JSONB,
        allowNull: true
      },
      ipAddress: {
        type: DataTypes.STRING(45),
        allowNull: true
      },
      userAgent: {
        type: DataTypes.TEXT,
        allowNull: true
      },
      // AUD-1 (DR-20 foundation). All nullable/defaulted: historical rows
      // stay valid; unknowable context stays NULL rather than fabricated.
      // The tenant FK is added by the audit DB backstop migration; historical
      // rows are backfilled from their store where possible.
      actorType: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'USER'
      },
      tenantId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        defaultValue: null,
        references: { model: 'tenant', key: 'id' }
      },
      result: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'SUCCESS'
      },
      requestId: {
        type: DataTypes.STRING(64),
        allowNull: true,
        defaultValue: null
      },
      reason: {
        type: DataTypes.TEXT,
        allowNull: true,
        defaultValue: null
      },
      source: {
        type: DataTypes.STRING(30),
        allowNull: true,
        defaultValue: null
      },
      metadata: {
        type: DataTypes.JSONB,
        allowNull: true,
        defaultValue: null
      }
    },
    {
      paranoid: false,
      freezeTableName: true,
      tableName: 'auditLog',
      hooks: {
        // Instance + static mutation paths. Static Model.update/destroy are
        // Sequelize's bulk paths, so beforeBulkUpdate/beforeBulkDestroy cover
        // the "bulk" APIs too; beforeSave with !isNewRecord additionally
        // covers instance.save() and increment()/decrement() on live rows.
        beforeUpdate: (instance, options) =>
          denyAuditMutation(options, 'UPDATE'),
        beforeDestroy: (instance, options) =>
          denyAuditMutation(options, 'DELETE'),
        beforeBulkUpdate: (options) => denyAuditMutation(options, 'UPDATE'),
        beforeBulkDestroy: (options) => denyAuditMutation(options, 'DELETE'),
        beforeSave: (instance, options) => {
          if (!instance.isNewRecord) denyAuditMutation(options, 'UPDATE')
        },
        beforeUpsert: (values, options) =>
          denyAuditMutation(options, 'UPSERT'),
        beforeBulkCreate: (instances, options) => {
          if (
            options &&
            Array.isArray(options.updateOnDuplicate) &&
            options.updateOnDuplicate.length > 0
          ) {
            denyAuditMutation(options, 'UPDATE')
          }
        }
      }
    }
  )

  AuditLog.associate = (models) => {
    AuditLog.belongsTo(models.location, {
      foreignKey: 'store',
      as: 'storeData'
    })
    if (models.tenant) {
      AuditLog.belongsTo(models.tenant, {
        foreignKey: 'tenantId',
        as: 'tenant'
      })
    }
  }

  return AuditLog
}
