process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// F-RET-1 regression: sales-return approval must restore stock symmetrically
// with what the sale consumed — FG stock, BOM ingredient stock, exact UOM
// base quantities, no truncation — inside the approval transaction.

const unique = (prefix) =>
  `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

let store = null
let category = null
let adminToken = null
let fgProduct = null
let mtoProduct = null
let ingredient = null

async function makeProduct(name, overrides = {}) {
  const p = await db.product.create({
    nameProduct: name,
    category: category.id,
    price: 12000,
    stock: 50,
    ...overrides
  })
  await db.product_store_stock.create({
    product: p.id,
    store: store.id,
    stock: 50
  })
  return p
}

async function sellProduct(productId, qty) {
  const res = await request(app)
    .post('/order/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send(withIdempotencyKey({
      store: store.id,
      items: [{ product: productId, quantity: qty, productName: 'ret' }],
      paymentMethod: 'cash',
      cashierName: 'Return Cashier',
      idempotencyKey: unique('retsell')
    }))
  if (res.status !== 201) throw new Error('sale setup failed: ' + JSON.stringify(res.body))
  return res.body.data
}

async function returnAndApprove(orderId, items, reason = 'customer changed mind') {
  const createRes = await request(app)
    .post(`/pos/order/${orderId}/return`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ items, reason, idempotencyKey: unique('retcreate') })
  if (![200, 201].includes(createRes.status)) {
    throw new Error('return setup failed: ' + JSON.stringify(createRes.body))
  }
  const retId = createRes.body.data.id
  const approveRes = await request(app)
    .patch(`/sales-return/approve/${retId}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ id: retId })
  return { retId, approveRes }
}

async function fgStock(productId) {
  return Number((await db.product.findByPk(productId)).stock)
}

async function ingStock(ingredientId) {
  return Number((await db.ingredient.findByPk(ingredientId)).stock)
}

