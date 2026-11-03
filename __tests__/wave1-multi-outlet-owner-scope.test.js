process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// PGA-01 / PGA-02 (audit product-grade-2026-11-02) and the #294 regression:
// a multi-outlet client owner (store-bound super_admin) must reach every
// outlet of its OWN tenant by id, and no outlet of another tenant. #294
// scoped these writes to the single active outlet instead, which blocked the
// owner's second outlet; before #294 they were not scoped at all.

const PREFIX = `w1mo_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
let seq = 0
const unique = (key) => `${PREFIX}_${key}_${++seq}`.toLowerCase()

const ids = { tenants: [], stores: [], users: [], orders: [], items: [], products: [], opnames: [], categories: [] }
const s = {}
const t = {}

const makeStore = async (key, tenantId) => {
  const row = await db.location.create({ name: unique(key), status: 'active', tenantId })
  ids.stores.push(row.id)
  return row
}

const makeUser = async (key, roleType, store) => {
  const name = unique(key)
  const row = await db.user.create({
    userName: name,
    email: `${name}@test.com`,
    password: 'Rahasia123!',
    fullName: name,
    roleType,
    userType: 'admin',
    status: 'active',
    store
  })
  ids.users.push(row.id)
  return signSessionToken({ id: row.id, roleType, store }, JWT_SECRET)
}

const makeOrderItem = async (store) => {
  const order = await db.order.create({
    orderNumber: unique('ORD'),
    store: store.id,
    status: 'pending',
    paymentStatus: 'paid',
    source: 'pos'
  })
  ids.orders.push(order.id)
  const item = await db.order_item.create({
    order: order.id,
    product: s.product.id,
    quantity: 1,
    price: 5000,
    status: 'pending'
  })
  ids.items.push(item.id)
  return { order, item }
}

const makeOpname = async (store) => {
  const row = await db.stockOpname.create({
    store: store.id,
    opnameNumber: unique('SO'),
    date: new Date(),
    status: 'draft',
    totalAdjustment: 0
  })
  ids.opnames.push(row.id)
  return row
}

const as = (token) => ({ Authorization: `Bearer ${token}` })

beforeAll(async () => {
  const tenantA = await db.tenant.create({ code: unique('TA').toUpperCase(), name: unique('Tenant A') })
  const tenantB = await db.tenant.create({ code: unique('TB').toUpperCase(), name: unique('Tenant B') })
  ids.tenants.push(tenantA.id, tenantB.id)
  s.a1 = await makeStore('A1', tenantA.id)
  s.a2 = await makeStore('A2', tenantA.id)
  s.b1 = await makeStore('B1', tenantB.id)

  t.ownerA = await makeUser('owner_a', 'super_admin', s.a1.id)
  t.adminA1 = await makeUser('admin_a1', 'admin', s.a1.id)

  s.category = await db.category.create({ name: unique('CAT'), status: 'active' })
  ids.categories.push(s.category.id)
  s.product = await db.product.create({ nameProduct: unique('PROD'), category: s.category.id, price: 5000 })
  ids.products.push(s.product.id)
})

afterAll(async () => {
  await db.order_item.destroy({ where: { id: ids.items }, force: true })
  await db.order.destroy({ where: { id: ids.orders }, force: true })
  await db.stockOpname.destroy({ where: { id: ids.opnames }, force: true })
  await db.product_store.destroy({ where: { product: ids.products } })
  await db.product.destroy({ where: { id: ids.products }, force: true })
  await db.category.destroy({ where: { id: ids.categories }, force: true })
  await db.user.destroy({ where: { id: ids.users }, force: true })
  await db.location.destroy({ where: { id: ids.stores }, force: true })
  await db.tenant.destroy({ where: { id: ids.tenants }, force: true })
})

describe('order item status', () => {
  const put = (token, { order, item }) =>
    request(app)
      .put('/order/update-item-status')
      .set(as(token))
      .send({ id: order.id, itemId: item.id, itemStatus: 'ready' })

  test('the owner updates an item at its second outlet', async () => {
    const row = await makeOrderItem(s.a2)
    const res = await put(t.ownerA, row)
    expect(res.status).toBe(200)
    expect((await db.order_item.findByPk(row.item.id)).status).toBe('ready')
  })

  test('another tenant\'s item answers 404 and is not changed', async () => {
    const row = await makeOrderItem(s.b1)
    expect((await put(t.ownerA, row)).status).toBe(404)
    expect((await db.order_item.findByPk(row.item.id)).status).toBe('pending')
  })

  test('an outlet admin stays on its own outlet', async () => {
    const row = await makeOrderItem(s.a2)
    expect((await put(t.adminA1, row)).status).toBe(404)
  })
})

describe('stock opname status', () => {
  const patch = (token, opname) =>
    request(app).patch(`/stock-opname/status/${opname.id}`).set(as(token)).send({ status: 'cancelled' })

  test('the owner cancels a draft at its second outlet', async () => {
    const opname = await makeOpname(s.a2)
    expect((await patch(t.ownerA, opname)).status).toBe(200)
    expect((await db.stockOpname.findByPk(opname.id)).status).toBe('cancelled')
  })

  test('another tenant\'s draft answers 404 and stays a draft', async () => {
    const opname = await makeOpname(s.b1)
    expect((await patch(t.ownerA, opname)).status).toBe(404)
    expect((await db.stockOpname.findByPk(opname.id)).status).toBe('draft')
  })
})

describe('product store assignment', () => {
  const add = (token, stores) =>
    request(app)
      .post('/product/add-product')
      .set(as(token))
      .send({ nameProduct: unique('NEW'), category: s.category.id, price: 10000, stock: 5, stores })

  test('the owner adds a product to its second outlet', async () => {
    const res = await add(t.ownerA, [s.a2.id])
    expect(res.status).toBe(200)
    ids.products.push(res.body.data.id)
    const bindings = await db.product_store.findAll({ where: { product: res.body.data.id } })
    expect(bindings.map((b) => b.store)).toEqual([s.a2.id])
  })

  test('the owner cannot assign another tenant\'s outlet', async () => {
    const res = await add(t.ownerA, [s.a1.id, s.b1.id])
    expect(res.status).toBe(403)
  })
})
