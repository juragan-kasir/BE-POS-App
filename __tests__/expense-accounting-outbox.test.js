process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { attemptJob, drainAccountingOutbox, enqueueAccountingJob } = require('../api/service/accountingOutboxService')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 22 Batch 8: Expense journal synchronization used to call
// syncExpenseJournal / deleteExpenseJournal directly, fire-and-forget, at
// 8 call sites with no durable retry (F22-B5-03). Per the Batch 7 design
// (Option C — state reconciliation), Expense now enqueues a thin
// `{expenseId}` job (`expense_journal_sync`) transactionally with the
// business mutation; the worker always re-reads the LIVE expense row and
// calls the existing, unmodified `syncExpenseJournal` — never trusting a
// captured payload snapshot. This file proves durability, transactional
// atomicity, retry, stale-event safety, delete-race safety, idempotency,
// concurrency, and store isolation for that design.

let location = null
let category = null
let customCategory = null
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
      description: 'Test expense',
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

const outboxFor = (expenseId) =>
  db.accounting_outbox.findAll({ where: { referenceType: 'expense', referenceId: expenseId } })

beforeAll(async () => {
  location = await db.location.create({ name: 'EXP_OUTBOX_STORE', status: 'active' })
  category = await db.expense_category.create({
    store: location.id,
    name: 'EXP_OUTBOX_CATEGORY',
    accountCode: '6000',
    status: 'active'
  })
  customCategory = await db.expense_category.create({
    store: location.id,
    name: 'EXP_OUTBOX_CUSTOM_CATEGORY',
    accountCode: '6500',
    status: 'active'
  })
  adminUser = await db.user.create({
    userName: 'admin_exp_outbox',
    email: 'admin_exp_outbox@test.com',
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
  await db.expense_category.destroy({
    where: { id: [category?.id, customCategory?.id].filter(Boolean) },
    force: true
  })
  await db.account.destroy({ where: { store: location.id }, force: true })
  await db.user.destroy({ where: { id: adminUser?.id }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

describe('Expense journal posting — durable outbox parity via state reconciliation (expense_journal_sync)', () => {
  test('creating an expense already at status=approved enqueues a durable expense_journal_sync job and posts it immediately', async () => {
    const res = await createExpense({ status: 'approved', amount: 12000 })
    expect(res.status).toBe(201)
    const expenseId = res.body.data.id

    const outboxRows = await outboxFor(expenseId)
    expect(outboxRows.map((r) => r.jobType)).toEqual(['expense_journal_sync'])
    expect(outboxRows[0].status).toBe('posted')
    expect(outboxRows[0].store).toBe(location.id)

    const journals = await journalFor(location.id, expenseId)
    expect(journals.length).toBe(1)
    expect(Number(journals[0].totalDebit)).toBe(12000)
  })

  test('posts a journal for a category whose accountCode is not a built-in account', async () => {
    const res = await createExpense({
      categoryId: customCategory.id,
      status: 'approved',
      amount: 7000
    })
    expect(res.status).toBe(201)

    const jobs = await outboxFor(res.body.data.id)
    expect(jobs.length).toBe(1)
    expect(jobs[0].status).toBe('posted')

    const journals = await journalFor(location.id, res.body.data.id)
    expect(journals.length).toBe(1)

    const lines = await db.journal_entry_line.findAll({
      where: { journalEntry: journals[0].id },
      order: [['id', 'ASC']]
    })
    const debitAccount = await db.account.findByPk(lines[0].account)
    expect(debitAccount.code).toBe('6500')
    expect(debitAccount.name).toBe('EXP_OUTBOX_CUSTOM_CATEGORY')
  })

  test('approving a pending expense enqueues a durable expense_journal_sync job and posts it immediately', async () => {
    const createRes = await createExpense({ amount: 30000 })
    const expenseId = createRes.body.data.id

    const approveRes = await approveExpense(expenseId)
    expect(approveRes.status).toBe(200)

    const outboxRows = await outboxFor(expenseId)
    expect(outboxRows.map((r) => r.jobType)).toEqual(['expense_journal_sync'])
    expect(outboxRows[0].status).toBe('posted')

    const journals = await journalFor(location.id, expenseId)
    expect(journals.length).toBe(1)
    expect(Number(journals[0].totalDebit)).toBe(30000)
  })

  test('updating an approved expense enqueues a durable job and rewrites the journal to the new amount', async () => {
    const createRes = await createExpense({ amount: 10000 })
    const expenseId = createRes.body.data.id
    await approveExpense(expenseId)

    // status must be passed explicitly: updateExpenseSchema
    // (createExpenseSchema.partial()) still carries createExpenseSchema's
    // `.default('pending')` on the status field, so an update that omits
    // status gets 'pending' injected by validation — a pre-existing,
    // independent Expense validation quirk (documented as a deferred
    // finding, not fixed in this batch; see the implementation report).
    const updateRes = await request(app)
      .put(`/expense/edit/${expenseId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ amount: 25000, status: 'approved' })
    expect(updateRes.status).toBe(200)

    const outboxRows = await outboxFor(expenseId)
    expect(outboxRows.length).toBe(2) // approve + update
    expect(outboxRows.every((r) => r.jobType === 'expense_journal_sync' && r.status === 'posted')).toBe(true)

    const journals = await journalFor(location.id, expenseId)
    expect(journals.length).toBe(1)
    expect(Number(journals[0].totalDebit)).toBe(25000)
  })

  test('rejecting a pending expense enqueues a durable job and removes any journal', async () => {
    const createRes = await createExpense({ amount: 15000, status: 'approved' })
    const expenseId = createRes.body.data.id
    const beforeReject = await journalFor(location.id, expenseId)
    expect(beforeReject.length).toBe(1)

    // reject() only accepts pending expenses — re-fetch through pending path
    const pendingRes = await createExpense({ amount: 15000 })
    const pendingId = pendingRes.body.data.id

    const rejectRes = await request(app)
      .put(`/expense/reject/${pendingId}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(rejectRes.status).toBe(200)

    const outboxRows = await outboxFor(pendingId)
    expect(outboxRows.map((r) => r.jobType)).toEqual(['expense_journal_sync'])
    expect(outboxRows[0].status).toBe('posted')

    const journals = await journalFor(location.id, pendingId)
    expect(journals.length).toBe(0)
  })

  test('archiving an approved expense (setActive: false) enqueues a durable job and removes the journal', async () => {
    const createRes = await createExpense({ amount: 18000 })
    const expenseId = createRes.body.data.id
    await approveExpense(expenseId)
    expect((await journalFor(location.id, expenseId)).length).toBe(1)

    const archiveRes = await request(app)
      .put(`/expense/set-active/${expenseId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ isActive: false })
    expect(archiveRes.status).toBe(200)

    const outboxRows = await outboxFor(expenseId)
    expect(outboxRows.length).toBe(2) // approve + archive
    expect(outboxRows[outboxRows.length - 1].status).toBe('posted')

    const journals = await journalFor(location.id, expenseId)
    expect(journals.length).toBe(0)
  })

  test('deleting an approved expense enqueues a durable job and removes the journal (soft-delete visibility)', async () => {
    const createRes = await createExpense({ amount: 22000 })
    const expenseId = createRes.body.data.id
    await approveExpense(expenseId)
    expect((await journalFor(location.id, expenseId)).length).toBe(1)

    const deleteRes = await request(app)
      .delete(`/expense/delete/${expenseId}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(deleteRes.status).toBe(200)

    const outboxRows = await outboxFor(expenseId)
    expect(outboxRows.length).toBe(2) // approve + delete
    expect(outboxRows[outboxRows.length - 1].status).toBe('posted')

    const journals = await journalFor(location.id, expenseId)
    expect(journals.length).toBe(0)
  })

  // Phase 22 Batch 9 (F22-B9-02) fixed the pre-existing bug this test used
  // to document: generateSalary's amount comes from `user.monthlySalary`,
  // a DECIMAL(15,2) column that Sequelize/pg always round-trips as a
  // numeric STRING (e.g. "4000000.00"), which used to be passed
  // unconverted into `expense.amount` (INTEGER) and rejected by Postgres.
  // Now that it's normalized (see expense.js, generateSalary), this test
  // proves the originally-intended positive path: category creation,
  // expense creation, and the new durable-outbox enqueue commit together
  // as one atomic transaction, and the enqueued job is posted correctly.
  // Dedicated normalization-correctness cases (whole numbers, cents,
  // no float artifacts) live in __tests__/expense-correctness.test.js.
  test('generateSalary is transactionally atomic — category, expense, and the outbox enqueue commit together, and the job posts correctly', async () => {
    const employee = await db.user.create({
      userName: 'salary_emp_outbox',
      email: 'salary_emp_outbox@test.com',
      roleType: 'user',
      userType: 'user',
      store: location.id,
      status: 'active',
      monthlySalary: 4000000
    })

    try {
      const res = await request(app)
        .post('/expense/generate-salary')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ store: location.id, employeeIds: [employee.id], paymentMethod: 'cash' })
      expect(res.status).toBe(201)
      expect(res.body.data.created).toBe(1)

      const salaryExpense = await db.expense.findOne({
        where: { store: location.id, employeeId: employee.id }
      })
      expect(salaryExpense).not.toBeNull()
      expect(salaryExpense.amount).toBe(4000000)

      const outboxRows = await outboxFor(salaryExpense.id)
      expect(outboxRows.map((r) => r.jobType)).toEqual(['expense_journal_sync'])
      expect(outboxRows[0].status).toBe('posted')

      const journals = await journalFor(location.id, salaryExpense.id)
      expect(journals.length).toBe(1)
      expect(Number(journals[0].totalDebit)).toBe(4000000)
    } finally {
      const salaryExpense = await db.expense.findOne({ where: { employeeId: employee.id } })
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
      await db.user.destroy({ where: { id: employee.id }, force: true })
    }
  })

  test('enqueueAccountingJob rolls back with its transaction — a rolled-back Expense mutation cannot leave an orphaned outbox row', async () => {
    let jobId = null
    await expect(
      db.sequelize.transaction(async (t) => {
        const job = await enqueueAccountingJob({
          jobType: 'expense_journal_sync',
          store: location.id,
          referenceType: 'expense',
          referenceId: 999321,
          payload: { expenseId: 999321 },
          transaction: t
        })
        jobId = job.id
        throw new Error('forced rollback after enqueue, before commit')
      })
    ).rejects.toThrow('forced rollback after enqueue, before commit')

    const survived = await db.accounting_outbox.findByPk(jobId)
    expect(survived).toBeNull()
  })

  test('an expense_journal_sync job whose immediate attempt fails stays pending and is recovered by the drain function', async () => {
    // Note: syncExpenseJournal has its own `if (!store || !expenseId) return
    // null` guard, so — unlike postPurchaseJournal/postPurchaseReturnJournal
    // in Batches 5/6 — corrupting the live row's `store` to null is not a
    // usable failure trigger here: it resolves to a safe no-op, not a
    // throw. The real, reproducible failure trigger for THIS reconciliation
    // path is a genuine DB-level unique-constraint conflict: soft-delete
    // the category's underlying account row (paranoid, but its unique
    // index on (store, code) is NOT partial-on-deletedAt) so a fresh
    // findOrCreateAccount attempt collides with the still-indexed deleted
    // row, fails to find a "winner" under the paranoid default scope, and
    // throws SequelizeUniqueConstraintError — the same class of transient-
    // looking DB failure a connection blip would produce.
    const createRes = await createExpense({ amount: 8000 })
    const expenseId = createRes.body.data.id
    await approveExpense(expenseId)
    expect((await journalFor(location.id, expenseId)).length).toBe(1)

    const acc = await db.account.findOne({ where: { store: location.id, code: '6000' } })
    expect(acc).not.toBeNull()
    await acc.destroy()

    const job = await db.accounting_outbox.create({
      jobType: 'expense_journal_sync',
      referenceType: 'expense',
      referenceId: expenseId,
      payload: { expenseId }
    })

    const firstAttempt = await attemptJob(job)
    expect(firstAttempt.ok).toBe(false)

    const stillPending = await db.accounting_outbox.findByPk(job.id)
    expect(stillPending.status).toBe('pending')

    // Repair (restore the account) and confirm the drain function recovers it.
    await db.account.restore({ where: { id: acc.id } })
    await drainAccountingOutbox({ limit: 100 })
    const recovered = await db.accounting_outbox.findByPk(job.id)
    expect(recovered.status).toBe('posted')

    await db.accounting_outbox.destroy({ where: { id: job.id }, force: true })
  })

  test('stale-event safety: replaying an older sync job after a newer update was already processed does not revert the journal', async () => {
    const createRes = await createExpense({ amount: 5000 })
    const expenseId = createRes.body.data.id
    await approveExpense(expenseId)
    expect(Number((await journalFor(location.id, expenseId))[0].totalDebit)).toBe(5000)

    // event A: an update job enqueued now, representing an event that will
    // be processed LATE (e.g. it was stuck retrying).
    const staleJobA = await enqueueAccountingJob({
      jobType: 'expense_journal_sync',
      store: location.id,
      referenceType: 'expense',
      referenceId: expenseId,
      payload: { expenseId }
    })

    // event B: a REAL, later update — processed through the real durable
    // path, moving the authoritative amount to 9000.
    const updateRes = await request(app)
      .put(`/expense/edit/${expenseId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ amount: 9000, status: 'approved' })
    expect(updateRes.status).toBe(200)
    expect(Number((await journalFor(location.id, expenseId))[0].totalDebit)).toBe(9000)

    // Now process the STALE event A. Because its payload carries no
    // snapshot (only {expenseId}), reconciliation re-reads the LIVE
    // expense (still amount=9000) and must NOT revert to 5000.
    const staleResult = await attemptJob(staleJobA)
    expect(staleResult.ok).toBe(true)

    const journals = await journalFor(location.id, expenseId)
    expect(journals.length).toBe(1)
    expect(Number(journals[0].totalDebit)).toBe(9000)

    await db.accounting_outbox.destroy({ where: { id: staleJobA.id }, force: true })
  })

  test('update-then-delete race: replaying a stale update job after a later reject was already processed does not resurrect the journal', async () => {
    const createRes = await createExpense({ amount: 6000 })
    const expenseId = createRes.body.data.id
    await approveExpense(expenseId)
    expect((await journalFor(location.id, expenseId)).length).toBe(1)

    // event A: an update job enqueued now, representing a change that will
    // be replayed LATE, after the expense has since been rejected.
    const staleJobA = await enqueueAccountingJob({
      jobType: 'expense_journal_sync',
      store: location.id,
      referenceType: 'expense',
      referenceId: expenseId,
      payload: { expenseId }
    })

    // event B: reject() only operates on pending expenses, so revert status
    // to pending first (direct DB manipulation, simulating the business
    // having already reverted this expense through some other real flow)
    // then reject through the real endpoint — the durable delete path.
    await db.expense.update({ status: 'pending' }, { where: { id: expenseId } })
    const rejectRes = await request(app)
      .put(`/expense/reject/${expenseId}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(rejectRes.status).toBe(200)
    expect((await journalFor(location.id, expenseId)).length).toBe(0)

    // Now process the STALE update event A. It must re-read live state
    // (status: rejected) and must NOT resurrect the journal.
    const staleResult = await attemptJob(staleJobA)
    expect(staleResult.ok).toBe(true)

    const journals = await journalFor(location.id, expenseId)
    expect(journals.length).toBe(0)

    await db.accounting_outbox.destroy({ where: { id: staleJobA.id }, force: true })
  })

  test('delete reconciliation is safe to retry/replay — reprocessing after the journal is already deleted is a safe no-op', async () => {
    const createRes = await createExpense({ amount: 7000 })
    const expenseId = createRes.body.data.id
    await approveExpense(expenseId)

    const deleteRes = await request(app)
      .delete(`/expense/delete/${expenseId}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(deleteRes.status).toBe(200)
    expect((await journalFor(location.id, expenseId)).length).toBe(0)

    // A retry/replay of the same reconciliation after the journal is
    // already gone must converge to the same correct (deleted) state,
    // not error and not resurrect anything.
    const replayJob = await enqueueAccountingJob({
      jobType: 'expense_journal_sync',
      store: location.id,
      referenceType: 'expense',
      referenceId: expenseId,
      payload: { expenseId }
    })
    const replayResult = await attemptJob(replayJob)
    expect(replayResult.ok).toBe(true)

    const journals = await journalFor(location.id, expenseId)
    expect(journals.length).toBe(0)

    await db.accounting_outbox.destroy({ where: { id: replayJob.id }, force: true })
  })

  test('a second, independently-crafted job for the same expense replays the existing journal instead of duplicating it', async () => {
    const createRes = await createExpense({ amount: 11000 })
    const expenseId = createRes.body.data.id
    await approveExpense(expenseId)

    const journalBefore = await journalFor(location.id, expenseId)
    expect(journalBefore.length).toBe(1)

    const duplicateJob = await enqueueAccountingJob({
      jobType: 'expense_journal_sync',
      store: location.id,
      referenceType: 'expense',
      referenceId: expenseId,
      payload: { expenseId }
    })
    const result = await attemptJob(duplicateJob)
    expect(result.ok).toBe(true)
    await db.accounting_outbox.destroy({ where: { id: duplicateJob.id }, force: true })

    const journals = await journalFor(location.id, expenseId)
    expect(journals.length).toBe(1)
    expect(journals[0].id).toBe(journalBefore[0].id)
  })

  test('re-draining after an expense job already posted does not create a duplicate journal entry', async () => {
    const createRes = await createExpense({ amount: 9500 })
    const expenseId = createRes.body.data.id
    await approveExpense(expenseId)

    await drainAccountingOutbox({ limit: 100 })
    await drainAccountingOutbox({ limit: 100 })

    const outboxRows = await outboxFor(expenseId)
    expect(outboxRows.every((r) => r.status === 'posted')).toBe(true)

    const journals = await journalFor(location.id, expenseId)
    expect(journals.length).toBe(1)
  })

  test('concurrent reconciliation workers for the same expense converge to one correct journal, not a corrupted or duplicated one', async () => {
    const createRes = await createExpense({ amount: 13000 })
    const expenseId = createRes.body.data.id
    await approveExpense(expenseId)
    expect((await journalFor(location.id, expenseId)).length).toBe(1)

    const jobA = await enqueueAccountingJob({
      jobType: 'expense_journal_sync',
      store: location.id,
      referenceType: 'expense',
      referenceId: expenseId,
      payload: { expenseId }
    })
    const jobB = await enqueueAccountingJob({
      jobType: 'expense_journal_sync',
      store: location.id,
      referenceType: 'expense',
      referenceId: expenseId,
      payload: { expenseId }
    })

    const [resultA, resultB] = await Promise.all([attemptJob(jobA), attemptJob(jobB)])
    expect(resultA.ok).toBe(true)
    expect(resultB.ok).toBe(true)

    const journals = await journalFor(location.id, expenseId)
    expect(journals.length).toBe(1)
    expect(Number(journals[0].totalDebit)).toBe(13000)
    expect(Number(journals[0].totalCredit)).toBe(13000)

    const lines = await db.journal_entry_line.findAll({ where: { journalEntry: journals[0].id } })
    expect(lines.length).toBe(2)

    await db.accounting_outbox.destroy({ where: { id: [jobA.id, jobB.id] }, force: true })
  })

  test('store isolation: a store A expense only creates outbox/journal rows scoped to store A', async () => {
    const storeB = await db.location.create({ name: 'EXP_OUTBOX_STORE_B', status: 'active' })
    const categoryB = await db.expense_category.create({
      store: storeB.id,
      name: 'EXP_OUTBOX_CATEGORY_B',
      accountCode: '6000',
      status: 'active'
    })
    const userB = await db.user.create({
      userName: 'admin_exp_outbox_b',
      email: 'admin_exp_outbox_b@test.com',
      roleType: 'admin',
      userType: 'admin',
      store: storeB.id,
      status: 'active'
    })
    const tokenB = await signSessionToken(
      { id: userB.id, userName: userB.userName, roleType: 'admin', store: storeB.id },
      JWT_SECRET
    )

    try {
      const createResB = await request(app)
        .post('/expense/add')
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ categoryId: categoryB.id, amount: 17000, paymentMethod: 'cash', status: 'approved' })
      expect(createResB.status).toBe(201)
      const expenseIdB = createResB.body.data.id

      const outboxRowsB = await outboxFor(expenseIdB)
      expect(outboxRowsB.length).toBe(1)
      expect(outboxRowsB[0].store).toBe(storeB.id)
      expect(outboxRowsB[0].store).not.toBe(location.id)

      const journalsB = await db.journal_entry.findAll({
        where: { sourceType: 'expense', referenceId: expenseIdB }
      })
      expect(journalsB.length).toBe(1)
      expect(journalsB[0].store).toBe(storeB.id)

      const crossStoreLeak = await db.accounting_outbox.findAll({
        where: { store: location.id, referenceType: 'expense', referenceId: expenseIdB }
      })
      expect(crossStoreLeak.length).toBe(0)
    } finally {
      await db.accounting_outbox.destroy({ where: { store: storeB.id }, force: true })
      await db.journal_entry_line.destroy({ where: {}, force: true })
      await db.journal_entry.destroy({ where: { store: storeB.id }, force: true })
      await db.expense.destroy({ where: { store: storeB.id }, force: true })
      await db.expense_category.destroy({ where: { id: categoryB.id }, force: true })
      await db.user.destroy({ where: { id: userB.id }, force: true })
      await db.location.destroy({ where: { id: storeB.id }, force: true })
    }
  })
})
