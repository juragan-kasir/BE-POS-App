process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const crypto = require('crypto')
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// BA gap 019 (DR-09): an unpaid pending QR order expires after the
// launch-configurable QR_PENDING_EXPIRY_MINUTES, so an abandoned order
// never keeps its table locked. Expiry is off while the variable is unset.

const unique = (p) => `${p}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
const CRON_SECRET = 'x'.repeat(40)

let store = null
let category = null
let product = null
let adminToken = null
const tables = []

const makeTable = async () => {
  const table = await db.table.create({ store: store.id, name: unique('EXP_TABLE') })
  tables.push(table.id)
  return table
}

const qrOrder = (table) =>
  request(app)
    .post('/order/customer-create')
    .send({
      store: store.id,
      tableId: table.id,
      customerName: 'Tamu',
      items: [{ productId: product.id, productName: product.nameProduct, quantity: 1 }],
      idempotencyKey: unique('expkey')
    })

const ageOrder = (orderId, minutes) =>
  db.sequelize.query(
    `UPDATE "order" SET "createdAt" = NOW() - (:minutes || ' minutes')::interval WHERE id = :orderId`,
    { replacements: { orderId, minutes: String(minutes) } }
  )

const withExpiry = async (minutes, fn) => {
  const saved = process.env.QR_PENDING_EXPIRY_MINUTES
  if (minutes == null) delete process.env.QR_PENDING_EXPIRY_MINUTES
  else process.env.QR_PENDING_EXPIRY_MINUTES = String(minutes)
  try {
    return await fn()
  } finally {
    if (saved === undefined) delete process.env.QR_PENDING_EXPIRY_MINUTES
    else process.env.QR_PENDING_EXPIRY_MINUTES = saved
  }
}

beforeAll(async () => {
  process.env.CRON_SECRET = CRON_SECRET
  store = await db.location.create({ name: unique('EXP_STORE'), status: 'active' })
  category = await db.category.create({ name: unique('EXP_CAT') })
  product = await db.product.create({
    nameProduct: unique('EXP_PRODUCT'),
    category: category.id,
    price: 10000,
    stock: 1000,
    isAvailable: true
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 1000 })
  await db.taxConfig.create({ store: store.id, name: unique('EXP_PPN'), rate: 0, type: 'ppn', status: 'active' })
  const admin = await db.user.create({
    userName: unique('exp_admin'),
    email: `${unique('exp_admin')}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: admin.id, userName: admin.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  const open = await request(app)
    .post('/cash-register/open')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ store: store.id, openingBalance: 0, shift: 1 })
  if (![200, 201].includes(open.status)) throw new Error('register: ' + JSON.stringify(open.body))
})

