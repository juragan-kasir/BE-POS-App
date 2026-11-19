process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 22 Batch 9 — two independent, pre-existing Expense correctness bugs
// discovered (but deliberately not fixed) during Batch 8:
//
// F22-B9-01: updateExpenseSchema (createExpenseSchema.partial()) inherits
// createExpenseSchema's `.default('pending')` on `status` — Zod's
// .partial() does not strip a field's default, so PUT /expense/edit/:id
// with no `status` in the body gets `status: 'pending'` INJECTED by
// validation. The controller's `status: status || expense.status` then
// sees a truthy 'pending' and overwrites whatever the expense's real
// status was — silently demoting an approved expense back to pending on
// any update that doesn't re-specify status. Because Batch 8 made journal
// reconciliation a pure function of the LIVE expense.status, this directly
// causes an accounting regression too: the very next expense_journal_sync
// reconciliation (the one this same update enqueues) sees status=pending
// and removes the journal.
//
// F22-B9-02: generateSalary()'s `amount: emp.monthlySalary` passes a
// DECIMAL(15,2) value — which Sequelize/pg always round-trips as a numeric
// STRING with 2 decimal places (e.g. "5000000.00") — straight into
// expense.amount (INTEGER), which Postgres rejects.

let location = null
let category = null
let adminUser = null
let adminToken = null

const createExpense = async (overrides = {}) => {
  const res = await request(app)
    .post('/expense/add')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      categoryId: category.id,
      amount: 50000,
      paymentMethod: 'cash',
      status: 'pending',
      description: 'Correctness test expense',
      ...overrides
    })
  return res
}

const approveExpense = (id) =>
  request(app)
    .put(`/expense/approve/${id}`)
    .set('Authorization', `Bearer ${adminToken}`)

const journalFor = (store, expenseId) =>
  db.journal_entry.findAll({ where: { store, sourceType: 'expense', referenceId: expenseId } })

