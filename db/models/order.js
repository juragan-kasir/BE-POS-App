'use strict'
module.exports = (sequelize, DataTypes) => {
  const order = sequelize.define(
    'order',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      orderNumber: {
        allowNull: false,
        type: DataTypes.STRING,
        unique: true
      },
      store: {
        type: DataTypes.INTEGER
      },
      tableId: {
        type: DataTypes.INTEGER
      },
      customerId: {
        type: DataTypes.INTEGER
      },
      customerName: {
        type: DataTypes.STRING
      },
      customerPhone: {
        type: DataTypes.STRING
      },
      discountId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'discount', key: 'id' }
      },
      promoCode: {
        type: DataTypes.STRING,
        allowNull: true
      },
      cashierId: {
        allowNull: true,
        type: DataTypes.INTEGER
      },
      cashierName: {
        type: DataTypes.STRING
      },
      status: {
        type: DataTypes.ENUM(
          'pending',
          'confirmed',
          'preparing',
          'ready',
          'served',
          'paid',
          'cancelled',
          'void'
        ),
        defaultValue: 'pending'
      },
      subTotal: {
        type: DataTypes.BIGINT,
        defaultValue: 0
      },
      discountType: {
        type: DataTypes.ENUM('none', 'percent', 'nominal'),
        defaultValue: 'none'
      },
      discountValue: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      discountAmount: {
        type: DataTypes.BIGINT,
        defaultValue: 0
      },
      taxRate: {
        type: DataTypes.DECIMAL(5, 2),
        defaultValue: 0
      },
      taxAmount: {
        type: DataTypes.BIGINT,
        defaultValue: 0
      },
      serviceChargeRate: {
        type: DataTypes.DECIMAL(5, 2),
        defaultValue: 0
      },
      serviceChargeAmount: {
        type: DataTypes.BIGINT,
        defaultValue: 0
      },
      totalQuantity: {
        defaultValue: 0,
        type: DataTypes.DECIMAL(14, 3),
        // Retail R1: sold-by-weight quantities keep three decimals; read
        // back as a number (Postgres NUMERIC arrives as a string).
        get() {
          const v = this.getDataValue('totalQuantity')
          return v === null || v === undefined ? v : Number(v)
        }
      },
      totalPrice: {
        type: DataTypes.BIGINT,
        defaultValue: 0
      },
      paymentMethod: {
        type: DataTypes.STRING
      },
      paymentMethodName: {
        type: DataTypes.STRING(255),
        allowNull: true
      },
      paymentStatus: {
        type: DataTypes.ENUM(
          'unpaid',
          'partial',
          'partially_paid',
          'partially_refunded',
          'paid',
          'refunded'
        ),
        defaultValue: 'unpaid'
      },
      splitCount: {
        type: DataTypes.INTEGER,
        allowNull: true
      },
      customerNumber: {
        type: DataTypes.INTEGER,
        allowNull: true
      },
      session: {
        type: DataTypes.STRING,
        allowNull: true
      },
      notes: {
        type: DataTypes.TEXT
      },
      source: {
        type: DataTypes.ENUM('pos', 'online', 'qr', 'waiter'),
        defaultValue: 'pos'
      },
      currencyId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'currency', key: 'id' }
      },
      currencyCode: {
        type: DataTypes.STRING(10),
        allowNull: true
      },
      exchangeRate: {
        type: DataTypes.DECIMAL(18, 6),
        allowNull: true,
        defaultValue: 1.0
      },
      createdBy: {
        type: DataTypes.INTEGER
      },
      modifiedBy: {
        type: DataTypes.INTEGER
      },
      totalCovers: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      shiftId: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      promoCampaignId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'promo_campaign', key: 'id' }
      },
      idempotencyKey: {
        type: DataTypes.STRING,
        allowNull: true
      },
      // Opaque per-order credential required by the unauthenticated
      // customer-tracking/receipt endpoints instead of the guessable
      // sequential id — see db/migrations/20260904000003-add-order-public-token.js
      publicToken: {
        type: DataTypes.STRING(64),
        allowNull: true
      },
      // Which register was open (if any) at the moment this order was
      // paid — resolved server-side, never client-supplied. Null for
      // historical orders (pre-F2) and for orders created via the QR
      // self-order path, which is never attributed to a register.
      cashRegisterId: {
        type: DataTypes.INTEGER,
        allowNull: true
      },
      redeemedPoints: {
        type: DataTypes.INTEGER,
        allowNull: true,
        defaultValue: 0
      }
    },
    {
      paranoid: true,
      freezeTableName: true,
      modelName: 'order',
      tableName: 'order'
    }
  )

  order.associate = (models) => {
    order.hasMany(models.order_item, { foreignKey: 'order', as: 'items' })
    order.hasMany(models.order_status, {
      foreignKey: 'order',
      as: 'statusHistory'
    })
    order.belongsTo(models.table, { foreignKey: 'tableId', as: 'table' })
    order.hasMany(models.transaction, {
      foreignKey: 'order',
      as: 'transactions'
    })
    order.belongsTo(models.location, { foreignKey: 'store', as: 'storeData' })
  }

  return order
}
