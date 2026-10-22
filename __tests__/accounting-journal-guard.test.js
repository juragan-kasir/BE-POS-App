process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const db = require('../db/models')
const accountingService = require('../api/service/accountingService')

let location
let cash
let revenue

beforeAll(async () => {
  location = await db.location.create({
    name: 'ACC_GUARD_STORE',
    status: 'active'
  })
  await accountingService.ensureDefaultAccounts(location.id)
  cash = await accountingService.findAccount(location.id, '1000')
  revenue = await accountingService.findAccount(location.id, '4000')
})

afterAll(async () => {
  const entries = await db.journal_entry.findAll({
    where: { store: location.id },
    attributes: ['id']
  })
  const ids = entries.map((entry) => entry.id)
  if (ids.length > 0) {
    await db.journal_entry_line.destroy({
      where: { journalEntry: ids },
      force: true
    })
  }
  await db.journal_entry.destroy({
    where: { store: location.id },
    force: true
  })
  await db.account.destroy({ where: { store: location.id }, force: true })
  await db.sequelize.query(
    'DELETE FROM journal_entry_sequence WHERE store = $1',
    { bind: [location.id] }
  )
  await db.location.destroy({ where: { id: location.id }, force: true })
})

const baseEntry = (referenceId, lines) => ({
  store: location.id,
  date: new Date(),
  description: 'Guard test',
  sourceType: 'manual',
  referenceId,
  lines,
  createdBy: null
})

test('rejects a journal whose debits and credits do not balance', async () => {
  await expect(
    accountingService.createJournalEntry(
      baseEntry(900001, [
        { account: cash.id, debit: 100, credit: 0 },
        { account: revenue.id, debit: 0, credit: 90 }
      ])
    )
  ).rejects.toMatchObject({ code: 'UNBALANCED_JOURNAL_ENTRY' })

  expect(
    await db.journal_entry.count({ where: { store: location.id } })
  ).toBe(0)
})

test('rejects a line with both debit and credit', async () => {
  await expect(
    accountingService.createJournalEntry(
      baseEntry(900002, [
        { account: cash.id, debit: 100, credit: 50 },
        { account: revenue.id, debit: 0, credit: 50 }
      ])
    )
  ).rejects.toMatchObject({ code: 'INVALID_JOURNAL_LINE' })

  expect(
    await db.journal_entry.count({ where: { store: location.id } })
  ).toBe(0)
})

test('still posts a balanced entry', async () => {
  const entry = await accountingService.createJournalEntry(
    baseEntry(900003, [
      { account: cash.id, debit: 100, credit: 0 },
      { account: revenue.id, debit: 0, credit: 100 }
    ])
  )

  expect(entry).toBeTruthy()
  expect(Number(entry.totalDebit)).toBe(100)
  expect(Number(entry.totalCredit)).toBe(100)
})
