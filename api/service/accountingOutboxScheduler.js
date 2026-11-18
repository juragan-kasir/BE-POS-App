'use strict'
const db = require('../../db/models')
const { tryAcquireSchedulerLock } = require('../../utils/schedulerLock')
const { drainAccountingOutboxUntilEmpty } = require('./accountingOutboxService')

let timer = null
let running = false

const startAccountingOutboxScheduler = (intervalMs = 30000) => {
  if (timer) return
  timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      // Cross-process lease — same reasoning as the other schedulers: if
      // this API is ever scaled to 2+ instances, only one of them drains
      // the outbox on any given tick.
      const gotLock = await tryAcquireSchedulerLock(
        db,
        'accounting-outbox',
        Math.max(intervalMs * 1.5, 45000)
      )
      if (!gotLock) return
      const result = await drainAccountingOutboxUntilEmpty()
      if (result.processed > 0) {
        console.log(
          `Accounting outbox: processed ${result.processed} (posted ${result.posted}, failed ${result.failed})`
        )
      }
    } catch (err) {
      console.error('Accounting outbox scheduler tick error:', err)
    } finally {
      running = false
    }
  }, intervalMs)
  if (timer.unref) timer.unref()
  console.log(`Accounting outbox scheduler started (every ${intervalMs}ms)`)
}

const stopAccountingOutboxScheduler = () => {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

module.exports = {
  startAccountingOutboxScheduler,
  stopAccountingOutboxScheduler
}
