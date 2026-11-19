process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken, createAuthenticatedTestSession } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')
const { getStoreLocalDate } = require('../utils/businessDate')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 22 Batch 3 — Timezone-Aware Due Date Foundation + H-4
// Classification, integration coverage.
//
// Proves the AP dashboard (api/controller/purchasePayment.js) computes
// daysUntilDue/classification from each PO's OWN store's timezone (via
// purchase_order.storeData.timezone), not a single server-wide "now",
// and that this stays correctly store-isolated — a Store A admin sees
// only Store A's classification, never Store B's.

const addDays = (dateStr, n) => {
  const [y, m, d] = dateStr.split('-').map(Number)
  const t = Date.UTC(y, m - 1, d) + n * 86400000
  return new Date(t).toISOString().slice(0, 10)
}

let storeJakarta = null
let storeJayapura = null
let category = null
let ingredientJakarta = null
let ingredientJayapura = null
let supplierJakarta = null
let supplierJayapura = null
let adminJakartaUser = null
let adminJayapuraUser = null
let adminJakartaToken = null
let adminJayapuraToken = null

const nextTag = () => `AP_TZ_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

beforeAll(async () => {
  storeJakarta = await db.location.create(await withTestTenant({
    name: 'AP_TZ_STORE_JAKARTA',
    status: 'active',
    timezone: 'Asia/Jakarta'
  }))
  storeJayapura = await db.location.create(await withTestTenant({
    name: 'AP_TZ_STORE_JAYAPURA',
    status: 'active',
    timezone: 'Asia/Jayapura'
  }))
  category = await db.category.create({ name: 'AP_TZ_CATEGORY' })

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
    userName: 'admin_ap_tz_jkt',
    email: 'admin_ap_tz_jkt@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: storeJakarta.id,
    status: 'active'
  })
  adminJayapuraUser = await db.user.create({
    userName: 'admin_ap_tz_jyp',
    email: 'admin_ap_tz_jyp@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: storeJayapura.id,
    status: 'active'
  })
  adminJakartaToken = await signSessionToken(
    { id: adminJakartaUser.id, userName: adminJakartaUser.userName, roleType: 'admin', store: storeJakarta.id },
    JWT_SECRET
  )
  adminJayapuraToken = await signSessionToken(
    { id: adminJayapuraUser.id, userName: adminJayapuraUser.userName, roleType: 'admin', store: storeJayapura.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  for (const store of [storeJakarta, storeJayapura]) {
    const pos = await db.purchase_order.findAll({ where: { store: store.id }, attributes: ['id'] })
    const poIds = pos.map((p) => p.id)
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

const createCreditPO = (token, storeId, ingredient, supplier, dueDate) =>
  request(app)
    .post('/purchase-order/create')
    .set('Authorization', `Bearer ${token}`)
    .send({
      store: storeId,
      status: 'ordered',
      paymentMethod: 'credit',
      dueDate,
      items: [
        {
          ingredient: ingredient.id,
          ingredientName: ingredient.name,
          quantity: 1,
          price: 100000,
          supplier: supplier.id
        }
      ]
    })

describe('AP dashboard — daysUntilDue/classification are computed per-store, in that store own timezone', () => {
  let poH4 = null
  let poDueToday = null
  let poOverdue = null

  beforeAll(async () => {
    const todayJakarta = getStoreLocalDate(storeJakarta.timezone)
    const todayJayapura = getStoreLocalDate(storeJayapura.timezone)

    const h4Res = await createCreditPO(
      adminJakartaToken,
      storeJakarta.id,
      ingredientJakarta,
      supplierJakarta,
      addDays(todayJakarta, 4)
    )
    expect(h4Res.status).toBe(201)
    poH4 = h4Res.body.data

    const dueTodayRes = await createCreditPO(
      adminJayapuraToken,
      storeJayapura.id,
      ingredientJayapura,
      supplierJayapura,
      todayJayapura
    )
    expect(dueTodayRes.status).toBe(201)
    poDueToday = dueTodayRes.body.data

    const overdueRes = await createCreditPO(
      adminJakartaToken,
      storeJakarta.id,
      ingredientJakarta,
      supplierJakarta,
      addDays(todayJakarta, -1)
    )
    expect(overdueRes.status).toBe(201)
    poOverdue = overdueRes.body.data
  })

  test('a PO due in exactly 4 (store-local) days classifies as H-4', async () => {
    const res = await request(app)
      .get('/purchase-payment/ap-dashboard')
      .set('Authorization', `Bearer ${adminJakartaToken}`)
    expect(res.status).toBe(200)

    const entry = res.body.data.outstandingPOs.find((p) => p.id === poH4.id)
    expect(entry).toBeDefined()
    expect(entry.daysUntilDue).toBe(4)
    expect(entry.classification).toBe('H-4')
  })

  test('a PO due today (in its own store local date) classifies as DUE_TODAY', async () => {
    const res = await request(app)
      .get('/purchase-payment/ap-dashboard')
      .set('Authorization', `Bearer ${adminJayapuraToken}`)
    expect(res.status).toBe(200)

    const entry = res.body.data.outstandingPOs.find((p) => p.id === poDueToday.id)
    expect(entry).toBeDefined()
    expect(entry.daysUntilDue).toBe(0)
    expect(entry.classification).toBe('DUE_TODAY')
  })

  test('a PO one day past due classifies as OVERDUE and daysOverdue stays backward-compatible', async () => {
    const res = await request(app)
      .get('/purchase-payment/ap-dashboard')
      .set('Authorization', `Bearer ${adminJakartaToken}`)
    expect(res.status).toBe(200)

    const entry = res.body.data.outstandingPOs.find((p) => p.id === poOverdue.id)
    expect(entry).toBeDefined()
    expect(entry.daysUntilDue).toBe(-1)
    expect(entry.classification).toBe('OVERDUE')
    expect(entry.daysOverdue).toBe(1) // pre-existing metric, still correct
  })

  test('store isolation: Jakarta admin never sees the Jayapura PO, and vice versa', async () => {
    const jktRes = await request(app)
      .get('/purchase-payment/ap-dashboard')
      .set('Authorization', `Bearer ${adminJakartaToken}`)
    expect(jktRes.body.data.outstandingPOs.some((p) => p.id === poDueToday.id)).toBe(false)

    const jypRes = await request(app)
      .get('/purchase-payment/ap-dashboard')
      .set('Authorization', `Bearer ${adminJayapuraToken}`)
    expect(jypRes.body.data.outstandingPOs.some((p) => p.id === poH4.id)).toBe(false)
    expect(jypRes.body.data.outstandingPOs.some((p) => p.id === poOverdue.id)).toBe(false)
  })
})

describe('Location timezone — IANA validation and safe default', () => {
  test('an existing location without an explicit timezone backfills to Asia/Jakarta', async () => {
    const fresh = await db.location.findByPk(storeJakarta.id)
    // storeJakarta was created WITH an explicit timezone; this proves the
    // column/model default itself, independent of that explicit value,
    // by creating a second row with no timezone key at all.
    const legacyStyle = await db.location.create(await withTestTenant({ name: nextTag(), status: 'active' }))
    const legacyFresh = await db.location.findByPk(legacyStyle.id)
    expect(legacyFresh.timezone).toBe('Asia/Jakarta')
    expect(fresh.timezone).toBe('Asia/Jakarta')
    await db.location.destroy({ where: { id: legacyStyle.id }, force: true })
  })

  test('POST /location/add-new-location rejects a non-IANA timezone value', async () => {
    // AUTH-1 P2: a super_admin claim on an admin row no longer escalates;
    // this check needs a real global super_admin account.
    const { user: superUser, token: superToken } = await createAuthenticatedTestSession({
      userName: `super_ap_tz_${Date.now()}`,
      roleType: 'super_admin',
      userType: 'admin',
      store: null,
      password: 'x'
    })
    try {
      const res = await request(app)
        .post('/location/add-new-location')
        .set('Authorization', `Bearer ${superToken}`)
        .field('name', nextTag())
        .field('status', 'active')
        .field('timezone', 'WIB')
      expect(res.status).toBe(400)
    } finally {
      await db.user.destroy({ where: { id: superUser.id }, force: true }).catch(() => {})
    }
  })
})