beforeAll(async () => {
  store = await db.location.create({ name: `RET_STORE_${Date.now()}`, status: 'active' })
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed the rate
  // so these restoration assertions exercise configured tax.
  await db.taxConfig.destroy({ where: { store: store.id }, force: true })
  await db.taxConfig.create({
    name: `RET_STORE_PPN_${store.id}`,
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: store.id
  })
  category = await db.category.create({ name: `RET_CAT_${Date.now()}` })

  fgProduct = await makeProduct(`RET_FG_${Date.now()}`)

  // make_to_order product: sale consumes ONLY ingredients (FG untouched).
  mtoProduct = await makeProduct(`RET_MTO_${Date.now()}`, {
    inventoryMode: 'make_to_order'
  })
  ingredient = await db.ingredient.create({
    store: store.id,
    name: `RET_ING_${Date.now()}`,
    stock: 1000,
    unit: 'g',
    baseUnit: 'g',
    costPrice: 10
  })
  const header = await db.bom_header.create({
    store: store.id,
    productId: mtoProduct.id,
    name: `RET_BOM_${Date.now()}`,
    status: 'active'
  })
  await db.bom_line.create({
    bomHeaderId: header.id,
    ingredientId: ingredient.id,
    qty: 100,
    unit: 'g'
  })

  const adminUser = await db.user.create({
    userName: `admin_ret_${Date.now()}`,
    email: `admin_ret_${Date.now()}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  // P1 (DR-PAY-ATTR-02): counter sales under test require an open register.
  await db.cashRegister.create({ store: store.id, user: adminUser.id, status: 'open', openingBalance: 0, openedAt: new Date() })
})

afterAll(async () => {
  await db.cashRegister.destroy({ where: { store: store?.id }, force: true })
  await db.taxConfig.destroy({ where: { store: store?.id }, force: true })
  await db.stock_history.destroy({ where: { store: store?.id }, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.sales_return_item.destroy({ where: {}, force: true })
  await db.sales_return.destroy({ where: { store: store?.id }, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: store?.id }, force: true })
  await db.best_selling.destroy({ where: { store: store?.id }, force: true })
  await db.product_store_stock.destroy({ where: { store: store?.id }, force: true })
  await db.bom_line.destroy({ where: {}, force: true })
  await db.bom_header.destroy({ where: { store: store?.id }, force: true })
  await db.ingredient.destroy({ where: { id: ingredient?.id }, force: true })
  await db.product.destroy({
    where: { id: [fgProduct?.id, mtoProduct?.id].filter(Boolean) },
    force: true
  })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { store: store?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('F-RET-1 sales-return approval restoration', () => {
  test('Test A — FG restoration: full return of 3 restores exactly 3', async () => {
    const baseline = await fgStock(fgProduct.id)
    const order = await sellProduct(fgProduct.id, 3)
    expect(await fgStock(fgProduct.id)).toBe(baseline - 3)

    const { approveRes } = await returnAndApprove(order.id, [
      { productId: fgProduct.id, orderItemId: order.items[0].id, qty: 3 }
    ])
    expect(approveRes.status).toBe(200)
    expect(await fgStock(fgProduct.id)).toBe(baseline)
  })

  test('Test B — ingredient restoration: full return of make_to_order sale restores BOM usage exactly', async () => {
    const order = await sellProduct(mtoProduct.id, 2)
    // 2 units × 100g = 200g consumed; FG untouched for make_to_order.
    expect(await ingStock(ingredient.id)).toBe(800)
    expect(await fgStock(mtoProduct.id)).toBe(50)

    const { approveRes } = await returnAndApprove(order.id, [
      { productId: mtoProduct.id, orderItemId: order.items[0].id, qty: 2 }
    ])
    expect(approveRes.status).toBe(200)
    expect(await ingStock(ingredient.id)).toBe(1000)
    expect(await fgStock(mtoProduct.id)).toBe(50)
  })

  test('Test C — UOM conversion parity: client conversionToBase never changes the restored quantity', async () => {
    const baseline = await fgStock(fgProduct.id)
    const order = await sellProduct(fgProduct.id, 4)
    expect(await fgStock(fgProduct.id)).toBe(baseline - 4)

    // F-RET-1 (Phase 39 Batch 2): the sale path has no conversion concept
    // — it deducted exactly 4 base units for qty 4. The return of 2
    // selling units therefore restores exactly 2, even though the client
    // sent conversionToBase 1.5 (which would previously restore 3.0 and
    // over-restore on full returns). conversionToBase is informational.
    const { approveRes } = await returnAndApprove(order.id, [
      {
        productId: fgProduct.id,
        orderItemId: order.items[0].id,
        qty: 2,
        conversionToBase: 1.5
      }
    ])
    expect(approveRes.status).toBe(200)
    expect(await fgStock(fgProduct.id)).toBe(baseline - 2)
  })

  test('Test E — no over-restoration: partial return restores only its share, remainder completes exactly', async () => {
    const baseline = await ingStock(ingredient.id)
    const order = await sellProduct(mtoProduct.id, 3)
    expect(await ingStock(ingredient.id)).toBe(baseline - 300)

    const first = await returnAndApprove(order.id, [
      { productId: mtoProduct.id, orderItemId: order.items[0].id, qty: 1 }
    ])
    expect(first.approveRes.status).toBe(200)
    expect(await ingStock(ingredient.id)).toBe(baseline - 200)

    const second = await returnAndApprove(order.id, [
      { productId: mtoProduct.id, orderItemId: order.items[0].id, qty: 2 }
    ])
    expect(second.approveRes.status).toBe(200)
    expect(await ingStock(ingredient.id)).toBe(baseline)
  })

  test('Test F — repeated approval is rejected without a second restoration', async () => {
    const order = await sellProduct(fgProduct.id, 2)
    const { retId, approveRes } = await returnAndApprove(order.id, [
      { productId: fgProduct.id, orderItemId: order.items[0].id, qty: 2 }
    ])
    expect(approveRes.status).toBe(200)
    const afterFirst = await fgStock(fgProduct.id)

    const again = await request(app)
      .patch(`/sales-return/approve/${retId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ id: retId })
    expect(again.status).toBe(409)
    expect(await fgStock(fgProduct.id)).toBe(afterFirst)
  })
})
