'use strict'
const db = require('../../db/models')
const accountingService = require('./accountingService')

// Durable retry queue for accounting journal posting.
//
// Every place that posts a journal entry as a side effect of a business
// event (order creation, sales return approval, purchase payment, expense
// approval, goods receipt, ...) used to call the posting function directly
// after its own transaction committed, wrapped in try/catch(console.error) —
// a transient failure there (a DB blip, pool exhaustion) meant the business
// event stayed committed (order paid, stock deducted, cash ledger row
// written) while the accounting entry silently never existed, discoverable
// only by manual reconciliation.
//
// The fix: the caller now also inserts a row here INSIDE its own
// transaction (enqueueAccountingJob) before that transaction commits — a
// plain INSERT can't fail independently the way an accounting call can, so
// this row's existence is exactly as durable as the business event it's
// attached to. The caller still attempts the actual posting immediately
// after commit for the common case (entries usually appear right away);
// on success it calls markPosted so the row never lingers for the
// scheduler to redundantly reprocess. On failure it's left `pending` and
// accountingOutboxScheduler.js retries it later with bounded attempts,
// escalating to Sentry once exhausted instead of discarding the failure.

const MAX_ATTEMPTS = 5

// Maps a jobType to the accountingService function it dispatches to.
// `payload` keys must exactly match that function's destructured params
// (everything except `transaction` — a drained job posts in its own fresh
// transaction, same as the original post-commit call never had one either).
const JOB_HANDLERS = {
  order_journal: accountingService.postOrderJournal,
  order_cogs_journal: accountingService.postOrderCogsJournal,
  reverse_order_journals: accountingService.reverseOrderJournals,
  sales_return_journal: accountingService.postSalesReturnJournal,
  purchase_journal: accountingService.postPurchaseJournal,
  purchase_payment_journal: accountingService.postPurchasePaymentJournal,
  purchase_return_journal: accountingService.postPurchaseReturnJournal,
  expense_journal: accountingService.postExpenseJournal,
  expense_journal_sync: accountingService.syncExpenseJournalFromState,
  overtime_payroll_journal: accountingService.postOvertimePayrollJournal
}

function assertKnownJobType(jobType) {
  if (!JOB_HANDLERS[jobType]) {
    throw new Error(`Unknown accounting outbox jobType: ${jobType}`)
  }
}

async function enqueueAccountingJob({
  jobType,
  store,
  referenceType,
  referenceId,
  payload,
  transaction
}) {
  assertKnownJobType(jobType)
  return db.accounting_outbox.create(
    {
      jobType,
      store: store || null,
      referenceType: referenceType || null,
      referenceId: referenceId || null,
      payload: payload || {}
    },
    { transaction }
  )
}

// Runs the actual posting function for one row. Never throws — the caller
// (either the immediate post-commit attempt or the scheduler) decides what
// to do with a failure; this just reports it.
async function attemptJob(row) {
  const handler = JOB_HANDLERS[row.jobType]
  if (!handler) {
    return { ok: false, error: `Unknown jobType: ${row.jobType}` }
  }
  try {
    // JSONB round-trips Date as an ISO string; the posting functions all
    // pass `date` straight to `new Date(...)`/moment-style formatting, so
    // rehydrate it before dispatching.
    const payload = { ...row.payload }
    if (payload.date) payload.date = new Date(payload.date)
    await handler(payload)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }
}

async function markPosted(outboxRow, transaction) {
  await outboxRow.update(
    {
      status: 'posted',
      postedAt: new Date(),
      lastError: null
    },
    { transaction }
  )
}

async function markAttemptFailed(outboxRow, error, transaction) {
  const attempts = outboxRow.attempts + 1
  const exhausted = attempts >= MAX_ATTEMPTS
  await outboxRow.update(
    {
      attempts,
      lastError: String(error).slice(0, 2000),
      status: exhausted ? 'failed' : 'pending'
    },
    { transaction }
  )
  if (exhausted) {
    try {
      const Sentry = require('../instrument')
      Sentry.captureMessage(
        `Accounting outbox job permanently failed after ${attempts} attempts: ${outboxRow.jobType} (${outboxRow.referenceType || 'unknown'}#${outboxRow.referenceId || '?'})`,
        'error'
      )
    } catch {
      // Sentry is a no-op without SENTRY_DSN — never let alerting itself
      // be the thing that throws inside a background drain loop.
    }
    console.error(
      `ACCOUNTING OUTBOX PERMANENTLY FAILED: job ${outboxRow.id} (${outboxRow.jobType}, ${outboxRow.referenceType || 'unknown'}#${outboxRow.referenceId || '?'}) — ${error}`
    )
  }
}

