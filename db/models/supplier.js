'use strict'
module.exports = (sequelize, DataTypes) => {
  const supplier = sequelize.define(
    'supplier',
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
      name: {
        allowNull: false,
        type: DataTypes.STRING
      },
      phone: {
        type: DataTypes.STRING
      },
      email: {
        type: DataTypes.STRING
      },
      contactPerson: {
        type: DataTypes.STRING
      },
      address: {
        type: DataTypes.TEXT
      },
      description: {
        type: DataTypes.TEXT
      },
      status: {
        type: DataTypes.STRING(20),
        defaultValue: 'active'
      },
      // Enhanced fields
      paymentType: {
        type: DataTypes.STRING(10),
        defaultValue: 'cbd'
      },
      tempoDays: {
        type: DataTypes.INTEGER,
        defaultValue: 0
      },
      categoryId: {
        type: DataTypes.INTEGER
      },
      mobile: {
        type: DataTypes.STRING
      },
      whatsapp: {
        type: DataTypes.STRING
      },
      fax: {
        type: DataTypes.STRING
      },
      website: {
        type: DataTypes.STRING(2048)
      },
      taxInclude: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
      },
      taxType: {
        type: DataTypes.STRING(20)
      },
      taxNumber: {
        type: DataTypes.STRING
      },
      taxName: {
        type: DataTypes.STRING
      },
      nitku: {
        type: DataTypes.STRING
      },
      taxTransactionType: {
        type: DataTypes.STRING(20)
      },
      defaultDiscount: {
        type: DataTypes.DECIMAL(5, 2),
        defaultValue: 0
      },
      defaultDescription: {
        type: DataTypes.TEXT
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
      modelName: 'supplier',
      tableName: 'supplier'
    }
  )

  supplier.associate = (models) => {
    supplier.hasMany(models.supplier_product, {
      foreignKey: 'supplier',
      as: 'supplierProducts'
    })
    supplier.belongsTo(models.supplier_category, {
      foreignKey: 'categoryId',
      as: 'categoryData'
    })
    supplier.hasMany(models.supplier_contact, {
      foreignKey: 'supplier',
      as: 'contacts'
    })
    supplier.hasMany(models.supplier_bank_account, {
      foreignKey: 'supplier',
      as: 'bankAccounts'
    })
  }

  return supplier
}
