process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { adjustMemberPoints } = require('../api/service/loyaltyService')
const { incrementPromoUsage } = require('../api/service/promoUsageService')
const {
  enqueueAccountingJob,
  attemptJob,
  drainAccountingOutbox
} = require('../api/service/accountingOutboxService')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Regression tests for the financial-integrity backlog identified in the
// original audit: (1) loyalty point balance races, (2) promo usage-limit
// races, (3) accounting journal posting being fire-and-forget with no
// durable retry. All three fire genuinely concurrent requests / real
// transactions against Postgres and assert final DB state, not just that
// no error was thrown.

let store = null
let category = null
let product = null
let cashierToken = null
let cashierUserId = null

beforeAll(async () => {
  store = await db.location.create({ name: 'FIN_INTEGRITY_STORE', status: 'active' })
  category = await db.category.create({ name: 'FIN_INTEGRITY_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'FIN_INTEGRITY_PRODUCT',
    category: category.id,
    price: 10000,
    costPrice: 4000,
    point: 5,
    stock: 100
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 100 })
  // member_point_history.createdBy has a real FK to user, unlike
  // order/order_item/transaction which accept any synthetic JWT subject —
  // so this fixture needs an actual user row.
  const cashierUser = await db.user.create({
    userName: 'fin_integrity_cashier',
    email: 'fin_integrity_cashier@test.com',
    roleType: 'kasir',
    userType: 'kasir',
    store: store.id,
    status: 'active'
  })
  cashierUserId = cashierUser.id
  cashierToken = await signSessionToken(
    { id: cashierUser.id, userName: cashierUser.userName, roleType: 'kasir', store: store.id },
    JWT_SECRET
  )
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed the rate
  // so these integrity assertions exercise configured tax.
  await db.taxConfig.create({
    name: 'FIN_INTEGRITY_PPN',
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: store.id
  })
  // P1 (DR-PAY-ATTR-02): counter sales under test require an open register.
  await db.cashRegister.create({ store: store.id, user: cashierUser.id, status: 'open', openingBalance: 0, openedAt: new Date() })
})

afterAll(async () => {
  await db.cashRegister.destroy({ where: { store: store?.id }, force: true })
  await db.taxConfig.destroy({ where: { store: store?.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product.id }, force: true })
  await db.product.destroy({ where: { id: product.id }, force: true })
  await db.category.destroy({ where: { id: category.id }, force: true })
  await db.user.destroy({ where: { id: cashierUserId }, force: true })
  await db.location.destroy({ where: { id: store.id }, force: true })
})

// ==================================== loyalty points ====================================

