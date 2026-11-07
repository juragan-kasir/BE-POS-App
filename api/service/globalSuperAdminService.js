'use strict'

// The product decision is one platform-wide super admin account. Historical
// seeds/migrations created several global super_admin rows, so both the
// cleanup migration and fresh installs converge on this rule: keep
// `super_admin` (or the oldest global row when it does not exist), retire the
// rest. Store-bound super_admin accounts are a different, tenant-scoped
// concept and are never touched here.
const DEFAULT_KEEPER = 'super_admin'

async function consolidateGlobalSuperAdmins(
  sequelize,
  { keepUserName = DEFAULT_KEEPER, now = new Date() } = {}
) {
  return sequelize.transaction(async (transaction) => {
    const [rows] = await sequelize.query(
      `SELECT id, "userName"
         FROM "user"
        WHERE "roleType" = 'super_admin'
          AND store IS NULL
          AND "deletedAt" IS NULL
        ORDER BY id ASC`,
      { transaction }
    )

    if (rows.length <= 1) {
      return { kept: rows[0] || null, retired: [] }
    }

    const kept = rows.find((row) => row.userName === keepUserName) || rows[0]
    const retired = rows.filter((row) => Number(row.id) !== Number(kept.id))
    if (retired.length === 0) return { kept, retired: [] }

    await sequelize.query(
      `UPDATE "user"
          SET status = 'inactive',
              "deletedAt" = :now,
              "disabledAt" = COALESCE("disabledAt", :now),
              "updatedAt" = :now
        WHERE id IN (:ids)`,
      {
        replacements: { now, ids: retired.map((row) => row.id) },
        transaction
      }
    )

    return { kept, retired }
  })
}

module.exports = {
  DEFAULT_KEEPER,
  consolidateGlobalSuperAdmins
}
