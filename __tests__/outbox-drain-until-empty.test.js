'use strict'

process.env.NODE_ENV = 'test'

// S-01 (BE audit 2026-11-18): a drain call keeps claiming batches until the
// retry backlog is empty or the time budget runs out, and never attempts the
// same row twice in one run (a transient outage must not burn MAX_ATTEMPTS
// retries within seconds).
const db = require('../db/models')
const {
  MAX_ATTEMPTS,
  drainAccountingOutboxUntilEmpty
} = require('../api/service/accountingOutboxService')

const created = []

// An order_journal without a store fails in its handler — a deterministic
// "posting failed, retry later" row.
const makeFailingJobs = async (n, tag) => {
  const rows = await db.accounting_outbox.bulkCreate(
    Array.from({ length: n }, (_, i) => ({
      jobType: 'order_journal',
      payload: {
        store: null,
        orderId: 990000 + i,
        orderNumber: `OUTBOX-DRAIN-${tag}-${i}`,
        subTotal: 100,
        discountAmount: 0,
        taxAmount: 0,
        serviceChargeAmount: 0,
        totalPrice: 100,
        date: new Date().toISOString(),
        createdBy: null
      }
    }))
  )
  // Rows must predate the run's start instant to be claimable.
  await db.sequelize.query(
    `UPDATE accounting_outbox SET "updatedAt" = NOW() - INTERVAL '1 minute' WHERE id IN (:ids)`,
    { replacements: { ids: rows.map((r) => r.id) } }
  )
  created.push(...rows.map((r) => r.id))
  return rows.map((r) => r.id)
}

afterAll(async () => {
  if (created.length) await db.accounting_outbox.destroy({ where: { id: created }, force: true })
  await db.sequelize.close()
})

test('drains past a single batch and attempts each row exactly once per run', async () => {
  const ids = await makeFailingJobs(130, 'A')

  const result = await drainAccountingOutboxUntilEmpty({ batchSize: 50, timeBudgetMs: 60000 })

  expect(result.batches).toBeGreaterThanOrEqual(3)
  expect(result.exhausted).toBe(true)
  const rows = await db.accounting_outbox.findAll({ where: { id: ids } })
  expect(rows).toHaveLength(130)
  for (const row of rows) {
    expect(row.attempts).toBe(1)
    expect(row.status).toBe('pending')
  }

  // The next run retries them once more — still far from MAX_ATTEMPTS.
  await db.sequelize.query(
    `UPDATE accounting_outbox SET "updatedAt" = NOW() - INTERVAL '1 minute' WHERE id IN (:ids)`,
    { replacements: { ids } }
  )
  await drainAccountingOutboxUntilEmpty({ batchSize: 50, timeBudgetMs: 60000 })
  const again = await db.accounting_outbox.findAll({ where: { id: ids } })
  for (const row of again) expect(row.attempts).toBe(2)
  expect(MAX_ATTEMPTS).toBeGreaterThan(2)
})

test('stops at the time budget and reports that the backlog is not exhausted', async () => {
  await makeFailingJobs(60, 'B')
  let clock = 0
  const now = () => {
    clock += 1000
    return clock
  }

  const result = await drainAccountingOutboxUntilEmpty({ batchSize: 10, timeBudgetMs: 1500, now })

  expect(result.batches).toBe(2)
  expect(result.processed).toBe(20)
  expect(result.exhausted).toBe(false)
})
