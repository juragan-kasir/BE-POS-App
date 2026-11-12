'use strict'

const db = require('../../db/models')

// F-11: one drawer per store, so a sale rung up or a refund approved by
// someone who did not open the register still lands in it. The drawer
// owner is shown who else moved money through their drawer, per person.
async function otherStaffActivity({ registerId, ownerId, transaction }) {
  const rows = await db.sequelize.query(
    `SELECT t."createdBy" AS "userId",
            u."fullName" AS "fullName",
            COUNT(*) FILTER (WHERE t."salesReturnId" IS NULL AND t."amount" > 0)::int AS "salesCount",
            COALESCE(SUM(t."amount") FILTER (WHERE t."salesReturnId" IS NULL AND t."amount" > 0), 0) AS "salesAmount",
            COUNT(*) FILTER (WHERE t."salesReturnId" IS NOT NULL)::int AS "refundCount",
            COALESCE(-SUM(t."amount") FILTER (WHERE t."salesReturnId" IS NOT NULL), 0) AS "refundAmount"
       FROM "transaction" t
       LEFT JOIN "order" o ON o.id = t."order"
       LEFT JOIN "user" u ON u.id = t."createdBy"
      WHERE COALESCE(t."cashRegisterId", o."cashRegisterId") = :registerId
        AND t."deletedAt" IS NULL
        AND t."createdBy" IS NOT NULL
        AND t."createdBy" IS DISTINCT FROM :ownerId
      GROUP BY t."createdBy", u."fullName"
      ORDER BY t."createdBy" ASC`,
    {
      replacements: { registerId, ownerId: ownerId ?? null },
      type: db.sequelize.QueryTypes.SELECT,
      ...(transaction ? { transaction } : {})
    }
  )
  return rows.map((row) => ({
    userId: Number(row.userId),
    fullName: row.fullName || null,
    salesCount: Number(row.salesCount || 0),
    salesAmount: Number(row.salesAmount || 0),
    refundCount: Number(row.refundCount || 0),
    refundAmount: Number(row.refundAmount || 0)
  }))
}

module.exports = { otherStaffActivity }
