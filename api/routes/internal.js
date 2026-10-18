'use strict'
const crypto = require('crypto')
const express = require('express')
const db = require('../../db/models')
const { tryAcquireSchedulerLock } = require('../../utils/schedulerLock')
const { expireStaleQrOrders, qrPendingExpiryMinutes } = require('../service/qrOrderExpiry')
const backupController = require('../controller/backup')
const { ACTOR_TYPES } = require('../../utils/auditLog')
const {
  drainAccountingOutbox,
  getAccountingOutboxHealth
} = require('../service/accountingOutboxService')

const router = express.Router()

// DR-10 / BA TP-04: on Vercel the in-process schedulers never start
// (api/index.js runs them only when !process.env.VERCEL), so a journal whose
// immediate post-commit attempt failed has no retry. These endpoints let an
// external scheduler — Vercel Cron, which calls with GET and
// `Authorization: Bearer $CRON_SECRET` — drain the accounting outbox and
// read its health.
//
// Fail closed: without a configured CRON_SECRET (min. 32 chars) every call
// is refused with 503, so deploying this code changes nothing until the
// secret and the cron schedule are deliberately configured.
const MIN_SECRET_LENGTH = 32
const LEASE_MS = 55000

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest()

const requireCronSecret = (req, res, next) => {
  const secret = process.env.CRON_SECRET
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    return res.status(503).json({
      code: 'CRON_NOT_CONFIGURED',
      message: 'Internal scheduler endpoints are not configured'
    })
  }
  const header = req.get('authorization') || ''
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
  if (!presented || !crypto.timingSafeEqual(digest(presented), digest(secret))) {
    return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Unauthorized' })
  }
  return next()
}

// One drain per lease window, shared with the in-process scheduler's lease
// name, so a cron call and a long-running server never drain concurrently
// (row claims are additionally FOR UPDATE SKIP LOCKED, and journal posting
// is idempotent per source).
router.get('/accounting-outbox/drain', requireCronSecret, async (req, res) => {
  try {
    const gotLease = await tryAcquireSchedulerLock(db, 'accounting-outbox', LEASE_MS)
    if (!gotLease) {
      return res.status(200).json({ skipped: true, reason: 'LEASE_HELD' })
    }
    const result = await drainAccountingOutbox({ limit: 50 })
    const health = await getAccountingOutboxHealth()
    if (result.processed > 0 || health.failed > 0) {
      console.log(
        JSON.stringify({
          level: health.failed > 0 ? 'error' : 'info',
          service: 'pos-api',
          event: 'accounting_outbox_drain',
          ...result,
          pending: health.pending,
          failed: health.failed,
          oldestPendingAgeSeconds: health.oldestPendingAgeSeconds
        })
      )
    }
    return res.status(200).json({ skipped: false, ...result, health })
  } catch (error) {
    console.error('Accounting outbox drain failed:', error)
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Drain failed' })
  }
})

// BA gap 019 (DR-09): sweep unpaid pending QR orders older than
// QR_PENDING_EXPIRY_MINUTES (no-op while unset). Schedule it with the
// same CRON_SECRET as the outbox drain.
router.get('/qr-orders/expire', requireCronSecret, async (req, res) => {
  try {
    const minutes = qrPendingExpiryMinutes()
    if (!minutes) {
      return res.status(200).json({ success: true, enabled: false, expired: 0 })
    }
    const expired = await expireStaleQrOrders({ actorType: ACTOR_TYPES.JOB })
    return res.status(200).json({
      success: true,
      enabled: true,
      expiryMinutes: minutes,
      expired: expired.length,
      orders: expired.map((o) => o.id)
    })
  } catch (error) {
    console.error('QR order expiry sweep failed:', error)
    return res.status(500).json({ success: false, code: 'QR_EXPIRY_FAILED' })
  }
})

router.get('/accounting-outbox/health', requireCronSecret, async (req, res) => {
  try {
    return res.status(200).json(await getAccountingOutboxHealth())
  } catch (error) {
    console.error('Accounting outbox health failed:', error)
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Health check failed' })
  }
})

// DR-24 C-24c (L-08): on Vercel the in-process backup scheduler never starts,
// so Vercel Cron drives the same DB-configured schedule through the shared
// controller — runScheduledBackupIfDue() is a no-op unless the stored cron
// matches now, keeping the stored configuration authoritative and the run
// exactly-once per matching minute. The 'backup' lease is shared with the
// in-process scheduler so an API instance and the cron never run concurrently.
router.get('/backup/run', requireCronSecret, async (req, res) => {
  try {
    const gotLease = await tryAcquireSchedulerLock(db, 'backup', LEASE_MS)
    if (!gotLease) {
      return res.status(200).json({ skipped: true, reason: 'LEASE_HELD' })
    }
    const ran = await backupController.runScheduledBackupIfDue(new Date())
    return res.status(200).json({ skipped: false, ran })
  } catch (error) {
    console.error('Scheduled backup run failed:', error)
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Backup failed' })
  }
})

module.exports = router