// Called right after a caller's own immediate post-commit attempt, whether
// it succeeded or failed — keeps the outbox row's state in sync with what
// actually happened instead of leaving it `pending` when posting already
// succeeded synchronously.
async function recordImmediateAttempt(outboxRow, result) {
  if (result.ok) {
    await markPosted(outboxRow)
  } else {
    await markAttemptFailed(outboxRow, result.error)
  }
}

// Drains up to `limit` retryable rows, oldest first. The claim uses
// FOR UPDATE SKIP LOCKED inside one transaction, so two concurrent drains
// (an immediate post-commit attempt racing a scheduler tick, or two
// scheduler instances) never pick up the same row: whichever worker locks it
// first processes it, the other worker skips it. Duplicate processing is
// additionally made harmless by the journal DB constraint + idempotent replay
// in createJournalEntry. Meant to be called from a scheduler tick
// (accountingOutboxScheduler.js) or a manual ops script.
async function drainAccountingOutbox({ limit = 50 } = {}) {
  let processed = 0
  let posted = 0
  let failed = 0

  await db.sequelize.transaction(async (claimTx) => {
    const [claimed] = await db.sequelize.query(
      `SELECT id FROM accounting_outbox
       WHERE status = 'pending' AND attempts < :maxAttempts
       ORDER BY "createdAt" ASC
       LIMIT :limit
       FOR UPDATE SKIP LOCKED`,
      {
        replacements: { maxAttempts: MAX_ATTEMPTS, limit },
        transaction: claimTx
      }
    )

    for (const { id } of claimed) {
      const row = await db.accounting_outbox.findByPk(id, {
        transaction: claimTx
      })
      if (!row) continue
      processed += 1
      const result = await attemptJob(row)
      if (result.ok) {
        posted += 1
        await markPosted(row, claimTx)
      } else {
        failed += 1
        await markAttemptFailed(row, result.error, claimTx)
      }
    }
  })

  return { processed, posted, failed }
}

// DR-10 (journals: "failures observable and recoverable"): an operational
// snapshot of the outbox — counts and ages only, never payloads or error
// text (which can carry business data). `oldestPendingAgeSeconds` is the
// journal-lag signal; `failed` rows have exhausted their retries and need
// an operator (they are also reported to Sentry when they exhaust).
async function getAccountingOutboxHealth({ failedSampleLimit = 20 } = {}) {
  const [[counts]] = await db.sequelize.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
       COUNT(*) FILTER (WHERE status = 'pending' AND attempts > 0)::int AS "retrying",
       COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
       EXTRACT(EPOCH FROM (NOW() - MIN("createdAt") FILTER (WHERE status = 'pending')))::bigint
         AS "oldestPendingAgeSeconds"
     FROM accounting_outbox`
  )
  const failedJobs = await db.accounting_outbox.findAll({
    where: { status: 'failed' },
    attributes: ['id', 'jobType', 'referenceType', 'referenceId', 'attempts', 'updatedAt'],
    order: [['updatedAt', 'DESC']],
    limit: failedSampleLimit
  })
  return {
    pending: Number(counts.pending) || 0,
    retrying: Number(counts.retrying) || 0,
    failed: Number(counts.failed) || 0,
    oldestPendingAgeSeconds:
      counts.oldestPendingAgeSeconds === null ? null : Number(counts.oldestPendingAgeSeconds),
    maxAttempts: MAX_ATTEMPTS,
    failedJobs: failedJobs.map((row) => row.get({ plain: true }))
  }
}

module.exports = {
  MAX_ATTEMPTS,
  getAccountingOutboxHealth,
  JOB_HANDLERS,
  enqueueAccountingJob,
  attemptJob,
  markPosted,
  markAttemptFailed,
  recordImmediateAttempt,
  drainAccountingOutbox
}
