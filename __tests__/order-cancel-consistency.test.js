process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// E1-E regression: order cancellation consistency — terminal state,
// exactly-once stock reversal (FG + ingredients), single refund ledger
// row, single reversal outbox job, atomic rollback, serialized races.
// Established contract: cancel reverses what the sale deducted
// (history-snapshot driven); loyalty/promo/tier benefits granted at sale
// are intentionally NOT reversed (no domain contract exists for that).

const unique = (prefix) =>
  `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

let store = null
let category = null
let adminToken = null
let stockedProduct = null
let mtoProduct = null
let ingredient = null
let bundleCompA = null
let bundleCompB = null
let bundle = null

async function makeProduct(name, overrides = {}) {
  const p = await db.product.create({
    nameProduct: name,
    category: category.id,
    price: 15000,
    stock: 60,
    ...overrides
  })
  await db.product_store_stock.create({
    product: p.id,
    store: store.id,
    stock: 60
  })
  return p
}

async function sell(items, key) {
  const res = await request(app)
    .post('/order/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send(withIdempotencyKey({
      store: store.id,
      items,
      paymentMethod: 'cash',
      cashierName: 'Cancel Cashier',
      idempotencyKey: key || unique('cancelsell')
    }))
  if (res.status !== 201) throw new Error('sale setup failed: ' + JSON.stringify(res.body))
  return res.body.data
}

async function cancelOrder(orderId, body = {}) {
  return request(app)
    .put('/order/update-status')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      id: orderId,
      status: 'cancelled',
      store: store.id,
      reason: 'customer changed mind',
      ...body
    })
}

// DR-23 (BA §35.10 G, DR-08): reversing a PAID order is a VOID (elevated,
// with reason); cancel is only for orders with nothing collected. The
// reversal guarantees below (exactly-once stock restore, single refund row,
// single reversal job, atomic rollback, serialized races) are unchanged and
// are now asserted on the void path.
async function voidOrder(orderId, body = {}) {
  return request(app)
    .put('/order/update-status')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      id: orderId,
      status: 'void',
      store: store.id,
      reason: 'customer changed mind',
      ...body
    })
}

async function fgStock(productId) {
  return Number((await db.product.findByPk(productId)).stock)
}

async function ingStock(ingredientId) {
  return Number((await db.ingredient.findByPk(ingredientId)).stock)
}

async function refundTxns(orderId) {
  return db.transaction.findAll({ where: { order: orderId } })
}

async function reversalJobs(orderId) {
  return db.accounting_outbox.findAll({
    where: { referenceType: 'order', referenceId: orderId, jobType: 'reverse_order_journals' }
  })
}

beforeAll(async () => {
  store = await db.location.create({ name: `CX_STORE_${Date.now()}`, status: 'active' })
  category = await db.category.create({ name: `CX_CAT_${Date.now()}` })
  stockedProduct = await makeProduct(`CX_STOCKED_${Date.now()}`)
  mtoProduct = await makeProduct(`CX_MTO_${Date.now()}`, { inventoryMode: 'make_to_order' })
  ingredient = await db.ingredient.create({
    store: store.id,
    name: `CX_ING_${Date.now()}`,
    stock: 2000,
    unit: 'g',
    baseUnit: 'g',
    costPrice: 5
  })
  const header = await db.bom_header.create({
    store: store.id,
    productId: mtoProduct.id,
    name: `CX_BOM_${Date.now()}`,
    status: 'active'
  })
  await db.bom_line.create({
    bomHeaderId: header.id,
    ingredientId: ingredient.id,
    qty: 50,
    unit: 'g'
  })

  bundleCompA = await makeProduct(`CX_BA_${Date.now()}`)
  bundleCompB = await makeProduct(`CX_BB_${Date.now()}`)
  bundle = await db.product_bundle.create({
    name: `CX_BUNDLE_${Date.now()}`,
    bundlePrice: 20000,
    isAvailable: true,
    status: 'active',
    store: store.id
  })
  await db.product_bundle_item.create({ bundleId: bundle.id, product: bundleCompA.id, quantity: 1 })
  await db.product_bundle_item.create({ bundleId: bundle.id, product: bundleCompB.id, quantity: 2 })

  const adminUser = await db.user.create({
    userName: `admin_cx_${Date.now()}`,
    email: `admin_cx_${Date.now()}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed the rate
  // so these cancel-consistency assertions exercise configured tax.
  await db.taxConfig.create({
    name: 'CX_PPN',
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: store.id
  })
  // DR-04: settling via update-status requires drawer attribution — seed
  // the open register the paid transition resolves at payment time.
  await db.cashRegister.destroy({ where: { store: store.id, status: 'open' }, force: true })
  await db.cashRegister.create({
    store: store.id,
    user: adminUser.id,
    status: 'open',
    openingBalance: 0,
    openedAt: new Date()
  })
})

