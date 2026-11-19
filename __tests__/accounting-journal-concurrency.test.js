process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')
const { Op } = require('sequelize')
const accountingService = require('../api/service/accountingService')
const accountingOutboxService = require('../api/service/accountingOutboxService')

let location
let refSeq

function orderPayload(store, orderId, overrides = {}) {
  return {
    store,
    orderId,
    orderNumber: `RACE-ORD-${orderId}`,
    subTotal: 10000,
    discountAmount: 0,
    taxAmount: 0,
    serviceChargeAmount: 0,
    totalPrice: 10000,
    date: new Date(),
    createdBy: null,
    ...overrides
  }
}

describe('F-02 journal posting — double-post, duplicate entryNumber, outbox integrity', () => {
  beforeAll(async () => {
    location = await db.location.create(await withTestTenant({ name: 'JV_RACE_STORE', status: 'active' }))
    refSeq = 800000
    // Warm up default accounts (fixed impl also seeds the per-store counter here).
    await accountingService.postOrderJournal(orderPayload(location.id, refSeq++))
  })

  afterAll(async () => {
    await db.accounting_outbox.destroy({ where: {}, force: true })
    await db.journal_entry_line.destroy({ where: {}, force: true })
    await db.journal_entry.destroy({ where: {}, force: true })
    await db.account.destroy({ where: { store: location.id }, force: true })
    await db.location.destroy({ where: { id: location.id }, force: true })
  })

  test('two concurrent posts for the SAME order — exactly one journal entry, one balanced set of lines', async () => {
    for (let i = 0; i < 10; i += 1) {
      const orderId = refSeq++
      await Promise.all([
        accountingService.postOrderJournal(orderPayload(location.id, orderId)),
        accountingService.postOrderJournal(orderPayload(location.id, orderId))
      ])

      const entries = await db.journal_entry.findAll({
        where: { store: location.id, sourceType: 'order', referenceId: orderId }
      })
      expect(entries).toHaveLength(1)

      const lines = await db.journal_entry_line.findAll({
        where: { journalEntry: entries[0].id }
      })
      expect(lines.length).toBeGreaterThan(1)
      const sums = lines.reduce(
        (acc, l) => {
          acc.debit += Number(l.debit)
          acc.credit += Number(l.credit)
          return acc
        },
        { debit: 0, credit: 0 }
      )
      expect(Math.abs(sums.debit - sums.credit)).toBeLessThan(0.01)
    }
  }, 120000)

  test('entryNumber stays unique under a counter race (existing entry, two concurrent different refs)', async () => {
    const orderA = refSeq++
    const orderB = refSeq++
    await Promise.all([
      accountingService.postOrderJournal(orderPayload(location.id, orderA)),
      accountingService.postOrderJournal(orderPayload(location.id, orderB))
    ])

    const entries = await db.journal_entry.findAll({
      where: {
        store: location.id,
        sourceType: 'order',
        referenceId: { [Op.in]: [orderA, orderB] }
      },
      order: [['id', 'ASC']]
    })
    // Vulnerable impl: both computed seq = MAX(id)+1 from the same committed
    // max, so both entries got identical entryNumbers.
    expect(entries).toHaveLength(2)
    expect(entries[0].entryNumber).not.toBe(entries[1].entryNumber)
    expect(new Set(entries.map((e) => e.entryNumber)).size).toBe(2)
  }, 60000)

  test('20 concurrent distinct orders — every entryNumber unique, every order journaled exactly once', async () => {
    const ids = []
    for (let i = 0; i < 20; i += 1) ids.push(refSeq++)

    await Promise.all(
      ids.map((orderId) => accountingService.postOrderJournal(orderPayload(location.id, orderId)))
    )

    const rows = await db.journal_entry.findAll({
      where: { store: location.id, sourceType: 'order', referenceId: { [Op.in]: ids } }
    })
    expect(rows).toHaveLength(20)
    const numbers = rows.map((r) => r.entryNumber)
    expect(new Set(numbers).size).toBe(20)
  }, 120000)

  test('outbox duplicate processing produces exactly one journal entry', async () => {
    const orderId = refSeq++
    const payload = orderPayload(location.id, orderId)
    const rowA = await db.accounting_outbox.create({
      jobType: 'order_journal',
      store: location.id,
      referenceType: 'order',
      referenceId: orderId,
      payload
    })
    const rowB = await db.accounting_outbox.create({
      jobType: 'order_journal',
      store: location.id,
      referenceType: 'order',
      referenceId: orderId,
      payload
    })

    const [rA, rB] = await Promise.all([
      accountingOutboxService.attemptJob(rowA),
      accountingOutboxService.attemptJob(rowB)
    ])
    // Keep both rows' status in sync so they don't linger as pending.
    await Promise.all([
      accountingOutboxService.recordImmediateAttempt(rowA, rA),
      accountingOutboxService.recordImmediateAttempt(rowB, rB)
    ])

    const entries = await db.journal_entry.findAll({
      where: { store: location.id, sourceType: 'order', referenceId: orderId }
    })
    expect(entries).toHaveLength(1)
    const lines = await db.journal_entry_line.findAll({
      where: { journalEntry: entries[0].id }
    })
    expect(lines.length).toBeGreaterThan(1)
  }, 60000)

  test('two concurrent drain passes over the same pending rows — each row processed once, one journal per order', async () => {
    const ids = []
    for (let i = 0; i < 4; i += 1) {
      const orderId = refSeq++
      ids.push(orderId)
      await db.accounting_outbox.create({
        jobType: 'order_journal',
        store: location.id,
        referenceType: 'order',
        referenceId: orderId,
        payload: orderPayload(location.id, orderId)
      })
    }

    const [r1, r2] = await Promise.all([
      accountingOutboxService.drainAccountingOutbox({ limit: 50 }),
      accountingOutboxService.drainAccountingOutbox({ limit: 50 })
    ])
    // SKIP LOCKED: only one worker owns each row — exactly 4 rows are
    // processed across the two drains combined. Without the claim, both
    // drains would have grabbed all 4 rows and processed 8 times total.
    expect(r1.processed + r2.processed).toBe(4)

    const entries = await db.journal_entry.findAll({
      where: { store: location.id, sourceType: 'order', referenceId: { [Op.in]: ids } }
    })
    expect(entries).toHaveLength(4)

    const rows = await db.accounting_outbox.findAll({
      where: { referenceId: { [Op.in]: ids }, jobType: 'order_journal' }
    })
    for (const row of rows) {
      expect(row.status).toBe('posted')
    }
  }, 60000)

  test('a failing posting is NEVER marked posted — row retries until failed', async () => {
    const orderId = refSeq++
    const row = await db.accounting_outbox.create({
      jobType: 'order_journal',
      store: location.id,
      referenceType: 'order',
      referenceId: orderId,
      payload: orderPayload(location.id, orderId, { date: 'not-a-date' })
    })

    // Vulnerable impl swallows the DB error and returns null, so attemptJob
    // reports ok:true and the row is wrongly marked posted with NO journal.
    const result = await accountingOutboxService.attemptJob(row)
    expect(result.ok).toBe(false)
    await accountingOutboxService.recordImmediateAttempt(row, result)

    let fresh = await db.accounting_outbox.findByPk(row.id)
    expect(fresh.status).not.toBe('posted')
    expect(fresh.attempts).toBe(1)

    while (fresh.attempts < accountingOutboxService.MAX_ATTEMPTS) {
      const r = await accountingOutboxService.attemptJob(fresh)
      await accountingOutboxService.recordImmediateAttempt(fresh, r)
      if (fresh.attempts < accountingOutboxService.MAX_ATTEMPTS) {
        fresh = await db.accounting_outbox.findByPk(row.id)
      }
    }

    fresh = await db.accounting_outbox.findByPk(row.id)
    expect(fresh.status).toBe('failed')
    expect(fresh.postedAt).toBeNull()

    const entries = await db.journal_entry.findAll({
      where: { store: location.id, sourceType: 'order', referenceId: orderId }
    })
    expect(entries).toHaveLength(0)
  }, 60000)
})