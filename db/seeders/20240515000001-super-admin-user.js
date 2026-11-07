'use strict'

const bcrypt = require('bcrypt')
const { seedPassword } = require('../../utils/seedCredential')

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Check if super admin role exists
    const roles = await queryInterface.sequelize.query(
      `SELECT id FROM role WHERE "roleType" = 'super_admin' LIMIT 1;`,
      { type: Sequelize.QueryTypes.SELECT }
    )

    if (roles.length === 0) {
      console.log('Super Admin role not found. Please run role seeder first.')
      return
    }

    const superAdminRoleId = roles[0].id

    // Product decision (2026-11-07): one platform-wide super admin account.
    // Store-bound super_admin accounts remain a separate tenant-scoped role
    // and are never seeded here.
    const user = {
      userName: 'super_admin',
      fullName: 'Super Admin',
      password: await bcrypt.hash(
        seedPassword('SEED_SUPER_ADMIN_PASSWORD').password,
        10
      ),
      email: 'superadmin@posapp.com',
      employeeID: 'EMP-0001'
    }

    const existing = await queryInterface.sequelize.query(
      `SELECT "userName" FROM "user" WHERE "userName" = :userName LIMIT 1`,
      {
        replacements: { userName: user.userName },
        type: Sequelize.QueryTypes.SELECT
      }
    )

    if (existing.length === 0) {
      await queryInterface.bulkInsert('user', [
        {
          ...user,
          roleType: 'super_admin',
          roleId: superAdminRoleId,
          userType: 'super_admin',
          status: 'active',
          createdAt: new Date(),
          updatedAt: new Date()
        }
      ])
      console.log('Created the platform super admin user: super_admin')
    } else {
      console.log('Platform super admin user already exists.')
    }
  },

  down: async (queryInterface) => {
    await queryInterface.bulkDelete('user', { userName: ['super_admin'] }, {})
  }
}
