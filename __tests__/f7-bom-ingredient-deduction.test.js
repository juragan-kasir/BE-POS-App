process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let storeA = null
let storeB = null
let tableA = null
let category = null
let tokenA = null
let counter = 0

const nextTag = () => {
  counter += 1
  return `F7-${Date.now()}-${counter}`
}

const makeIngredient = async (store, overrides = {}) =>
  db.ingredient.create({
    store,
    name: nextTag(),
    stock: 1000,
    unit: 'g',
    baseUnit: 'g',
    costPrice: 10,
    ...overrides
  })

const makeProduct = async (overrides = {}) => {
  const product = await db.product.create({
    nameProduct: nextTag(),
    category: category.id,
    price: 20000,
    stock: 100,
    inventoryMode: 'stocked',
    ...overrides
  })
  // DR-14: the outlet row is the authoritative stock at each test store.
  for (const s of [storeA, storeB]) {
    await db.product_store_stock.create({ product: product.id, store: s.id, stock: product.stock })
  }
  return product
}

const makeBom = async (store, productId, lines, overrides = {}) => {
  const header = await db.bom_header.create({
    store,
    productId,
    name: nextTag(),
    status: 'active',
    ...overrides
  })
  await db.bom_line.bulkCreate(
    lines.map((l) => ({
      bomHeaderId: header.id,
      ingredientId: l.ingredientId,
      qty: l.qty,
      unit: l.unit || 'g'
    }))
  )
  return header
}

const createOrder = (token, body) =>
  request(app).post('/order/create').set('Authorization', `Bearer ${token}`).send(withIdempotencyKey(body))

// Phase 39 — a successful QR order occupies its table until paid/cancelled/
// void releases it. These fixtures create many independent QR orders on one
// shared tableA across different tests, so each booking starts from a freed
// table (same convention as the F-05 table-lock suite).
const customerCreate = async (body) => {
  await db.table.update({ status: 'available' }, { where: { id: tableA?.id } })
  return request(app)
    .post('/order/customer-create')
    .send({ tableId: tableA?.id, ...body })
}

const updateOrderStatus = (token, body) =>
  request(app).put('/order/update-status').set('Authorization', `Bearer ${token}`).send(body)

// Direct DB fixture for the deferred/paid-transition path — mirrors the
// established F3-F6 convention (an order created unpaid, transitioned to
// 'paid' later via PUT /order/update-status, exercising
// deductStockForPaidOrder rather than deductStockForOrder).
const makeUnpaidOrderWithItem = async ({ store, product, quantity, price = 20000 }) => {
  const order = await db.order.create({
    orderNumber: nextTag(),
    store,
    status: 'pending',
    paymentStatus: 'unpaid',
    subTotal: price * quantity,
    totalQuantity: quantity,
    totalPrice: price * quantity,
    // DR-04: settling via update-status requires a tender method — cash
    // here, so the paid-transition tests exercise the stocked-method path.
    paymentMethod: 'cash',
    source: 'pos'
  })
  const item = await db.order_item.create({
    order: order.id,
    product: product.id,
    productName: product.nameProduct,
    quantity,
    price,
    totalPrice: price * quantity,
    hppSnapshot: 0,
    status: 'pending'
  })
  return { order, item }
}

beforeAll(async () => {
  storeA = await db.location.create({ name: 'F7_STORE_A', status: 'active' })
  storeB = await db.location.create({ name: 'F7_STORE_B', status: 'active' })
  tableA = await db.table.create({ store: storeA.id, name: 'F7_TABLE' })
  category = await db.category.create({ name: 'F7_CATEGORY' })
  // P1-4: central gate denies unknown caller identities; these rows
  // satisfy the identity invariant. Assertions below are unchanged.
  await db.user.create({
    id: 9401,
    userName: 'f7_admin_a',
    email: 'p14-9401-f7-bom-ingredient-deduction@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: storeA.id,
    status: 'active',
    fullName: 'f7_admin_a'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  tokenA = await signSessionToken({ id: 9401, userName: 'f7_admin_a', roleType: 'admin', store: storeA.id }, JWT_SECRET)
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed rates for
  // both stores so these deduction assertions exercise configured tax.
  for (const s of [storeA, storeB]) {
    await db.taxConfig.create({
      name: `F7_PPN_${s.id}`,
      rate: 11,
      type: 'ppn',
      status: 'active',
      store: s.id
    })
  }
  // DR-04: settling via update-status requires drawer attribution — seed
  // the open register the paid transitions resolve at payment time.
  await db.cashRegister.destroy({ where: { store: storeA.id, status: 'open' }, force: true })
  await db.cashRegister.create({
    store: storeA.id,
    user: 9401,
    status: 'open',
    openingBalance: 0,
    openedAt: new Date()
  })
})

afterAll(async () => {
  await db.taxConfig.destroy({
    where: { store: [storeA?.id, storeB?.id].filter(Boolean) },
    force: true
  })
  await db.stock_history.destroy({ where: {}, force: true })
  await db.bom_line.destroy({ where: {}, force: true })
  await db.bom_header.destroy({ where: {}, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: [storeA.id, storeB.id] }, force: true })
  await db.cashRegister.destroy({ where: { store: [storeA.id, storeB.id] }, force: true })
  // Users last: open-register rows reference the opener (FK).
  await db.user.destroy({ where: { id: [9401] }, force: true })
  await db.table.destroy({ where: { id: tableA?.id }, force: true })
  await db.product_store_stock.destroy({ where: {}, force: true })
  await db.best_selling.destroy({ where: {}, force: true })
  await db.product.destroy({ where: { category: category.id }, force: true })
  await db.ingredient.destroy({ where: {}, force: true, paranoid: false })
  await db.category.destroy({ where: { id: category.id }, force: true })
  await db.location.destroy({ where: { id: [storeA.id, storeB.id] }, force: true })
})

describe('F7 — inventory modes', () => {
  test('stocked product with no BOM: unaffected, product stock deducted as before', async () => {
    const product = await makeProduct({ stock: 50 })
    const res = await createOrder(tokenA, {
      store: storeA.id,
      items: [{ product: product.id, quantity: 3 }],
      paymentMethod: 'cash',
      cashierName: 'F7 Test'
    })
    expect(res.status).toBe(201)
    const after = await db.product.findByPk(product.id)
    expect(Number(after.stock)).toBe(47)
  })

  test('stocked product WITH an active BOM: BOM is ignored entirely, only product stock deducted', async () => {
    const ing = await makeIngredient(storeA.id)
    const product = await makeProduct({ stock: 50, inventoryMode: 'stocked' })
    await makeBom(storeA.id, product.id, [{ ingredientId: ing.id, qty: 5 }])

    const res = await createOrder(tokenA, {
      store: storeA.id,
      items: [{ product: product.id, quantity: 2 }],
      paymentMethod: 'cash',
      cashierName: 'F7 Test'
    })
    expect(res.status).toBe(201)
    const afterProduct = await db.product.findByPk(product.id)
    expect(Number(afterProduct.stock)).toBe(48)
    const afterIng = await db.ingredient.findByPk(ing.id)
    expect(Number(afterIng.stock)).toBe(1000) // untouched
  })

  test('make_to_order product: product stock NOT deducted, ingredients deducted', async () => {
    const ing = await makeIngredient(storeA.id, { stock: 100 })
    const product = await makeProduct({ stock: 50, inventoryMode: 'make_to_order' })
    await makeBom(storeA.id, product.id, [{ ingredientId: ing.id, qty: 5 }])

    const res = await createOrder(tokenA, {
      store: storeA.id,
      items: [{ product: product.id, quantity: 3 }],
      paymentMethod: 'cash',
      cashierName: 'F7 Test'
    })
    expect(res.status).toBe(201)
    const afterProduct = await db.product.findByPk(product.id)
    expect(Number(afterProduct.stock)).toBe(50) // untouched
    const afterIng = await db.ingredient.findByPk(ing.id)
    expect(Number(afterIng.stock)).toBe(85) // 100 - (5*3)
  })

  test('hybrid product: both product stock and ingredients deducted', async () => {
    const ing = await makeIngredient(storeA.id, { stock: 100 })
    const product = await makeProduct({ stock: 50, inventoryMode: 'hybrid' })
    await makeBom(storeA.id, product.id, [{ ingredientId: ing.id, qty: 4 }])

    const res = await createOrder(tokenA, {
      store: storeA.id,
      items: [{ product: product.id, quantity: 2 }],
      paymentMethod: 'cash',
      cashierName: 'F7 Test'
    })
    expect(res.status).toBe(201)
    const afterProduct = await db.product.findByPk(product.id)
    expect(Number(afterProduct.stock)).toBe(48)
    const afterIng = await db.ingredient.findByPk(ing.id)
    expect(Number(afterIng.stock)).toBe(92) // 100 - (4*2)
  })

  test('default existing product (inventoryMode omitted at create) is stocked', async () => {
    const product = await db.product.create({
      nameProduct: nextTag(),
      category: category.id,
      price: 10000,
      stock: 10
    })
    expect(product.inventoryMode).toBe('stocked')
  })

  test('invalid inventoryMode is rejected at the API boundary', async () => {
    const res = await request(app)
      .post('/product/add-product')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ nameProduct: nextTag(), category: category.id, price: 1000, inventoryMode: 'bogus_mode' })
    expect(res.status).toBe(400)
  })
})

