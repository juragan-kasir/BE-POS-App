process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// BA DR-28 (field-length standard, 2026-10-24): typed text is limited per
// field kind and an over-long value is refused with 400 — never cut. Text
// copied from master data (an order line's product name, the cashier name)
// is not limited, so an older long product name never blocks a sale.
const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const TAG = `FLEN_${Date.now()}`
let seq = 0
const tag = (label) => `${TAG}_${label}_${++seq}`

const created = { users: [], stores: [], products: [], ingredients: [], categories: [] }
let storeA
let storeB
let category
let adminToken
let adminUser

const http = (method, path, token) => request(app)[method](path).set('Authorization', `Bearer ${token}`)

// A menu product sold at the given stores, still on the default mode.
const makeProduct = async (stores = [storeA.id], overrides = {}) => {
  const product = await db.product.create({
    nameProduct: tag('MENU'),
    category: category.id,
    price: 20000,
    stock: 20,
    inventoryMode: 'stocked',
    ...overrides
  })
  created.products.push(product.id)
  for (const store of stores) {
    await db.product_store.create({ product: product.id, store })
    await db.product_store_stock.create({ product: product.id, store, stock: 20 })
  }
  return product
}

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


const long = (n) => 'x'.repeat(n)
const review = (body) =>
  request(app)
    .post('/order/customer-review')
    .send({ rating: 5, store: storeA.id, deviceId: tag('dev'), ...body })

describe('per-field limits (validate)', () => {
  test('a category name holds 50: 51 is refused on create and edit, 50 is saved', async () => {
    const tooLong = await http('post', '/category/add-new-category', adminToken).send({ name: `${TAG}${long(51)}`.slice(0, 51), store: [storeA.id] })
    expect(tooLong.status).toBe(400)
    expect(tooLong.body.errors).toEqual([expect.objectContaining({ field: 'name', message: 'maksimal 50 karakter' })])

    const name = `${TAG}_`.padEnd(50, 'n')
    const ok = await http('post', '/category/add-new-category', adminToken).send({ name, store: [storeA.id] })
    expect(ok.status).toBe(200)
    const row = await db.category.findOne({ where: { name } })
    created.categories.push(row.id)

    const edit = await http('put', `/category/edit-category/${row.id}`, adminToken).send({ name: name + 'z' })
    expect(edit.status).toBe(400)
    expect(edit.body.errors[0]).toMatchObject({ field: 'name', message: 'maksimal 50 karakter' })
  })

  test('supplier NPWP holds 20 and NITKU 22', async () => {
    const res = await http('post', '/supplier', adminToken).send({ name: tag('SUP'), store: [storeA.id], taxNumber: long(21), nitku: long(23) })
    expect(res.status).toBe(400)
    expect(res.body.errors.map((e) => e.field).sort()).toEqual(['nitku', 'taxNumber'])
  })
})

describe('copied text is not limited', () => {
  test('a product whose old name is longer than 150 still sells', async () => {
    const menu = await makeProduct([storeA.id], { nameProduct: `${TAG}_${long(190)}` })
    const sale = await http('post', '/order/create', adminToken).send(withIdempotencyKey({
      store: storeA.id,
      items: [{ product: menu.id, quantity: 1, productName: menu.nameProduct }],
      paymentMethod: 'cash',
      cashierName: long(120)
    }))
    expect(sale.status).toBe(201)
  })
})

describe('handlers outside validate()', () => {
  test('QR order: a customer name over 100 is refused before anything else', async () => {
    const res = await request(app)
      .post('/order/customer-create')
      .send({ store: storeA.id, tableId: 999999, items: [{ product: 1, quantity: 1 }], customerName: long(101) })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: 'VALUE_TOO_LONG', field: 'customerName', max: 100 })
  })

  test('QR order: an item note over 255 is refused', async () => {
    const res = await request(app)
      .post('/order/customer-create')
      .send({ store: storeA.id, tableId: 999999, items: [{ product: 1, quantity: 1, notes: long(256) }] })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: 'VALUE_TOO_LONG', field: 'items.0.notes', max: 255 })
  })

  test('review: a name over 100 is refused, not cut', async () => {
    const menu = await makeProduct([storeA.id])
    const res = await review({ productId: String(menu.id), name: long(101), comment: 'enak' })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: 'VALUE_TOO_LONG', field: 'name', max: 100 })
  })

  test('review: a comment of exactly 255 is accepted', async () => {
    const menu = await makeProduct([storeA.id])
    const res = await review({ productId: String(menu.id), name: 'Ani', comment: long(255) })
    expect(res.status).toBeLessThan(300)
    await db.product_review.destroy({ where: { productId: menu.id }, force: true })
  })

  test('accounting: an account code over 20 is refused, not cut', async () => {
    const account = await db.account.create({ store: storeA.id, code: tag('A').slice(-12), name: 'Kas', type: 'asset', normalBalance: 'debit' })
    const res = await http('put', `/accounting/accounts/${account.id}`, adminToken).send({ code: long(21) })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: 'VALUE_TOO_LONG', field: 'code', max: 20 })
    expect((await db.account.findByPk(account.id)).code).toBe(account.code)
    await account.destroy({ force: true })
  })
})

describe('columns widened by DR-28 batch B5 take the standard', () => {
  const url = (n) => `https://res.cloudinary.com/demo/${'u'.repeat(n - 32)}`

  test('an image URL holds 2048: 1500 is saved, 2049 is refused', async () => {
    expect(url(1500)).toHaveLength(1500)
    const ok = await http('post', '/category/add-new-category', adminToken).send({ name: tag('img'), image: url(1500), store: [storeA.id] })
    expect(ok.status).toBe(200)
    const row = await db.category.findOne({ where: { image: url(1500) } })
    created.categories.push(row.id)

    const tooLong = await http('post', '/category/add-new-category', adminToken).send({ name: tag('img2'), image: url(2049), store: [storeA.id] })
    expect(tooLong.status).toBe(400)
    expect(tooLong.body.errors[0]).toMatchObject({ field: 'image', message: 'maksimal 2048 karakter' })
  })

  test('the column net follows the widened models (table.area 50, stock_transfer.reason 255)', async () => {
    const { findTooLong } = require('../utils/valueTooLong')
    expect(findTooLong(db.table, { area: 'a'.repeat(50) })).toBeNull()
    expect(findTooLong(db.table, { area: 'a'.repeat(51) })).toMatchObject({ field: 'area', max: 50 })
    expect(findTooLong(db.stock_transfer, { reason: 'r'.repeat(255) })).toBeNull()
    expect(findTooLong(db.tenant, { name: 'n'.repeat(150) })).toBeNull()
    expect(findTooLong(db.tenant, { name: 'n'.repeat(151) })).toMatchObject({ field: 'name', max: 150 })
    expect(findTooLong(db.product, { image: 'i'.repeat(2048) })).toBeNull()
  })
})
