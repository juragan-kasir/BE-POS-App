process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// FINDINGS.md E2E-02: the recurring-expense scheduler must read the category
// inside the same transaction that creates the child expense; Sequelize's
// findOne only takes one options object, so passing `{ transaction }` as a
// second argument silently dropped the transaction.

const db = require('../db/models')
const { generateDueRecurringExpenses } = require('../api/service/expenseScheduler')

const PREFIX = `RECTX_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

let location = null
let category = null
let template = null

beforeAll(async () => {
  location = await db.location.create({ name: `${PREFIX}_STORE`, status: 'active' })
  category = await db.expense_category.create({
    store: location.id,
    name: `${PREFIX}_CATEGORY`,
    accountCode: '6000',
    status: 'active'
  })
  const past = new Date(Date.now() - 60 * 1000)
  template = await db.expense.create({
    store: location.id,
    expenseNumber: `${PREFIX}_TPL`,
    category: category.id,
    description: `${PREFIX} recurring`,
    amount: 15000,
    date: past,
    frequency: 'monthly',
    nextDueDate: past,
    status: 'approved',
    isActive: true
  })
})

afterAll(async () => {
  if (location) {
    const journals = await db.journal_entry.findAll({
      where: { store: location.id },
      attributes: ['id']
    })
    const journalIds = journals.map((j) => j.id)
    if (journalIds.length) {
      await db.journal_entry_line.destroy({
        where: { journalEntry: journalIds },
        force: true
      })
      await db.journal_entry.destroy({ where: { id: journalIds }, force: true })
    }
    await db.expense.destroy({
      where: { store: location.id },
      force: true
    })
    await db.account.destroy({ where: { store: location.id }, force: true })
  }
  if (category) await db.expense_category.destroy({ where: { id: category.id }, force: true })
  if (location) await db.location.destroy({ where: { id: location.id }, force: true })
})

test('scheduler reads the expense category inside the generation transaction', async () => {
  const spy = jest.spyOn(db.expense_category, 'findOne').mockResolvedValue(null)

  try {
    const generated = await generateDueRecurringExpenses()
    expect(generated).toBeGreaterThanOrEqual(1)

    const call = spy.mock.calls.find(
      ([options]) => options?.where?.id === category.id
    )
    expect(call).toBeDefined()
    expect(call[0]).toEqual(
      expect.objectContaining({ transaction: expect.anything() })
    )
  } finally {
    spy.mockRestore()
  }
})
