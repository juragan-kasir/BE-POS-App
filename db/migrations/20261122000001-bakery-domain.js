'use strict'

module.exports = {
  async up(queryInterface, Sequelize) {
    const location = await queryInterface.describeTable('location')
    if (!location.bakerySettings) {
      await queryInterface.addColumn('location', 'bakerySettings', {
        type: Sequelize.JSONB,
        allowNull: true
      })
    }

    const tables = await queryInterface.showAllTables()
    if (!tables.includes('bakery_order')) {
      await queryInterface.createTable('bakery_order', {
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
            'PENDING_CONFIRMATION',
            'CONFIRMED',
            'IN_PRODUCTION',
            'READY',
            'PICKED_UP',
            'DELIVERED',
            'CANCELLED'
          ),
          defaultValue: 'PENDING_CONFIRMATION'
        },
        fulfillmentType: {
          allowNull: false,
          type: Sequelize.ENUM('pickup', 'delivery'),
          defaultValue: 'pickup'
        },
        scheduledAt: {
          allowNull: false,
          type: Sequelize.DATE
        },
        customerNote: { type: Sequelize.TEXT },
        adminNote: { type: Sequelize.TEXT },
        deliveryAddress: { type: Sequelize.TEXT },
        deliveryNote: { type: Sequelize.TEXT },
        readyAt: { type: Sequelize.DATE },
        pickedUpAt: { type: Sequelize.DATE },
        deliveredAt: { type: Sequelize.DATE },
        cancelledAt: { type: Sequelize.DATE },
        cancelledReason: { type: Sequelize.TEXT },
        createdBy: { type: Sequelize.INTEGER },
        modifiedBy: { type: Sequelize.INTEGER },
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
        deletedAt: { type: Sequelize.DATE }
      })

      await queryInterface.addIndex('bakery_order', ['orderId'], {
        name: 'bakery_order_order_unique',
        unique: true,
        where: { deletedAt: null }
      })
      await queryInterface.addIndex('bakery_order', ['store', 'processStatus'], {
        name: 'bakery_order_store_status_idx',
        where: { deletedAt: null }
      })
      await queryInterface.addIndex('bakery_order', ['store', 'scheduledAt'], {
        name: 'bakery_order_store_schedule_idx',
        where: { deletedAt: null }
      })
    }

    if (!tables.includes('bakery_status_history')) {
      await queryInterface.createTable('bakery_status_history', {
        id: {
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
          type: Sequelize.INTEGER
        },
        bakeryOrderId: {
          allowNull: false,
          type: Sequelize.INTEGER,
          references: { model: 'bakery_order', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE'
        },
        fromStatus: { type: Sequelize.STRING(30) },
        toStatus: { allowNull: false, type: Sequelize.STRING(30) },
        actorId: { type: Sequelize.INTEGER },
        reason: { type: Sequelize.TEXT },
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

      await queryInterface.addIndex('bakery_status_history', ['bakeryOrderId'], {
        name: 'bakery_status_history_order_idx'
      })
    }
  },

  async down(queryInterface) {
    const tables = await queryInterface.showAllTables()
    if (tables.includes('bakery_status_history')) await queryInterface.dropTable('bakery_status_history')
    if (tables.includes('bakery_order')) await queryInterface.dropTable('bakery_order')
    const location = await queryInterface.describeTable('location')
    if (location.bakerySettings) await queryInterface.removeColumn('location', 'bakerySettings')
  }
}
