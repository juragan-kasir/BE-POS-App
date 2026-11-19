'use strict'

// W3-5: account, journal_entry and stock_history carry tenantId with an
// ON DELETE RESTRICT FK (tenants are soft-deleted in production; a hard
// delete must never orphan a ledger). Sales and stock moves create these rows
// as side effects, so a suite that hard-deletes its tenants removes them
// first. Only rows of the given tenants are touched.
const purgeTenantLedger = async (db, tenantIds) => {
  const ids = (Array.isArray(tenantIds) ? tenantIds : [tenantIds]).filter((v) => v != null)
  if (ids.length === 0) return
  const q = (sql) => db.sequelize.query(sql, { replacements: { ids } })
  await q(`DELETE FROM journal_entry_line WHERE "journalEntry" IN (SELECT id FROM journal_entry WHERE "tenantId" IN (:ids))
             OR account IN (SELECT id FROM account WHERE "tenantId" IN (:ids))`)
  await q('DELETE FROM journal_entry WHERE "tenantId" IN (:ids)')
  await q('DELETE FROM account WHERE "tenantId" IN (:ids)')
  await q('DELETE FROM stock_history WHERE "tenantId" IN (:ids)')
}

module.exports = { purgeTenantLedger }
