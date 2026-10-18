process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

// DR-24 C-04 / DR-05 (§35.7): outlet closure is an archive, never a purge.
// POST /location/archive-location refuses to close a store that still has an
// open register, unsettled orders or in-transit stock transfers; a clean
// store flips to status 'archived' (audited, reversible via
// /location/reactivate-location). Archived stores are refused for new sales
// (counter + QR). The pre-existing destructive delete-location is untouched.

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
let uniqueSeq = 0
const unique = (prefix) => `${prefix}_${Date.now()}_${++uniqueSeq}`

const locations = []
const users = []
const orders = []

let superToken = null
let adminToken = null
let kasirToken = null
let adminStore = null

const createStore = async (name) => {
  const loc = await db.location.create({ name: name || unique('C04_STORE'), status: 'active' })
  locations.push(loc.id)
  return loc
}

const archive = (token, body) =>
  request(app).post('/location/archive-location').set('Authorization', `Bearer ${token}`).send(body)

const reactivate = (token, body) =>
  request(app).post('/location/reactivate-location').set('Authorization', `Bearer ${token}`).send(body)

const makeUnsettledOrder = async (storeId, status = 'pending') => {
  const order = await db.order.create({
    orderNumber: unique('C04-ORD'),
    store: storeId,
    status,
    paymentStatus: status === 'paid' ? 'paid' : 'unpaid',
    subTotal: 0,
    totalQuantity: 1,
    totalPrice: 0,
    totalCovers: 1,
    source: 'qr'
  })
  orders.push(order.id)
  return order
}

const makeOpenRegister = async (storeId, userId) => {
  await db.cashRegister.create({
    store: storeId,
    user: userId,
    status: 'open',
    openingBalance: 0,
    openedAt: new Date()
  })
}

