'use strict'
const bcrypt = require('bcrypt')
const { Model } = require('sequelize')

// P0-1: credential and recovery material. Never loaded by default reads and
// never serialized. Code that must verify them (login, password reset) reads
// them explicitly through the `withCredentials` scope.
const CREDENTIAL_ATTRIBUTES = Object.freeze(['password', 'resetToken', 'resetTokenExpires'])

module.exports = (sequelize, DataTypes) => {
  const User = sequelize.define(
    'user',
    {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: DataTypes.INTEGER
      },
      image: {
        type: DataTypes.STRING(2048)
      },
      roleType: {
        type: DataTypes.ENUM('super_admin', 'admin', 'kasir', 'user'),
        defaultValue: 'user'
      },
      roleId: {
        type: DataTypes.INTEGER,
        references: {
          model: 'role',
          key: 'id'
        }
      },
      userType: {
        type: DataTypes.STRING
      },
      fullName: {
        type: DataTypes.STRING
      },
      userName: {
        allowNull: true,
        type: DataTypes.STRING,
        unique: true
      },
      password: {
        allowNull: true,
        type: DataTypes.STRING
      },
      confirmPassword: {
        type: DataTypes.VIRTUAL,
        set(value) {
          if (value !== this.password) {
            throw new Error('Password & Confirmation Password Tidak Sama')
          }
        }
      },
      email: {
        allowNull: true,
        type: DataTypes.STRING,
        unique: true
      },
      address: {
        type: DataTypes.STRING
      },
      gender: {
        type: DataTypes.STRING
      },
      phoneNumber: {
        type: DataTypes.STRING
      },
      employeeID: {
        type: DataTypes.STRING,
        unique: true
      },
      department: {
        type: DataTypes.STRING
      },
      departmentId: {
        type: DataTypes.INTEGER,
        references: { model: 'department', key: 'id' }
      },
      employmentType: {
        type: DataTypes.STRING
      },
      startDate: {
        type: DataTypes.DATEONLY
      },
      status: {
        type: DataTypes.STRING(20),
        defaultValue: 'active'
      },
      // P1-3: authoritative account-disablement state, separate from the
      // presence/session `status` above. NULL = enabled; non-NULL (timestamp
      // of disablement) = disabled and barred from authentication. Legacy
      // logout writes `status = inactive` without touching this field.
      disabledAt: {
        type: DataTypes.DATE,
        allowNull: true,
        defaultValue: null
      },
      dateOfBirth: {
        type: DataTypes.DATEONLY
      },
      placeOfBirth: {
        type: DataTypes.STRING
      },
      store: {
        type: DataTypes.INTEGER
      },
      shift: {
        type: DataTypes.INTEGER
      },
      position: {
        type: DataTypes.INTEGER
      },
      contractDuration: {
        type: DataTypes.STRING
      },
      endDate: {
        type: DataTypes.DATEONLY
      },
      accessMenu: {
        type: DataTypes.JSONB,
        defaultValue: []
      },
      monthlySalary: {
        type: DataTypes.DECIMAL(15, 2)
      },
      dailySalary: {
        type: DataTypes.DECIMAL(15, 2)
      },
      overtimeRate: {
        type: DataTypes.DECIMAL(15, 2),
        defaultValue: 0
      },
      overtimeFactor: {
        type: DataTypes.DECIMAL(10, 2),
        defaultValue: 1.5
      },
      documents: {
        type: DataTypes.TEXT
      },
      resetToken: {
        allowNull: true,
        type: DataTypes.STRING
      },
      resetTokenExpires: {
        allowNull: true,
        type: DataTypes.DATE
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
      tableName: 'user',
      // Applied to finders and to `include`s of this model; an explicit
      // `attributes: { exclude: [...] }` merges with it, an explicit
      // whitelist replaces it.
      defaultScope: {
        attributes: { exclude: [...CREDENTIAL_ATTRIBUTES] }
      },
      scopes: {
        withCredentials: {}
      },
      hooks: {
        beforeSave: async (user) => {
          if (user.changed('password') && user.password) {
            user.password = await bcrypt.hash(user.password, 10)
          }
        }
      }
    }
  )

  // Instances from create(), update({ returning: true }) or the
  // `withCredentials` scope still hold credentials in memory; strip them at
  // the serialization boundary so returning such an instance cannot leak.
  User.prototype.toJSON = function toJSON() {
    const values = Model.prototype.toJSON.call(this)
    for (const attribute of [...CREDENTIAL_ATTRIBUTES, 'confirmPassword']) {
      delete values[attribute]
    }
    return values
  }

  User.associate = (models) => {
    User.belongsTo(models.role, { foreignKey: 'roleId', as: 'role' })
    User.belongsTo(models.location, { foreignKey: 'store', as: 'storeData' })
    User.belongsTo(models.position, {
      foreignKey: 'position',
      as: 'positionData'
    })
    User.belongsTo(models.department, {
      foreignKey: 'departmentId',
      as: 'departmentData'
    })
    // AUTH-1 (DR-01/DR-03): account → tenant memberships → store assignments.
    if (models.tenantMembership) {
      User.hasMany(models.tenantMembership, {
        foreignKey: 'userId',
        as: 'tenantMemberships'
      })
    }
    if (models.storeAssignment) {
      User.hasMany(models.storeAssignment, {
        foreignKey: 'userId',
        as: 'storeAssignments'
      })
    }
  }

  return User
}
