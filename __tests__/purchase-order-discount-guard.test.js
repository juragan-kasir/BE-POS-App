process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// A PO discount above the item total used to be stored as-is, leaving a
// negative finalAmount. Create and update now refuse it, and an update is
// refused before its items are replaced.

let store = null
let category = null
let ingredient = null
let adminToken = null
let adminUser = null

const tag = () => `PO_DISC_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

beforeAll(async () => {
  store = await db.location.create({ name: tag(), status: 'active' })
  category = await db.category.create({ name: tag() })
  ingredient = await db.ingredient.create({
    store: store.id,
    name: tag(),
    stock: 0,
    minStock: 0,
    unit: 'pcs',
    baseUnit: 'pcs',
    conversionFactor: 1,
    costPrice: 0,
    status: 'active'
  })
  adminUser = await db.user.create({
    userName: tag().toLowerCase(),
    email: `${tag().toLowerCase()}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  const pos = await db.purchase_order.findAll({ where: { store: store.id }, attributes: ['id'] })
  const poIds = pos.map((p) => p.id)
  await db.purchase_order_item.destroy({ where: { purchaseOrder: poIds }, force: true })
  await db.purchase_order.destroy({ where: { id: poIds }, force: true })
  await db.ingredient.destroy({ where: { store: store.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { id: adminUser?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

const line = (quantity, price) => ({
  ingredient: ingredient.id,
  ingredientName: ingredient.name,
  quantity,
  price
})

const createPO = (body) =>
  request(app)
    .post('/purchase-order/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ store: store.id, status: 'draft', ...body })

const updatePO = (id, body) =>
  request(app)
    .put(`/purchase-order/update/${id}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send(body)

describe('PO discount guard — create', () => {
  test('a discount above the item total is refused', async () => {
    const res = await createPO({ discount: 15000, items: [line(1, 10000)] })
    expect(res.status).toBe(400)
    expect(res.body.message).toBe('Diskon tidak boleh melebihi total harga')
  })

  test('a negative discount is refused', async () => {
    const res = await createPO({ discount: -1, items: [line(1, 10000)] })
    expect(res.status).toBe(400)
  })

  test('a discount equal to the total is allowed', async () => {
    const res = await createPO({ discount: 10000, items: [line(1, 10000)] })
    expect(res.status).toBe(201)
    expect(res.body.data.finalAmount).toBe(0)
  })
})

describe('PO discount guard — update', () => {
  test('raising the discount above the total is refused', async () => {
    const created = await createPO({ discount: 0, items: [line(2, 10000)] })
    const res = await updatePO(created.body.data.id, { discount: 25000 })
    expect(res.status).toBe(400)
    const stored = await db.purchase_order.findByPk(created.body.data.id)
    expect(Number(stored.discount)).toBe(0)
  })

  test('shrinking the items under the existing discount is refused and keeps the old items', async () => {
    const created = await createPO({ discount: 15000, items: [line(2, 10000)] })
    const id = created.body.data.id
    const res = await updatePO(id, { items: [line(1, 10000)] })
    expect(res.status).toBe(400)
    const items = await db.purchase_order_item.findAll({ where: { purchaseOrder: id } })
    expect(items).toHaveLength(1)
    expect(Number(items[0].quantity)).toBe(2)
  })

  test('a discount within the new total is saved', async () => {
    const created = await createPO({ discount: 0, items: [line(2, 10000)] })
    const res = await updatePO(created.body.data.id, { discount: 5000 })
    expect(res.status).toBe(200)
    const stored = await db.purchase_order.findByPk(created.body.data.id)
    expect(Number(stored.finalAmount)).toBe(15000)
  })
})