beforeAll(async () => {
  adminStore = await createStore('C04_ADMIN_STORE')
  const superUser = await db.user.create({
    userName: unique('c04_super'),
    email: `${unique('c04_super_mail')}@test.com`,
    roleType: 'super_admin',
    userType: 'admin',
    store: null,
    status: 'active'
  })
  users.push(superUser.id)
  const adminUser = await db.user.create({
    userName: unique('c04_admin'),
    email: `${unique('c04_admin_mail')}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: adminStore.id,
    status: 'active'
  })
  users.push(adminUser.id)
  const kasirUser = await db.user.create({
    userName: unique('c04_kasir'),
    email: `${unique('c04_kasir_mail')}@test.com`,
    roleType: 'kasir',
    userType: 'user',
    store: adminStore.id,
    status: 'active'
  })
  users.push(kasirUser.id)

  superToken = await signSessionToken(
    { id: superUser.id, userName: superUser.userName, roleType: 'super_admin', store: null },
    JWT_SECRET
  )
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: adminStore.id },
    JWT_SECRET
  )
  kasirToken = await signSessionToken(
    { id: kasirUser.id, userName: kasirUser.userName, roleType: 'kasir', store: adminStore.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.authorizationContextSession.destroy({ where: { userId: users } })
  await db.auditLog.destroy({
    where: { entity: 'location', entityId: locations },
    force: true,
    __auditMaintenance: true
  })
  await db.stock_transfer.destroy({ where: { fromStore: locations }, force: true })
  await db.stock_transfer.destroy({ where: { toStore: locations }, force: true })
  await db.cashRegister.destroy({ where: { store: locations }, force: true })
  await db.order.destroy({ where: { id: orders }, force: true })
  await db.table.destroy({ where: { store: locations }, force: true })
  await db.user.destroy({ where: { id: users }, force: true })
  await db.location.destroy({ where: { id: locations }, force: true })
})

describe('archive/reactivate authorization and audit', () => {
  test('a kasir cannot archive or reactivate a store', async () => {
    const store = await createStore()
    expect((await archive(kasirToken, { id: store.id, reason: 'nope' })).status).toBe(403)
    expect((await reactivate(kasirToken, { id: store.id, reason: 'nope' })).status).toBe(403)
  })

  test('an admin cannot archive a store outside its own scope', async () => {
    const other = await createStore()
    const res = await archive(adminToken, { id: other.id, reason: 'other store' })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('STORE_SCOPE_DENIED')
    expect((await db.location.findByPk(other.id)).status).toBe('active')
  })

  test('archiving without a reason is refused before any change', async () => {
    const res = await archive(superToken, { id: adminStore.id })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('ARCHIVE_REASON_REQUIRED')
    expect((await db.location.findByPk(adminStore.id)).status).toBe('active')
  })

  test('a clean store is archived with an audit trail', async () => {
    const res = await archive(adminToken, { id: adminStore.id, reason: 'outlet relocated' })
    expect(res.status).toBe(200)
    expect((await db.location.findByPk(adminStore.id)).status).toBe('archived')

    const [row] = await db.auditLog.findAll({
      where: { entity: 'location', entityId: adminStore.id, action: 'status_change' },
      limit: 1
    })
    expect(row).toBeTruthy()
    expect(row.actorType).toBe('USER')
    expect(row.userId).toBe(users[1])
    expect(row.reason).toBe('outlet relocated')
    expect(row.oldValues?.status).toBe('active')
    expect(row.newValues?.status).toBe('archived')
  })

  test('reactivating a non-archived store is refused; an archived store can be reactivated with an audit trail', async () => {
    const store = await createStore()
    const early = await reactivate(superToken, { id: store.id, reason: 'early' })
    expect(early.status).toBe(400)
    expect(early.body.code).toBe('STORE_NOT_ARCHIVED')

    await archive(superToken, { id: store.id, reason: 'temporary closure' })
    const res = await reactivate(superToken, { id: store.id, reason: 'reopening' })
    expect(res.status).toBe(200)
    expect((await db.location.findByPk(store.id)).status).toBe('active')

    const [row] = await db.auditLog.findAll({
      where: {
        entity: 'location',
        entityId: store.id,
        action: 'status_change',
        userId: users[0]
      },
      order: [['id', 'DESC']],
      limit: 1
    })
    expect(row).toBeTruthy()
    expect(row.reason).toBe('reopening')
    expect(row.oldValues?.status).toBe('archived')
    expect(row.newValues?.status).toBe('active')
  })
})

describe('archive preconditions are fail-closed', () => {
  test('an open cash register blocks the archive', async () => {
    const store = await createStore()
    await makeOpenRegister(store.id, users[1])
    const res = await archive(superToken, { id: store.id, reason: 'close' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('STORE_HAS_OPEN_REGISTERS')
    expect((await db.location.findByPk(store.id)).status).toBe('active')
  })

  test('an unsettled order blocks the archive', async () => {
    const store = await createStore()
    await makeUnsettledOrder(store.id)
    const res = await archive(superToken, { id: store.id, reason: 'close' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('STORE_HAS_UNSETTLED_ORDERS')
    expect((await db.location.findByPk(store.id)).status).toBe('active')
  })

  test('an in-transit stock transfer blocks the archive (outbound and inbound)', async () => {
    const source = await createStore()
    const other = await createStore()
    await db.stock_transfer.create({
      transferNumber: unique('C04-TR'),
      fromStore: source.id,
      toStore: other.id,
      status: 'sent'
    })
    const outbound = await archive(superToken, { id: source.id, reason: 'close' })
    expect(outbound.status).toBe(409)
    expect(outbound.body.code).toBe('STORE_HAS_IN_TRANSIT_TRANSFERS')

    const inboundTarget = await createStore()
    await db.stock_transfer.create({
      transferNumber: unique('C04-TR'),
      fromStore: other.id,
      toStore: inboundTarget.id,
      status: 'approved'
    })
    const inbound = await archive(superToken, { id: inboundTarget.id, reason: 'close' })
    expect(inbound.status).toBe(409)
    expect(inbound.body.code).toBe('STORE_HAS_IN_TRANSIT_TRANSFERS')
  })

  test('a settled store archives cleanly (positive control)', async () => {
    const store = await createStore()
    await makeUnsettledOrder(store.id, 'paid')
    await db.stock_transfer.create({
      transferNumber: unique('C04-TR'),
      fromStore: store.id,
      toStore: adminStore.id,
      status: 'received'
    })
    const res = await archive(superToken, { id: store.id, reason: 'retired' })
    expect(res.status).toBe(200)
    expect((await db.location.findByPk(store.id)).status).toBe('archived')
  })
})

describe('archived stores are refused for new sales', () => {
  test('a counter sale to an archived store is refused before any write', async () => {
    const store = await createStore()
    await archive(superToken, { id: store.id, reason: 'closing' })

    const res = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${superToken}`)
      .send({
        store: store.id,
        items: [{ product: 1, quantity: 1 }],
        cashierName: 'C04',
        idempotencyKey: unique('c04-idem')
      })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('STORE_ARCHIVED')
    expect(await db.order.count({ where: { store: store.id } })).toBe(0)
  })

  test('a QR order against an archived store is refused before any write', async () => {
    const store = await createStore()
    const table = await db.table.create({ store: store.id, name: unique('C04_TABLE') })
    await archive(superToken, { id: store.id, reason: 'closing' })

    const res = await request(app)
      .post('/order/customer-create')
      .send({
        store: store.id,
        tableId: table.id,
        customerName: 'QR Guest',
        items: [{ productId: 1, quantity: 1 }]
      })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('STORE_ARCHIVED')
    expect(await db.order.count({ where: { store: store.id } })).toBe(0)
  })
})
