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

    // DR-06: never a known password — SEED_SUPER_ADMIN_PASSWORD, or a random
    // one per account (set it with a password reset). Never logged.
    const hashSeed = async () => bcrypt.hash(seedPassword('SEED_SUPER_ADMIN_PASSWORD').password, 10)
    const hashedPasswordAngga = await hashSeed()
    const hashedPasswordFebi = await hashSeed()
    const hashedPasswordSurya = await hashSeed()
    const hashedPasswordTegar = await hashSeed()
    const hashedPasswordLuthfi = await hashSeed()
    const hashedPasswordSuperAdmin = await hashSeed()

    const allUsers = [
      { userName: 'angga', fullName: 'angga', password: hashedPasswordAngga, email: 'angga@posapp.com', employeeID: 'EMP-0002' },
      { userName: 'luthfi', fullName: 'luthfi', password: hashedPasswordLuthfi, email: 'luthfi@posapp.com', employeeID: 'EMP-0003' },
      { userName: 'febi', fullName: 'febi', password: hashedPasswordFebi, email: 'febi@posapp.com', employeeID: 'EMP-0004' },
      { userName: 'surya', fullName: 'surya', password: hashedPasswordSurya, email: 'surya@posapp.com', employeeID: 'EMP-0005' },
      { userName: 'tegar', fullName: 'tegar', password: hashedPasswordTegar, email: 'tegar@posapp.com', employeeID: 'EMP-0006' },
      { userName: 'super_admin', fullName: 'Super Admin', password: hashedPasswordSuperAdmin, email: 'superadmin@posapp.com', employeeID: 'EMP-0001' }
    ]

    const [existing] = await queryInterface.sequelize.query(
      `SELECT "userName" FROM "user" WHERE "roleType" = 'super_admin'`
    )
    const existingNames = existing.map((r) => r.userName)

    const toInsert = allUsers
      .filter((u) => !existingNames.includes(u.userName))
      .map((u) => ({
        ...u,
        roleType: 'super_admin',
        roleId: superAdminRoleId,
        userType: 'super_admin',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date()
      }))

    if (toInsert.length > 0) {
      await queryInterface.bulkInsert('user', toInsert)
      console.log(`Created ${toInsert.length} super admin user(s): ${toInsert.map((u) => u.userName).join(', ')}`)
    } else {
      console.log('All super admin users already exist.')
    }
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.bulkDelete('user', { roleType: 'super_admin' }, {})
  }
}