describe('F7 — BOM explosion', () => {
  test('multiple ingredients, quantity multiplication', async () => {
    const ingA = await makeIngredient(storeA.id, { stock: 1000 })
    const ingB = await makeIngredient(storeA.id, { stock: 1000 })
    const product = await makeProduct({ inventoryMode: 'make_to_order' })
    await makeBom(storeA.id, product.id, [
      { ingredientId: ingA.id, qty: 3 },
      { ingredientId: ingB.id, qty: 7 }
    ])

    const res = await createOrder(tokenA, {
      store: storeA.id,
      items: [{ product: product.id, quantity: 4 }],
      paymentMethod: 'cash',
      cashierName: 'F7 Test'
    })
    expect(res.status).toBe(201)
    expect(Number((await db.ingredient.findByPk(ingA.id)).stock)).toBe(1000 - 3 * 4)
    expect(Number((await db.ingredient.findByPk(ingB.id)).stock)).toBe(1000 - 7 * 4)
  })

  test('duplicate BOM lines for the same ingredient are summed, not deduplicated', async () => {
    const ing = await makeIngredient(storeA.id, { stock: 1000 })
    const product = await makeProduct({ inventoryMode: 'make_to_order' })
    await makeBom(storeA.id, product.id, [
      { ingredientId: ing.id, qty: 2 },
      { ingredientId: ing.id, qty: 3 }
    ])

    const res = await createOrder(tokenA, {
      store: storeA.id,
      items: [{ product: product.id, quantity: 4 }],
      paymentMethod: 'cash',
      cashierName: 'F7 Test'
    })
    expect(res.status).toBe(201)
    // (2+3) * 4 = 20, matching the mandatory example from the contract.
    expect(Number((await db.ingredient.findByPk(ing.id)).stock)).toBe(1000 - 20)
  })

  test('multiple order lines (different products) sharing one ingredient aggregate into a single mutation', async () => {
    const ing = await makeIngredient(storeA.id, { stock: 1000 })
    const productA = await makeProduct({ inventoryMode: 'make_to_order' })
    const productB = await makeProduct({ inventoryMode: 'make_to_order' })
    await makeBom(storeA.id, productA.id, [{ ingredientId: ing.id, qty: 5 }])
    await makeBom(storeA.id, productB.id, [{ ingredientId: ing.id, qty: 7 }])

    const res = await createOrder(tokenA, {
      store: storeA.id,
      items: [
        { product: productA.id, quantity: 1 },
        { product: productB.id, quantity: 1 }
      ],
      paymentMethod: 'cash',
      cashierName: 'F7 Test'
    })
    expect(res.status).toBe(201)
    expect(Number((await db.ingredient.findByPk(ing.id)).stock)).toBe(1000 - 12)

    const rows = await db.stock_history.findAll({
      where: { referenceType: 'sale', referenceId: res.body.data.id, ingredient: ing.id }
    })
    // per-(product, ingredient) attribution preserved, not collapsed.
    expect(rows.length).toBe(2)
    expect(rows.map((r) => Number(r.quantityChange)).sort((a, b) => a - b)).toEqual([-7, -5])
  })

  test('same product appearing in multiple order lines: ingredient requirement sums correctly', async () => {
    const ing = await makeIngredient(storeA.id, { stock: 1000 })
    const product = await makeProduct({ inventoryMode: 'make_to_order' })
    await makeBom(storeA.id, product.id, [{ ingredientId: ing.id, qty: 2 }])

    const res = await createOrder(tokenA, {
      store: storeA.id,
      items: [
        { product: product.id, quantity: 3 },
        { product: product.id, quantity: 5 }
      ],
      paymentMethod: 'cash',
      cashierName: 'F7 Test'
    })
    expect(res.status).toBe(201)
    // (2*3) + (2*5) = 16
    expect(Number((await db.ingredient.findByPk(ing.id)).stock)).toBe(1000 - 16)
  })
})

