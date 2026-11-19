// F-08 — regression: concurrent FIRST-EVER accounting postings for a store
// that has no account rows yet. ensureDefaultAccounts uses count-then-create
// (and findOrCreateAccount uses find-then-create) without a transaction, so
// two postings racing the very first provisioning step can both see `count =
// 0` and both attempt to INSERT the same DEFAULT_ACCOUNTS rows. One of them
// then hits the (store, code) unique index (account_store_code_unique from
// db/migrations/20260809000001-create-accounting.js) and fails, even though
// the posting itself was legitimate.
//
// The invariant pinned here: provisioning is idempotent under concurrency —
// every legitimate first-ever posting succeeds immediately, exactly one row
// exists per (store, code), and every posted journal stays balanced.

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')
const { postOrderJournal } = require('../api/service/accountingService')

let store = null

const makePosting = (orderId) =>
  postOrderJournal({
    store: store.id,
    orderId,
    orderNumber: `F08-${orderId}`,
    subTotal: 100000,
    discountAmount: 0,
    taxAmount: 0,
    serviceChargeAmount: 0,
    totalPrice: 100000,
    date: new Date(),
    createdBy: null
  })

beforeAll(async () => {
  store = await db.location.create(await withTestTenant({ name: 'F08_PROVISIONING_STORE', status: 'active' }))
})

afterAll(async () => {
  if (store) {
    await db.journal_entry_line.destroy({ where: {}, force: true })
    await db.journal_entry.destroy({ where: { store: store.id }, force: true })
    await db.sequelize.query('DELETE FROM journal_entry_sequence WHERE store = $1', {
      bind: [store.id]
    })
    await db.account.destroy({ where: { store: store.id }, force: true })
    await db.location.destroy({ where: { id: store.id }, force: true })
  }
})

describe('F-08 — account provisioning race under concurrent first postings', () => {
  test('every concurrent first-ever posting succeeds; exactly one row per (store, code); all journals balanced', async () => {
    // First-time postings — no account rows and no journal rows exist for this
    // store yet, so EVERY posting has to run the provisioning path concurrently.
    const orderIds = [1, 2, 3, 4, 5, 6]
    const outcomes = await Promise.allSettled(orderIds.map(makePosting))

    const rejected = outcomes.filter((o) => o.status === 'rejected')
    expect(rejected).toEqual([])

    const entries = await db.journal_entry.findAll({
      where: { store: store.id },
      order: [['referenceId', 'ASC']]
    })
    expect(entries.length).toBe(orderIds.length)
    for (const entry of entries) {
      expect(Number(entry.totalDebit)).toBe(Number(entry.totalCredit))
    }

    // No duplicate (store, code) rows — even under the provisioning race the
    // unique index + conflict-skip must never produce a double account row.
    const accounts = await db.account.findAll({ where: { store: store.id } })
    expect(accounts.length).toBeGreaterThan(0)
    const codes = new Set(accounts.map((a) => a.code))
    expect(accounts.length).toBe(codes.size)

    const [seqRows] = await db.sequelize.query(
      'SELECT counter FROM journal_entry_sequence WHERE store = $1',
      { bind: [store.id] }
    )
    expect(Number(seqRows[0].counter)).toBeGreaterThanOrEqual(orderIds.length)
  })

  test('a second wave of postings reuses the existing accounts and never duplicates them', async () => {
    const outcomes = await Promise.allSettled([7, 8, 9].map(makePosting))
    expect(outcomes.filter((o) => o.status === 'rejected')).toEqual([])

    const accounts = await db.account.findAll({ where: { store: store.id } })
    expect(accounts.length).toBeGreaterThan(0)
    const codes = new Set(accounts.map((a) => a.code))
    expect(accounts.length).toBe(codes.size)

    const entries = await db.journal_entry.findAll({ where: { store: store.id } })
    expect(entries.length).toBeGreaterThanOrEqual(9)
  })
})