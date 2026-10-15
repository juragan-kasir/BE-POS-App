# Runbook — accounting outbox drain on Vercel (DR-10, BA TP-04)

Status: **code shipped inert; activation requires an authorized infrastructure
change** (environment secret + cron schedule). Nothing in this runbook has
been executed.

## Why

Every journal-producing write (sale, settlement, void, sales return, expense,
goods receipt, purchase payment/return) enqueues an `accounting_outbox` row in
its own transaction and attempts the posting immediately after commit. When
that attempt fails, the row stays `pending` for a retry. The in-process retry
scheduler (`accountingOutboxScheduler`) starts only when `!process.env.VERCEL`
(`api/index.js`), so on Vercel a failed posting is never retried and nothing
reports it. DR-10 requires journals to be reliable, with failures observable
and recoverable.

## What the code provides

| Endpoint | Purpose |
|---|---|
| `GET /internal/accounting-outbox/drain` | Claims up to 50 retryable rows (oldest first, `FOR UPDATE SKIP LOCKED`), posts them, records bounded attempts (`MAX_ATTEMPTS` = 5, then `failed` + Sentry). One drain per 55 s lease, shared with the in-process scheduler. |
| `GET /internal/accounting-outbox/health` | `pending`, `retrying`, `failed`, `oldestPendingAgeSeconds` (journal lag), and up to 20 failed jobs (id, jobType, reference, attempts) — never payloads or error text. |

Both require `Authorization: Bearer $CRON_SECRET`. Without `CRON_SECRET`
(minimum 32 characters) they answer `503 CRON_NOT_CONFIGURED`; a wrong token
answers `401`. Journal posting stays idempotent per source document, so
overlapping drains cannot double-post.

## Activation (needs authorization)

1. Generate a secret of at least 32 random characters and set it as
   `CRON_SECRET` in the Vercel project's **Production** environment.
2. Add a cron entry to `vercel.json` (Vercel calls cron paths with `GET` and
   sends `Authorization: Bearer $CRON_SECRET` automatically):

   ```json
   "crons": [{ "path": "/internal/accounting-outbox/drain", "schedule": "*/5 * * * *" }]
   ```

   The achievable frequency depends on the Vercel plan (Hobby allows daily
   jobs only). The interval must satisfy the **journal/outbox lag bound**, an
   open DR-10 launch input.
3. Deploy, then verify with the health endpoint (same bearer token):
   `pending` should drain to 0 and `oldestPendingAgeSeconds` stay below the
   lag bound.
4. Alerting: page on `failed > 0` (Sentry already receives exhausted jobs) and
   on `oldestPendingAgeSeconds` above the lag bound.

Rollback: remove the cron entry or unset `CRON_SECRET` (the endpoints return
to `503`). No data migration is involved.

## Operating failed jobs

A `failed` row exhausted its retries. Fix the cause (e.g. a missing account
configuration), then reset it for the drain:

```sql
UPDATE accounting_outbox SET status = 'pending', attempts = 0 WHERE id = :id;
```

Run this only with production-change authorization; it is an operational
write.
