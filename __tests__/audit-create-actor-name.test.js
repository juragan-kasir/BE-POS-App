'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// createAudit read req.user.name || req.user.username, but the
// authorization middleware sets req.user.userName / fullName — so every
// legacy audit row (~130 call sites) was written with userName = null.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { createAudit } = require('../utils/auditLog')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const P = 'AUD_NAME_'
const uniq = (k) =>
  `${P}${k}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`

const ids = {
  users: [],
  stores: [],
  categories: [],
  products: [],
  orders: [],
  items: []
}
let store

beforeAll(async () => {
  store = await db.location.create({ name: uniq('STORE'), status: 'active' })
  ids.stores.push(store.id)
})

afterAll(async () => {
  await db.auditLog.destroy({
    where: { description: { [db.Sequelize.Op.like]: `${P}%` } },
    force: true,
    __auditMaintenance: true
  })
  await db.auditLog.destroy({
    where: { entity: 'order_item', entityId: ids.items },
    force: true,
    __auditMaintenance: true
  })
  await db.order_item.destroy({ where: { id: ids.items }, force: true })
  await db.order.destroy({ where: { id: ids.orders }, force: true })
  await db.product.destroy({ where: { id: ids.products }, force: true })
  await db.category.destroy({ where: { id: ids.categories }, force: true })
  await db.authorizationContextSession.destroy({ where: { userId: ids.users } })
  await db.user.destroy({ where: { id: ids.users }, force: true })
  await db.location.destroy({ where: { id: ids.stores }, force: true })
})

// Same shape utils/authorization.js puts on req.user.
const reqFor = (user) => ({
  storeId: store.id,
  user,
  ip: '127.0.0.1',
  get: () => 'jest-agent'
})

const latest = (description) =>
  db.auditLog.findOne({ where: { description }, order: [['id', 'DESC']] })

describe('createAudit records who did it', () => {
  test('userName comes from req.user.userName', async () => {
    const description = uniq('username')
    await createAudit(
      reqFor({
        id: 9101,
        userName: 'kasir_satu',
        fullName: 'Kasir Satu',
        store: store.id
      }),
      'update',
      'order',
      1,
      description
    )
    expect((await latest(description)).userName).toBe('kasir_satu')
  })

  test('falls back to fullName when there is no userName', async () => {
    const description = uniq('fullname')
    await createAudit(
      reqFor({ id: 9102, fullName: 'Kasir Dua', store: store.id }),
      'update',
      'order',
      1,
      description
    )
    expect((await latest(description)).userName).toBe('Kasir Dua')
  })

  test('a request without a user still writes the row with a null name', async () => {
    const description = uniq('anon')
    await createAudit(
      { ip: '127.0.0.1', get: () => 'jest-agent' },
      'update',
      'order',
      1,
      description
    )
    const row = await latest(description)
    expect(row).not.toBeNull()
    expect(row.userName).toBeNull()
  })

  test('an authenticated endpoint stores the signed-in userName', async () => {
    const user = await db.user.create({
      userName: uniq('admin').toLowerCase(),
      email: `${uniq('admin').toLowerCase()}@test.com`,
      roleType: 'admin',
      userType: 'admin',
      store: store.id,
      status: 'active',
      fullName: 'Admin Dapur'
    })
    ids.users.push(user.id)
    const token = await signSessionToken(
      {
        id: user.id,
        userName: user.userName,
        roleType: 'admin',
        store: store.id
      },
      JWT_SECRET
    )
    const category = await db.category.create({
      name: uniq('CAT'),
      status: 'active'
    })
    ids.categories.push(category.id)
    const product = await db.product.create({
      nameProduct: uniq('P'),
      category: category.id,
      price: 5000
    })
    ids.products.push(product.id)
    const order = await db.order.create({
      orderNumber: uniq('ORD'),
      store: store.id,
      status: 'pending',
      paymentStatus: 'paid',
      source: 'pos'
    })
    ids.orders.push(order.id)
    const item = await db.order_item.create({
      order: order.id,
      product: product.id,
      quantity: 1,
      price: 5000,
      status: 'pending'
    })
    ids.items.push(item.id)

    const res = await request(app)
      .put('/order/update-item-status')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: order.id, itemId: item.id, itemStatus: 'ready' })
    expect(res.status).toBe(200)

    const row = await db.auditLog.findOne({
      where: { entity: 'order_item', entityId: item.id },
      order: [['id', 'DESC']]
    })
    expect(row.userId).toBe(user.id)
    expect(row.userName).toBe(user.userName)
  })
})