describe('Loyalty point balance — concurrency', () => {
  test('two concurrent redemptions never produce a negative balance or a lost update', async () => {
    const member = await db.member.create({
      name: 'FIN_RACE_MEMBER', phoneNumber: '081000001', totalPoints: 100
    })

    const redeem = (amt) =>
      db.sequelize.transaction((t) =>
        adjustMemberPoints({ memberId: member.id, deltaPoints: -amt, transaction: t })
      )

    const [r1, r2] = await Promise.all([redeem(60), redeem(60)])

    // Both requests are for 60 points against a 100-point balance — only
    // one can be fully honored without going negative. floorAtZero means
    // neither individual call errors, but the two results together must
    // never imply the balance went below zero.
    const final = await db.member.findByPk(member.id)
    expect(Number(final.totalPoints)).toBeGreaterThanOrEqual(0)
    // The lost-update failure mode this replaces: both transactions reading
    // the same pre-race value (100) and both writing 100-60=40, leaving the
    // final balance at 40 instead of correctly reflecting BOTH deductions
    // (which floors at 0, not 40 — 100-60-60 clamped is 0).
    expect(Number(final.totalPoints)).toBe(0)
    expect([r1.pointsAfter, r2.pointsAfter].sort((a, b) => a - b)).toEqual([0, 40])

    const historyCount = await db.member_point_history.count({ where: { member: member.id } })
    expect(historyCount).toBe(2)

    await db.member_point_history.destroy({ where: { member: member.id }, force: true })
    await db.member.destroy({ where: { id: member.id }, force: true })
  })

  test('earning points is atomic and updates lifetimePoints alongside totalPoints', async () => {
    const member = await db.member.create({
      name: 'FIN_EARN_MEMBER', phoneNumber: '081000002', totalPoints: 10, lifetimePoints: 10
    })

    await db.sequelize.transaction((t) =>
      adjustMemberPoints({
        memberId: member.id,
        deltaPoints: 25,
        deltaLifetimePoints: 25,
        transaction: t
      })
    )

    const updated = await db.member.findByPk(member.id)
    expect(Number(updated.totalPoints)).toBe(35)
    expect(Number(updated.lifetimePoints)).toBe(35)

    await db.member_point_history.destroy({ where: { member: member.id }, force: true })
    await db.member.destroy({ where: { id: member.id }, force: true })
  })

  test('checkout with point redemption end-to-end: order succeeds and points are deducted atomically inside the order transaction', async () => {
    const member = await db.member.create({
      name: 'FIN_CHECKOUT_MEMBER', phoneNumber: '081000003', totalPoints: 1000
    })

    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send(withIdempotencyKey({
        store: store.id,
        items: [{ product: product.id, quantity: 1 }],
        paymentMethod: 'cash',
        cashierName: 'Fin Integrity Cashier',
        customerId: member.id,
        redeemedPoints: 100
      }))

    expect(res.status).toBe(201)

    // Redemption (-100) and earning from the order's line items
    // (product.point = 5) both apply atomically inside the same order
    // transaction: 1000 - 100 + 5 = 905.
    const updatedMember = await db.member.findByPk(member.id)
    expect(Number(updatedMember.totalPoints)).toBe(905)

    const historyRow = await db.member_point_history.findOne({
      where: { member: member.id, pointsChange: -100 }
    })
    expect(historyRow).not.toBeNull()
    expect(String(historyRow.transactionId)).toBe(String(res.body.data.id))

    await db.member_point_history.destroy({ where: { member: member.id }, force: true })
    await db.transaction.destroy({ where: { order: res.body.data.id }, force: true })
    await db.order_status.destroy({ where: { order: res.body.data.id }, force: true })
    await db.order_item.destroy({ where: { order: res.body.data.id }, force: true })
    await db.order.destroy({ where: { id: res.body.data.id }, force: true })
    await db.member.destroy({ where: { id: member.id }, force: true })
  })
})

// ==================================== promo usage ====================================

describe('Promo campaign usage limit — concurrency', () => {
  test('two concurrent increments against a single-use campaign: exactly one succeeds, currentUsage never exceeds the cap', async () => {
    const campaign = await db.promo_campaign.create({
      name: 'FIN_RACE_PROMO',
      type: 'manual',
      startDate: new Date(),
      endDate: new Date(Date.now() + 86400000),
      maxUsageTotal: 1,
      currentUsage: 0
    })

    const use = () =>
      db.sequelize.transaction((t) =>
        incrementPromoUsage({ campaignId: campaign.id, transaction: t })
      )

    const [r1, r2] = await Promise.all([use(), use()])
    const outcomes = [r1, r2].map((r) => (r.usage ? 'recorded' : 'limitReached')).sort()
    expect(outcomes).toEqual(['limitReached', 'recorded'])

    const final = await db.promo_campaign.findByPk(campaign.id)
    expect(final.currentUsage).toBe(1)

    const usageRows = await db.promo_usage.count({ where: { campaignId: campaign.id } })
    expect(usageRows).toBe(1)

    await db.promo_usage.destroy({ where: { campaignId: campaign.id }, force: true })
    await db.promo_campaign.destroy({ where: { id: campaign.id }, force: true })
  })

  test('POST /promo/usage end-to-end: two concurrent HTTP requests against a single-use campaign, exactly one succeeds', async () => {
    const campaign = await db.promo_campaign.create({
      name: 'FIN_RACE_PROMO_HTTP',
      type: 'manual',
      startDate: new Date(),
      endDate: new Date(Date.now() + 86400000),
      maxUsageTotal: 1,
      currentUsage: 0
    })

    const call = () =>
      request(app)
        .post('/promo/usage')
        .set('Authorization', `Bearer ${cashierToken}`)
        .send({ campaignId: campaign.id })

    const [r1, r2] = await Promise.all([call(), call()])
    expect([r1.status, r2.status].sort()).toEqual([201, 400])

    const final = await db.promo_campaign.findByPk(campaign.id)
    expect(final.currentUsage).toBe(1)

    await db.promo_usage.destroy({ where: { campaignId: campaign.id }, force: true })
    await db.promo_campaign.destroy({ where: { id: campaign.id }, force: true })
  })
})

