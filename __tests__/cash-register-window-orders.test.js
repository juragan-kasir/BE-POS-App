process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 39 Batch 4: /order/get-orders?cashRegisterId=<id> must return the
// orders inside the register lifecycle window (openedAt..closedAt on
// order.createdAt, inclusive on both ends) — never the opening calendar
// date. Mirrors the reported register #11 case:
//
//   opened: 2026-09-14 14:48:27 +07:00
//   closed: 2026-09-21 11:27:48 +07:00
//
// A transaction on 2026-09-14 14:00 (same calendar date, before opening)
// and one on 2026-09-21 12:00 (same calendar date, after closing) must be
// EXCLUDED even though a `date=` filter would include them.

const SUFFIX = Date.now()

// Register #11 window, Asia/Jakarta wall times from the user report.
const OPENED_AT = new Date('2026-09-14T14:48:27+07:00')
const CLOSED_AT = new Date('2026-09-21T11:27:48+07:00')

let store = null
let storeOther = null
let opener = null
let adminToken = null
let otherStoreAdminToken = null
let register = null
let registerOtherWindow = null
let openRegister = null

const orderIds = {}
let otherStoreOrder = null
// Phase 39 Batch 5 (W13/W14): order ids that get order_item rows attached,
// tracked separately so afterAll can clean those up explicitly — the rest
// of this suite's orders never get items, so the blanket order.destroy
// below never had order_item rows to worry about.
const multiItemOrderIds = []

async function mkOrder(name, overrides) {
  const row = await db.order.create({
    orderNumber: `CRW-${name}-${SUFFIX}`,
    store: store.id,
    createdBy: opener.id,
    status: 'served',
    paymentStatus: 'paid',
    source: 'pos',
    paymentMethod: 'cash',
    totalPrice: 10000,
    ...overrides
  })
  orderIds[name] = row.id
  return row
}

