'use strict'
module.exports = (sequelize, DataTypes) => {
  const expense = sequelize.define(
    'expense',
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
      expenseNumber: {
        allowNull: false,
        type: DataTypes.STRING
      },
      category: {
        type: DataTypes.INTEGER
      },
      description: {
        type: DataTypes.TEXT
      },
      amount: {
        type: DataTypes.INTEGER
      },
      date: {
        allowNull: false,
        type: DataTypes.DATE
      },
      paymentMethod: {
        type: DataTypes.ENUM('cash', 'bank', 'e-wallet'),
        defaultValue: 'cash'
      },
      frequency: {
        type: DataTypes.STRING(20)
      },
      parentId: {
        type: DataTypes.INTEGER
      },
      nextDueDate: {
        type: DataTypes.DATE
      },
      recurringEndDate: {
        type: DataTypes.DATE
      },
      status: {
        type: DataTypes.ENUM('pending', 'approved', 'rejected', 'draft'),
        defaultValue: 'pending'
      },
      isActive: {
        type: DataTypes.BOOLEAN,
        defaultValue: true
      },
      isPaid: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
      },
      paidAt: {
        type: DataTypes.DATE
      },
      notes: {
        type: DataTypes.TEXT
      },
      payee: {
        type: DataTypes.STRING
      },
      employeeId: {
        type: DataTypes.INTEGER
      },
      receipt: {
        type: DataTypes.STRING(2048)
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
      modelName: 'expense',
      tableName: 'expense'
    }
  )

  expense.associate = (models) => {
    expense.belongsTo(models.expense_category, {
      foreignKey: 'category',
      as: 'categoryData'
    })
    expense.belongsTo(models.user, {
      foreignKey: 'createdBy',
      as: 'creator'
    })
    expense.belongsTo(models.user, {
      foreignKey: 'employeeId',
      as: 'employee'
    })
    expense.belongsTo(models.expense, {
      foreignKey: 'parentId',
      as: 'parentExpense'
    })
    expense.hasMany(models.expense_payment, {
      foreignKey: 'expenseId',
      as: 'payments'
    })
  }

  return expense
}
