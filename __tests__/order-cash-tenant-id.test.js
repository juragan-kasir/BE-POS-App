'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// W3-4 (BE audit S-04, migration 20261119000004 / batch B22): order,
// transaction, shift, cash_register, cash_movement and expense carry their
// tenant. Outlet tables take the tenant of `store`; a transaction takes the
// tenant of its order. Both come from persisted rows, never from the caller.
const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const migration = require('../db/migrations/20261119000004-order-cash-tenant-id')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const uniq = (k) => `oct_${k}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
const TABLES = ['cash_movement', 'cash_register', 'expense', 'order', 'shift', 'transaction']
const f = {}
const orderIds = []

beforeAll(async () => {
  f.tA = await db.tenant.create({ code: uniq('a').replace(/_/g, '-'), name: uniq('TA') })
  f.tB = await db.tenant.create({ code: uniq('b').replace(/_/g, '-'), name: uniq('TB') })
  f.a1 = await db.location.create({ name: uniq('A1'), status: 'active', tenantId: f.tA.id })
  f.b1 = await db.location.create({ name: uniq('B1'), status: 'active', tenantId: f.tB.id })
  f.free = await db.location.create({ name: uniq('F'), status: 'active' })
  f.category = await db.category.create({ name: uniq('CAT') })
  f.product = await db.product.create({ nameProduct: uniq('P'), category: f.category.id, price: 10000, stock: 50, tenantId: f.tA.id })
  await db.product_store.create({ product: f.product.id, store: f.a1.id })
  await db.product_store_stock.create({ product: f.product.id, store: f.a1.id, stock: 50 })
  f.cashier = await db.user.create({
    userName: uniq('kasir'), email: `${uniq('kasir')}@test.com`, roleType: 'kasir', userType: 'user',
    store: f.a1.id, status: 'active', fullName: 'kasir oct'
  })
  f.token = await signSessionToken(
    { id: f.cashier.id, userName: f.cashier.userName, roleType: 'kasir', store: f.a1.id },
    JWT_SECRET
  )
  await db.taxConfig.create({ name: uniq('PPN'), rate: 11, type: 'ppn', status: 'active', store: f.a1.id })
  f.register = await db.cashRegister.create({
    store: f.a1.id, user: f.cashier.id, status: 'open', openingBalance: 0, openedAt: new Date()
  })
})

afterAll(async () => {
  const stores = [f.a1?.id, f.b1?.id, f.free?.id].filter(Boolean)
  const orders = await db.order.findAll({ where: { store: stores }, attributes: ['id'], paranoid: false })
  const oids = [...new Set([...orders.map((o) => o.id), ...orderIds])]
  await db.transaction.destroy({ where: { order: oids }, force: true })
  await db.order_item.destroy({ where: { order: oids }, force: true })
  await db.order_status.destroy({ where: { order: oids }, force: true })
  await db.order.destroy({ where: { id: oids }, force: true })
  await db.cashMovement.destroy({ where: { store: stores } })
  await db.cashRegister.destroy({ where: { store: stores }, force: true })
  await db.expense.destroy({ where: { store: stores }, force: true })
  await db.shift.destroy({ where: { store: stores }, force: true })
  await db.taxConfig.destroy({ where: { store: stores }, force: true })
  await db.stock_history.destroy({ where: { product: f.product.id }, force: true })
  await db.best_selling.destroy({ where: { productId: f.product.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: f.product.id }, force: true })
  await db.product_store.destroy({ where: { product: f.product.id }, force: true })
  await db.product.destroy({ where: { id: f.product.id }, force: true })
  await db.category.destroy({ where: { id: f.category.id }, force: true })
  await db.authorizationContextSession.destroy({ where: { userId: f.cashier.id } })
  await db.user.destroy({ where: { id: f.cashier.id }, force: true })
  await db.location.destroy({ where: { id: stores }, force: true })
  await db.tenant.destroy({ where: { id: [f.tA.id, f.tB.id] }, force: true })
  await db.sequelize.close()
})

test('the six money tables carry tenantId + index', async () => {
  const [cols] = await db.sequelize.query(
    `SELECT table_name FROM information_schema.columns
      WHERE column_name = 'tenantId' AND table_name IN (:tables) ORDER BY 1`,
    { replacements: { tables: TABLES } }
  )
  expect(cols.map((c) => c.table_name)).toEqual(TABLES)
  const [idx] = await db.sequelize.query(
    `SELECT indexname FROM pg_indexes WHERE indexname IN (:names) ORDER BY 1`,
    { replacements: { names: TABLES.map((t) => `ix_${t}_tenant`) } }
  )
  expect(idx).toHaveLength(TABLES.length)
})

test('a real counter sale stamps the order and its payment with the outlet\'s tenant', async () => {
  const res = await request(app)
    .post('/order/create')
    .set('Authorization', `Bearer ${f.token}`)
    .send(withIdempotencyKey({
      store: f.a1.id,
      items: [{ product: f.product.id, quantity: 1 }],
      paymentMethod: 'cash',
      cashierName: 'kasir oct'
    }))
  expect(res.status).toBe(201)
  orderIds.push(res.body.data.id)
  expect((await db.order.findByPk(res.body.data.id)).tenantId).toBe(f.tA.id)
  const payments = await db.transaction.findAll({ where: { order: res.body.data.id } })
  expect(payments.length).toBeGreaterThan(0)
  expect(payments.every((p) => p.tenantId === f.tA.id)).toBe(true)
  expect((await db.cashRegister.findByPk(f.register.id)).tenantId).toBe(f.tA.id)
})

test('every outlet table follows its store on create and on a store change', async () => {
  const shift = await db.shift.create({ name: uniq('s'), store: f.b1.id, startTime: '08:00', endTime: '16:00' })
  expect(shift.tenantId).toBe(f.tB.id)
  const expense = await db.expense.create({ expenseNumber: uniq('EXP'), store: f.a1.id, amount: 1000, description: uniq('e'), date: new Date() })
  expect(expense.tenantId).toBe(f.tA.id)
  await db.expense.update({ store: f.b1.id }, { where: { id: expense.id } })
  expect((await db.expense.findByPk(expense.id)).tenantId).toBe(f.tB.id)
  const free = await db.shift.create({ name: uniq('s'), store: f.free.id, startTime: '08:00', endTime: '16:00' })
  expect(free.tenantId ?? null).toBeNull()
})

test('a transaction takes its order\'s tenant, never a caller-supplied one', async () => {
  const order = await db.order.create({ orderNumber: uniq('ORD'), store: f.b1.id, tenantId: f.tA.id })
  orderIds.push(order.id)
  expect(order.tenantId).toBe(f.tB.id)
  const trx = await db.transaction.create({ order: order.id, typePayment: 'CASH', amount: 5000, tenantId: f.tA.id })
  expect(trx.tenantId).toBe(f.tB.id)
})

test('the backfill follows store (transaction: its order), leaves the rest NULL, and is replay-safe', async () => {
  const [[oA]] = await db.sequelize.query(
    `INSERT INTO "order" ("orderNumber", store, "createdAt", "updatedAt") VALUES ('${uniq('R')}', ${f.a1.id}, NOW(), NOW()) RETURNING id`
  )
  const [[oFree]] = await db.sequelize.query(
    `INSERT INTO "order" ("orderNumber", store, "createdAt", "updatedAt") VALUES ('${uniq('R')}', ${f.free.id}, NOW(), NOW()) RETURNING id`
  )
  orderIds.push(oA.id, oFree.id)
  const [[tA]] = await db.sequelize.query(
    `INSERT INTO "transaction" ("order", "typePayment", amount, "createdAt", "updatedAt") VALUES (${oA.id}, 'CASH', 1, NOW(), NOW()) RETURNING id`
  )
  const [[tFree]] = await db.sequelize.query(
    `INSERT INTO "transaction" ("order", "typePayment", amount, "createdAt", "updatedAt") VALUES (${oFree.id}, 'CASH', 1, NOW(), NOW()) RETURNING id`
  )

  await migration.up(db.sequelize.getQueryInterface(), db.Sequelize)
  await migration.up(db.sequelize.getQueryInterface(), db.Sequelize)

  expect((await db.order.findByPk(oA.id)).tenantId).toBe(f.tA.id)
  expect((await db.order.findByPk(oFree.id)).tenantId ?? null).toBeNull()
  expect((await db.transaction.findByPk(tA.id)).tenantId).toBe(f.tA.id)
  expect((await db.transaction.findByPk(tFree.id)).tenantId ?? null).toBeNull()
})
