'use strict'

const {
  consolidateGlobalSuperAdmins
} = require('../../api/service/globalSuperAdminService')

module.exports = {
  async up(queryInterface) {
    const result = await consolidateGlobalSuperAdmins(queryInterface.sequelize)
    if (result.retired.length > 0) {
      console.log(
        `[one-global-super-admin] kept "${result.kept.userName}", retired: ${result.retired
          .map((row) => row.userName)
          .join(', ')}`
      )
    }
  },

  // Retirement is a deliberate product decision, not a reversible data
  // migration: re-activating old platform-wide accounts would recreate the
  // exact over-privileged state this migration removes.
  async down() {}
}