afterAll(async () => {
  await db.taxConfig.destroy({ where: { store: store?.id }, force: true })
  await db.stock_history.destroy({ where: { store: store?.id }, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.sales_return_item.destroy({ where: {}, force: true })
  await db.sales_return.destroy({ where: { store: store?.id }, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: store?.id }, force: true })
  await db.cashRegister.destroy({ where: { store: store?.id }, force: true })
  await db.best_selling.destroy({ where: { store: store?.id }, force: true })
  await db.accounting_outbox.destroy({ where: { store: store?.id }, force: true })
  const journals = await db.journal_entry.findAll({ where: { store: store?.id } })
  for (const j of journals) {
    await db.journal_entry_line.destroy({ where: { journalEntry: j.id }, force: true })
  }
  await db.journal_entry.destroy({ where: { store: store?.id }, force: true })
  await db.product_store_stock.destroy({ where: { store: store?.id }, force: true })
  await db.product_bundle_item.destroy({ where: {}, force: true })
  await db.product_bundle.destroy({ where: {}, force: true })
  await db.bom_line.destroy({ where: {}, force: true })
  await db.bom_header.destroy({ where: { store: store?.id }, force: true })
  await db.ingredient.destroy({ where: { id: ingredient?.id }, force: true })
  await db.product.destroy({
    where: {
      id: [stockedProduct?.id, mtoProduct?.id, bundleCompA?.id, bundleCompB?.id].filter(Boolean)
    },
    force: true
  })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { store: store?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('E1-E cancellation consistency', () => {
  test('Test A — normal paid void: terminal state, exact stock restore, single refund + reversal job', async () => {
    const baseline = await fgStock(stockedProduct.id)
    const order = await sell([{ product: stockedProduct.id, quantity: 3, productName: 'a' }])
    expect(await fgStock(stockedProduct.id)).toBe(baseline - 3)

    const res = await voidOrder(order.id)
    expect([200, 201]).toContain(res.status)

    const fresh = await db.order.findByPk(order.id)
    expect(fresh.status).toBe('void')
    expect(fresh.paymentStatus).toBe('refunded')
    expect(await fgStock(stockedProduct.id)).toBe(baseline)

    const txns = await refundTxns(order.id)
    expect(txns.filter((t) => Number(t.amount) < 0).length).toBe(1)
    expect(await reversalJobs(order.id)).toHaveLength(1)
  })

  test('Test B — repeated void: no second reversal, no duplicate refund or job', async () => {
    const baseline = await fgStock(stockedProduct.id)
    const order = await sell([{ product: stockedProduct.id, quantity: 2, productName: 'b' }])
    const first = await voidOrder(order.id)
    expect([200, 201]).toContain(first.status)
    expect(await fgStock(stockedProduct.id)).toBe(baseline)

    const second = await voidOrder(order.id)
    expect(second.status).not.toBe(500)
    expect(await fgStock(stockedProduct.id)).toBe(baseline)
    const txns = await refundTxns(order.id)
    expect(txns.filter((t) => Number(t.amount) < 0).length).toBe(1)
    expect(await reversalJobs(order.id)).toHaveLength(1)
  })

  test('Test C — injected mid-void failure rolls everything back', async () => {
    const baseline = await fgStock(stockedProduct.id)
    const order = await sell([{ product: stockedProduct.id, quantity: 2, productName: 'c' }])

    // F-04 convention: fail the refund-ledger write deterministically.
    const spy = jest
      .spyOn(db.transaction, 'create')
      .mockRejectedValueOnce(new Error('injected E1-E failure'))
    const res = await voidOrder(order.id)
    spy.mockRestore()

    expect(res.status).toBe(500)
    const fresh = await db.order.findByPk(order.id)
    expect(fresh.status).toBe('paid')
    expect(fresh.paymentStatus).toBe('paid')
    expect(await fgStock(stockedProduct.id)).toBe(baseline - 2)
    expect((await refundTxns(order.id)).filter((t) => Number(t.amount) < 0)).toHaveLength(0)
    expect(await reversalJobs(order.id)).toHaveLength(0)
  })

  test('Test D — concurrent voids: exactly one logical reversal', async () => {
    const baseline = await fgStock(stockedProduct.id)
    const order = await sell([{ product: stockedProduct.id, quantity: 2, productName: 'd' }])

    const [r1, r2] = await Promise.all([voidOrder(order.id), voidOrder(order.id)])
    for (const r of [r1, r2]) expect(r.status).not.toBe(500)

    const fresh = await db.order.findByPk(order.id)
    expect(fresh.status).toBe('void')
    expect(await fgStock(stockedProduct.id)).toBe(baseline)
    const txns = await refundTxns(order.id)
    expect(txns.filter((t) => Number(t.amount) < 0).length).toBe(1)
    expect(await reversalJobs(order.id)).toHaveLength(1)
  })

  test('Test E — cancel vs paid-transition race: exactly one terminal outcome, consistent stock/ledger', async () => {
    const baseline = await fgStock(stockedProduct.id)
    const order = await db.order.create({
      orderNumber: `CX-UNPAID-${Date.now()}`,
      store: store.id,
      status: 'pending',
      paymentStatus: 'unpaid',
      subTotal: 15000,
      totalQuantity: 1,
      totalPrice: 15000,
      // DR-04: settling via update-status requires a tender method.
      paymentMethod: 'cash',
      source: 'qr'
    })
    await db.order_item.create({
      order: order.id,
      product: stockedProduct.id,
      productName: stockedProduct.nameProduct,
      quantity: 1,
      price: 15000,
      totalPrice: 15000
    })

    const payBody = { id: order.id, status: 'paid', store: store.id }
    const [payRes, cancelRes] = await Promise.all([
      request(app).put('/order/update-status').set('Authorization', `Bearer ${adminToken}`).send(payBody),
      cancelOrder(order.id)
    ])
    for (const r of [payRes, cancelRes]) expect(r.status).not.toBe(500)

    const fresh = await db.order.findByPk(order.id)
    const stock = await fgStock(stockedProduct.id)
    const txns = await refundTxns(order.id)
    const negatives = txns.filter((t) => Number(t.amount) < 0).length
    if (fresh.status === 'paid') {
      // Payment won: exactly-once deduction and exactly one payment row.
      expect(stock).toBe(baseline - 1)
      expect(txns.length).toBe(1)
      expect(negatives).toBe(0)
    } else {
      // Cancel won (possibly followed by a consistent paid-cancel): stock
      // is either untouched (cancel of unpaid) or restored exactly once.
      expect(['cancelled', 'void']).toContain(fresh.status)
      expect(stock).toBe(baseline)
      if (fresh.paymentStatus === 'refunded') {
        expect(negatives).toBe(1)
      } else {
        expect(negatives).toBe(0)
      }
    }
  })

  test('Test F — BOM void: ingredient restored exactly, FG untouched for make_to_order', async () => {
    const baseline = await ingStock(ingredient.id)
    const fgBefore = await fgStock(mtoProduct.id)
    const order = await sell([{ product: mtoProduct.id, quantity: 2, productName: 'f' }])
    expect(await ingStock(ingredient.id)).toBe(baseline - 100)
    expect(await fgStock(mtoProduct.id)).toBe(fgBefore)

    const res = await voidOrder(order.id)
    expect([200, 201]).toContain(res.status)
    expect(await ingStock(ingredient.id)).toBe(baseline)
    expect(await fgStock(mtoProduct.id)).toBe(fgBefore)
  })

  test('Test G — mixed order (stocked + mto + bundle): every domain reversed exactly', async () => {
    const baseS = await fgStock(stockedProduct.id)
    const baseI = await ingStock(ingredient.id)
    const baseA = await fgStock(bundleCompA.id)
    const baseB = await fgStock(bundleCompB.id)
    const order = await sell([
      { product: stockedProduct.id, quantity: 2, productName: 'g1' },
      { product: mtoProduct.id, quantity: 1, productName: 'g2' },
      { product: bundleCompA.id, bundleId: bundle.id, quantity: 1, productName: 'g3' }
    ])

    expect(await fgStock(stockedProduct.id)).toBe(baseS - 2)
    expect(await ingStock(ingredient.id)).toBe(baseI - 50)
    expect(await fgStock(bundleCompA.id)).toBe(baseA - 1)
    expect(await fgStock(bundleCompB.id)).toBe(baseB - 2)

    const res = await voidOrder(order.id)
    expect([200, 201]).toContain(res.status)
    expect(await fgStock(stockedProduct.id)).toBe(baseS)
    expect(await ingStock(ingredient.id)).toBe(baseI)
    expect(await fgStock(bundleCompA.id)).toBe(baseA)
    expect(await fgStock(bundleCompB.id)).toBe(baseB)
  })
})