afterAll(async () => {
  const orders = (await db.order.findAll({ where: { store: store?.id }, paranoid: false })).map((o) => o.id)
  await db.auditLog.destroy({ where: { entity: 'order', entityId: orders } }).catch(() => {})
  await db.transaction.destroy({ where: { order: orders }, force: true })
  await db.order_status.destroy({ where: { order: orders }, force: true })
  await db.order_item.destroy({ where: { order: orders }, force: true })
  await db.order.destroy({ where: { id: orders }, force: true })
  const registers = (await db.cashRegister.findAll({ where: { store: store?.id } })).map((r) => r.id)
  await db.cashMovement.destroy({ where: { cashRegisterId: registers }, force: true })
  await db.cashRegister.destroy({ where: { store: store?.id }, force: true })
  await db.best_selling.destroy({ where: { store: store?.id }, force: true })
  await db.stock_history.destroy({ where: { store: store?.id }, force: true })
  await db.product_store_stock.destroy({ where: { store: store?.id }, force: true })
  await db.taxConfig.destroy({ where: { store: store?.id }, force: true })
  await db.table.destroy({ where: { id: tables }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { store: store?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('BA 019 QR pending order expiry (DR-09)', () => {
  test('expiry is off while QR_PENDING_EXPIRY_MINUTES is unset: an old order keeps its table', async () => {
    await withExpiry(null, async () => {
      const table = await makeTable()
      const first = await qrOrder(table)
      expect(first.status).toBe(201)
      await ageOrder(first.body.data.id, 600)
      const second = await qrOrder(table)
      expect(second.status).toBe(400)
      expect((await db.order.findByPk(first.body.data.id)).status).toBe('pending')
    })
  })

  test('a stale unpaid order expires when the next diner orders: cancelled, noted, audited, table reused', async () => {
    await withExpiry(30, async () => {
      const table = await makeTable()
      const first = await qrOrder(table)
      expect(first.status).toBe(201)
      expect((await db.table.findByPk(table.id)).status).toBe('occupied')
      await ageOrder(first.body.data.id, 31)

      const second = await qrOrder(table)
      expect(second.status).toBe(201)

      const expired = await db.order.findByPk(first.body.data.id)
      expect(expired.status).toBe('cancelled')
      const [note] = await db.order_status.findAll({
        where: { order: expired.id, status: 'cancelled' },
        limit: 1
      })
      expect(note.notes).toMatch(/expired/)
      const [audit] = await db.auditLog.findAll({
        where: { entity: 'order', entityId: expired.id, action: 'status_change' },
        limit: 1
      })
      expect(audit).toBeDefined()
      expect(audit.actorType).toBe('SYSTEM')
      expect((await db.table.findByPk(table.id)).status).toBe('occupied')
    })
  })

  test('an order younger than the expiry keeps its table', async () => {
    await withExpiry(30, async () => {
      const table = await makeTable()
      const first = await qrOrder(table)
      await ageOrder(first.body.data.id, 10)
      expect((await qrOrder(table)).status).toBe(400)
      expect((await db.order.findByPk(first.body.data.id)).status).toBe('pending')
    })
  })

  test('an order with money collected, or already confirmed by staff, never expires', async () => {
    await withExpiry(30, async () => {
      const paidTable = await makeTable()
      const partly = await qrOrder(paidTable)
      await ageOrder(partly.body.data.id, 120)
      await db.transaction.create({ order: partly.body.data.id, typePayment: 'CASH', amount: 1000 })
      expect((await qrOrder(paidTable)).status).toBe(400)
      expect((await db.order.findByPk(partly.body.data.id)).status).toBe('pending')

      const confirmedTable = await makeTable()
      const confirmed = await qrOrder(confirmedTable)
      await ageOrder(confirmed.body.data.id, 120)
      await db.order.update({ status: 'confirmed' }, { where: { id: confirmed.body.data.id } })
      expect((await qrOrder(confirmedTable)).status).toBe(400)
      expect((await db.order.findByPk(confirmed.body.data.id)).status).toBe('confirmed')
    })
  })

  test('a POS dine-in sale on a table held by a stale QR order frees it first', async () => {
    await withExpiry(30, async () => {
      const table = await makeTable()
      const first = await qrOrder(table)
      await ageOrder(first.body.data.id, 45)
      const res = await request(app)
        .post('/order/create')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          store: store.id,
          tableId: table.id,
          items: [{ product: product.id, productName: product.nameProduct, quantity: 1 }],
          paymentMethod: 'cash',
          cashierName: 'EXP',
          idempotencyKey: unique('exppos')
        })
      expect(res.status).toBe(201)
      expect((await db.order.findByPk(first.body.data.id)).status).toBe('cancelled')
    })
  })

  test('an expiry failure never breaks ordering: the table is judged as it stands', async () => {
    await withExpiry(30, async () => {
      const table = await makeTable()
      const first = await qrOrder(table)
      await ageOrder(first.body.data.id, 60)
      const spy = jest.spyOn(db.order_status, 'create').mockRejectedValueOnce(new Error('audit down'))
      let res
      try {
        res = await qrOrder(table)
      } finally {
        spy.mockRestore()
      }
      expect(res.status).toBe(400)
      expect((await db.order.findByPk(first.body.data.id)).status).toBe('pending')
    })
  })

  test('the cron sweep needs the secret, is a no-op while off, and expires stale orders', async () => {
    const table = await makeTable()
    const first = await qrOrder(table)
    await ageOrder(first.body.data.id, 90)

    const noSecret = await request(app).get('/internal/qr-orders/expire')
    expect([401, 403]).toContain(noSecret.status)

    await withExpiry(null, async () => {
      const off = await request(app)
        .get('/internal/qr-orders/expire')
        .set('Authorization', `Bearer ${CRON_SECRET}`)
      expect(off.status).toBe(200)
      expect(off.body.enabled).toBe(false)
      expect((await db.order.findByPk(first.body.data.id)).status).toBe('pending')
    })

    await withExpiry(60, async () => {
      const on = await request(app)
        .get('/internal/qr-orders/expire')
        .set('Authorization', `Bearer ${CRON_SECRET}`)
      expect(on.status).toBe(200)
      expect(on.body.enabled).toBe(true)
      expect(on.body.orders).toContain(first.body.data.id)
      expect((await db.order.findByPk(first.body.data.id)).status).toBe('cancelled')
      expect((await db.table.findByPk(table.id)).status).toBe('available')
      const [audit] = await db.auditLog.findAll({
        where: { entity: 'order', entityId: first.body.data.id, action: 'status_change' },
        limit: 1
      })
      expect(audit.actorType).toBe('JOB')
    })
  })
})

// BISA showed every cancelled order as "Ditolak oleh kasir", including the
// ones the system expired. The public order endpoints now say how an order
// ended — coarsely, never exposing staff notes.
describe('public order endReason (expired vs cancelled)', () => {
  const qrOrderWithSession = (table, session) =>
    request(app)
      .post('/order/customer-create')
      .send({
        store: store.id,
        tableId: table.id,
        customerName: 'Tamu',
        session,
        items: [{ productId: product.id, productName: product.nameProduct, quantity: 1 }],
        idempotencyKey: unique('endkey')
      })

  test('an expired order reads endReason "expired"; a staff cancel reads "cancelled"; open orders null', async () => {
    await withExpiry(30, async () => {
      const session = `diner-${crypto.randomBytes(6).toString('hex')}`
      const tableA = await makeTable()
      const expiredOrder = await qrOrderWithSession(tableA, session)
      expect(expiredOrder.status).toBe(201)
      await ageOrder(expiredOrder.body.data.id, 31)
      const next = await qrOrderWithSession(tableA, session) // triggers the expiry
      expect(next.status).toBe(201)

      const tableB = await makeTable()
      const staffCancelled = await qrOrderWithSession(tableB, session)
      const cancel = await request(app)
        .put('/order/update-status')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ id: staffCancelled.body.data.id, status: 'cancelled', notes: 'expired: typed by staff' })
      expect(cancel.status).toBe(200)

      const read = async (id) => {
        const row = await db.order.findByPk(id, { attributes: ['publicToken'] })
        return request(app).get(`/order/customer-order/${row.publicToken}`)
      }
      expect((await read(expiredOrder.body.data.id)).body.data.endReason).toBe('expired')
      expect((await read(next.body.data.id)).body.data.endReason).toBeNull()

      const list = await request(app)
        .get('/order/customer-orders')
        .query({ store: store.id, tableId: tableA.id, session })
      const byId = new Map(list.body.data.map((o) => [o.id, o]))
      expect(byId.get(expiredOrder.body.data.id).endReason).toBe('expired')
      expect(byId.get(next.body.data.id).endReason).toBeNull()
      // no staff note ever reaches the diner
      expect(JSON.stringify(list.body)).not.toMatch(/unpaid QR order after/)

      // A staff cancel is "cancelled" even when the staff note mimics the
      // expiry text: only the system's own expiry row counts.
      const staffRow = await read(staffCancelled.body.data.id)
      expect(staffRow.body.data.endReason).toBe('cancelled')
    })
  })
})