describe('F7 — BOM validation (fail-closed)', () => {
  test('missing BOM for a make_to_order product: 409, nothing mutated', async () => {
    const product = await makeProduct({ inventoryMode: 'make_to_order', stock: 20 })
    const res = await createOrder(tokenA, {
      store: storeA.id,
      items: [{ product: product.id, quantity: 1 }],
      paymentMethod: 'cash',
      cashierName: 'F7 Test'
    })
    expect(res.status).toBe(409)
    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(20)
  })

  test('empty BOM (header exists, zero lines): 409', async () => {
    const product = await makeProduct({ inventoryMode: 'make_to_order' })
    await db.bom_header.create({ store: storeA.id, productId: product.id, name: nextTag(), status: 'active' })
    const res = await createOrder(tokenA, {
      store: storeA.id,
      items: [{ product: product.id, quantity: 1 }],
      paymentMethod: 'cash',
      cashierName: 'F7 Test'
    })
    expect(res.status).toBe(409)
  })

  test('missing ingredient (bom_line references a soft-deleted ingredient): 409', async () => {
    const ing = await makeIngredient(storeA.id)
    const product = await makeProduct({ inventoryMode: 'make_to_order' })
    await makeBom(storeA.id, product.id, [{ ingredientId: ing.id, qty: 1 }])
    // Soft-delete only — bom_line.ingredientId has a real FK with no
    // ON DELETE CASCADE, so a hard delete is rejected by the database
    // itself. Paranoid's default scope excludes this row from the
    // resolver's findAll, which is exactly what "missing" means here.
    await db.ingredient.destroy({ where: { id: ing.id } })

    const res = await createOrder(tokenA, {
      store: storeA.id,
      items: [{ product: product.id, quantity: 1 }],
      paymentMethod: 'cash',
      cashierName: 'F7 Test'
    })
    expect(res.status).toBe(409)
  })

  test('foreign-store ingredient referenced by a same-store BOM: 409, deduction-time defense catches it', async () => {
    const foreignIng = await makeIngredient(storeB.id)
    const product = await makeProduct({ inventoryMode: 'make_to_order' })
    // Bypass bom.js's own authoring validation (direct DB insert) to prove
    // deduction-time defense does not rely solely on it.
    await makeBom(storeA.id, product.id, [{ ingredientId: foreignIng.id, qty: 1 }])

    const res = await createOrder(tokenA, {
      store: storeA.id,
      items: [{ product: product.id, quantity: 1 }],
      paymentMethod: 'cash',
      cashierName: 'F7 Test'
    })
    expect(res.status).toBe(409)
    expect(Number((await db.ingredient.findByPk(foreignIng.id)).stock)).toBe(1000)
  })

  test('NULL-store ingredient: 409', async () => {
    const nullStoreIng = await makeIngredient(null)
    const product = await makeProduct({ inventoryMode: 'make_to_order' })
    await makeBom(storeA.id, product.id, [{ ingredientId: nullStoreIng.id, qty: 1 }])

    const res = await createOrder(tokenA, {
      store: storeA.id,
      items: [{ product: product.id, quantity: 1 }],
      paymentMethod: 'cash',
      cashierName: 'F7 Test'
    })
    expect(res.status).toBe(409)
  })

  test('bom_line.qty <= 0: 409', async () => {
    const ing = await makeIngredient(storeA.id)
    const product = await makeProduct({ inventoryMode: 'make_to_order' })
    await makeBom(storeA.id, product.id, [{ ingredientId: ing.id, qty: 0 }])

    const res = await createOrder(tokenA, {
      store: storeA.id,
      items: [{ product: product.id, quantity: 1 }],
      paymentMethod: 'cash',
      cashierName: 'F7 Test'
    })
    expect(res.status).toBe(409)
  })

  test('unit mismatch (bom_line.unit !== ingredient.baseUnit): 409', async () => {
    const ing = await makeIngredient(storeA.id, { baseUnit: 'g' })
    const product = await makeProduct({ inventoryMode: 'make_to_order' })
    // Direct DB insert bypassing bom.js's own authoring check, to prove
    // deduction-time re-verification independently catches it too.
    const header = await db.bom_header.create({ store: storeA.id, productId: product.id, name: nextTag(), status: 'active' })
    await db.bom_line.create({ bomHeaderId: header.id, ingredientId: ing.id, qty: 5, unit: 'kg' })

    const res = await createOrder(tokenA, {
      store: storeA.id,
      items: [{ product: product.id, quantity: 1 }],
      paymentMethod: 'cash',
      cashierName: 'F7 Test'
    })
    expect(res.status).toBe(409)
  })
})

describe('F7 — BOM authoring validation (bom.js)', () => {
  test('creating a BOM with a unit mismatch is rejected at authoring time', async () => {
    const ing = await makeIngredient(storeA.id, { baseUnit: 'g' })
    const product = await makeProduct()
    const res = await request(app)
      .post('/bom/add')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ productId: product.id, lines: [{ ingredientId: ing.id, qty: 5, unit: 'kg' }] })
    expect(res.status).toBe(400)
    const lines = await db.bom_line.findAll({ include: [{ model: db.bom_header, as: 'header', where: { productId: product.id } }] })
    expect(lines.length).toBe(0)
  })

  test('creating a BOM with matching units succeeds', async () => {
    const ing = await makeIngredient(storeA.id, { baseUnit: 'g' })
    const product = await makeProduct()
    const res = await request(app)
      .post('/bom/add')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ productId: product.id, lines: [{ ingredientId: ing.id, qty: 5, unit: 'g' }] })
    expect(res.status).toBe(201)
  })
})

describe('F7 — atomicity: no partial mutation', () => {
  test('one sufficient ingredient + one insufficient ingredient: entire order rolls back', async () => {
    const ingOk = await makeIngredient(storeA.id, { stock: 1000 })
    const ingShort = await makeIngredient(storeA.id, { stock: 2 })
    const product = await makeProduct({ inventoryMode: 'make_to_order', stock: 20 })
    await makeBom(storeA.id, product.id, [
      { ingredientId: ingOk.id, qty: 1 },
      { ingredientId: ingShort.id, qty: 5 } // needs 5, only 2 available
    ])

    const res = await createOrder(tokenA, {
      store: storeA.id,
      items: [{ product: product.id, quantity: 1 }],
      paymentMethod: 'cash',
      cashierName: 'F7 Test'
    })
    expect(res.status).toBe(409)

    expect(Number((await db.ingredient.findByPk(ingOk.id)).stock)).toBe(1000)
    expect(Number((await db.ingredient.findByPk(ingShort.id)).stock)).toBe(2)
    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(20)
    const historyRows = await db.stock_history.findAll({
      where: { ingredient: [ingOk.id, ingShort.id] }
    })
    expect(historyRows.length).toBe(0)
  })
})

