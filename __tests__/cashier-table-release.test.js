process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// Client request 2026-10-20 / BA DR-24 C-16 amended: the cashier can put a
// table back to "available" from the cashier screen. A kasir may release
// only a table without an unpaid open order; admin/owner may release any.
// A reason is always required and every release is audited.

const crypto = require('crypto')
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const IDS = { kasirA: 9851, adminA: 9852, staffA: 9853, kasirB: 9854 }

let storeA
let storeB
const tok = {}
const T = {}

const makeOrder = (table, fields) =>
  db.order.create({
    orderNumber: `CTR-${crypto.randomBytes(5).toString('hex')}`,
    store: table.store,
    tableId: table.id,
    source: 'qr',
    subTotal: 20000,
    totalPrice: 20000,
    ...fields
  })

const release = (who, table, body = { reason: 'Tamu sudah pulang' }) =>
  request(app)
    .put(`/pos/tables/${table.id}/release`)
    .set('Authorization', `Bearer ${tok[who]}`)
    .send(body)

const statusList = (who, storeId) =>
  request(app)
    .get('/pos/tables/status')
    .query({ storeId })
    .set('Authorization', `Bearer ${tok[who]}`)

const statusOf = async (table) => (await db.table.findByPk(table.id)).status

beforeAll(async () => {
  storeA = await db.location.create({ name: 'CTR Store A', status: 'active' })
  storeB = await db.location.create({ name: 'CTR Store B', status: 'active' })
  const users = [
    [IDS.kasirA, 'kasir', storeA.id],
    [IDS.adminA, 'admin', storeA.id],
    [IDS.staffA, 'user', storeA.id],
    [IDS.kasirB, 'kasir', storeB.id]
  ]
  for (const [id, roleType, store] of users) {
    await db.user.create({
      id,
      userName: `ctr_${roleType}_${id}`,
      email: `ctr-${id}@test.com`,
      roleType,
      userType: roleType === 'admin' ? 'admin' : 'user',
      store,
      status: 'active'
    })
  }
  for (const [key, id] of Object.entries(IDS)) {
    const user = await db.user.findByPk(id)
    tok[key] = await signSessionToken(
      {
        id,
        userName: user.userName,
        roleType: user.roleType,
        store: user.store
      },
      JWT_SECRET
    )
  }
})

beforeEach(async () => {
  const mk = (name, status, store = storeA.id) =>
    db.table.create({ store, name, status, capacity: 4 })
  T.paidDineIn = await mk(`CTR-PAID-${Date.now()}`, 'occupied')
  await makeOrder(T.paidDineIn, {
    source: 'pos',
    status: 'served',
    paymentStatus: 'paid'
  })
  T.unpaidQr = await mk(`CTR-UNPAID-${Date.now()}`, 'occupied')
  await makeOrder(T.unpaidQr, { status: 'pending', paymentStatus: 'unpaid' })
  T.reserved = await mk(`CTR-RES-${Date.now()}`, 'reserved')
  T.reservation = await db.reservation.create({
    store: storeA.id,
    tableId: T.reserved.id,
    customerName: 'Pak Budi',
    guestCount: 2,
    reservationDate: '2026-10-20',
    startTime: '19:00',
    status: 'confirmed'
  })
  T.maintenance = await mk(`CTR-MAINT-${Date.now()}`, 'maintenance')
  T.available = await mk(`CTR-AVAIL-${Date.now()}`, 'available')
  T.otherStore = await mk(`CTR-B-${Date.now()}`, 'occupied', storeB.id)
})

afterEach(async () => {
  const stores = [storeA.id, storeB.id]
  await db.order.destroy({ where: { store: stores }, force: true })
  await db.reservation.destroy({ where: { store: stores }, force: true })
  await db.table.destroy({ where: { store: stores }, force: true })
})

afterAll(async () => {
  await db.auditLog.destroy({
    where: { userId: Object.values(IDS) },
    force: true,
    __auditMaintenance: true
  })
  await db.user.destroy({ where: { id: Object.values(IDS) }, force: true })
  await db.location.destroy({
    where: { id: [storeA.id, storeB.id] },
    force: true
  })
})

