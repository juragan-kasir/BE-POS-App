'use strict'

// Shared laundry domain (2026-11-14).
//
// Additive-only: every existing table keeps its current columns and meaning.
// Laundry order state lives in a 1:1 extension of `order`, so pricing, tax,
// promo, settlement and financial invariants stay in one place.

module.exports = {
  async up(queryInterface, Sequelize) {
    const location = await queryInterface.describeTable('location')
    if (!location.businessType) {
      await queryInterface.addColumn('location', 'businessType', {
        type: Sequelize.STRING(20),
        allowNull: false,
        defaultValue: 'fnb'
      })
    }
    if (!location.laundrySettings) {
      await queryInterface.addColumn('location', 'laundrySettings', {
        type: Sequelize.JSONB,
        allowNull: true
      })
    }

    const product = await queryInterface.describeTable('product')
    if (!product.serviceConfig) {
      await queryInterface.addColumn('product', 'serviceConfig', {
        type: Sequelize.JSONB,
        allowNull: true
      })
    }

    const member = await queryInterface.describeTable('member')
    if (!member.isCredit) {
      await queryInterface.addColumn('member', 'isCredit', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false
      })
    }
    if (!member.creditLimit) {
      await queryInterface.addColumn('member', 'creditLimit', {
        type: Sequelize.BIGINT,
        allowNull: true
      })
    }

    const transaction = await queryInterface.describeTable('transaction')
    if (!transaction.idempotencyKey) {
      await queryInterface.addColumn('transaction', 'idempotencyKey', {
        type: Sequelize.STRING(255),
        allowNull: true
      })
      await queryInterface.sequelize.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS "transaction_order_idempotency_unique" ON "transaction" ("order", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL'
      )
    }

    const orderItem = await queryInterface.describeTable('order_item')
    if (!orderItem.serviceSnapshot) {
      await queryInterface.addColumn('order_item', 'serviceSnapshot', {
        type: Sequelize.JSONB,
        allowNull: true
      })
    }

    const tables = await queryInterface.showAllTables()
    if (!tables.includes('laundry_turnaround')) {
      await queryInterface.createTable('laundry_turnaround', {
        id: {
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
          type: Sequelize.INTEGER
        },
        store: {
          allowNull: false,
          type: Sequelize.INTEGER
        },
        tenantId: {
          type: Sequelize.INTEGER,
          references: { model: 'tenant', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL'
        },
        name: {
          allowNull: false,
          type: Sequelize.STRING(150)
        },
        durationHours: {
          allowNull: false,
          type: Sequelize.INTEGER,
          defaultValue: 72
        },
        surchargeType: {
          allowNull: false,
          type: Sequelize.ENUM('none', 'percent', 'fixed'),
          defaultValue: 'none'
        },
        surchargeValue: {
          allowNull: false,
          type: Sequelize.INTEGER,
          defaultValue: 0
        },
        isDefault: {
          allowNull: false,
          type: Sequelize.BOOLEAN,
          defaultValue: false
        },
        status: {
          allowNull: false,
          type: Sequelize.STRING(20),
          defaultValue: 'active'
        },
        createdBy: {
          type: Sequelize.INTEGER
        },
        modifiedBy: {
          type: Sequelize.INTEGER
        },
        createdAt: {
          allowNull: false,
          type: Sequelize.DATE,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        },
        updatedAt: {
          allowNull: false,
          type: Sequelize.DATE,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        },
        deletedAt: {
          type: Sequelize.DATE
        }
      })

      await queryInterface.addIndex('laundry_turnaround', ['store'], {
        name: 'laundry_turnaround_store_idx',
        where: { deletedAt: null }
      })
      await queryInterface.addIndex('laundry_turnaround', ['store', 'isDefault'], {
        name: 'laundry_turnaround_store_default_idx',
        where: { deletedAt: null }
      })
    }

    if (!tables.includes('laundry_order')) {
      await queryInterface.createTable('laundry_order', {
        id: {
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
          type: Sequelize.INTEGER
        },
        orderId: {
          allowNull: false,
          type: Sequelize.INTEGER,
          references: { model: 'order', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE'
        },
        store: {
          allowNull: false,
          type: Sequelize.INTEGER
        },
        tenantId: {
          type: Sequelize.INTEGER,
          references: { model: 'tenant', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL'
        },
        processStatus: {
          allowNull: false,
          type: Sequelize.ENUM(
            'RECEIVED',
            'WASHING',
            'IRONING',
            'READY',
            'PICKED_UP',
            'CANCELLED'
          ),
          defaultValue: 'RECEIVED'
        },
        turnaroundId: {
          type: Sequelize.INTEGER,
          references: { model: 'laundry_turnaround', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL'
        },
        receivedAt: {
          allowNull: false,
          type: Sequelize.DATE,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        },
        dueAt: {
          type: Sequelize.DATE
        },
        pieceCount: {
          type: Sequelize.INTEGER,
          defaultValue: 0
        },
        conditionTags: {
          type: Sequelize.JSONB,
          defaultValue: []
        },
        conditionNote: {
          type: Sequelize.TEXT
        },
        rackCode: {
          type: Sequelize.STRING(50)
        },
        readyAt: {
          type: Sequelize.DATE
        },
        readyNotifiedAt: {
          type: Sequelize.DATE
        },
        pickedUpAt: {
          type: Sequelize.DATE
        },
        pickedUpBy: {
          type: Sequelize.INTEGER
        },
        pickupPieceCount: {
          type: Sequelize.INTEGER
        },
        pickupNote: {
          type: Sequelize.TEXT
        },
        cancelledReason: {
          type: Sequelize.TEXT
        },
        createdBy: {
          type: Sequelize.INTEGER
        },
        modifiedBy: {
          type: Sequelize.INTEGER
        },
        createdAt: {
          allowNull: false,
          type: Sequelize.DATE,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        },
        updatedAt: {
          allowNull: false,
          type: Sequelize.DATE,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        },
        deletedAt: {
          type: Sequelize.DATE
        }
      })

      await queryInterface.addIndex('laundry_order', ['orderId'], {
        name: 'laundry_order_order_unique',
        unique: true,
        where: { deletedAt: null }
      })
      await queryInterface.addIndex('laundry_order', ['store', 'processStatus'], {
        name: 'laundry_order_store_status_idx',
        where: { deletedAt: null }
      })
      await queryInterface.addIndex('laundry_order', ['store', 'dueAt'], {
        name: 'laundry_order_store_due_idx',
        where: { deletedAt: null }
      })
    }

    if (!tables.includes('laundry_status_history')) {
      await queryInterface.createTable('laundry_status_history', {
        id: {
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
          type: Sequelize.INTEGER
        },
        laundryOrderId: {
          allowNull: false,
          type: Sequelize.INTEGER,
          references: { model: 'laundry_order', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE'
        },
        fromStatus: {
          type: Sequelize.STRING(20)
        },
        toStatus: {
          allowNull: false,
          type: Sequelize.STRING(20)
        },
        actorId: {
          type: Sequelize.INTEGER
        },
        reason: {
          type: Sequelize.TEXT
        },
        createdAt: {
          allowNull: false,
          type: Sequelize.DATE,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        },
        updatedAt: {
          allowNull: false,
          type: Sequelize.DATE,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
        }
      })

      await queryInterface.addIndex('laundry_status_history', ['laundryOrderId'], {
        name: 'laundry_status_history_order_idx'
      })
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable('laundry_status_history')
    await queryInterface.dropTable('laundry_order')
    await queryInterface.dropTable('laundry_turnaround')
    await queryInterface.removeColumn('order_item', 'serviceSnapshot')
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS "transaction_order_idempotency_unique"')
    await queryInterface.removeColumn('transaction', 'idempotencyKey')
    await queryInterface.removeColumn('member', 'creditLimit')
    await queryInterface.removeColumn('member', 'isCredit')
    await queryInterface.removeColumn('product', 'serviceConfig')
    await queryInterface.removeColumn('location', 'laundrySettings')
    await queryInterface.removeColumn('location', 'businessType')
  }
}