beforeAll(async () => {
  location = await db.location.create(await withTestTenant({ name: 'EXP_CORRECTNESS_STORE', status: 'active' }))
  category = await db.expense_category.create({
    store: location.id,
    name: 'EXP_CORRECTNESS_CATEGORY',
    accountCode: '6000',
    status: 'active'
  })
  adminUser = await db.user.create({
    userName: 'admin_exp_correctness',
    email: 'admin_exp_correctness@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: location.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: location.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.accounting_outbox.destroy({ where: { store: location.id }, force: true })
  await db.journal_entry_line.destroy({ where: {}, force: true })
  await db.journal_entry.destroy({ where: { store: location.id }, force: true })
  await db.expense.destroy({ where: { store: location.id }, force: true })
  await db.expense_category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { id: adminUser?.id }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

describe('F22-B9-01 — Expense update preserves status when omitted', () => {
  test('Case A: an approved expense stays approved after an update that omits status', async () => {
    const createRes = await createExpense({ amount: 10000 })
    const expenseId = createRes.body.data.id
    await approveExpense(expenseId)

    const updateRes = await request(app)
      .put(`/expense/edit/${expenseId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ amount: 15000 })
    expect(updateRes.status).toBe(200)

    const fresh = await db.expense.findByPk(expenseId)
    expect(fresh.status).toBe('approved')
  })

  test('Case B: a pending expense stays pending after an update that omits status', async () => {
    const createRes = await createExpense({ amount: 8000 })
    const expenseId = createRes.body.data.id

    const updateRes = await request(app)
      .put(`/expense/edit/${expenseId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ amount: 9000 })
    expect(updateRes.status).toBe(200)

    const fresh = await db.expense.findByPk(expenseId)
    expect(fresh.status).toBe('pending')
  })

  test('Case C: an explicit status in the update body is still honored', async () => {
    const createRes = await createExpense({ amount: 12000 })
    const expenseId = createRes.body.data.id

    const updateRes = await request(app)
      .put(`/expense/edit/${expenseId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ amount: 12000, status: 'rejected' })
    expect(updateRes.status).toBe(200)

    const fresh = await db.expense.findByPk(expenseId)
    expect(fresh.status).toBe('rejected')
  })

  test('Case D: updating an approved expense without status does not remove its accounting journal', async () => {
    const createRes = await createExpense({ amount: 20000 })
    const expenseId = createRes.body.data.id
    await approveExpense(expenseId)
    expect((await journalFor(location.id, expenseId)).length).toBe(1)

    const updateRes = await request(app)
      .put(`/expense/edit/${expenseId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ amount: 30000 })
    expect(updateRes.status).toBe(200)

    const fresh = await db.expense.findByPk(expenseId)
    expect(fresh.status).toBe('approved')

    const journals = await journalFor(location.id, expenseId)
    expect(journals.length).toBe(1)
    expect(Number(journals[0].totalDebit)).toBe(30000)
  })
})

describe('F22-B9-02 — generateSalary normalizes the DECIMAL monthlySalary amount', () => {
  const makeEmployee = async (monthlySalary, tag) => {
    const emp = await db.user.create({
      userName: `salary_correctness_${tag}`,
      email: `salary_correctness_${tag}@test.com`,
      roleType: 'user',
      userType: 'user',
      store: location.id,
      status: 'active',
      monthlySalary
    })
    // Confirm the ORM round-trip actually reproduces the DECIMAL-as-string
    // condition this bug depends on, rather than assuming it.
    const fresh = await db.user.findByPk(emp.id, { attributes: ['id', 'monthlySalary'] })
    expect(typeof fresh.monthlySalary).toBe('string')
    return emp
  }

  const cleanupEmployee = async (empId) => {
    const salaryExpense = await db.expense.findOne({ where: { employeeId: empId } })
    if (salaryExpense) {
      const journalIds = (
        await db.journal_entry.findAll({
          where: { store: location.id, sourceType: 'expense', referenceId: salaryExpense.id },
          attributes: ['id'],
          paranoid: false
        })
      ).map((j) => j.id)
      if (journalIds.length > 0) {
        await db.journal_entry_line.destroy({ where: { journalEntry: journalIds }, force: true })
        await db.journal_entry.destroy({ where: { id: journalIds }, force: true })
      }
      await db.accounting_outbox.destroy({ where: { referenceType: 'expense', referenceId: salaryExpense.id }, force: true })
      await db.expense.destroy({ where: { id: salaryExpense.id }, force: true })
    }
    await db.user.destroy({ where: { id: empId }, force: true })
  }

  test('Case A: a whole-number DECIMAL salary (round-trips as "5000000.00") produces a successful generate-salary call', async () => {
    const emp = await makeEmployee(5000000, 'a')
    try {
      const res = await request(app)
        .post('/expense/generate-salary')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ store: location.id, employeeIds: [emp.id], paymentMethod: 'cash' })
      expect(res.status).toBe(201)
      expect(res.body.data.created).toBe(1)

      const salaryExpense = await db.expense.findOne({ where: { employeeId: emp.id } })
      expect(salaryExpense).not.toBeNull()
      expect(salaryExpense.amount).toBe(5000000)
    } finally {
      await cleanupEmployee(emp.id)
    }
  })

  test('Case B: a numeric-looking DECIMAL salary still produces the correct integer amount', async () => {
    const emp = await makeEmployee(3250000, 'b')
    try {
      const res = await request(app)
        .post('/expense/generate-salary')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ store: location.id, employeeIds: [emp.id], paymentMethod: 'cash' })
      expect(res.status).toBe(201)

      const salaryExpense = await db.expense.findOne({ where: { employeeId: emp.id } })
      expect(salaryExpense.amount).toBe(3250000)
      expect(Number.isInteger(salaryExpense.amount)).toBe(true)
    } finally {
      await cleanupEmployee(emp.id)
    }
  })

  test('Case C: a salary with cents normalizes to the nearest integer rupiah, no floating-point artifact', async () => {
    const emp = await makeEmployee(4500000.75, 'c')
    try {
      const res = await request(app)
        .post('/expense/generate-salary')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ store: location.id, employeeIds: [emp.id], paymentMethod: 'cash' })
      expect(res.status).toBe(201)

      const salaryExpense = await db.expense.findOne({ where: { employeeId: emp.id } })
      // Math.round(4500000.75) = 4500001 — not 4499999.999999 or any
      // other float artifact, and not silently truncated to 4500000.
      expect(salaryExpense.amount).toBe(4500001)
    } finally {
      await cleanupEmployee(emp.id)
    }
  })

  test('Case D: the generated salary expense still enters the durable expense_journal_sync flow with the correct amount', async () => {
    const emp = await makeEmployee(6000000, 'd')
    try {
      const res = await request(app)
        .post('/expense/generate-salary')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ store: location.id, employeeIds: [emp.id], paymentMethod: 'cash' })
      expect(res.status).toBe(201)

      const salaryExpense = await db.expense.findOne({ where: { employeeId: emp.id } })
      const outboxRows = await db.accounting_outbox.findAll({
        where: { referenceType: 'expense', referenceId: salaryExpense.id }
      })
      expect(outboxRows.map((r) => r.jobType)).toEqual(['expense_journal_sync'])
      expect(outboxRows[0].status).toBe('posted')

      const journals = await journalFor(location.id, salaryExpense.id)
      expect(journals.length).toBe(1)
      expect(Number(journals[0].totalDebit)).toBe(6000000)
    } finally {
      await cleanupEmployee(emp.id)
    }
  })
})
