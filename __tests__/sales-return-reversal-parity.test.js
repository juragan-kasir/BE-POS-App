process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 39 Batch 2 (F-RET-1, P0): sales-return approval must restore EXACTLY
// the stock quantity the original sale deducted.
//
// Sale contract (api/controller/order.js deductStockForOrder):
// - order_item.quantity is INTEGER selling units; the sale path has ZERO
//   conversionToBase references — a regular line deducts exactly its
//   quantity, a bundle line deducts sale-time bi.quantity x bundleQty per
//   component, and stock_history 'sale' rows record the exact deduction.
// - The return approval path must therefore reverse the recorded historical
//   mutation. It must NOT multiply by client-supplied conversionToBase,
//   must NOT re-read the current bundle/BOM/mode configuration, and must
//   quantize to the canonical DECIMAL(10,4) precision.
//
// Every test below FAILS against the pre-fix approval implementation:
// - conv != 1 restores lineQty x conv instead of the deducted quantity
// - client conversion (including absurd values) distorts restoration
// - post-sale BOM / bundle / mode mutations change the restored amounts

const SUFFIX = Date.now()

let store = null
let category = null
let adminToken = null

let fgA = null
let modeP = null
let mtoP = null
let ingredient = null
let bomHeader = null
let bomLine = null
let compA = null
let compB = null
let bundle = null

async function makeProduct(name, overrides = {}, storeStock = 100) {
  const p = await db.product.create({
    nameProduct: name,
    category: category.id,
    price: 12000,
    stock: storeStock,
    ...overrides
  })
  await db.product_store_stock.create({
    product: p.id,
    store: store.id,
    stock: storeStock
  })
  return p
}

async function sell(items) {
  const res = await request(app)
    .post('/order/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send(withIdempotencyKey({
      store: store.id,
      items,
      paymentMethod: 'cash',
      cashierName: 'Parity Cashier',
      idempotencyKey: `parity-sell-${SUFFIX}-${Math.floor(Math.random() * 1e9)}`
    }))
  if (res.status !== 201) {
    throw new Error('sale setup failed: ' + JSON.stringify(res.body))
  }
  return res.body.data
}

async function createReturn(orderId, items) {
  return request(app)
    .post(`/pos/order/${orderId}/return`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      items,
      reason: 'parity check',
      idempotencyKey: `parity-ret-${SUFFIX}-${Math.floor(Math.random() * 1e9)}`
    })
}

