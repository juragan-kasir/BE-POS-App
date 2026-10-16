'use strict'

const bcrypt = require('bcrypt')
const { seedPassword } = require('../../utils/seedCredential')

module.exports = {
  async up(queryInterface, Sequelize) {
    // Get role IDs
    const roles = await queryInterface.sequelize.query(
      `SELECT id, "roleType" FROM role WHERE "roleType" IN ('admin', 'user');`,
      { type: Sequelize.QueryTypes.SELECT }
    )

    const adminRoleId = roles.find((r) => r.roleType === 'admin')?.id
    const userRoleId = roles.find((r) => r.roleType === 'user')?.id

    if (!adminRoleId || !userRoleId) {
      console.log('Required roles not found')
      return
    }

    // Check if users already exist
    const existingUsers = await queryInterface.sequelize.query(
      `SELECT "userName" FROM "user" WHERE "userName" IN ('admin', 'kasir_utama', 'staff_gudang');`,
      { type: Sequelize.QueryTypes.SELECT }
    )

    const existingUsernames = existingUsers.map((u) => u.userName)

    const users = []

    // Admin user (full access to store operations)
    if (!existingUsernames.includes('admin')) {
      // DR-06: never a known password (SEED_ADMIN_PASSWORD or random).
      const hashedPassword = await bcrypt.hash(seedPassword('SEED_ADMIN_PASSWORD').password, 10)
      users.push({
        userName: 'admin',
        fullName: 'Admin',
        password: hashedPassword,
        email: 'admin@posapp.com',
        roleType: 'admin',
        roleId: adminRoleId,
        userType: 'admin',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date()
      })
    }

    // Kasir Utama (kasir role - can access cashier, products, members)
    if (!existingUsernames.includes('kasir_utama')) {
      // DR-06: never a known password (SEED_KASIR_PASSWORD or random).
      const hashedPassword = await bcrypt.hash(seedPassword('SEED_KASIR_PASSWORD').password, 10)
      users.push({
        userName: 'kasir_utama',
        fullName: 'Kasir Utama',
        password: hashedPassword,
        email: 'kasir@posapp.com',
        roleType: 'user',
        roleId: userRoleId,
        userType: 'user',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date()
      })
    }

    // Staff Gudang (limited user role - inventory & reports only)
    if (!existingUsernames.includes('staff_gudang')) {
      // DR-06: never a known password (SEED_STAFF_PASSWORD or random).
      const hashedPassword = await bcrypt.hash(seedPassword('SEED_STAFF_PASSWORD').password, 10)
      users.push({
        userName: 'staff_gudang',
        fullName: 'Staff Gudang',
        password: hashedPassword,
        email: 'staff@posapp.com',
        roleType: 'user',
        roleId: userRoleId,
        userType: 'user',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date()
      })
    }

    if (users.length > 0) {
      await queryInterface.bulkInsert('user', users)
      console.log(`Created ${users.length} user accounts`)
      users.forEach((u) => {
        // Passwords are never logged (DR-06).
        console.log(`Username: ${u.userName}`)
      })
    } else {
      await queryInterface.sequelize.query(
        `UPDATE "user" SET "fullName" = CASE "userName"
          WHEN 'admin' THEN 'Admin'
          WHEN 'kasir_utama' THEN 'Kasir Utama'
          WHEN 'staff_gudang' THEN 'Staff Gudang'
        END
        WHERE "userName" IN ('admin', 'kasir_utama', 'staff_gudang')
        AND ("fullName" IS NULL OR "fullName" = '');`
      )
      console.log('All user accounts already exist. Full names updated.')
    }
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.bulkDelete(
      'user',
      {
        userName: {
          [Sequelize.Op.in]: ['admin', 'kasir_utama', 'staff_gudang']
        }
      },
      {}
    )
  }
}