describe('F7 — deferred path (deductStockForPaidOrder, via PUT /order/update-status)', () => {
  test('make_to_order product: ingredients deducted on the paid-transition, not at order creation', async () => {
    const ing = await makeIngredient(storeA.id, { stock: 100 })
    const product = await makeProduct({ inventoryMode: 'make_to_order' })
    await makeBom(storeA.id, product.id, [{ ingredientId: ing.id, qty: 6 }])
    const { order } = await makeUnpaidOrderWithItem({ store: storeA.id, product, quantity: 2 })

    // Not yet deducted — order is still unpaid.
    expect(Number((await db.ingredient.findByPk(ing.id)).stock)).toBe(100)

    const res = await updateOrderStatus(tokenA, { id: order.id, status: 'paid' })
    expect(res.status).toBe(200)
    expect(Number((await db.ingredient.findByPk(ing.id)).stock)).toBe(100 - 12)
  })

  test('split-bill completion also triggers ingredient deduction (shared deductStockForPaidOrder)', async () => {
    const ing = await makeIngredient(storeA.id, { stock: 100 })
    const product = await makeProduct({ inventoryMode: 'make_to_order' })
    await makeBom(storeA.id, product.id, [{ ingredientId: ing.id, qty: 10 }])
    const { order } = await makeUnpaidOrderWithItem({ store: storeA.id, product, quantity: 1, price: 50000 })

    const createRes = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ order: order.id, items: [{ amount: 50000 }] })
    expect(createRes.status).toBe(201)
    const [split] = createRes.body.data

    const payRes = await request(app)
      .put(`/split-bill/pay/${split.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ paymentMethod: 'cash' })
    expect(payRes.status).toBe(200)
    expect(payRes.body.data.orderComplete).toBe(true)
    expect(Number((await db.ingredient.findByPk(ing.id)).stock)).toBe(90)
  })
})

describe('F7 — snapshot immutability (mandatory)', () => {
  test('cancellation restores the EXACT originally-deducted quantity, never a re-read of a since-edited BOM', async () => {
    const ing = await makeIngredient(storeA.id, { stock: 100 })
    const product = await makeProduct({ inventoryMode: 'make_to_order' })
    const bom = await makeBom(storeA.id, product.id, [{ ingredientId: ing.id, qty: 5 }])

    const res = await createOrder(tokenA, {
      store: storeA.id,
      items: [{ product: product.id, quantity: 1 }],
      paymentMethod: 'cash',
      cashierName: 'F7 Test'
    })
    expect(res.status).toBe(201)
    expect(Number((await db.ingredient.findByPk(ing.id)).stock)).toBe(95) // 100 - 5

    // Change the recipe drastically AFTER the sale.
    const line = await db.bom_line.findOne({ where: { bomHeaderId: bom.id, ingredientId: ing.id } })
    await line.update({ qty: 100 })

    const cancelRes = await updateOrderStatus(tokenA, { id: res.body.data.id, status: 'void', reason: 'F7 test void reason' })
    expect(cancelRes.status).toBe(200)

    // Must restore exactly 5 (the original snapshot), never 100.
    expect(Number((await db.ingredient.findByPk(ing.id)).stock)).toBe(100)

    const reversalRows = await db.stock_history.findAll({
      where: { referenceType: 'sale_reversal', referenceId: res.body.data.id, ingredient: ing.id }
    })
    expect(reversalRows.length).toBe(1)
    expect(Number(reversalRows[0].quantityChange)).toBe(5)
  })

  test('cancellation reversal preserves per-product attribution for multiple products sharing an ingredient', async () => {
    const ing = await makeIngredient(storeA.id, { stock: 100 })
    const productA = await makeProduct({ inventoryMode: 'make_to_order' })
    const productB = await makeProduct({ inventoryMode: 'make_to_order' })
    await makeBom(storeA.id, productA.id, [{ ingredientId: ing.id, qty: 5 }])
    await makeBom(storeA.id, productB.id, [{ ingredientId: ing.id, qty: 7 }])

    const res = await createOrder(tokenA, {
      store: storeA.id,
      items: [
        { product: productA.id, quantity: 1 },
        { product: productB.id, quantity: 1 }
      ],
      paymentMethod: 'cash',
      cashierName: 'F7 Test'
    })
    expect(res.status).toBe(201)
    expect(Number((await db.ingredient.findByPk(ing.id)).stock)).toBe(100 - 12)

    const cancelRes = await updateOrderStatus(tokenA, { id: res.body.data.id, status: 'void', reason: 'F7 test void reason' })
    expect(cancelRes.status).toBe(200)
    expect(Number((await db.ingredient.findByPk(ing.id)).stock)).toBe(100)

    const reversalRows = await db.stock_history.findAll({
      where: { referenceType: 'sale_reversal', referenceId: res.body.data.id, ingredient: ing.id }
    })
    expect(reversalRows.length).toBe(2)
    expect(reversalRows.map((r) => Number(r.quantityChange)).sort((a, b) => a - b)).toEqual([5, 7])
  })
})

// DR-23 (BA §35.10 G): reversing a PAID order is an elevated VOID (cancel
// is only for orders with nothing collected); the reversal assertions below
// are unchanged and now run on the void path.
describe('F7 — exactly-once', () => {
  test('duplicate/retried completion attempt on the same order never double-deducts', async () => {
    const ing = await makeIngredient(storeA.id, { stock: 100 })
    const product = await makeProduct({ inventoryMode: 'make_to_order' })
    await makeBom(storeA.id, product.id, [{ ingredientId: ing.id, qty: 6 }])
    const { order } = await makeUnpaidOrderWithItem({ store: storeA.id, product, quantity: 1 })

    const [r1, r2] = await Promise.all([
      updateOrderStatus(tokenA, { id: order.id, status: 'paid' }),
      updateOrderStatus(tokenA, { id: order.id, status: 'paid' })
    ])
    const statuses = [r1.status, r2.status].sort((a, b) => a - b)
    // DR-23 (BA §35.10 K): the loser re-validates under the order lock and is
    // refused on the fresh state (outstanding 0) — never a hidden 200 no-op.
    expect(statuses).toEqual([200, 409])
    expect([r1, r2].find((r) => r.status === 409).body.code).toBe('OUTSTANDING_CHANGED')

    expect(Number((await db.ingredient.findByPk(ing.id)).stock)).toBe(94) // deducted exactly once, not 88
    const rows = await db.stock_history.findAll({
      where: { referenceType: 'sale', referenceId: order.id, ingredient: ing.id }
    })
    expect(rows.length).toBe(1)
  })
})

describe('F7 — tenant isolation', () => {
  test('a BOM belonging to a different store is treated as absent (409), not silently used', async () => {
    const ing = await makeIngredient(storeB.id)
    const product = await makeProduct({ inventoryMode: 'make_to_order' })
    // BOM exists, but for storeB, while the order is for storeA.
    await makeBom(storeB.id, product.id, [{ ingredientId: ing.id, qty: 1 }])

    const res = await createOrder(tokenA, {
      store: storeA.id,
      items: [{ product: product.id, quantity: 1 }],
      paymentMethod: 'cash',
      cashierName: 'F7 Test'
    })
    expect(res.status).toBe(409)
  })

  test('malformed cross-store BOM inserted directly at the DB level is still rejected at checkout', async () => {
    const foreignIng = await makeIngredient(storeB.id, { stock: 500 })
    const product = await makeProduct({ inventoryMode: 'make_to_order' })
    // Same-store BOM header, but its line references another store's
    // ingredient — exactly the malformed-record scenario deduction-time
    // defense (not authoring-time validation) must catch.
    await makeBom(storeA.id, product.id, [{ ingredientId: foreignIng.id, qty: 1 }])

    const res = await createOrder(tokenA, {
      store: storeA.id,
      items: [{ product: product.id, quantity: 1 }],
      paymentMethod: 'cash',
      cashierName: 'F7 Test'
    })
    expect(res.status).toBe(409)
    expect(Number((await db.ingredient.findByPk(foreignIng.id)).stock)).toBe(500)
  })
})

// Client contract (docs/order-create-client-contract.md §4): the
// insufficient-ingredient refusal carries a stable code so clients never
// mistake it for an idempotency conflict. Status and message are unchanged;
// it is raised inside the sale transaction, after the key lookup, so it
// writes nothing and does not consume the key.
describe('F7 — INGREDIENT_STOCK_CONFLICT contract', () => {
  test('counter sale: 409 + code, unchanged message, no order/stock/ledger/journal effect, key not consumed', async () => {
    const ing = await makeIngredient(storeA.id, { stock: 2 })
    const product = await makeProduct({ inventoryMode: 'make_to_order', stock: 20 })
    await makeBom(storeA.id, product.id, [{ ingredientId: ing.id, qty: 5 }])
    const key = `${nextTag()}-key`
    const body = {
      store: storeA.id,
      items: [{ product: product.id, quantity: 1 }],
      paymentMethod: 'cash',
      cashierName: 'F7 Code',
      idempotencyKey: key
    }
    const [ledgerBefore, outboxBefore] = [await db.transaction.count(), await db.accounting_outbox.count()]

    const res = await createOrder(tokenA, body)
    expect(res.status).toBe(409)
    // exactly the existing body plus the code (message format unchanged)
    expect(Object.keys(res.body).sort()).toEqual(['code', 'error'])
    expect(res.body.code).toBe('INGREDIENT_STOCK_CONFLICT')
    expect(res.body.error).toMatch(
      new RegExp(`^Stok bahan baku "${ing.name}" tidak mencukupi\\. Tersedia: 2(\\.0+)?, dibutuhkan: 5$`)
    )
    expect(await db.order.count({ where: { idempotencyKey: key } })).toBe(0)
    expect(Number((await db.ingredient.findByPk(ing.id)).stock)).toBe(2)
    expect(await db.stock_history.count({ where: { ingredient: ing.id } })).toBe(0)
    expect(await db.transaction.count()).toBe(ledgerBefore)
    expect(await db.accounting_outbox.count()).toBe(outboxBefore)

    // same key, stock refilled: the sale is created once (nothing was
    // recorded under the key by the refusal)
    await db.ingredient.update({ stock: 10 }, { where: { id: ing.id } })
    const retry = await createOrder(tokenA, body)
    expect(retry.status).toBe(201)
    expect(await db.order.count({ where: { idempotencyKey: key } })).toBe(1)
    expect(Number((await db.ingredient.findByPk(ing.id)).stock)).toBe(5)
  })

  test('unrelated BOM 409s keep their existing code-less shape', async () => {
    const product = await makeProduct({ inventoryMode: 'make_to_order', stock: 20 })
    const res = await createOrder(tokenA, {
      store: storeA.id,
      items: [{ product: product.id, quantity: 1 }],
      paymentMethod: 'cash',
      cashierName: 'F7 Code'
    })
    expect(res.status).toBe(409)
    expect(res.body.code).toBeUndefined()
  })

  // BA gap 028 (DR-18): settling an already-taken order is never refused
  // for stock — the payment stands and the shortage is recorded and shown.
  test('deferred paid transition with an ingredient shortage settles and records the shortage', async () => {
    const ing = await makeIngredient(storeA.id, { stock: 1 })
    const product = await makeProduct({ inventoryMode: 'make_to_order', stock: 20 })
    await makeBom(storeA.id, product.id, [{ ingredientId: ing.id, qty: 3 }])
    const { order } = await makeUnpaidOrderWithItem({ store: storeA.id, product, quantity: 1 })
    const res = await updateOrderStatus(tokenA, {
      id: order.id,
      store: storeA.id,
      status: 'paid',
      paymentMethod: 'cash'
    })
    expect(res.status).toBe(200)
    expect(res.body.stockShortages).toEqual([
      expect.objectContaining({ type: 'ingredient', id: ing.id, required: 3, deducted: 1, shortfall: 2 })
    ])
    expect((await db.order.findByPk(order.id)).paymentStatus).toBe('paid')
    expect(await db.transaction.count({ where: { order: order.id } })).toBe(1)
    // Never below zero, and the uncovered amount is explicit, not clamped away.
    expect(Number((await db.ingredient.findByPk(ing.id)).stock)).toBe(0)
    const [history] = await db.stock_history.findAll({
      where: { referenceType: 'sale', referenceId: order.id, ingredient: ing.id },
      limit: 1
    })
    expect(Number(history.quantityChange)).toBe(-1)
    expect(history.notes).toMatch(/KURANG 2/)
    const [audit] = await db.auditLog.findAll({
      where: { entity: 'stock_shortage', entityId: order.id },
      limit: 1
    })
    expect(audit).not.toBeNull()
    expect(audit.newValues.shortages[0].shortfall).toBe(2)
  })
})

describe('F7 — concurrency', () => {
  test('two concurrent orders consuming the same ingredient, combined demand > stock: exactly one succeeds', async () => {
    const ing = await makeIngredient(storeA.id, { stock: 10 })
    const product = await makeProduct({ inventoryMode: 'make_to_order' })
    await makeBom(storeA.id, product.id, [{ ingredientId: ing.id, qty: 7 }])

    const [r1, r2] = await Promise.all([
      createOrder(tokenA, {
        store: storeA.id,
        items: [{ product: product.id, quantity: 1 }],
        paymentMethod: 'cash',
        cashierName: 'F7 Concurrent A'
      }),
      createOrder(tokenA, {
        store: storeA.id,
        items: [{ product: product.id, quantity: 1 }],
        paymentMethod: 'cash',
        cashierName: 'F7 Concurrent B'
      })
    ])
    const statuses = [r1.status, r2.status].sort((a, b) => a - b)
    expect(statuses).toEqual([201, 409])
    expect(Number((await db.ingredient.findByPk(ing.id)).stock)).toBe(3) // 10 - 7, exactly once
  })

  test('two different products sharing one ingredient, concurrent checkouts, both within stock: both succeed, deducted once each', async () => {
    const ing = await makeIngredient(storeA.id, { stock: 100 })
    const productA = await makeProduct({ inventoryMode: 'make_to_order' })
    const productB = await makeProduct({ inventoryMode: 'make_to_order' })
    await makeBom(storeA.id, productA.id, [{ ingredientId: ing.id, qty: 5 }])
    await makeBom(storeA.id, productB.id, [{ ingredientId: ing.id, qty: 8 }])

    const [r1, r2] = await Promise.all([
      createOrder(tokenA, {
        store: storeA.id,
        items: [{ product: productA.id, quantity: 1 }],
        paymentMethod: 'cash',
        cashierName: 'F7 Concurrent A'
      }),
      createOrder(tokenA, {
        store: storeA.id,
        items: [{ product: productB.id, quantity: 1 }],
        paymentMethod: 'cash',
        cashierName: 'F7 Concurrent B'
      })
    ])
    expect(r1.status).toBe(201)
    expect(r2.status).toBe(201)
    expect(Number((await db.ingredient.findByPk(ing.id)).stock)).toBe(100 - 5 - 8)
  })

  test('multiple ingredients in one order, post-lock revalidation determines the outcome (not a stale pre-transaction estimate)', async () => {
    const ing = await makeIngredient(storeA.id, { stock: 10 })
    const product = await makeProduct({ inventoryMode: 'make_to_order' })
    await makeBom(storeA.id, product.id, [{ ingredientId: ing.id, qty: 6 }])

    // First order passes any pre-check (10 >= 6) and succeeds, leaving 4.
    const first = await createOrder(tokenA, {
      store: storeA.id,
      items: [{ product: product.id, quantity: 1 }],
      paymentMethod: 'cash',
      cashierName: 'F7 Test'
    })
    expect(first.status).toBe(201)

    // Second order also needs 6, but only 4 remain — must fail under the
    // freshly-locked value, not any stale estimate from before the first
    // order committed.
    const second = await createOrder(tokenA, {
      store: storeA.id,
      items: [{ product: product.id, quantity: 1 }],
      paymentMethod: 'cash',
      cashierName: 'F7 Test'
    })
    expect(second.status).toBe(409)
    expect(Number((await db.ingredient.findByPk(ing.id)).stock)).toBe(4)
  })
})

describe('F7 — deadlock retry (real Postgres deadlock, not mocked)', () => {
  test('withDeadlockRetry recovers a genuine deadlock between two transactions locking ingredient rows in opposite order', async () => {
    const { withDeadlockRetry } = require('../utils/deadlockRetry')
    const ingX = await makeIngredient(storeA.id, { stock: 100 })
    const ingY = await makeIngredient(storeA.id, { stock: 100 })

    // Deliberately opposite lock order across the two transactions —
    // bypassing F7's own sorted-locking code on purpose, to force a real
    // Postgres deadlock and prove withDeadlockRetry (the mechanism F7's
    // sorted locking relies on as a backstop) actually recovers one.
    let attemptsA = 0
    let attemptsB = 0
    const txnA = withDeadlockRetry(() =>
      db.sequelize.transaction(async (t) => {
        attemptsA += 1
        await db.ingredient.findByPk(ingX.id, { transaction: t, lock: t.LOCK.UPDATE })
        await new Promise((resolve) => setTimeout(resolve, 150))
        await db.ingredient.findByPk(ingY.id, { transaction: t, lock: t.LOCK.UPDATE })
        await db.ingredient.update({ stock: 90 }, { where: { id: ingX.id }, transaction: t })
      })
    )
    const txnB = withDeadlockRetry(() =>
      db.sequelize.transaction(async (t) => {
        attemptsB += 1
        await db.ingredient.findByPk(ingY.id, { transaction: t, lock: t.LOCK.UPDATE })
        await new Promise((resolve) => setTimeout(resolve, 150))
        await db.ingredient.findByPk(ingX.id, { transaction: t, lock: t.LOCK.UPDATE })
        await db.ingredient.update({ stock: 90 }, { where: { id: ingY.id }, transaction: t })
      })
    )

    await Promise.all([txnA, txnB])

    // Both must have eventually succeeded — one of them was necessarily
    // killed by Postgres's deadlock detector and retried from scratch by
    // withDeadlockRetry (a genuine 40P01, not a mock).
    expect(Number((await db.ingredient.findByPk(ingX.id)).stock)).toBe(90)
    expect(Number((await db.ingredient.findByPk(ingY.id)).stock)).toBe(90)
    expect(attemptsA + attemptsB).toBeGreaterThan(2)
  })
})

describe('F7 — QR customer paid via trusted cashier transition (Phase 3.1)', () => {
  // AUD-1 security boundary: the public QR create can never self-authorize
  // a paid state. Every "immediate" payment in these tests is therefore a
  // two-step flow: public create (recorded unpaid, no mutations) followed by
  // the cashier's authorized order-status transition to 'paid', which is
  // where stock/ingredient/ledger mutates exactly once (deductStockForPaidOrder).
  const createThenPaid = async (body) => {
    const created = await customerCreate(body)
    if (created.status !== 201) return { created, paid: null }
    const paid = await updateOrderStatus(tokenA, {
      id: created.body.data.id,
      status: 'paid'
    })
    return { created, paid }
  }

  test('make_to_order: finished-good stock untouched, ingredients deducted per BOM (on trusted paid)', async () => {
    const ing = await makeIngredient(storeA.id, { stock: 100 })
    // FG stock deliberately below demand — must NOT reject on finished
    // goods; BOM ingredient availability is authoritative for this mode.
    const product = await makeProduct({ stock: 1, inventoryMode: 'make_to_order' })
    await makeBom(storeA.id, product.id, [{ ingredientId: ing.id, qty: 5 }])

    const { created, paid } = await createThenPaid({
      store: storeA.id,
      paymentMethod: 'cash',
      customerName: 'QR F7',
      items: [{ productId: product.id, productName: product.nameProduct, quantity: 2 }]
    })
    expect(created.status).toBe(201)
    expect(created.body.data.paymentStatus).toBe('unpaid')
    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(1) // FG untouched yet
    expect(paid.status).toBe(200)
    expect(created.body.data.paymentStatus).toBe('unpaid')
    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(1) // FG untouched
    expect(Number((await db.ingredient.findByPk(ing.id)).stock)).toBe(90) // 100 - (5*2)
  })

  test('hybrid: both finished-good stock and ingredients deducted (on trusted paid)', async () => {
    const ing = await makeIngredient(storeA.id, { stock: 100 })
    const product = await makeProduct({ stock: 50, inventoryMode: 'hybrid' })
    await makeBom(storeA.id, product.id, [{ ingredientId: ing.id, qty: 4 }])

    const { created, paid } = await createThenPaid({
      store: storeA.id,
      paymentMethod: 'cash',
      customerName: 'QR F7',
      items: [{ productId: product.id, productName: product.nameProduct, quantity: 2 }]
    })
    expect(created.status).toBe(201)
    expect(created.body.data.paymentStatus).toBe('unpaid')
    expect(paid.status).toBe(200)
    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(48)
    expect(Number((await db.ingredient.findByPk(ing.id)).stock)).toBe(92) // 100 - (4*2)
  })

  test('make_to_order with insufficient ingredient: create OK, trusted paid settles with a recorded shortage (DR-18)', async () => {
    const ing = await makeIngredient(storeA.id, { stock: 2 })
    const product = await makeProduct({ stock: 0, inventoryMode: 'make_to_order' })
    await makeBom(storeA.id, product.id, [{ ingredientId: ing.id, qty: 5 }])

    const created = await customerCreate({
      store: storeA.id,
      paymentMethod: 'cash',
      customerName: 'QR F7',
      items: [{ productId: product.id, productName: product.nameProduct, quantity: 1 }]
    })
    // The public create itself cannot know the ingredient demand yet — the
    // order is recorded unpaid without touching any stock.
    expect(created.status).toBe(201)
    expect(created.body.data.paymentStatus).toBe('unpaid')

    const paid = await updateOrderStatus(tokenA, {
      id: created.body.data.id,
      status: 'paid'
    })
    // DR-18: the payment is not refused for stock at settlement.
    expect(paid.status).toBe(200)
    expect(paid.body.stockShortages).toEqual([
      expect.objectContaining({ type: 'ingredient', id: ing.id, required: 5, deducted: 2, shortfall: 3 })
    ])
    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(0)
    expect(Number((await db.ingredient.findByPk(ing.id)).stock)).toBe(0)
    const persisted = await db.order.findByPk(created.body.data.id)
    expect(persisted.paymentStatus).toBe('paid')
    expect(await db.transaction.findAll({ where: { order: created.body.data.id } })).toHaveLength(1)
  })

  test('a stocked dish short at its outlet settles; the shortfall is recorded, never clamped silently (DR-18)', async () => {
    const product = await makeProduct({ stock: 1, inventoryMode: 'stocked' })
    const created = await customerCreate({
      store: storeA.id,
      paymentMethod: 'cash',
      customerName: 'QR F7 FG',
      items: [{ productId: product.id, productName: product.nameProduct, quantity: 1 }]
    })
    expect(created.status).toBe(201)
    // Another sale takes the last unit before this order is paid.
    await db.product_store_stock.update({ stock: 0 }, { where: { product: product.id, store: storeA.id } })

    const paid = await updateOrderStatus(tokenA, { id: created.body.data.id, status: 'paid' })
    expect(paid.status).toBe(200)
    expect(paid.body.stockShortages).toEqual([
      expect.objectContaining({ type: 'product', id: product.id, required: 1, deducted: 0, shortfall: 1 })
    ])
    const [outlet] = await db.product_store_stock.findAll({
      where: { product: product.id, store: storeA.id },
      limit: 1
    })
    expect(Number(outlet.stock)).toBe(0)
    const [history] = await db.stock_history.findAll({
      where: { referenceType: 'sale', referenceId: created.body.data.id, product: product.id, ingredient: null },
      limit: 1
    })
    expect(Number(history.quantityChange)).toBe(0)
    expect(history.notes).toMatch(/KURANG 1/)
  })

  test('stocked: finished-good stock deducted, ingredient stock untouched (regression)', async () => {
    const ing = await makeIngredient(storeA.id, { stock: 100 })
    const product = await makeProduct({ stock: 50, inventoryMode: 'stocked' })
    await makeBom(storeA.id, product.id, [{ ingredientId: ing.id, qty: 5 }])

    const { created, paid } = await createThenPaid({
      store: storeA.id,
      paymentMethod: 'cash',
      customerName: 'QR F7',
      items: [{ productId: product.id, productName: product.nameProduct, quantity: 3 }]
    })
    expect(created.status).toBe(201)
    expect(created.body.data.paymentStatus).toBe('unpaid')
    expect(paid.status).toBe(200)
    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(47)
    expect(Number((await db.ingredient.findByPk(ing.id)).stock)).toBe(100) // BOM ignored
  })

  test('bundle with a make_to_order BOM component: each component expanded & deducted per inventoryMode', async () => {
    const mtoIng = await makeIngredient(storeA.id, { stock: 100 })
    const mtoProduct = await makeProduct({ stock: 1, inventoryMode: 'make_to_order' })
    await makeBom(storeA.id, mtoProduct.id, [{ ingredientId: mtoIng.id, qty: 5 }])
    const stockedProduct = await makeProduct({ stock: 50, inventoryMode: 'stocked' })

    const bundle = await db.product_bundle.create({
      name: nextTag(),
      store: storeA.id,
      bundlePrice: 30000,
      status: 'active',
      isAvailable: true
    })
    await db.product_bundle_item.bulkCreate([
      { bundleId: bundle.id, product: mtoProduct.id, quantity: 1 },
      { bundleId: bundle.id, product: stockedProduct.id, quantity: 2 }
    ])

    const { created, paid } = await createThenPaid({
      store: storeA.id,
      paymentMethod: 'cash',
      customerName: 'QR F7 bundle',
      items: [{ bundleId: bundle.id, bundleName: bundle.name, quantity: 1 }]
    })
    expect(created.status).toBe(201)
    expect(created.body.data.paymentStatus).toBe('unpaid')
    expect(paid.status).toBe(200)
    // make_to_order component: finished-good untouched, ingredients per BOM.
    expect(Number((await db.product.findByPk(mtoProduct.id)).stock)).toBe(1)
    expect(Number((await db.ingredient.findByPk(mtoIng.id)).stock)).toBe(95) // 100 - (5*1)
    // stocked component: finished-good deducted for the bundle quantity.
    expect(Number((await db.product.findByPk(stockedProduct.id)).stock)).toBe(48) // 50 - (2*1)

    // Cleanup: the QR order's order_item references the bundle (FK), so
    // drop those rows before the bundle records themselves.
    await db.order_item.destroy({ where: { bundleId: bundle.id }, force: true })
    await db.product_bundle_item.destroy({ where: { bundleId: bundle.id }, force: true })
    await db.product_bundle.destroy({ where: { id: bundle.id }, force: true })
  })
})

// F-REV1 — the deferred paid-transition path expands a bundle into ALL its
// components at deduction time, so the corresponding cancel/void reversal
// must restore EXACTLY what that deduction snapshot recorded — never the
// first component only, and never the bundle config as it reads after the
// sale. These tests pin the "WHAT WAS DEDUCTED == WHAT CAN BE RESTORED"
// invariant for bundle FG stock and best_selling.
describe('F7 — bundle FG reversal symmetry (F-REV1)', () => {
  const createThenPaid = async (body) => {
    const created = await customerCreate(body)
    if (created.status !== 201) return { created, paid: null }
    const paid = await updateOrderStatus(tokenA, {
      id: created.body.data.id,
      status: 'paid'
    })
    return { created, paid }
  }

  const makeBundle = async ({ components }) => {
    const bundle = await db.product_bundle.create({
      name: nextTag(),
      store: storeA.id,
      bundlePrice: 100000,
      status: 'active',
      isAvailable: true
    })
    await db.product_bundle_item.bulkCreate(
      components.map((c) => ({
        bundleId: bundle.id,
        product: c.product.id,
        quantity: c.quantity || 1
      }))
    )
    return bundle
  }

  const repackBundle = async (bundleId, components) => {
    await db.product_bundle_item.destroy({ where: { bundleId }, force: true })
    await db.product_bundle_item.bulkCreate(
      components.map((c) => ({
        bundleId,
        product: c.product.id,
        quantity: c.quantity || 1
      }))
    )
  }

  const bestSellingOf = async (productId) => {
    const row = await db.best_selling.findOne({
      where: { productId, store: storeA.id }
    })
    return Number(row?.totalSelling || 0)
  }

  const cleanupOrderWithBundle = async (orderId, bundleId) => {
    await db.order.destroy({ where: { id: orderId }, force: true })
    await db.product_bundle_item.destroy({ where: { bundleId }, force: true })
    await db.product_bundle.destroy({ where: { id: bundleId }, force: true })
  }

  test('REV-BUNDLE-MULTI-FG — multi-component stocked bundle: every component FG-restored, best_selling symmetric', async () => {
    const A = await makeProduct({ stock: 10 })
    const B = await makeProduct({ stock: 10 })
    const C = await makeProduct({ stock: 10 })
    const bsBefore = {
      A: await bestSellingOf(A.id),
      B: await bestSellingOf(B.id),
      C: await bestSellingOf(C.id)
    }
    const bundle = await makeBundle({ components: [{ product: A }, { product: B }, { product: C }] })

    const { created, paid } = await createThenPaid({
      store: storeA.id,
      paymentMethod: 'cash',
      customerName: 'REV-BUNDLE-MULTI-FG',
      items: [{ bundleId: bundle.id, bundleName: bundle.name, quantity: 1 }]
    })
    expect(created.status).toBe(201)
    expect(paid.status).toBe(200)

    expect(Number((await db.product.findByPk(A.id)).stock)).toBe(9)
    expect(Number((await db.product.findByPk(B.id)).stock)).toBe(9)
    expect(Number((await db.product.findByPk(C.id)).stock)).toBe(9)
    expect(await bestSellingOf(A.id)).toBe(bsBefore.A + 1)
    expect(await bestSellingOf(B.id)).toBe(bsBefore.B + 1)
    expect(await bestSellingOf(C.id)).toBe(bsBefore.C + 1)

    const cancel = await updateOrderStatus(tokenA, {
      id: created.body.data.id,
      status: 'void',
      reason: 'F7 test void reason'
    })
    expect(cancel.status).toBe(200)

    expect(Number((await db.product.findByPk(A.id)).stock)).toBe(10)
    expect(Number((await db.product.findByPk(B.id)).stock)).toBe(10)
    expect(Number((await db.product.findByPk(C.id)).stock)).toBe(10)
    expect(await bestSellingOf(A.id)).toBe(bsBefore.A)
    expect(await bestSellingOf(B.id)).toBe(bsBefore.B)
    expect(await bestSellingOf(C.id)).toBe(bsBefore.C)

    await cleanupOrderWithBundle(created.body.data.id, bundle.id)
  })

  test('REV-BUNDLE-MIXED-MODE — stocked/make_to_order/hybrid: FG per mode + ingredients all restored', async () => {
    const A = await makeProduct({ stock: 10, inventoryMode: 'stocked' })
    const ingB = await makeIngredient(storeA.id, { stock: 100 })
    const B = await makeProduct({ stock: 10, inventoryMode: 'make_to_order' })
    await makeBom(storeA.id, B.id, [{ ingredientId: ingB.id, qty: 5 }])
    const ingC = await makeIngredient(storeA.id, { stock: 100 })
    const C = await makeProduct({ stock: 10, inventoryMode: 'hybrid' })
    await makeBom(storeA.id, C.id, [{ ingredientId: ingC.id, qty: 2 }])

    const bundle = await makeBundle({ components: [{ product: A }, { product: B }, { product: C }] })

    const { created, paid } = await createThenPaid({
      store: storeA.id,
      paymentMethod: 'cash',
      customerName: 'REV-BUNDLE-MIXED-MODE',
      items: [{ bundleId: bundle.id, bundleName: bundle.name, quantity: 1 }]
    })
    expect(created.status).toBe(201)
    expect(paid.status).toBe(200)
    expect(Number((await db.product.findByPk(A.id)).stock)).toBe(9)
    expect(Number((await db.product.findByPk(B.id)).stock)).toBe(10) // FG untouched
    expect(Number((await db.product.findByPk(C.id)).stock)).toBe(9)
    expect(Number((await db.ingredient.findByPk(ingB.id)).stock)).toBe(95)
    expect(Number((await db.ingredient.findByPk(ingC.id)).stock)).toBe(98)

    const cancel = await updateOrderStatus(tokenA, {
      id: created.body.data.id,
      status: 'void',
      reason: 'F7 test void reason'
    })
    expect(cancel.status).toBe(200)
    expect(Number((await db.product.findByPk(A.id)).stock)).toBe(10)
    expect(Number((await db.product.findByPk(B.id)).stock)).toBe(10) // FG stays untouched
    expect(Number((await db.product.findByPk(C.id)).stock)).toBe(10)
    expect(Number((await db.ingredient.findByPk(ingB.id)).stock)).toBe(100)
    expect(Number((await db.ingredient.findByPk(ingC.id)).stock)).toBe(100)

    await cleanupOrderWithBundle(created.body.data.id, bundle.id)
  })

  test('REV-BUNDLE-QUANTITY — bundleQty > 1 restores the exact multiplied amounts', async () => {
    const A = await makeProduct({ stock: 50 })
    const B = await makeProduct({ stock: 50 })
    const bundle = await makeBundle({
      components: [{ product: A, quantity: 3 }, { product: B, quantity: 2 }]
    })

    const { created, paid } = await createThenPaid({
      store: storeA.id,
      paymentMethod: 'cash',
      customerName: 'REV-BUNDLE-QUANTITY',
      items: [{ bundleId: bundle.id, bundleName: bundle.name, quantity: 2 }]
    })
    expect(created.status).toBe(201)
    expect(paid.status).toBe(200)
    expect(Number((await db.product.findByPk(A.id)).stock)).toBe(44) // 50 - (3*2)
    expect(Number((await db.product.findByPk(B.id)).stock)).toBe(46) // 50 - (2*2)

    const cancel = await updateOrderStatus(tokenA, {
      id: created.body.data.id,
      status: 'void',
      reason: 'F7 test void reason'
    })
    expect(cancel.status).toBe(200)
    expect(Number((await db.product.findByPk(A.id)).stock)).toBe(50)
    expect(Number((await db.product.findByPk(B.id)).stock)).toBe(50)

    await cleanupOrderWithBundle(created.body.data.id, bundle.id)
  })

  test('REV-BUNDLE-IDEMPOTENT-REVERSE — repeated cancellation never double-restores', async () => {
    const A = await makeProduct({ stock: 10 })
    const bundle = await makeBundle({ components: [{ product: A }] })

    const { created, paid } = await createThenPaid({
      store: storeA.id,
      paymentMethod: 'cash',
      customerName: 'REV-BUNDLE-IDEMPOTENT-REVERSE',
      items: [{ bundleId: bundle.id, bundleName: bundle.name, quantity: 1 }]
    })
    expect(created.status).toBe(201)
    expect(paid.status).toBe(200)
    expect(Number((await db.product.findByPk(A.id)).stock)).toBe(9)

    const cancel1 = await updateOrderStatus(tokenA, { id: created.body.data.id, status: 'void', reason: 'F7 test void reason' })
    expect(cancel1.status).toBe(200)
    expect(Number((await db.product.findByPk(A.id)).stock)).toBe(10)

    const cancel2 = await updateOrderStatus(tokenA, { id: created.body.data.id, status: 'void' })
    expect(cancel2.status).toBe(200)
    expect(Number((await db.product.findByPk(A.id)).stock)).toBe(10) // no double restore

    // DR-23: switching between terminal states is refused; still no restore.
    const cancelAfterVoid = await updateOrderStatus(tokenA, { id: created.body.data.id, status: 'cancelled' })
    expect(cancelAfterVoid.status).toBe(409)
    expect(cancelAfterVoid.body.code).toBe('INVALID_TRANSITION')
    expect(Number((await db.product.findByPk(A.id)).stock)).toBe(10)

    await cleanupOrderWithBundle(created.body.data.id, bundle.id)
  })

  test('REV-BUNDLE-AFTER-EDIT — reversal follows the historical sale snapshot, never the current bundle config', async () => {
    const A = await makeProduct({ stock: 10 })
    const B = await makeProduct({ stock: 10 })
    const C = await makeProduct({ stock: 10 })
    const D = await makeProduct({ stock: 10 })
    const E = await makeProduct({ stock: 10 })
    const bundle = await makeBundle({
      components: [{ product: A }, { product: B }, { product: C }]
    })

    // T0: order taken while the bundle is A+B+C.
    const created = await customerCreate({
      store: storeA.id,
      paymentMethod: 'cash',
      customerName: 'REV-BUNDLE-AFTER-EDIT',
      items: [{ bundleId: bundle.id, bundleName: bundle.name, quantity: 1 }]
    })
    expect(created.status).toBe(201)
    expect(created.body.data.paymentStatus).toBe('unpaid')

    // T1: admin edits the bundle to A+D before payment.
    await repackBundle(bundle.id, [{ product: A }, { product: D }])

    // T2: trusted paid reads the CURRENT config — only A and D are deducted.
    const paid = await updateOrderStatus(tokenA, { id: created.body.data.id, status: 'paid' })
    expect(paid.status).toBe(200)
    expect(Number((await db.product.findByPk(A.id)).stock)).toBe(9)
    expect(Number((await db.product.findByPk(D.id)).stock)).toBe(9)
    expect(Number((await db.product.findByPk(B.id)).stock)).toBe(10)
    expect(Number((await db.product.findByPk(C.id)).stock)).toBe(10)

    // T3: admin edits the bundle again (to A+E) AFTER the sale.
    await repackBundle(bundle.id, [{ product: A }, { product: E }])

    // T4: reversal must restore the SALE's immutable deduction (A,D) — not
    // the original order composition (A,B,C), not the current config (A,E).
    const cancel = await updateOrderStatus(tokenA, { id: created.body.data.id, status: 'void', reason: 'F7 test void reason' })
    expect(cancel.status).toBe(200)
    expect(Number((await db.product.findByPk(A.id)).stock)).toBe(10)
    expect(Number((await db.product.findByPk(D.id)).stock)).toBe(10)
    expect(Number((await db.product.findByPk(B.id)).stock)).toBe(10) // never deducted
    expect(Number((await db.product.findByPk(C.id)).stock)).toBe(10) // never deducted
    expect(Number((await db.product.findByPk(E.id)).stock)).toBe(10) // current-config only, never sold

    await cleanupOrderWithBundle(created.body.data.id, bundle.id)
  })
})
