process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')
const { generateApReminders } = require('../api/service/apReminderService')
const { getStoreLocalDate } = require('../utils/businessDate')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 22 Batch 4 — AP Reminder Scheduler + Notification Foundation.
//
// generateApReminders() is the single entry point the scheduler calls.
// It reuses:
//   - purchase_order.finalAmount - Σpurchase_payment.amount as the ONLY
//     AP outstanding calculation (no second formula)
//   - utils/businessDate.js's classifyDueDate() as the ONLY
//     classification rule
//   - a real Postgres UNIQUE index (ap_reminder_event) as the ONLY
//     idempotency mechanism (no in-memory flags)
//   - the existing createNotification()/notification table for delivery

let storeJakarta = null
let storeJayapura = null
let category = null
let ingredientJakarta = null
let ingredientJayapura = null
let supplierJakarta = null
let supplierJayapura = null
let adminJakartaUser = null
let adminJakartaToken = null
let adminJayapuraUser = null
let adminJayapuraToken = null

const nextTag = () => `AP_REM_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

const addDays = (dateStr, n) => {
  const [y, m, d] = dateStr.split('-').map(Number)
  const t = Date.UTC(y, m - 1, d) + n * 86400000
  return new Date(t).toISOString().slice(0, 10)
}

beforeAll(async () => {
  storeJakarta = await db.location.create(await withTestTenant({
    name: 'AP_REM_STORE_JAKARTA',
    status: 'active',
    timezone: 'Asia/Jakarta'
  }))
  storeJayapura = await db.location.create(await withTestTenant({
    name: 'AP_REM_STORE_JAYAPURA',
    status: 'active',
    timezone: 'Asia/Jayapura'
  }))
  category = await db.category.create({ name: 'AP_REM_CATEGORY' })

  ingredientJakarta = await db.ingredient.create({
    store: storeJakarta.id,
    name: nextTag(),
    stock: 0,
    minStock: 0,
    unit: 'pcs',
    baseUnit: 'pcs',
    conversionFactor: 1,
    costPrice: 0,
    status: 'active'
  })
  ingredientJayapura = await db.ingredient.create({
    store: storeJayapura.id,
    name: nextTag(),
    stock: 0,
    minStock: 0,
    unit: 'pcs',
    baseUnit: 'pcs',
    conversionFactor: 1,
    costPrice: 0,
    status: 'active'
  })

  supplierJakarta = await db.supplier.create({
    name: nextTag(),
    store: [storeJakarta.id],
    status: 'active'
  })
  supplierJayapura = await db.supplier.create({
    name: nextTag(),
    store: [storeJayapura.id],
    status: 'active'
  })

  adminJakartaUser = await db.user.create({
    userName: 'admin_ap_rem_jkt',
    email: 'admin_ap_rem_jkt@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: storeJakarta.id,
    status: 'active'
  })
  adminJakartaToken = await signSessionToken(
    { id: adminJakartaUser.id, userName: adminJakartaUser.userName, roleType: 'admin', store: storeJakarta.id },
    JWT_SECRET
  )
  adminJayapuraUser = await db.user.create({
    userName: 'admin_ap_rem_jyp',
    email: 'admin_ap_rem_jyp@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: storeJayapura.id,
    status: 'active'
  })
  adminJayapuraToken = await signSessionToken(
    { id: adminJayapuraUser.id, userName: adminJayapuraUser.userName, roleType: 'admin', store: storeJayapura.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  for (const store of [storeJakarta, storeJayapura]) {
    const pos = await db.purchase_order.findAll({ where: { store: store.id }, attributes: ['id'] })
    const poIds = pos.map((p) => p.id)
    await db.ap_reminder_event.destroy({ where: { purchaseOrder: poIds } })
    await db.notification.destroy({ where: { store: store.id }, force: true })
    await db.purchase_payment.destroy({ where: { purchaseOrder: poIds }, force: true })
    await db.purchase_order_item.destroy({ where: { purchaseOrder: poIds }, force: true })
    await db.purchase_order.destroy({ where: { id: poIds }, force: true })
  }
  await db.ingredient.destroy({ where: { store: [storeJakarta.id, storeJayapura.id] }, force: true })
  await db.supplier.destroy({ where: { id: [supplierJakarta?.id, supplierJayapura?.id] }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { id: [adminJakartaUser?.id, adminJayapuraUser?.id] }, force: true })
  await db.location.destroy({ where: { id: [storeJakarta?.id, storeJayapura?.id] }, force: true })
})

const createPO = (storeId, ingredient, supplier, overrides = {}) =>
  request(app)
    .post('/purchase-order/create')
    .set('Authorization', `Bearer ${adminJakartaToken}`)
    .send({
      store: storeId,
      status: 'ordered',
      paymentMethod: 'credit',
      items: [
        {
          ingredient: ingredient.id,
          ingredientName: ingredient.name,
          quantity: 1,
          price: 100000,
          supplier: supplier.id
        }
      ],
      ...overrides
    })

describe('generateApReminders — eligibility', () => {
  test.each([
    ['H-4', 4],
    ['H-3', 3],
    ['H-2', 2],
    ['H-1', 1],
    ['DUE_TODAY', 0],
    ['OVERDUE', -1]
  ])('%s (daysUntilDue=%i) is reminder-eligible', async (expectedClass, offset) => {
    const today = getStoreLocalDate(storeJakarta.timezone)
    const res = await createPO(storeJakarta.id, ingredientJakarta, supplierJakarta, {
      dueDate: addDays(today, offset)
    })
    expect(res.status).toBe(201)
    const po = res.body.data

    const result = await generateApReminders()
    expect(result.created).toBeGreaterThanOrEqual(1)

    const event = await db.ap_reminder_event.findOne({ where: { purchaseOrder: po.id } })
    expect(event).not.toBeNull()
    expect(event.classification).toBe(expectedClass)
    expect(event.notificationId).not.toBeNull()

    const notif = await db.notification.findByPk(event.notificationId)
    expect(notif).not.toBeNull()
    expect(notif.type).toBe('ap_reminder')
    expect(notif.store).toBe(storeJakarta.id)
  })

  test('UPCOMING (> H-4) does not generate a reminder', async () => {
    const today = getStoreLocalDate(storeJakarta.timezone)
    const res = await createPO(storeJakarta.id, ingredientJakarta, supplierJakarta, {
      dueDate: addDays(today, 30)
    })
    expect(res.status).toBe(201)
    await generateApReminders()
    const event = await db.ap_reminder_event.findOne({ where: { purchaseOrder: res.body.data.id } })
    expect(event).toBeNull()
  })

  test('a PO with no dueDate does not generate a reminder', async () => {
    const res = await request(app)
      .post('/purchase-order/create')
      .set('Authorization', `Bearer ${adminJakartaToken}`)
      .send({
        store: storeJakarta.id,
        status: 'ordered',
        paymentMethod: 'cash',
        items: [
          {
            ingredient: ingredientJakarta.id,
            ingredientName: ingredientJakarta.name,
            quantity: 1,
            price: 50000,
            supplier: supplierJakarta.id
          }
        ]
      })
    expect(res.status).toBe(201)
    await generateApReminders()
    const event = await db.ap_reminder_event.findOne({ where: { purchaseOrder: res.body.data.id } })
    expect(event).toBeNull()
  })

  test('a fully paid PO does not generate a reminder', async () => {
    const today = getStoreLocalDate(storeJakarta.timezone)
    const res = await createPO(storeJakarta.id, ingredientJakarta, supplierJakarta, {
      dueDate: addDays(today, 1)
    })
    expect(res.status).toBe(201)
    const po = res.body.data

    const payRes = await request(app)
      .post('/purchase-payment/create')
      .set('Authorization', `Bearer ${adminJakartaToken}`)
      .send({
        purchaseOrder: po.id,
        supplier: supplierJakarta.id,
        amount: po.finalAmount,
        paymentMethod: 'cash'
      })
    expect(payRes.status).toBe(201)

    await generateApReminders()
    const event = await db.ap_reminder_event.findOne({ where: { purchaseOrder: po.id } })
    expect(event).toBeNull()
  })

  test('a cancelled PO does not generate a reminder', async () => {
    const today = getStoreLocalDate(storeJakarta.timezone)
    const res = await createPO(storeJakarta.id, ingredientJakarta, supplierJakarta, {
      dueDate: addDays(today, 1)
    })
    expect(res.status).toBe(201)
    const po = res.body.data

    const cancelRes = await request(app)
      .put(`/purchase-order/cancel/${po.id}`)
      .set('Authorization', `Bearer ${adminJakartaToken}`)
    expect(cancelRes.status).toBe(200)

    await generateApReminders()
    const event = await db.ap_reminder_event.findOne({ where: { purchaseOrder: po.id } })
    expect(event).toBeNull()
  })

  test('a draft PO (with a nonzero total, so exclusion is attributable to status, not outstanding<=0) does not generate a reminder', async () => {
    const today = getStoreLocalDate(storeJakarta.timezone)
    const res = await request(app)
      .post('/purchase-order/create')
      .set('Authorization', `Bearer ${adminJakartaToken}`)
      .send({
        store: storeJakarta.id,
        status: 'draft',
        paymentMethod: 'credit',
        dueDate: addDays(today, 1),
        items: [
          {
            ingredient: ingredientJakarta.id,
            ingredientName: ingredientJakarta.name,
            quantity: 1,
            price: 75000,
            supplier: supplierJakarta.id
          }
        ]
      })
    expect(res.status).toBe(201)
    expect(res.body.data.finalAmount).toBeGreaterThan(0)
    await generateApReminders()
    const event = await db.ap_reminder_event.findOne({ where: { purchaseOrder: res.body.data.id } })
    expect(event).toBeNull()
  })
})

describe('generateApReminders — idempotency', () => {
  test('running twice for the same PO/classification/business-date produces exactly one event', async () => {
    const today = getStoreLocalDate(storeJakarta.timezone)
    const res = await createPO(storeJakarta.id, ingredientJakarta, supplierJakarta, {
      dueDate: addDays(today, 2)
    })
    expect(res.status).toBe(201)
    const po = res.body.data

    const first = await generateApReminders()
    const second = await generateApReminders()

    expect(first.created).toBeGreaterThanOrEqual(1)
    expect(second.skippedDuplicate).toBeGreaterThanOrEqual(1)

    const events = await db.ap_reminder_event.findAll({ where: { purchaseOrder: po.id } })
    expect(events).toHaveLength(1)

    const notifications = await db.notification.findAll({
      where: { store: storeJakarta.id, referenceType: 'purchase_order', referenceId: po.id }
    })
    expect(notifications).toHaveLength(1)
  })
})

describe('generateApReminders — concurrent execution', () => {
  test('two overlapping calls for the same eligible PO create exactly one event (real Postgres unique index, no in-memory flag)', async () => {
    const today = getStoreLocalDate(storeJakarta.timezone)
    const res = await createPO(storeJakarta.id, ingredientJakarta, supplierJakarta, {
      dueDate: addDays(today, 3)
    })
    expect(res.status).toBe(201)
    const po = res.body.data

    const [r1, r2] = await Promise.all([generateApReminders(), generateApReminders()])
    const totalCreated = r1.created + r2.created

    const events = await db.ap_reminder_event.findAll({ where: { purchaseOrder: po.id } })
    expect(events).toHaveLength(1)
    // At most one of the two concurrent calls should have won the insert
    // for THIS PO specifically (other POs from earlier tests may also be
    // eligible again this run, so we assert on this PO's own event count,
    // not a global created-count equality).
    expect(totalCreated).toBeGreaterThanOrEqual(1)
  })
})

describe('generateApReminders — store isolation', () => {
  test('a Jakarta-store event never carries the Jayapura store id, and vice versa', async () => {
    const todayJakarta = getStoreLocalDate(storeJakarta.timezone)
    const todayJayapura = getStoreLocalDate(storeJayapura.timezone)

    const jktRes = await createPO(storeJakarta.id, ingredientJakarta, supplierJakarta, {
      dueDate: addDays(todayJakarta, 1)
    })
    const jypRes = await request(app)
      .post('/purchase-order/create')
      .set('Authorization', `Bearer ${adminJayapuraToken}`)
      .send({
        store: storeJayapura.id,
        status: 'ordered',
        paymentMethod: 'credit',
        dueDate: addDays(todayJayapura, 1),
        items: [
          {
            ingredient: ingredientJayapura.id,
            ingredientName: ingredientJayapura.name,
            quantity: 1,
            price: 100000,
            supplier: supplierJayapura.id
          }
        ]
      })
    expect(jktRes.status).toBe(201)
    expect(jypRes.status).toBe(201)

    await generateApReminders()

    const jktEvent = await db.ap_reminder_event.findOne({ where: { purchaseOrder: jktRes.body.data.id } })
    const jypEvent = await db.ap_reminder_event.findOne({ where: { purchaseOrder: jypRes.body.data.id } })
    expect(jktEvent.store).toBe(storeJakarta.id)
    expect(jypEvent.store).toBe(storeJayapura.id)
    expect(jktEvent.store).not.toBe(jypEvent.store)
  })
})

describe('generateApReminders — timezone correctness', () => {
  test('the same real "now" classifies differently per store timezone at the midnight boundary', async () => {
    // 16:00 UTC: Jakarta (+7) = 23:00 same day; Jayapura (+9) = next day 01:00.
    const instant = new Date()
    instant.setUTCHours(16, 0, 0, 0)

    const jktLocalToday = getStoreLocalDate('Asia/Jakarta', instant)
    const jypLocalToday = getStoreLocalDate('Asia/Jayapura', instant)
    // These MUST differ at this boundary — if they don't (e.g. test run
    // near a DST-irrelevant edge), the boundary assumption baked into
    // this test no longer holds, so skip rather than false-fail.
    if (jktLocalToday === jypLocalToday) {
      return
    }

    const jktRes = await createPO(storeJakarta.id, ingredientJakarta, supplierJakarta, {
      dueDate: jktLocalToday
    })
    const jypRes = await request(app)
      .post('/purchase-order/create')
      .set('Authorization', `Bearer ${adminJayapuraToken}`)
      .send({
        store: storeJayapura.id,
        status: 'ordered',
        paymentMethod: 'credit',
        dueDate: jypLocalToday,
        items: [
          {
            ingredient: ingredientJayapura.id,
            ingredientName: ingredientJayapura.name,
            quantity: 1,
            price: 100000,
            supplier: supplierJayapura.id
          }
        ]
      })
    expect(jktRes.status).toBe(201)
    expect(jypRes.status).toBe(201)

    await generateApReminders({ now: instant })

    const jktEvent = await db.ap_reminder_event.findOne({ where: { purchaseOrder: jktRes.body.data.id } })
    const jypEvent = await db.ap_reminder_event.findOne({ where: { purchaseOrder: jypRes.body.data.id } })
    expect(jktEvent.classification).toBe('DUE_TODAY')
    expect(jypEvent.classification).toBe('DUE_TODAY')
    expect(jktEvent.businessDate).not.toBe(jypEvent.businessDate)
  })
})
