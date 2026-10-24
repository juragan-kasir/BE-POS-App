process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// BA DR-28 decision 4: a supplier product's minimum order quantity is a whole
// number — typed as digits, stored as INTEGER. The migration converts the
// old VARCHAR, and stops before any change when a value is not digits only.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const TAG = `DR28Q_${Date.now()}`
let seq = 0
const tag = (label) => `${TAG}_${label}_${++seq}`

const created = { users: [], stores: [], products: [], ingredients: [], categories: [] }
let storeA
let storeB
let category
let adminToken
let adminUser

const http = (method, path, token) => request(app)[method](path).set('Authorization', `Bearer ${token}`)


beforeAll(async () => {
  storeA = await db.location.create({ name: tag('STORE_A'), status: 'active' })
  storeB = await db.location.create({ name: tag('STORE_B'), status: 'active' })
  created.stores.push(storeA.id, storeB.id)
  category = await db.category.create({ name: tag('CAT') })
  created.categories.push(category.id)

  adminUser = await db.user.create({
    userName: tag('admin'),
    email: `${tag('admin')}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: storeA.id,
    status: 'active',
    fullName: 'BOMRM admin'
  })
  created.users.push(adminUser.id)
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: storeA.id },
    JWT_SECRET
  )

  await db.taxConfig.create({ name: tag('PPN'), rate: 11, type: 'ppn', status: 'active', store: storeA.id })
  await db.cashRegister.destroy({ where: { store: storeA.id, status: 'open' }, force: true })
  await db.cashRegister.create({
    store: storeA.id,
    user: adminUser.id,
    status: 'open',
    openingBalance: 0,
    openedAt: new Date()
  })
})

afterAll(async () => {
  const orders = await db.order.findAll({ where: { store: created.stores }, attributes: ['id'] })
  const orderIds = orders.map((o) => o.id)
  await db.stock_history.destroy({ where: { store: created.stores }, force: true })
  const headers = await db.bom_header.findAll({ where: { productId: created.products }, attributes: ['id'] })
  await db.bom_line.destroy({ where: { bomHeaderId: headers.map((h) => h.id) }, force: true })
  await db.bom_header.destroy({ where: { productId: created.products }, force: true })
  await db.productionOrder.destroy({ where: { productItemId: created.products }, force: true })
  await db.order_item.destroy({ where: { order: orderIds }, force: true })
  await db.transaction.destroy({ where: { order: orderIds }, force: true })
  await db.order_status.destroy({ where: { order: orderIds }, force: true })
  await db.order.destroy({ where: { id: orderIds }, force: true })
  await db.cashRegister.destroy({ where: { store: created.stores }, force: true })
  await db.taxConfig.destroy({ where: { store: created.stores }, force: true })
  await db.authorizationContextSession.destroy({ where: { userId: created.users } })
  await db.user.destroy({ where: { id: created.users }, force: true })
  await db.best_selling.destroy({ where: { productId: created.products }, force: true })
  await db.product_store_stock.destroy({ where: { product: created.products }, force: true })
  await db.product_store.destroy({ where: { product: created.products }, force: true })
  await db.product.destroy({ where: { id: created.products }, force: true })
  await db.ingredient.destroy({ where: { id: created.ingredients }, force: true, paranoid: false })
  await db.category.destroy({ where: { id: created.categories }, force: true })
  await db.location.destroy({ where: { id: created.stores }, force: true })
})


const { parseMinOrderQty } = require('../utils/minOrderQty')
const migration = require('../db/migrations/20261025000001-dr28-min-order-qty-integer')

const tempTable = () => `zz_dr28_moq_${Date.now()}_${++seq}`
const q = (sql, replacements) => db.sequelize.query(sql, { replacements, type: db.sequelize.QueryTypes.SELECT })
const columnInfo = async (table) =>
  (await q(`SELECT data_type, column_default FROM information_schema.columns WHERE table_name = :t AND column_name = 'minOrderQty'`, { t: table }))[0]
const makeTemp = async (values) => {
  const table = tempTable()
  await db.sequelize.query(`CREATE TABLE "${table}" (id SERIAL PRIMARY KEY, "minOrderQty" VARCHAR(50) DEFAULT '1')`)
  for (const v of values) await db.sequelize.query(`INSERT INTO "${table}" ("minOrderQty") VALUES (:v)`, { replacements: { v } })
  return table
}
const tables = []
afterAll(async () => {
  for (const t of tables) await db.sequelize.query(`DROP TABLE IF EXISTS "${t}"`)
})

describe('parseMinOrderQty', () => {
  test.each([
    [undefined, 1], [null, 1], ['', 1], ['  ', 1], ['12', 12], [' 7 ', 7], ['0', 0], [3, 3],
    ['1.5', null], ['10 kg', null], ['-2', null], [2.5, null], [-1, null]
  ])('%p -> %p', (input, expected) => expect(parseMinOrderQty(input)).toBe(expected))
})

describe('migration', () => {
  test('digits become integers, empty and NULL become 1; it replays and reverts', async () => {
    const table = await makeTemp(['12', '', ' 7 ', null, '1'])
    tables.push(table)
    await migration.convertMinOrderQty(db.sequelize.getQueryInterface(), table)
    await migration.convertMinOrderQty(db.sequelize.getQueryInterface(), table)

    const info = await columnInfo(table)
    expect(info.data_type).toBe('integer')
    expect(info.column_default).toBe('1')
    const rows = await q(`SELECT "minOrderQty" AS v FROM "${table}" ORDER BY id`)
    expect(rows.map((r) => r.v)).toEqual([12, 1, 7, 1, 1])

    await migration.revertMinOrderQty(db.sequelize.getQueryInterface(), table)
    expect((await columnInfo(table)).data_type).toBe('character varying')
    expect((await q(`SELECT "minOrderQty" AS v FROM "${table}" ORDER BY id`)).map((r) => r.v)).toEqual(['12', '1', '7', '1', '1'])
  })

  test('a value that is not a whole number stops it before any change', async () => {
    const table = await makeTemp(['5', '1.5', '10 kg'])
    tables.push(table)
    await expect(migration.convertMinOrderQty(db.sequelize.getQueryInterface(), table)).rejects.toThrow(
      /2 value\(s\) are not whole numbers/
    )
    expect((await columnInfo(table)).data_type).toBe('character varying')
    expect((await q(`SELECT "minOrderQty" AS v FROM "${table}" ORDER BY id`)).map((r) => r.v)).toEqual(['5', '1.5', '10 kg'])
  })

  test('the real column is INTEGER on the test DB', async () => {
    expect((await columnInfo('supplier_product')).data_type).toBe('integer')
  })
})

describe('supplier API', () => {
  const supplierIds = []
  afterAll(async () => {
    await db.supplier_product.destroy({ where: { supplier: supplierIds }, force: true })
    await db.supplier.destroy({ where: { id: supplierIds }, force: true })
  })

  test('typed digits are stored as a number; empty is 1', async () => {
    const res = await http('post', '/supplier', adminToken).send({
      name: tag('SUP'),
      store: [storeA.id],
      phone: '081234567890',
      products: [{ name: tag('Daging'), minOrderQty: '12' }, { name: tag('Bawang'), minOrderQty: '' }]
    })
    expect(res.status).toBeLessThan(300)
    const supplier = await db.supplier.findOne({ where: { name: res.body.data?.name || res.body.data?.supplier?.name } })
    supplierIds.push(supplier.id)
    const rows = await db.supplier_product.findAll({ where: { supplier: supplier.id }, order: [['name', 'ASC']] })
    expect(rows.map((r) => r.minOrderQty).sort()).toEqual([1, 12])
  })

  test('a quantity that is not a whole number is refused', async () => {
    const res = await http('post', '/supplier', adminToken).send({
      name: tag('SUP'),
      store: [storeA.id],
      phone: '081234567890',
      products: [{ name: tag('Mie'), minOrderQty: '10 kg' }]
    })
    expect(res.status).toBe(400)
    expect(res.body.errors).toEqual([expect.objectContaining({ field: 'products.0.minOrderQty', message: 'harus angka bulat' })])
  })
})
