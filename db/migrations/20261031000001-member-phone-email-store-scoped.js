'use strict'

// Amends the D-05 member identity contract (20261012000001): phone and email
// become unique per store bucket, the same rule names already follow, instead
// of across every store. Owner decision 2026-10-31: a customer who is a member
// of one business must be able to join another business with the same phone
// or email. Rows with store IS NULL keep one shared bucket.
//
//   UNIQUE(store, "phoneNumber") WHERE store IS NOT NULL
//     AND "deletedAt" IS NULL AND "phoneNumber" NOT LIKE 'GUEST-%'
//   UNIQUE("phoneNumber") WHERE store IS NULL
//     AND "deletedAt" IS NULL AND "phoneNumber" NOT LIKE 'GUEST-%'
//   UNIQUE(store, LOWER(TRIM(email))) WHERE store IS NOT NULL
//     AND "deletedAt" IS NULL AND email IS NOT NULL
//   UNIQUE(LOWER(TRIM(email))) WHERE store IS NULL
//     AND "deletedAt" IS NULL AND email IS NOT NULL
//
// up only relaxes uniqueness, so existing rows always satisfy it. down
// restores the global indexes and aborts, without any DDL, when rows created
// since then share a phone or email across stores.

const OLD_PHONE = 'uq_member_phone_e164'
const OLD_EMAIL = 'uq_member_email_ci'
const STORE_PHONE = 'uq_member_store_phone_e164'
const GLOBAL_PHONE = 'uq_member_global_phone_e164'
const STORE_EMAIL = 'uq_member_store_email_ci'
const GLOBAL_EMAIL = 'uq_member_global_email_ci'

const PHONE_SCOPE = `"deletedAt" IS NULL AND "phoneNumber" NOT LIKE 'GUEST-%'`
const EMAIL_SCOPE = `"deletedAt" IS NULL AND email IS NOT NULL`

const memberTableExists = async (queryInterface, Sequelize, transaction) => {
  const rows = await queryInterface.sequelize.query(
    `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'member')`,
    { type: Sequelize.QueryTypes.SELECT, transaction }
  )
  return rows[0].exists
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      if (!(await memberTableExists(queryInterface, Sequelize, transaction))) return
      const exec = (sql) => queryInterface.sequelize.query(sql, { transaction })

      await exec(`DROP INDEX IF EXISTS "${OLD_PHONE}"`)
      await exec(`DROP INDEX IF EXISTS "${OLD_EMAIL}"`)
      await exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${STORE_PHONE}" ON "member" (store, "phoneNumber") WHERE store IS NOT NULL AND ${PHONE_SCOPE}`
      )
      await exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${GLOBAL_PHONE}" ON "member" ("phoneNumber") WHERE store IS NULL AND ${PHONE_SCOPE}`
      )
      await exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${STORE_EMAIL}" ON "member" (store, (LOWER(TRIM(email)))) WHERE store IS NOT NULL AND ${EMAIL_SCOPE}`
      )
      await exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${GLOBAL_EMAIL}" ON "member" ((LOWER(TRIM(email)))) WHERE store IS NULL AND ${EMAIL_SCOPE}`
      )
    })
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      if (!(await memberTableExists(queryInterface, Sequelize, transaction))) return
      const count = async (sql) => {
        const rows = await queryInterface.sequelize.query(sql, {
          type: Sequelize.QueryTypes.SELECT,
          transaction
        })
        return Number(rows[0].n)
      }
      const phoneDupes = await count(
        `SELECT COUNT(*) AS n FROM (SELECT "phoneNumber" FROM "member" WHERE ${PHONE_SCOPE} GROUP BY "phoneNumber" HAVING COUNT(*) > 1) d`
      )
      const emailDupes = await count(
        `SELECT COUNT(*) AS n FROM (SELECT LOWER(TRIM(email)) FROM "member" WHERE ${EMAIL_SCOPE} GROUP BY LOWER(TRIM(email)) HAVING COUNT(*) > 1) d`
      )
      if (phoneDupes > 0 || emailDupes > 0) {
        const e = new Error(
          `member store-scoped identity down abort: phones shared across stores=${phoneDupes}, emails=${emailDupes}`
        )
        e.code = 'MEMBER_SCOPE_DOWN_ABORT'
        throw e
      }
      const exec = (sql) => queryInterface.sequelize.query(sql, { transaction })
      await exec(`DROP INDEX IF EXISTS "${STORE_PHONE}"`)
      await exec(`DROP INDEX IF EXISTS "${GLOBAL_PHONE}"`)
      await exec(`DROP INDEX IF EXISTS "${STORE_EMAIL}"`)
      await exec(`DROP INDEX IF EXISTS "${GLOBAL_EMAIL}"`)
      await exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${OLD_PHONE}" ON "member" ("phoneNumber") WHERE ${PHONE_SCOPE}`
      )
      await exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${OLD_EMAIL}" ON "member" ((LOWER(TRIM(email)))) WHERE ${EMAIL_SCOPE}`
      )
    })
  }
}