async function approveReturn(retId) {
  return request(app)
    .patch(`/sales-return/approve/${retId}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ id: retId })
}

async function returnAndApprove(orderId, items) {
  const created = await createReturn(orderId, items)
  if (![200, 201].includes(created.status)) {
    throw new Error('return setup failed: ' + JSON.stringify(created.body))
  }
  const approved = await approveReturn(created.body.data.id)
  return { retId: created.body.data.id, created, approved }
}

async function fgStock(productId) {
  return Number((await db.product.findByPk(productId)).stock)
}

async function ingStock(ingredientId) {
  return Number((await db.ingredient.findByPk(ingredientId)).stock)
}

async function returnHistoryChanges(retId, productId) {
  const rows = await db.stock_history.findAll({
    where: { referenceType: 'sale_return', referenceId: retId, product: productId }
  })
  return rows.map((r) => Number(r.quantityChange))
}

beforeAll(async () => {
  store = await db.location.create({ name: `PARITY_STORE_${SUFFIX}`, status: 'active' })
  category = await db.category.create({ name: `PARITY_CAT_${SUFFIX}` })
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed the rate
  // so these reversal assertions exercise configured tax.
  await db.taxConfig.create({
    name: `PARITY_PPN_${SUFFIX}`,
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: store.id
  })

  fgA = await makeProduct(`PARITY_FG_${SUFFIX}`)
  modeP = await makeProduct(`PARITY_MODE_${SUFFIX}`)
  compA = await makeProduct(`PARITY_CA_${SUFFIX}`)
  compB = await makeProduct(`PARITY_CB_${SUFFIX}`)

  mtoP = await makeProduct(`PARITY_MTO_${SUFFIX}`, { inventoryMode: 'make_to_order' }, 50)
  ingredient = await db.ingredient.create({
    store: store.id,
    name: `PARITY_ING_${SUFFIX}`,
    stock: 1000,
    unit: 'g',
    baseUnit: 'g',
    costPrice: 10
  })
  bomHeader = await db.bom_header.create({
    store: store.id,
    productId: mtoP.id,
    name: `PARITY_BOM_${SUFFIX}`,
    status: 'active'
  })
  bomLine = await db.bom_line.create({
    bomHeaderId: bomHeader.id,
    ingredientId: ingredient.id,
    qty: 100,
    unit: 'g'
  })

  bundle = await db.product_bundle.create({
    name: `PARITY_BUNDLE_${SUFFIX}`,
    bundlePrice: 15000,
    originalPrice: 24000,
    isAvailable: true,
    status: 'active'
  })
  await db.product_bundle_item.create({ bundleId: bundle.id, product: compA.id, quantity: 2 })
  await db.product_bundle_item.create({ bundleId: bundle.id, product: compB.id, quantity: 1 })

  const adminUser = await db.user.create({
    userName: `admin_parity_${SUFFIX}`,
    email: `admin_parity_${SUFFIX}@test.com`,
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
  await db.product_bundle_item.destroy({ where: { bundleId: bundle?.id }, force: true })
  await db.product_bundle.destroy({ where: { id: bundle?.id }, force: true })
  await db.bom_line.destroy({ where: {}, force: true })
  await db.bom_header.destroy({ where: { store: store?.id }, force: true })
  await db.ingredient.destroy({ where: { id: ingredient?.id }, force: true })
  await db.product.destroy({
    where: { id: [fgA?.id, modeP?.id, mtoP?.id, compA?.id, compB?.id].filter(Boolean) },
    force: true
  })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { store: store?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('Phase 39 Batch 2 — sales-return reversal parity (F-RET-1)', () => {
  test('TEST A — conversion symmetry: full return with conv 2.5 restores exactly the deducted qty', async () => {
    const baseline = await fgStock(fgA.id)
    const order = await sell([{ product: fgA.id, quantity: 4, productName: 'fg' }])
    expect(await fgStock(fgA.id)).toBe(baseline - 4)

    const { approved, retId } = await returnAndApprove(order.id, [
      { productId: fgA.id, orderItemId: order.items[0].id, qty: 4, conversionToBase: 2.5 }
    ])
    expect(approved.status).toBe(200)
    // Sale deducted 4 base units; conv 2.5 must not inflate restoration to 10.
    expect(await fgStock(fgA.id)).toBe(baseline)
    expect(await returnHistoryChanges(retId, fgA.id)).toEqual([4])
  })

  test('TEST B — client conversion cannot distort reversal; invalid conversion rejected', async () => {
    const baseline = await fgStock(fgA.id)
    const order = await sell([{ product: fgA.id, quantity: 4, productName: 'fg' }])
    expect(await fgStock(fgA.id)).toBe(baseline - 4)

    const { approved } = await returnAndApprove(order.id, [
      { productId: fgA.id, orderItemId: order.items[0].id, qty: 2, conversionToBase: 999 }
    ])
    expect(approved.status).toBe(200)
    // Absurd client conversion must not manufacture stock: exactly 2 restored.
    expect(await fgStock(fgA.id)).toBe(baseline - 2)

    const zeroConv = await createReturn(order.id, [
      { productId: fgA.id, orderItemId: order.items[0].id, qty: 1, conversionToBase: 0 }
    ])
    expect(zeroConv.status).toBe(400)

    const negConv = await createReturn(order.id, [
      { productId: fgA.id, orderItemId: order.items[0].id, qty: 1, conversionToBase: -3 }
    ])
    expect(negConv.status).toBe(400)
  })

  test('TEST C — BOM mutation after sale: return reverses the ORIGINAL ingredient consumption', async () => {
    const order = await sell([{ product: mtoP.id, quantity: 2, productName: 'mto' }])
    // 2 units x 100g (BOM version A) = 200g consumed.
    expect(await ingStock(ingredient.id)).toBe(800)

    // Recipe changes BEFORE the return is approved (version B: 250g/unit).
    await bomLine.update({ qty: 250 })

    const { approved } = await returnAndApprove(order.id, [
      { productId: mtoP.id, orderItemId: order.items[0].id, qty: 2 }
    ])
    expect(approved.status).toBe(200)
    // Must restore the original 200g, not the current-recipe 500g.
    expect(await ingStock(ingredient.id)).toBe(1000)

    await bomLine.update({ qty: 100 })
  })

  test('TEST D — bundle composition mutation after sale: return reverses ORIGINAL components', async () => {
    const order = await sell([
      { product: compA.id, bundleId: bundle.id, quantity: 1, productName: bundle.name }
    ])
    // Sale-time composition: compA x2, compB x1.
    expect(await fgStock(compA.id)).toBe(98)
    expect(await fgStock(compB.id)).toBe(99)

    // Composition changes BEFORE approval: compA 2 -> 5, compB removed.
    const bundleItems = await db.product_bundle_item.findAll({ where: { bundleId: bundle.id } })
    const itemA = bundleItems.find((i) => i.product === compA.id)
    const itemB = bundleItems.find((i) => i.product === compB.id)
    await itemA.update({ quantity: 5 })
    await itemB.destroy()

    const bundleOrderItemId = order.items[0].id
    const { approved } = await returnAndApprove(order.id, [
      { productId: compA.id, orderItemId: bundleOrderItemId, qty: 1 }
    ])
    expect(approved.status).toBe(200)
    // Original mutation reversed: compA +2, compB +1 — never the new recipe.
    expect(await fgStock(compA.id)).toBe(100)
    expect(await fgStock(compB.id)).toBe(100)

    await db.product_bundle_item.destroy({ where: { bundleId: bundle.id }, force: true })
    await db.product_bundle_item.create({ bundleId: bundle.id, product: compA.id, quantity: 2 })
    await db.product_bundle_item.create({ bundleId: bundle.id, product: compB.id, quantity: 1 })
  })

  test('TEST E — mode mutation after sale: stocked sale still restores FG; MTO sale never gains phantom FG', async () => {
    const baselineMode = await fgStock(modeP.id)
    const orderStocked = await sell([{ product: modeP.id, quantity: 3, productName: 'mode' }])
    expect(await fgStock(modeP.id)).toBe(baselineMode - 3)

    // Product flips to make_to_order BEFORE approval: FG was deducted, so
    // FG must still be restored (history is the truth, not current mode).
    await modeP.update({ inventoryMode: 'make_to_order' })
    const first = await returnAndApprove(orderStocked.id, [
      { productId: modeP.id, orderItemId: orderStocked.items[0].id, qty: 3 }
    ])
    expect(first.approved.status).toBe(200)
    expect(await fgStock(modeP.id)).toBe(baselineMode)
    await modeP.update({ inventoryMode: 'stocked' })

    // Reverse direction: MTO sale consumes only ingredients; flipping to
    // stocked before approval must not create phantom FG stock.
    const fgBeforeMto = await fgStock(mtoP.id)
    const ingBefore = await ingStock(ingredient.id)
    const orderMto = await sell([{ product: mtoP.id, quantity: 1, productName: 'mto' }])
    expect(await ingStock(ingredient.id)).toBe(ingBefore - 100)
    expect(await fgStock(mtoP.id)).toBe(fgBeforeMto)
    await mtoP.update({ inventoryMode: 'stocked' })
    const second = await returnAndApprove(orderMto.id, [
      { productId: mtoP.id, orderItemId: orderMto.items[0].id, qty: 1 }
    ])
    expect(second.approved.status).toBe(200)
    expect(await fgStock(mtoP.id)).toBe(fgBeforeMto)
    expect(await ingStock(ingredient.id)).toBe(ingBefore)
    await mtoP.update({ inventoryMode: 'make_to_order' })
  })

  test('TEST F — fractional 4dp: fractional client conversion restores exact integer qty with no float drift', async () => {
    const baseline = await fgStock(fgA.id)
    const order = await sell([{ product: fgA.id, quantity: 2, productName: 'fg' }])
    expect(await fgStock(fgA.id)).toBe(baseline - 2)

    const { approved, retId } = await returnAndApprove(order.id, [
      { productId: fgA.id, orderItemId: order.items[0].id, qty: 2, conversionToBase: 1.5555 }
    ])
    expect(approved.status).toBe(200)
    expect(await fgStock(fgA.id)).toBe(baseline)
    // History carries the exact integer reversal — no binary-float residue.
    expect(await returnHistoryChanges(retId, fgA.id)).toEqual([2])

    // Conversion beyond the canonical 4dp precision is rejected at create.
    const overPrecise = await createReturn(order.id, [
      { productId: fgA.id, orderItemId: order.items[0].id, qty: 1, conversionToBase: 1.23456 }
    ])
    expect(overPrecise.status).toBe(400)
  })

  test('TEST G — partial return sequence with conversion noise sums exactly to the original deduction', async () => {
    const baseline = await fgStock(fgA.id)
    const order = await sell([{ product: fgA.id, quantity: 10, productName: 'fg' }])
    expect(await fgStock(fgA.id)).toBe(baseline - 10)

    const orderItemId = order.items[0].id
    const r1 = await returnAndApprove(order.id, [
      { productId: fgA.id, orderItemId, qty: 4, conversionToBase: 3 }
    ])
    expect(r1.approved.status).toBe(200)
    expect(await fgStock(fgA.id)).toBe(baseline - 6)

    const r2 = await returnAndApprove(order.id, [
      { productId: fgA.id, orderItemId, qty: 3, conversionToBase: 0.5 }
    ])
    expect(r2.approved.status).toBe(200)
    expect(await fgStock(fgA.id)).toBe(baseline - 3)

    const r3 = await returnAndApprove(order.id, [
      { productId: fgA.id, orderItemId, qty: 3 }
    ])
    expect(r3.approved.status).toBe(200)
    expect(await fgStock(fgA.id)).toBe(baseline)
  })
})