describe('PUT /pos/tables/:id/release', () => {
  test('kasir releases a table whose guests already paid, with an audited reason', async () => {
    const res = await release('kasirA', T.paidDineIn)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ status: 'available', changed: true })
    expect(await statusOf(T.paidDineIn)).toBe('available')

    const audit = await db.auditLog.findOne({
      where: {
        entity: 'table',
        entityId: String(T.paidDineIn.id),
        userId: IDS.kasirA
      },
      order: [['id', 'DESC']]
    })
    expect(audit).not.toBeNull()
    expect(audit.reason).toBe('Tamu sudah pulang')
    expect(audit.metadata.channel).toBe('cashier')
    expect(audit.oldValues.status).toBe('occupied')
    expect(audit.newValues.status).toBe('available')
  })

  test('kasir releases a reserved table; its active reservation is closed', async () => {
    const res = await release('kasirA', T.reserved)
    expect(res.status).toBe(200)
    expect(await statusOf(T.reserved)).toBe('available')
    expect((await db.reservation.findByPk(T.reservation.id)).status).toBe(
      'completed'
    )
  })

  test('kasir cannot release a table with an unpaid open order — nothing changes', async () => {
    const res = await release('kasirA', T.unpaidQr)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('TABLE_HAS_UNPAID_ORDER')
    expect(res.body.data.unpaidOrders).toHaveLength(1)
    expect(await statusOf(T.unpaidQr)).toBe('occupied')
  })

  test('admin can release a table with an unpaid order; the override is audited', async () => {
    const res = await release('adminA', T.unpaidQr, {
      reason: 'Tamu pindah meja'
    })
    expect(res.status).toBe(200)
    expect(await statusOf(T.unpaidQr)).toBe('available')
    const audit = await db.auditLog.findOne({
      where: {
        entity: 'table',
        entityId: String(T.unpaidQr.id),
        userId: IDS.adminA
      },
      order: [['id', 'DESC']]
    })
    expect(audit.metadata.unpaidOrdersOverridden).toHaveLength(1)
  })

  test('maintenance stays admin-only', async () => {
    const byKasir = await release('kasirA', T.maintenance)
    expect(byKasir.status).toBe(409)
    expect(byKasir.body.code).toBe('TABLE_IN_MAINTENANCE')
    expect(await statusOf(T.maintenance)).toBe('maintenance')
    expect((await release('adminA', T.maintenance)).status).toBe(200)
  })

  test('a reason is required', async () => {
    for (const body of [{}, { reason: '   ' }]) {
      const res = await release('kasirA', T.paidDineIn, body)
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('RELEASE_REASON_REQUIRED')
    }
    expect(await statusOf(T.paidDineIn)).toBe('occupied')
  })

  test('an already-available table is a harmless no-op', async () => {
    const res = await release('kasirA', T.available)
    expect(res.status).toBe(200)
    expect(res.body.data.changed).toBe(false)
  })

  test("another store's table is not found and untouched", async () => {
    const res = await release('kasirA', T.otherStore)
    expect(res.status).toBe(404)
    expect(await statusOf(T.otherStore)).toBe('occupied')
  })

  test('staff without a cashier role cannot release', async () => {
    const res = await release('staffA', T.paidDineIn)
    expect(res.status).toBe(403)
    expect(await statusOf(T.paidDineIn)).toBe('occupied')
  })
})

describe('GET /pos/tables/status', () => {
  const byName = (list, table) => list.find((t) => t.id === table.id)

  test('kasir sees which tables they may reset, and why not', async () => {
    const res = await statusList('kasirA', storeA.id)
    expect(res.status).toBe(200)
    const list = res.body.data
    expect(byName(list, T.paidDineIn)).toMatchObject({
      canRelease: true,
      blockedReason: null
    })
    expect(byName(list, T.reserved)).toMatchObject({ canRelease: true })
    expect(byName(list, T.unpaidQr)).toMatchObject({
      canRelease: false,
      blockedReason: 'TABLE_HAS_UNPAID_ORDER'
    })
    expect(byName(list, T.unpaidQr).unpaidOrders).toHaveLength(1)
    expect(byName(list, T.maintenance)).toMatchObject({
      blockedReason: 'TABLE_IN_MAINTENANCE'
    })
    expect(byName(list, T.available)).toMatchObject({
      blockedReason: 'ALREADY_AVAILABLE'
    })
    expect(byName(list, T.otherStore)).toBeUndefined()
  })

  test('admin may reset unpaid and maintenance tables too', async () => {
    const list = (await statusList('adminA', storeA.id)).body.data
    expect(byName(list, T.unpaidQr).canRelease).toBe(true)
    expect(byName(list, T.maintenance).canRelease).toBe(true)
  })

  test("a kasir cannot list another store's tables", async () => {
    const res = await statusList('kasirB', storeA.id)
    expect(res.status).not.toBe(200)
    expect(JSON.stringify(res.body)).not.toContain('CTR-PAID')
  })
})
