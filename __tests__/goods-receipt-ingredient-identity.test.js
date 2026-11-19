process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 21 Batch 3 — P1: Goods Receipt previously resolved an ingredient's
// identity by Op.iLike name matching against a client-supplied
// `ingredientName` snapshot, even though purchase_order_item already
// carries a real `ingredient` FK (validated at PO creation) that is
// reachable through the same object graph goodsReceipt.js already loads
// (goods_receipt_item -> purchaseOrderItem -> poItemData.ingredient /
// poItemData.ingredientData.id). Name matching breaks silently on a
// rename, resolves non-deterministically when two ingredients in the same
// store share a name, and never surfaces a failure when nothing matches —
// the receipt still reports success with the ingredient side quietly
// skipped. resolveIngredientForItem() in api/controller/goodsReceipt.js
// now prefers the FK whenever it's reachable, and throws (failing the
// whole receipt atomically) when an authoritative reference is present but
// does not resolve to a real ingredient row for the receipt's own store.

let storeA = null
let storeB = null
let adminA = null
let adminB = null
let tokenA = null
let tokenB = null

beforeAll(async () => {
  storeA = await db.location.create(await withTestTenant({ name: 'GR_ID_STORE_A', status: 'active' }))
  storeB = await db.location.create(await withTestTenant({ name: 'GR_ID_STORE_B', status: 'active' }))

  adminA = await db.user.create({
    userName: 'admin_gr_id_a',
    email: 'admin_gr_id_a@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: storeA.id,
    status: 'active'
  })
  adminB = await db.user.create({
    userName: 'admin_gr_id_b',
    email: 'admin_gr_id_b@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: storeB.id,
    status: 'active'
  })

  tokenA = await signSessionToken(
    { id: adminA.id, userName: adminA.userName, roleType: 'admin', store: storeA.id },
    JWT_SECRET
  )
  tokenB = await signSessionToken(
    { id: adminB.id, userName: adminB.userName, roleType: 'admin', store: storeB.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.stock_history.destroy({ where: { store: [storeA.id, storeB.id] }, force: true })
  await db.goodsReceiptItem.destroy({ where: {}, force: true })
  await db.goodsReceipt.destroy({ where: { store: [storeA.id, storeB.id] }, force: true })
  await db.purchase_order_item.destroy({ where: {}, force: true })
  await db.purchase_order.destroy({ where: { store: [storeA.id, storeB.id] }, force: true })
  await db.ingredient.destroy({ where: { store: [storeA.id, storeB.id] }, force: true })
  await db.user.destroy({ where: { id: [adminA?.id, adminB?.id] }, force: true })
  await db.location.destroy({ where: { id: [storeA?.id, storeB?.id] }, force: true })
})

const createIngredient = (store, overrides = {}) =>
  db.ingredient.create({
    store: store.id,
    name: 'GR_ID_ING',
    stock: 0,
    minStock: 0,
    unit: 'pcs',
    baseUnit: 'pcs',
    conversionFactor: 1,
    status: 'active',
    ...overrides
  })

const createPoWithIngredient = async (token, store, ingredient, opts = {}) => {
  const res = await request(app)
    .post('/purchase-order/create')
    .set('Authorization', `Bearer ${token}`)
    .send({
      store: store.id,
      status: 'ordered',
      items: [
        {
          ingredient: ingredient.id,
          ingredientName: opts.ingredientName ?? ingredient.name,
          quantity: opts.quantity ?? 10,
          price: opts.price ?? 1000
        }
      ]
    })
  expect(res.status).toBe(201)
  return { po: res.body.data, poItemId: res.body.data.items[0].id }
}

describe('Goods Receipt ingredient identity — TEST A rename safety', () => {
  test('receiving still updates the correct ingredient after it was renamed post-PO', async () => {
    const ingredient = await createIngredient(storeA, { name: 'Gula Pasir' })
    const { po, poItemId } = await createPoWithIngredient(tokenA, storeA, ingredient, {
      ingredientName: 'Gula Pasir'
    })

    // Renamed after the PO/GR-form data was captured, before physical receiving.
    await ingredient.update({ name: 'Gula Pasir Premium' })

    const grRes = await request(app)
      .post('/goods-receipt/create')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        store: storeA.id,
        purchaseOrderId: po.id,
        status: 'completed',
        items: [
          {
            purchaseOrderItem: poItemId,
            ingredient: ingredient.id,
            // Stale snapshot — what the FE would still be holding from
            // when the PO/GR form was first loaded, before the rename.
            ingredientName: 'Gula Pasir',
            qtyReceived: 10,
            price: 1000
          }
        ]
      })

    expect(grRes.status).toBe(201)

    const updated = await db.ingredient.findByPk(ingredient.id)
    expect(Number(updated.stock)).toBe(10)
  })
})

