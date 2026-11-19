process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 21 Batch 6 — F21-08.
//
// applyCostPrice's product/ingredient cost read (`db.product.findByPk` /
// resolveIngredientForItem's `db.ingredient.findOne`) is a plain,
// unlocked SELECT inside the GR transaction, followed by a JS-computed
// weighted average and a plain field UPDATE. Two concurrent Goods
// Receipts against the SAME product can both read stale cost/stock and
// the second commit can silently discard the first's cost contribution —
// a classic lost update.
//
// This test does NOT assert a specific expected cost value (the exact
// weighted-average arithmetic this codebase implements is out of this
// batch's scope to re-derive independently). Instead it proves internal
// CONSISTENCY: properly serialized concurrent execution must produce the
// same result as SOME valid sequential ordering (A-then-B or B-then-A) of
// the exact same two receipts starting from the exact same state. A lost
// update shows up as a THIRD, different value that matches neither valid
// ordering — proof that cross-transaction information was discarded,
// regardless of what the "correct" absolute number is.

let store = null
let category = null
let adminUser = null
let token = null
let productCounter = 0

const nextTag = () => {
  productCounter += 1
  return `GR_COST_RACE_${Date.now()}_${productCounter}`
}

beforeAll(async () => {
  store = await db.location.create(await withTestTenant({ name: 'GR_COST_RACE_STORE', status: 'active' }))
  category = await db.category.create({ name: 'GR_COST_RACE_CATEGORY' })
  adminUser = await db.user.create({
    userName: 'admin_gr_cost_race',
    email: 'admin_gr_cost_race@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  token = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  // Scoped to this file's own store/PO/receipt ids throughout — an
  // unscoped destroy({where:{}}) here would match every other test file's
  // in-flight fixtures under Jest's parallel workers sharing one DB
  // (observed in other suites' afterAll hooks).
  await db.stock_history.destroy({ where: { store: store.id }, force: true })
  const ownReceipts = await db.goodsReceipt.findAll({ where: { store: store.id }, attributes: ['id'] })
  const ownReceiptIds = ownReceipts.map((r) => r.id)
  await db.goodsReceiptItem.destroy({ where: { goodsReceipt: ownReceiptIds }, force: true })
  await db.goodsReceipt.destroy({ where: { store: store.id }, force: true })
  const ownPOs = await db.purchase_order.findAll({ where: { store: store.id }, attributes: ['id'] })
  const ownPOIds = ownPOs.map((po) => po.id)
  await db.purchase_order_item.destroy({ where: { purchaseOrder: ownPOIds }, force: true })
  await db.purchase_order.destroy({ where: { store: store.id }, force: true })
  await db.product_store_stock.destroy({ where: { store: store.id }, force: true })
  await db.ingredient.destroy({ where: { store: store.id }, force: true })
  await db.product.destroy({ where: { category: category.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { id: adminUser?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

const STARTING_STOCK = 100
const STARTING_COST = 1000
const GR_A = { qty: 20, unitCost: 5000 }
const GR_B = { qty: 30, unitCost: 9000 }

const makeProduct = () =>
  db.product.create({
    nameProduct: nextTag(),
    category: category.id,
    price: 20000,
    stock: STARTING_STOCK,
    costPrice: STARTING_COST
  })

const makePOFor = async (product, receipt) => {
  const res = await request(app)
    .post('/purchase-order/create')
    .set('Authorization', `Bearer ${token}`)
    .send({
      store: store.id,
      status: 'ordered',
      items: [{ product: product.id, quantity: receipt.qty, price: receipt.unitCost }]
    })
  return { po: res.body.data, poItemId: res.body.data.items[0].id }
}

const makeIngredient = () =>
  db.ingredient.create({
    store: store.id,
    name: nextTag(),
    stock: STARTING_STOCK,
    minStock: 0,
    unit: 'g',
    baseUnit: 'g',
    conversionFactor: 1,
    costPrice: STARTING_COST,
    status: 'active'
  })

const makePOForIngredient = async (ingredient, receipt) => {
  const res = await request(app)
    .post('/purchase-order/create')
    .set('Authorization', `Bearer ${token}`)
    .send({
      store: store.id,
      status: 'ordered',
      items: [
        {
          ingredient: ingredient.id,
          ingredientName: ingredient.name,
          quantity: receipt.qty,
          price: receipt.unitCost
        }
      ]
    })
  return { po: res.body.data, poItemId: res.body.data.items[0].id }
}

const fireGRForIngredient = (ingredient, po, poItemId, receipt) =>
  request(app)
    .post('/goods-receipt/create')
    .set('Authorization', `Bearer ${token}`)
    .send({
      store: store.id,
      purchaseOrderId: po.id,
      status: 'completed',
      items: [
        {
          purchaseOrderItem: poItemId,
          ingredient: ingredient.id,
          ingredientName: ingredient.name,
          qtyReceived: receipt.qty,
          price: receipt.unitCost,
          costPrice: receipt.unitCost
        }
      ]
    })

const fireGR = (product, po, poItemId, receipt) =>
  request(app)
    .post('/goods-receipt/create')
    .set('Authorization', `Bearer ${token}`)
    .send({
      store: store.id,
      purchaseOrderId: po.id,
      status: 'completed',
      items: [
        {
          purchaseOrderItem: poItemId,
          product: product.id,
          qtyReceived: receipt.qty,
          price: receipt.unitCost,
          costPrice: receipt.unitCost
        }
      ]
    })

describe('F21-08 — Goods Receipt weighted-average cost concurrency', () => {
  test('two concurrent receipts for the same product produce a result consistent with SOME valid serialized ordering', async () => {
    // Reference 1: A committed fully, then B — both fully sequential.
    const seqABProduct = await makeProduct()
    const { po: poA1, poItemId: itemA1 } = await makePOFor(seqABProduct, GR_A)
    const resA1 = await fireGR(seqABProduct, poA1, itemA1, GR_A)
    expect(resA1.status).toBe(201)
    const { po: poB1, poItemId: itemB1 } = await makePOFor(seqABProduct, GR_B)
    const resB1 = await fireGR(seqABProduct, poB1, itemB1, GR_B)
    expect(resB1.status).toBe(201)
    const seqABResult = await db.product.findByPk(seqABProduct.id)

    // Reference 2: B committed fully, then A — the other valid ordering.
    const seqBAProduct = await makeProduct()
    const { po: poB2, poItemId: itemB2 } = await makePOFor(seqBAProduct, GR_B)
    const resB2 = await fireGR(seqBAProduct, poB2, itemB2, GR_B)
    expect(resB2.status).toBe(201)
    const { po: poA2, poItemId: itemA2 } = await makePOFor(seqBAProduct, GR_A)
    const resA2 = await fireGR(seqBAProduct, poA2, itemA2, GR_A)
    expect(resA2.status).toBe(201)
    const seqBAResult = await db.product.findByPk(seqBAProduct.id)

    // Both valid sequential orderings must at least agree with each other
    // on final stock (always true — atomic literal) — sanity check before
    // the real concurrency comparison.
    expect(Number(seqABResult.stock)).toBe(STARTING_STOCK + GR_A.qty + GR_B.qty)
    expect(Number(seqBAResult.stock)).toBe(STARTING_STOCK + GR_A.qty + GR_B.qty)

    // The actual concurrency scenario: both receipts fired at once against
    // a product starting from the identical state.
    const concurrentProduct = await makeProduct()
    const { po: poAc, poItemId: itemAc } = await makePOFor(concurrentProduct, GR_A)
    const { po: poBc, poItemId: itemBc } = await makePOFor(concurrentProduct, GR_B)

    const [resAc, resBc] = await Promise.all([
      fireGR(concurrentProduct, poAc, itemAc, GR_A),
      fireGR(concurrentProduct, poBc, itemBc, GR_B)
    ])
    expect(resAc.status).toBe(201)
    expect(resBc.status).toBe(201)

    const concurrentResult = await db.product.findByPk(concurrentProduct.id)

    // Stock is always correct — the atomic literal increment guarantees
    // this regardless of the cost race.
    expect(Number(concurrentResult.stock)).toBe(STARTING_STOCK + GR_A.qty + GR_B.qty)

    // The cost race: a properly serialized implementation must land on
    // EXACTLY one of the two valid sequential outcomes, never a third,
    // different value produced by both transactions reading stale data.
    expect([seqABResult.costPrice, seqBAResult.costPrice]).toContain(
      concurrentResult.costPrice
    )
  })

  // Section 8: ingredient path is a separate mutation path (its own FK-
  // resolved row via resolveIngredientForItem, Batch 3) and must be
  // independently verified, not assumed safe by analogy to the product path.
  test('two concurrent receipts for the same ingredient produce a result consistent with SOME valid serialized ordering', async () => {
    const seqABIngredient = await makeIngredient()
    const { po: poA1, poItemId: itemA1 } = await makePOForIngredient(seqABIngredient, GR_A)
    expect((await fireGRForIngredient(seqABIngredient, poA1, itemA1, GR_A)).status).toBe(201)
    const { po: poB1, poItemId: itemB1 } = await makePOForIngredient(seqABIngredient, GR_B)
    expect((await fireGRForIngredient(seqABIngredient, poB1, itemB1, GR_B)).status).toBe(201)
    const seqABResult = await db.ingredient.findByPk(seqABIngredient.id)

    const seqBAIngredient = await makeIngredient()
    const { po: poB2, poItemId: itemB2 } = await makePOForIngredient(seqBAIngredient, GR_B)
    expect((await fireGRForIngredient(seqBAIngredient, poB2, itemB2, GR_B)).status).toBe(201)
    const { po: poA2, poItemId: itemA2 } = await makePOForIngredient(seqBAIngredient, GR_A)
    expect((await fireGRForIngredient(seqBAIngredient, poA2, itemA2, GR_A)).status).toBe(201)
    const seqBAResult = await db.ingredient.findByPk(seqBAIngredient.id)

    expect(Number(seqABResult.stock)).toBe(STARTING_STOCK + GR_A.qty + GR_B.qty)
    expect(Number(seqBAResult.stock)).toBe(STARTING_STOCK + GR_A.qty + GR_B.qty)

    const concurrentIngredient = await makeIngredient()
    const { po: poAc, poItemId: itemAc } = await makePOForIngredient(concurrentIngredient, GR_A)
    const { po: poBc, poItemId: itemBc } = await makePOForIngredient(concurrentIngredient, GR_B)

    const [resAc, resBc] = await Promise.all([
      fireGRForIngredient(concurrentIngredient, poAc, itemAc, GR_A),
      fireGRForIngredient(concurrentIngredient, poBc, itemBc, GR_B)
    ])
    expect(resAc.status).toBe(201)
    expect(resBc.status).toBe(201)

    const concurrentResult = await db.ingredient.findByPk(concurrentIngredient.id)

    expect(Number(concurrentResult.stock)).toBe(STARTING_STOCK + GR_A.qty + GR_B.qty)
    expect([seqABResult.costPrice, seqBAResult.costPrice]).toContain(
      concurrentResult.costPrice
    )
  })
})