beforeAll(async () => {
  store = await db.location.create(await withTestTenant({ name: `CRW_STORE_${SUFFIX}` }))
  storeOther = await db.location.create(await withTestTenant({ name: `CRW_STORE_OTHER_${SUFFIX}` }))

  opener = await db.user.create({
    userName: `crw_opener_${SUFFIX}`,
    roleType: 'admin',
    store: store.id,
    password: 'x'
  })
  const otherStoreAdmin = await db.user.create({
    userName: `crw_other_admin_${SUFFIX}`,
    roleType: 'admin',
    store: storeOther.id,
    password: 'x'
  })
  adminToken = await signSessionToken(
    { id: opener.id, userName: opener.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  otherStoreAdminToken = await signSessionToken(
    { id: otherStoreAdmin.id, userName: otherStoreAdmin.userName, roleType: 'admin', store: storeOther.id },
    JWT_SECRET
  )

  register = await db.cashRegister.create({
    store: store.id,
    user: opener.id,
    shift: 11,
    openingBalance: 150000,
    closingBalance: 166650,
    status: 'closed',
    openedAt: OPENED_AT,
    closedAt: CLOSED_AT
  })
  // Another register in the same store with a disjoint later window.
  registerOtherWindow = await db.cashRegister.create({
    store: store.id,
    user: opener.id,
    shift: 12,
    openingBalance: 100000,
    closingBalance: 100000,
    status: 'closed',
    openedAt: new Date('2026-09-22T09:00:00+07:00'),
    closedAt: new Date('2026-09-22T17:00:00+07:00')
  })
  // Still-open register: window runs to now.
  openRegister = await db.cashRegister.create({
    store: store.id,
    user: opener.id,
    shift: 13,
    openingBalance: 50000,
    status: 'open',
    openedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    closedAt: null
  })

  // A: same calendar date as opening, BEFORE opening time → EXCLUDED.
  await mkOrder('SAME_DAY_BEFORE_OPEN', { createdAt: new Date('2026-09-14T14:00:00+07:00') })
  // B: exactly at opening → INCLUDED.
  await mkOrder('EDGE_OPEN', { createdAt: new Date(OPENED_AT.getTime()) })
  // C: mid-window → INCLUDED.
  await mkOrder('MID_15', { createdAt: new Date('2026-09-15T10:00:00+07:00') })
  // D: mid-window → INCLUDED.
  await mkOrder('MID_20', { createdAt: new Date('2026-09-20T23:59:59+07:00') })
  // E: exactly at closing → INCLUDED.
  await mkOrder('EDGE_CLOSE', { createdAt: new Date(CLOSED_AT.getTime()) })
  // F: same calendar date as closing, AFTER closing time → EXCLUDED.
  await mkOrder('SAME_DAY_AFTER_CLOSE', { createdAt: new Date('2026-09-21T12:00:00+07:00') })
  // G: inside another register's window, outside this one → EXCLUDED.
  await mkOrder('OTHER_REGISTER', { createdAt: new Date('2026-09-22T10:00:00+07:00') })
  // Open-register window probes (relative to now, deterministic).
  await mkOrder('OPEN_REG_BEFORE_NOW', {
    createdAt: new Date(Date.now() - 60 * 60 * 1000),
    orderNumber: `CRW-OPEN-BEFORE-${SUFFIX}`
  })
  await mkOrder('OPEN_REG_FUTURE', {
    createdAt: new Date(Date.now() + 60 * 60 * 1000),
    orderNumber: `CRW-OPEN-FUTURE-${SUFFIX}`
  })
  // H: another store, timestamp inside the window → EXCLUDED.
  otherStoreOrder = await db.order.create({
    orderNumber: `CRW-OTHERSTORE-${SUFFIX}`,
    store: storeOther.id,
    createdBy: opener.id,
    createdAt: new Date('2026-09-16T10:00:00+07:00'),
    paymentStatus: 'paid',
    status: 'served',
    source: 'pos',
    paymentMethod: 'cash',
    totalPrice: 628830
  })
})

afterAll(async () => {
  await db.order_item.destroy({ where: { order: multiItemOrderIds }, force: true }).catch(() => {})
  await db.order.destroy({ where: { store: [store?.id, storeOther?.id].filter(Boolean) }, force: true }).catch(() => {})
  await db.cashRegister.destroy({ where: { id: [register?.id, registerOtherWindow?.id, openRegister?.id].filter(Boolean) }, force: true }).catch(() => {})
  await db.user.destroy({ where: { store: [store?.id, storeOther?.id].filter(Boolean) }, force: true }).catch(() => {})
  await db.location.destroy({ where: { id: [store?.id, storeOther?.id].filter(Boolean) }, force: true }).catch(() => {})
})

const getOrders = (query, token = adminToken) =>
  request(app).get('/order/get-orders').query(query).set('Authorization', `Bearer ${token}`)

describe('Phase 39 Batch 4 — register-window order querying', () => {
  test('W1 — returns exactly the in-window orders for a multi-day register', async () => {
    const res = await getOrders({ store: store.id, cashRegisterId: register.id, limit: 100 })
    expect(res.status).toBe(200)
    const ids = res.body.data.map((o) => o.id)
    for (const name of ['EDGE_OPEN', 'MID_15', 'MID_20', 'EDGE_CLOSE']) {
      expect(ids).toContain(orderIds[name])
    }
  })

  test('W2 — excludes same-day-before-open and same-day-after-close (calendar-date regression)', async () => {
    const res = await getOrders({ store: store.id, cashRegisterId: register.id, limit: 100 })
    expect(res.status).toBe(200)
    const ids = res.body.data.map((o) => o.id)
    // A `date=2026-09-14` filter would include SAME_DAY_BEFORE_OPEN and a
    // `date=2026-09-21` filter would include SAME_DAY_AFTER_CLOSE — the
    // exact bug this suite guards against.
    expect(ids).not.toContain(orderIds.SAME_DAY_BEFORE_OPEN)
    expect(ids).not.toContain(orderIds.SAME_DAY_AFTER_CLOSE)
  })

  test('W3 — boundaries are inclusive on both ends', async () => {
    const res = await getOrders({ store: store.id, cashRegisterId: register.id, limit: 100 })
    const ids = res.body.data.map((o) => o.id)
    expect(ids).toContain(orderIds.EDGE_OPEN)
    expect(ids).toContain(orderIds.EDGE_CLOSE)
  })

  test('W4 — excludes another-register and another-store transactions', async () => {
    const res = await getOrders({ store: store.id, cashRegisterId: register.id, limit: 100 })
    const ids = res.body.data.map((o) => o.id)
    expect(ids).not.toContain(orderIds.OTHER_REGISTER)
    expect(ids).not.toContain(otherStoreOrder.id)
  })

  test('W5 — open register windows to now', async () => {
    const res = await getOrders({ store: store.id, cashRegisterId: openRegister.id, limit: 100 })
    expect(res.status).toBe(200)
    const ids = res.body.data.map((o) => o.id)
    expect(ids).toContain(orderIds.OPEN_REG_BEFORE_NOW)
    expect(ids).not.toContain(orderIds.OPEN_REG_FUTURE)
  })

  test('W6 — unknown register is 404', async () => {
    const res = await getOrders({ store: store.id, cashRegisterId: 999999999 })
    expect(res.status).toBe(404)
  })

  test('W7 — cross-store register access stays forbidden', async () => {
    // The middleware passes (store == caller's own store) so this 403
    // proves the register-level store check, not just the middleware.
    const res = await getOrders(
      { store: storeOther.id, cashRegisterId: register.id },
      otherStoreAdminToken
    )
    expect(res.status).toBe(403)
  })

  test('W8 — calendar-date filtering still works for general consumers', async () => {
    const res = await getOrders({ store: store.id, date: '2026-09-15', limit: 100 })
    expect(res.status).toBe(200)
    const ids = res.body.data.map((o) => o.id)
    expect(ids).toContain(orderIds.MID_15)
    expect(ids).not.toContain(orderIds.MID_20)
  })

  test('W9 — pagination shape and ordering are preserved', async () => {
    const res = await getOrders({ store: store.id, cashRegisterId: register.id, limit: 2, page: 1 })
    expect(res.status).toBe(200)
    expect(res.body.pagination).toMatchObject({ page: 1, limit: 2 })
    expect(res.body.data.length).toBeLessThanOrEqual(2)
    const created = res.body.data.map((o) => new Date(o.createdAt).getTime())
    const sorted = [...created].sort((a, b) => b - a)
    expect(created).toEqual(sorted)
  })

  test('W10 — window=outside lists exactly the OUTSIDE_WINDOW bucket population', async () => {
    const res = await getOrders({ store: store.id, cashRegisterId: register.id, window: 'outside', limit: 100 })
    expect(res.status).toBe(200)
    const ids = res.body.data.map((o) => o.id)
    // Same-day-outside orders that the old calendar-date table could never
    // explain are listed here…
    expect(ids).toContain(orderIds.SAME_DAY_BEFORE_OPEN)
    expect(ids).toContain(orderIds.SAME_DAY_AFTER_CLOSE)
    expect(ids).toContain(orderIds.OTHER_REGISTER)
    // …while in-window and other-store orders are not.
    for (const name of ['EDGE_OPEN', 'MID_15', 'MID_20', 'EDGE_CLOSE']) {
      expect(ids).not.toContain(orderIds[name])
    }
    const otherStoreOrder = await db.order.findOne({
      where: { orderNumber: `CRW-OTHERSTORE-${SUFFIX}` }
    })
    expect(ids).not.toContain(otherStoreOrder.id)
    // 1:1 parity with the z-report reconciliation bucket (same membership
    // semantics, only the time predicate inverted).
    const z = await request(app)
      .get(`/cash-register/z-report/${register.id}`)
      .query({ store: store.id })
      .set('Authorization', `Bearer ${adminToken}`)
    expect(z.status).toBe(200)
    const bucket = (z.body.data.reconciliation.sales.excluded || []).find(
      (b) => b.code === 'OUTSIDE_WINDOW'
    )
    expect(bucket).toBeDefined()
    expect(new Set(ids)).toEqual(new Set(bucket.orderIds))
    expect(res.body.pagination.total).toBe(bucket.count)
  })

  test('W11 — window=outside on an unknown register is 404', async () => {
    const res = await getOrders({ store: store.id, cashRegisterId: 999999999, window: 'outside' })
    expect(res.status).toBe(404)
  })

  test('W12 — history rows carry the outside-window population', async () => {
    const res = await request(app)
      .get('/cash-register/history')
      .query({ store: store.id, limit: 50 })
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    const row = res.body.data.find((r) => r.id === register.id)
    expect(row).toBeDefined()
    expect(row.outsideWindow).toBeDefined()
    // Parity with the reconciliation bucket for the same register.
    const z = await request(app)
      .get(`/cash-register/z-report/${register.id}`)
      .query({ store: store.id })
      .set('Authorization', `Bearer ${adminToken}`)
    const bucket = (z.body.data.reconciliation.sales.excluded || []).find(
      (b) => b.code === 'OUTSIDE_WINDOW'
    )
    expect(row.outsideWindow.count).toBe(bucket.count)
    expect(row.outsideWindow.total).toBe(bucket.total)
  })

  // Phase 39 Batch 5: getOrdersByStore's findAndCountAll includes `items`
  // (order.hasMany(order_item)). Without `distinct: true`, Sequelize's
  // generated COUNT joins order_item and counts one row per item instead
  // of per order — rows stay correctly deduplicated, but pagination.total
  // gets inflated for any order with 2+ items. This is exactly what
  // produced the reported 31 (reconciliation, joinless SQL) vs 44
  // (this endpoint, joined COUNT) mismatch. W1-W12 never caught it because
  // mkOrder() never attaches order_item rows.
  test('W13 — window=outside counts a multi-item order once, not once per item', async () => {
    const order = await mkOrder('MULTI_ITEM_OUTSIDE', {
      // Before OPENED_AT (2026-09-14 14:48:27) → outside window.
      createdAt: new Date('2026-09-13T10:00:00+07:00')
    })
    multiItemOrderIds.push(order.id)
    await db.order_item.bulkCreate([
      { order: order.id, product: 1, quantity: 1, price: 5000, totalPrice: 5000 },
      { order: order.id, product: 2, quantity: 1, price: 5000, totalPrice: 5000 }
    ])

    const res = await getOrders({ store: store.id, cashRegisterId: register.id, window: 'outside', limit: 100 })
    expect(res.status).toBe(200)
    // Returned exactly once, not once per OrderItem.
    const matches = res.body.data.filter((o) => o.id === order.id)
    expect(matches).toHaveLength(1)
    // pagination.total counts distinct orders, matching the fetched page.
    expect(res.body.pagination.total).toBe(res.body.data.length)

    // 1:1 parity with the joinless reconciliation bucket — this is the
    // assertion that fails without `distinct: true` (total would be
    // bucket.count + 1 extra from the second item).
    const z = await request(app)
      .get(`/cash-register/z-report/${register.id}`)
      .query({ store: store.id })
      .set('Authorization', `Bearer ${adminToken}`)
    const bucket = (z.body.data.reconciliation.sales.excluded || []).find(
      (b) => b.code === 'OUTSIDE_WINDOW'
    )
    expect(bucket).toBeDefined()
    expect(bucket.orderIds).toContain(order.id)
    expect(res.body.pagination.total).toBe(bucket.count)
  })

  test('W14 — in-window query counts a multi-item order once, not once per item', async () => {
    const order = await mkOrder('MULTI_ITEM_IN_WINDOW', {
      // Mid-window → included.
      createdAt: new Date('2026-09-16T10:00:00+07:00')
    })
    multiItemOrderIds.push(order.id)
    await db.order_item.bulkCreate([
      { order: order.id, product: 1, quantity: 1, price: 7500, totalPrice: 7500 },
      { order: order.id, product: 2, quantity: 1, price: 7500, totalPrice: 7500 }
    ])

    const res = await getOrders({ store: store.id, cashRegisterId: register.id, limit: 100 })
    expect(res.status).toBe(200)
    const matches = res.body.data.filter((o) => o.id === order.id)
    expect(matches).toHaveLength(1)
    // pagination.total is not multiplied by the item count.
    expect(res.body.pagination.total).toBe(res.body.data.length)
  })
})
