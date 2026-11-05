'use strict'
module.exports = (sequelize, DataTypes) => {
  const Department = sequelize.define(
    'department',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      name: {
        allowNull: false,
        type: DataTypes.STRING
      },
      description: {
        type: DataTypes.STRING
      },
      // Owning outlet (batch B12). NULL = shared default, readable by every
      // outlet and changeable only by a global super admin.
      store: {
        type: DataTypes.INTEGER,
        allowNull: true
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
      modelName: 'department',
      tableName: 'department'
    }
  )

  Department.associate = (models) => {
    Department.hasMany(models.position, {
      foreignKey: 'departmentId',
      as: 'positions'
    })
  }

  return Department
}
