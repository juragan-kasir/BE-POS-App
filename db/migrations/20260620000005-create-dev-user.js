'use strict'
const bcrypt = require('bcrypt')
const { seedPassword, describeSeedPassword } = require('../../utils/seedCredential')

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const roles = await queryInterface.sequelize.query(
      `SELECT id FROM role WHERE "roleType" = 'super_admin' LIMIT 1;`,
      { type: Sequelize.QueryTypes.SELECT }
    )

    if (roles.length === 0) {
      console.log('Super Admin role not found. Skipping migration.')
      return
    }

    const superAdminRoleId = roles[0].id
    // DR-06: never a known password (SEED_DEV_PASSWORD or random).
    const seed = seedPassword('SEED_DEV_PASSWORD')
    const hashedPassword = await bcrypt.hash(seed.password, 10)

    const users = [
      {
        userName: 'dev',
        fullName: 'Development User',
        password: hashedPassword,
        email: 'dev@posapp.com',
        roleType: 'super_admin',
        roleId: superAdminRoleId,
        userType: 'super_admin',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ]

    for (const user of users) {
      const existing = await queryInterface.sequelize.query(
        `SELECT id FROM "user" WHERE "userName" = :userName LIMIT 1;`,
        { replacements: { userName: user.userName }, type: Sequelize.QueryTypes.SELECT }
      )
      if (!existing.length) {
        await queryInterface.bulkInsert('user', [user])
        console.log(`Dev user "${user.fullName}" created successfully!`)
      } else {
        console.log(`Dev user "${user.fullName}" already exists. Skipping.`)
      }
    }

    console.log('')
    console.log(`Dev user created/verified: dev (${describeSeedPassword(seed)})`)
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.bulkDelete('user', {
      userName: ['dev']
    })
  }
}