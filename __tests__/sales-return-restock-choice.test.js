process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { profitFigures } = require('../api/service/salesFigures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Batch B10 (product owner, 2026-11-01): a sales return states whether the
// goods go back into stock. restock = false is refund-only — approval restores
// no product or ingredient stock and the returned units' cost stays in HPP.
// Omitting the field keeps the previous behaviour (restocked).

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
const UNIT_COST = 5000

let store = null
let category = null
let adminToken = null
let fgProduct = null
let mtoProduct = null
let ingredient = null

const makeProduct = async (name, overrides = {}) => {
  const product = await db.product.create({
    nameProduct: name,
    category: category.id,
    price: 12000,
    stock: 50,
    ...overrides
  })
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 50 })
  return product
}

const sell = async (productId, qty) => {
  const res = await request(app)
    .post('/order/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send(
      withIdempotencyKey({
        store: store.id,
        items: [{ product: productId, quantity: qty, productName: 'restock' }],
        paymentMethod: 'cash',
        cashierName: 'Restock Cashier'
      })
    )
  if (res.status !== 201) throw new Error('sale setup failed: ' + JSON.stringify(res.body))
  await db.order_item.update({ hppSnapshot: UNIT_COST }, { where: { order: res.body.data.id } })
  return res.body.data
}

const returnAndApprove = async (order, productId, qty, extra = {}) => {
  const created = await request(app)
    .post(`/pos/order/${order.id}/return`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      items: [{ productId, orderItemId: order.items[0].id, qty }],
      reason: 'Rusak',
      idempotencyKey: unique('ret'),
      ...extra
    })
  if (![200, 201].includes(created.status)) {
    throw new Error('return setup failed: ' + JSON.stringify(created.body))
  }
  const retId = created.body.data.id
  const approved = await request(app)
    .patch(`/sales-return/approve/${retId}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ id: retId })
  return { retId, approved }
}

const fgStock = async (productId) => Number((await db.product.findByPk(productId)).stock)
const ingStock = async () => Number((await db.ingredient.findByPk(ingredient.id)).stock)
const storeCogs = async () => {
  const start = new Date(Date.now() - 86400000)
  const end = new Date(Date.now() + 86400000)
  return (await profitFigures({ start, end, store: store.id })).cogs
}

beforeAll(async () => {
  store = await db.location.create({ name: unique('RSK_STORE'), status: 'active' })
  await db.taxConfig.create({
    name: unique('RSK_PPN'),
    rate: 0,
    type: 'ppn',
    status: 'active',
    store: store.id
  })
  category = await db.category.create({ name: unique('RSK_CAT') })
  fgProduct = await makeProduct(unique('RSK_FG'))
  mtoProduct = await makeProduct(unique('RSK_MTO'), { inventoryMode: 'make_to_order' })
  ingredient = await db.ingredient.create({
    store: store.id,
    name: unique('RSK_ING'),
    stock: 1000,
    unit: 'g',
    baseUnit: 'g',
    costPrice: 10
  })
  const header = await db.bom_header.create({
    store: store.id,
    productId: mtoProduct.id,
    name: unique('RSK_BOM'),
    status: 'active'
  })
  await db.bom_line.create({ bomHeaderId: header.id, ingredientId: ingredient.id, qty: 100, unit: 'g' })
  const admin = await db.user.create({
    userName: unique('rsk_admin'),
    email: `${unique('rsk_admin')}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: admin.id, userName: admin.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  await db.cashRegister.create({
    store: store.id,
    user: admin.id,
    status: 'open',
    openingBalance: 0,
    openedAt: new Date()
  })
})

afterAll(async () => {
  const orders = (await db.order.findAll({ where: { store: store?.id }, paranoid: false })).map((o) => o.id)
  const returns = (await db.sales_return.findAll({ where: { store: store?.id }, paranoid: false })).map((r) => r.id)
  await db.accounting_outbox.destroy({ where: { store: store?.id }, force: true })
  await db.transaction.destroy({ where: { order: orders }, force: true })
  await db.sales_return_item.destroy({ where: { salesReturn: returns }, force: true })
  await db.sales_return.destroy({ where: { id: returns }, force: true })
  await db.order_item.destroy({ where: { order: orders }, force: true })
  await db.order_status.destroy({ where: { order: orders }, force: true })
  await db.order.destroy({ where: { id: orders }, force: true })
  await db.ingredient_stock_history?.destroy({ where: { store: store?.id }, force: true })
  await db.stock_history.destroy({ where: { store: store?.id }, force: true })
  await db.cashRegister.destroy({ where: { store: store?.id }, force: true })
  await db.best_selling.destroy({ where: { store: store?.id }, force: true })
  await db.product_store_stock.destroy({ where: { store: store?.id }, force: true })
  await db.bom_line.destroy({ where: { ingredientId: ingredient?.id }, force: true })
  await db.bom_header.destroy({ where: { store: store?.id }, force: true })
  await db.ingredient.destroy({ where: { id: ingredient?.id }, force: true })
  await db.product.destroy({ where: { id: [fgProduct?.id, mtoProduct?.id] }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.taxConfig.destroy({ where: { store: store?.id }, force: true })
  await db.user.destroy({ where: { store: store?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('sales return restock choice (batch B10)', () => {
  test('a damaged return refunds but puts nothing back and keeps its cost', async () => {
    const order = await sell(fgProduct.id, 2)
    const stockAfterSale = await fgStock(fgProduct.id)
    const cogsAfterSale = await storeCogs()

    const { retId, approved } = await returnAndApprove(order, fgProduct.id, 2, { restock: false })
    expect(approved.status).toBe(200)
    expect((await db.sales_return.findByPk(retId)).restock).toBe(false)
    expect(await fgStock(fgProduct.id)).toBe(stockAfterSale)
    expect(await storeCogs()).toBe(cogsAfterSale)
    const refunds = await db.transaction.findAll({ where: { order: order.id } })
    expect(refunds.some((row) => Number(row.amount) < 0)).toBe(true)
  })

  test('a returned dish not put back leaves its ingredients consumed', async () => {
    const order = await sell(mtoProduct.id, 1)
    const ingredientAfterSale = await ingStock()
    const { approved } = await returnAndApprove(order, mtoProduct.id, 1, { restock: false })
    expect(approved.status).toBe(200)
    expect(await ingStock()).toBe(ingredientAfterSale)
  })

  test("the order detail tells each line's inventory mode, so the form can default the choice", async () => {
    const order = await sell(mtoProduct.id, 1)
    const res = await request(app)
      .get(`/order/get-order/${order.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .query({ store: store.id })
    expect(res.status).toBe(200)
    expect(res.body.data.items[0].inventoryMode).toBe('make_to_order')
  })

  test('without the field the return is restocked as before', async () => {
    const order = await sell(fgProduct.id, 3)
    const stockAfterSale = await fgStock(fgProduct.id)
    const cogsAfterSale = await storeCogs()
    const { retId, approved } = await returnAndApprove(order, fgProduct.id, 3)
    expect(approved.status).toBe(200)
    expect((await db.sales_return.findByPk(retId)).restock).toBe(true)
    expect(await fgStock(fgProduct.id)).toBe(stockAfterSale + 3)
    expect(await storeCogs()).toBe(cogsAfterSale - 3 * UNIT_COST)
  })
})