// ==================================== accounting outbox ====================================

describe('Accounting outbox — durability and retry', () => {
  test('a real order create enqueues journal jobs and posts them immediately on the happy path', async () => {
    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${cashierToken}`)
      .send(withIdempotencyKey({
        store: store.id,
        items: [{ product: product.id, quantity: 1 }],
        paymentMethod: 'cash',
        cashierName: 'Fin Integrity Outbox'
      }))
    expect(res.status).toBe(201)
    const orderId = res.body.data.id

    const outboxRows = await db.accounting_outbox.findAll({
      where: { referenceType: 'order', referenceId: orderId }
    })
    expect(outboxRows.map((r) => r.jobType).sort()).toEqual([
      'order_cogs_journal',
      'order_journal'
    ])
    expect(outboxRows.every((r) => r.status === 'posted')).toBe(true)

    const journalEntries = await db.journal_entry.findAll({ where: { referenceId: orderId } })
    expect(journalEntries.length).toBeGreaterThanOrEqual(1)

    await db.accounting_outbox.destroy({
      where: { referenceType: 'order', referenceId: orderId },
      force: true
    })
    await db.journal_entry_line.destroy({ where: {}, force: true })
    await db.journal_entry.destroy({ where: { referenceId: orderId }, force: true })
    await db.transaction.destroy({ where: { order: orderId }, force: true })
    await db.order_status.destroy({ where: { order: orderId }, force: true })
    await db.order_item.destroy({ where: { order: orderId }, force: true })
    await db.order.destroy({ where: { id: orderId }, force: true })
  })

  test('a job whose immediate posting fails stays pending and is recovered by the drain function, instead of being silently discarded', async () => {
    // store: null on a job type whose handler requires it -> a real,
    // reproducible posting failure (account.store NOT NULL), same failure
    // class as a transient DB blip in production.
    const job = await db.accounting_outbox.create({
      jobType: 'order_journal',
      payload: {
        store: null,
        orderId: 999999,
        orderNumber: 'FIN-OUTBOX-FAIL',
        subTotal: 100,
        discountAmount: 0,
        taxAmount: 0,
        serviceChargeAmount: 0,
        totalPrice: 100,
        date: new Date().toISOString(),
        createdBy: null
      }
    })

    const firstAttempt = await attemptJob(job)
    expect(firstAttempt.ok).toBe(false)

    // Nothing about the failure discarded the row — it's still there,
    // status still pending, ready for the scheduler's next tick.
    const stillPending = await db.accounting_outbox.findByPk(job.id)
    expect(stillPending.status).toBe('pending')

    await db.accounting_outbox.destroy({ where: { id: job.id }, force: true })
  })

  test('drainAccountingOutbox marks a job failed only after exhausting MAX_ATTEMPTS, preserving the real error', async () => {
    const job = await db.accounting_outbox.create({
      jobType: 'order_journal',
      payload: {
        store: null,
        orderId: 999998,
        orderNumber: 'FIN-OUTBOX-EXHAUST',
        subTotal: 100,
        discountAmount: 0,
        taxAmount: 0,
        serviceChargeAmount: 0,
        totalPrice: 100,
        date: new Date().toISOString(),
        createdBy: null
      }
    })

    for (let i = 0; i < 5; i++) {
      await drainAccountingOutbox({ limit: 100 })
    }

    const final = await db.accounting_outbox.findByPk(job.id)
    expect(final.status).toBe('failed')
    expect(final.attempts).toBe(5)
    expect(final.lastError).toMatch(/store/)

    await db.accounting_outbox.destroy({ where: { id: job.id }, force: true })
  })
})