describe('Goods Receipt ingredient identity — TEST B duplicate-name safety', () => {
  test('receiving updates only the specific ingredient referenced by FK, not a same-named sibling', async () => {
    const first = await createIngredient(storeA, { name: 'Susu' })
    const second = await createIngredient(storeA, { name: 'Susu' })

    // PO item explicitly references the SECOND ingredient.
    const { po, poItemId } = await createPoWithIngredient(tokenA, storeA, second, {
      ingredientName: 'Susu'
    })

    const grRes = await request(app)
      .post('/goods-receipt/create')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        store: storeA.id,
        purchaseOrderId: po.id,
        status: 'completed',
        items: [
          {
            purchaseOrderItem: poItemId,
            ingredient: second.id,
            ingredientName: 'Susu',
            qtyReceived: 10,
            price: 1000
          }
        ]
      })

    expect(grRes.status).toBe(201)

    const firstAfter = await db.ingredient.findByPk(first.id)
    const secondAfter = await db.ingredient.findByPk(second.id)
    expect(Number(secondAfter.stock)).toBe(10)
    expect(Number(firstAfter.stock)).toBe(0)
  })
})

describe('Goods Receipt ingredient identity — TEST C no silent skip / atomicity', () => {
  test('a deleted-but-referenced ingredient fails the whole receipt instead of silently skipping it', async () => {
    const ingredient = await createIngredient(storeA, { name: 'GR_ID_DELETED' })
    const { po, poItemId } = await createPoWithIngredient(tokenA, storeA, ingredient)

    // Deleted (soft-delete, paranoid) after the PO was created, before receiving.
    await ingredient.destroy()

    const poItemBefore = await db.purchase_order_item.findByPk(poItemId)

    const grRes = await request(app)
      .post('/goods-receipt/create')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        store: storeA.id,
        purchaseOrderId: po.id,
        status: 'completed',
        items: [
          {
            purchaseOrderItem: poItemId,
            ingredient: ingredient.id,
            ingredientName: ingredient.name,
            qtyReceived: 10,
            price: 1000
          }
        ]
      })

    // Must fail, not silently succeed.
    expect(grRes.status).toBeGreaterThanOrEqual(400)

    // Nothing partially mutated: receivedQuantity unchanged, no GR row created.
    const poItemAfter = await db.purchase_order_item.findByPk(poItemId)
    expect(Number(poItemAfter.receivedQuantity)).toBe(Number(poItemBefore.receivedQuantity))

    const receipts = await db.goodsReceipt.findAll({ where: { purchaseOrderId: po.id } })
    expect(receipts.length).toBe(0)

    const history = await db.stock_history.findAll({
      where: { ingredient: ingredient.id }
    })
    expect(history.length).toBe(0)
  })
})

describe('Goods Receipt ingredient identity — TEST D existing valid flow regression', () => {
  test('a normal ingredient receipt still increases stock and writes a ledger entry', async () => {
    const ingredient = await createIngredient(storeA, { name: 'GR_ID_VALID' })
    const { po, poItemId } = await createPoWithIngredient(tokenA, storeA, ingredient)

    const grRes = await request(app)
      .post('/goods-receipt/create')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        store: storeA.id,
        purchaseOrderId: po.id,
        status: 'completed',
        items: [
          {
            purchaseOrderItem: poItemId,
            ingredient: ingredient.id,
            ingredientName: ingredient.name,
            qtyReceived: 10,
            price: 1000
          }
        ]
      })

    expect(grRes.status).toBe(201)

    const updated = await db.ingredient.findByPk(ingredient.id)
    expect(Number(updated.stock)).toBe(10)

    const history = await db.stock_history.findAll({
      where: { ingredient: ingredient.id, referenceType: 'purchase' }
    })
    expect(history.length).toBe(1)
    expect(Number(history[0].quantityChange)).toBe(10)
  })
})

describe('Goods Receipt ingredient identity — store isolation', () => {
  test('a forged ingredient id belonging to another store fails safely and never mutates that store\'s ingredient', async () => {
    const ingredientA = await createIngredient(storeA, { name: 'GR_ID_CROSS_A' })
    const ingredientB = await createIngredient(storeB, { name: 'GR_ID_CROSS_B' })

    const { po, poItemId } = await createPoWithIngredient(tokenB, storeB, ingredientB, {
      ingredientName: 'GR_ID_CROSS_B'
    })

    const grRes = await request(app)
      .post('/goods-receipt/create')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({
        store: storeB.id,
        purchaseOrderId: po.id,
        status: 'completed',
        items: [
          {
            purchaseOrderItem: poItemId,
            // Forged: points at Store A's ingredient instead of the PO's own.
            ingredient: ingredientA.id,
            ingredientName: 'GR_ID_CROSS_B',
            qtyReceived: 10,
            price: 1000
          }
        ]
      })

    expect(grRes.status).toBeGreaterThanOrEqual(400)

    const aAfter = await db.ingredient.findByPk(ingredientA.id)
    const bAfter = await db.ingredient.findByPk(ingredientB.id)
    expect(Number(aAfter.stock)).toBe(0)
    expect(Number(bAfter.stock)).toBe(0)
  })
})
