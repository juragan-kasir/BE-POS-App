process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Regression tests for the concurrency audit: these fire genuinely
// concurrent requests (Promise.all against the same in-process app, real
// HTTP round trips through supertest, real Postgres transactions) at the
// same row, rather than testing sequentially and assuming correctness.

describe('Concurrent checkout — overselling (order.js createOrder)', () => {
  let location, category, product, token

  beforeAll(async () => {
    location = await db.location.create({ name: 'RACE_STORE', status: 'active' })
    // W3-3 (DR-17): PPN is explicit setup, never a fallback.
    await db.taxConfig.create({
      name: `RACE_PPN_${location.id}`,
      rate: 11,
      type: 'ppn',
      status: 'active',
      store: location.id
    })
    category = await db.category.create({ name: 'RACE_CATEGORY' })
    product = await db.product.create({
      nameProduct: 'RACE_PRODUCT_LAST_UNIT',
      category: category.id,
      price: 10000,
      stock: 1 // exactly one unit — the classic "two cashiers, one item" scenario
    })
    // DR-14: the outlet row is the authoritative stock.
    await db.product_store_stock.create({ product: product.id, store: location.id, stock: 1 })
  // P1-4: central gate denies unknown caller identities; these rows
  // satisfy the identity invariant. Assertions below are unchanged.
  await db.user.create({
    id: 8801,
    userName: 'race_cashier',
    email: 'p14-8801-concurrency-race-conditions@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: null, // assigned per describe before its token is minted (AUTH-1 P2: the row drives scope)
    status: 'active',
    fullName: 'race_cashier'
  })
  await db.user.create({
    id: 8802,
    userName: 'race_status_cashier',
    email: 'p14-8802-concurrency-race-conditions@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: null, // assigned per describe before its token is minted (AUTH-1 P2: the row drives scope)
    status: 'active',
    fullName: 'race_status_cashier'
  })
  await db.user.create({
    id: 8803,
    userName: 'race_po_admin',
    email: 'p14-8803-concurrency-race-conditions@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: null, // assigned per describe before its token is minted (AUTH-1 P2: the row drives scope)
    status: 'active',
    fullName: 'race_po_admin'
  })
  await db.user.create({
    id: 8804,
    userName: 'race_idempotency_cashier',
    email: 'p14-8804-concurrency-race-conditions@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: null, // assigned per describe before its token is minted (AUTH-1 P2: the row drives scope)
    status: 'active',
    fullName: 'race_idempotency_cashier'
  })
  await db.user.create({
    id: 8805,
    userName: 'race_custnum_cashier',
    email: 'p14-8805-concurrency-race-conditions@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: null, // assigned per describe before its token is minted (AUTH-1 P2: the row drives scope)
    status: 'active',
    fullName: 'race_custnum_cashier'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
    // AUTH-1 P2: the row is the authority — assign it the store the token claims.
    await db.user.update({ store: location.id }, { where: { id: 8801 } })
    token = await signSessionToken(
      { id: 8801, userName: 'race_cashier', roleType: 'kasir', store: location.id },
      JWT_SECRET
    )
    // P1 (DR-PAY-ATTR-02): counter sales under test require an open register.
    await db.cashRegister.destroy({ where: { store: location.id, status: 'open' }, force: true })
    await db.cashRegister.create({
      store: location.id,
      user: 8801,
      status: 'open',
      openingBalance: 0,
      openedAt: new Date()
    })
  })

  afterAll(async () => {
    await db.order_item.destroy({ where: {}, force: true })
    await db.transaction.destroy({ where: {}, force: true })
    await db.order_status.destroy({ where: {}, force: true })
    await db.order.destroy({ where: { store: location.id }, force: true })
    await db.best_selling.destroy({ where: { productId: product.id }, force: true })
    await db.stock_history.destroy({ where: { product: product.id }, force: true })
    await db.product_store_stock.destroy({ where: { product: product.id }, force: true })
    await db.product.destroy({ where: { id: product.id }, force: true })
    await db.category.destroy({ where: { id: category.id }, force: true })
    // Release the per-describe store assignment (user.store FK) before deleting it.
    await db.user.update({ store: null }, { where: { store: location.id } })
    await db.taxConfig.destroy({ where: { store: location.id }, force: true })
    await db.cashRegister.destroy({ where: { store: location.id }, force: true })
    await db.location.destroy({ where: { id: location.id }, force: true })
  })

  test('two simultaneous orders for the last unit — exactly one succeeds, stock never goes negative or oversold', async () => {
    const makeOrderRequest = () =>
      request(app)
        .post('/order/create')
        .set('Authorization', `Bearer ${token}`)
        .send(withIdempotencyKey({
          store: location.id,
          items: [{ product: product.id, quantity: 1 }],
          paymentMethod: 'cash',
          cashierName: 'Race Cashier'
        }))

    // Fired together, not awaited sequentially — both requests are in
    // flight at the same time, racing for the same row.
    const [resA, resB] = await Promise.all([makeOrderRequest(), makeOrderRequest()])

    const statuses = [resA.status, resB.status].sort()
    // Exactly one must succeed (201) and the other must be rejected (400) —
    // NOT both 201 (overselling) and NOT both 400 (false rejection).
    expect(statuses).toEqual([201, 400])

    const finalProduct = await db.product.findByPk(product.id)
    expect(Number(finalProduct.stock)).toBe(0) // never negative, never left at 1 (double-success) either
    const outlet = await db.product_store_stock.findOne({ where: { product: product.id, store: location.id } })
    expect(Number(outlet.stock)).toBe(0)

    const paidOrders = await db.order.count({
      where: { store: location.id, status: 'paid' }
    })
    expect(paidOrders).toBe(1) // only one sale actually happened
  })
})

describe('Concurrent status update — double stock deduction (order.js updateOrderStatus)', () => {
  let location, category, product, order, token

  beforeAll(async () => {
    location = await db.location.create({ name: 'RACE_STATUS_STORE', status: 'active' })
    // W3-3 (DR-17): PPN is explicit setup, never a fallback.
    await db.taxConfig.create({
      name: `RACE_PPN_${location.id}`,
      rate: 11,
      type: 'ppn',
      status: 'active',
      store: location.id
    })
    // DR-04: settling via update-status requires drawer attribution — seed
    // the open register the paid transitions resolve at payment time.
    await db.cashRegister.destroy({ where: { store: location.id, status: 'open' }, force: true })
    await db.cashRegister.create({
      store: location.id,
      user: 8803,
      status: 'open',
      openingBalance: 0,
      openedAt: new Date()
    })
    category = await db.category.create({ name: 'RACE_STATUS_CATEGORY' })
    product = await db.product.create({
      nameProduct: 'RACE_STATUS_PRODUCT',
      category: category.id,
      price: 5000,
      stock: 10
    })
    // DR-14: the outlet row is the authoritative stock.
    await db.product_store_stock.create({ product: product.id, store: location.id, stock: 10 })
    // AUTH-1 P2: the row is the authority — assign it the store the token claims.
    await db.user.update({ store: location.id }, { where: { id: 8802 } })
    token = await signSessionToken(
      { id: 8802, userName: 'race_status_cashier', roleType: 'kasir', store: location.id },
      JWT_SECRET
    )

    // Bypass the API to create an order sitting in a not-yet-paid state —
    // createOrder always marks orders paid immediately, so the only way to
    // reach the "transition pending -> paid" code path (where the double-
    // deduction bug lived) is to seed one directly, mirroring a pay-later
    // order that a cashier later marks as paid.
    order = await db.order.create({
      orderNumber: `RACE-STATUS-${Date.now()}`,
      store: location.id,
      status: 'pending',
      paymentStatus: 'unpaid',
      totalPrice: 15000,
      paymentMethod: 'cash'
    })
    await db.order_item.create({
      order: order.id,
      product: product.id,
      quantity: 3,
      price: 5000
    })
  })

  afterAll(async () => {
    await db.order_item.destroy({ where: { order: order.id }, force: true })
    await db.transaction.destroy({ where: { order: order.id }, force: true })
    await db.order_status.destroy({ where: { order: order.id }, force: true })
    await db.order.destroy({ where: { id: order.id }, force: true })
    await db.cashRegister.destroy({ where: { store: location.id }, force: true })
    await db.best_selling.destroy({ where: { productId: product.id }, force: true })
    await db.stock_history.destroy({ where: { product: product.id }, force: true })
    await db.product_store_stock.destroy({ where: { product: product.id }, force: true })
    await db.product.destroy({ where: { id: product.id }, force: true })
    await db.category.destroy({ where: { id: category.id }, force: true })
    // Release the per-describe store assignment (user.store FK) before deleting it.
    await db.user.update({ store: null }, { where: { store: location.id } })
    await db.taxConfig.destroy({ where: { store: location.id }, force: true })
    await db.location.destroy({ where: { id: location.id }, force: true })
  })

  test('two simultaneous "mark as paid" requests deduct stock exactly once', async () => {
    const markPaid = () =>
      request(app)
        .put('/order/update-status')
        .set('Authorization', `Bearer ${token}`)
        .send({ id: order.id, status: 'paid', store: location.id })

    await Promise.all([markPaid(), markPaid()])

    const finalProduct = await db.product.findByPk(product.id)
    expect(Number(finalProduct.stock)).toBe(7) // 10 - 3, deducted once, not 4 (10 - 3 - 3)

    const payments = await db.transaction.count({ where: { order: order.id } })
    expect(payments).toBe(1)

    const saleHistoryCount = await db.stock_history.count({
      where: { product: product.id, referenceType: 'sale' }
    })
    expect(saleHistoryCount).toBe(1)
  })
})

describe('Concurrent PO receiving — lost update on product.stock (purchaseOrder.js receive)', () => {
  let location, category, product, poA, poB, poItemA, poItemB, token

  beforeAll(async () => {
    location = await db.location.create({ name: 'RACE_PO_STORE', status: 'active' })
    // W3-3 (DR-17): PPN is explicit setup, never a fallback.
    await db.taxConfig.create({
      name: `RACE_PPN_${location.id}`,
      rate: 11,
      type: 'ppn',
      status: 'active',
      store: location.id
    })
    category = await db.category.create({ name: 'RACE_PO_CATEGORY' })
    product = await db.product.create({
      nameProduct: 'RACE_PO_PRODUCT',
      category: category.id,
      price: 7000,
      costPrice: 4000,
      stock: 0
    })
    // AUTH-1 P2: the row is the authority — assign it the store the token claims.
    await db.user.update({ store: location.id }, { where: { id: 8803 } })
    token = await signSessionToken(
      { id: 8803, userName: 'race_po_admin', roleType: 'admin', store: location.id },
      JWT_SECRET
    )

    const createRes = (qty) =>
      request(app)
        .post('/purchase-order/create')
        .set('Authorization', `Bearer ${token}`)
        .send({
          store: location.id,
          status: 'ordered',
          items: [{ product: product.id, quantity: qty, price: 4000 }]
        })

    const [resA, resB] = await Promise.all([createRes(5), createRes(3)])
    poA = resA.body.data
    poB = resB.body.data
    poItemA = poA.items[0]
    poItemB = poB.items[0]
  })

  afterAll(async () => {
    await db.product_batch_stock.destroy({ where: {}, force: true })
    await db.product_batch.destroy({ where: { product: product.id }, force: true })
    await db.stock_history.destroy({ where: { product: product.id }, force: true })
    await db.product_store_stock.destroy({ where: { product: product.id }, force: true })
    await db.purchase_order_item.destroy({ where: {}, force: true })
    await db.purchase_order.destroy({ where: { store: location.id }, force: true })
    await db.product.destroy({ where: { id: product.id }, force: true })
    await db.category.destroy({ where: { id: category.id }, force: true })
    // Release the per-describe store assignment (user.store FK) before deleting it.
    await db.user.update({ store: null }, { where: { store: location.id } })
    await db.taxConfig.destroy({ where: { store: location.id }, force: true })
    await db.location.destroy({ where: { id: location.id }, force: true })
  })

  test('two purchase orders for the same product received at the same time — both increments land, none lost', async () => {
    const receive = (poId, itemId, product_id, qty) =>
      request(app)
        .put(`/purchase-order/receive/${poId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ items: [{ id: itemId, product: product_id, receivedQuantity: qty }] })

    const [resA, resB] = await Promise.all([
      receive(poA.id, poItemA.id, product.id, 5),
      receive(poB.id, poItemB.id, product.id, 3)
    ])

    expect(resA.status).toBe(200)
    expect(resB.status).toBe(200)

    const finalProduct = await db.product.findByPk(product.id)
    // Started at 0; both receipts (+5 and +3) must both land — 8, not 5 or 3
    // (which is what the pre-fix plain-JS `product.stock + receiveQty` race
    // would silently produce).
    expect(Number(finalProduct.stock)).toBe(8)
  })
})

describe('Concurrent duplicate submit — idempotency key (order.js createOrder)', () => {
  let location, category, product, token

  beforeAll(async () => {
    location = await db.location.create({ name: 'RACE_IDEMPOTENCY_STORE', status: 'active' })
    // W3-3 (DR-17): PPN is explicit setup, never a fallback.
    await db.taxConfig.create({
      name: `RACE_PPN_${location.id}`,
      rate: 11,
      type: 'ppn',
      status: 'active',
      store: location.id
    })
    category = await db.category.create({ name: 'RACE_IDEMPOTENCY_CATEGORY' })
    product = await db.product.create({
      nameProduct: 'RACE_IDEMPOTENCY_PRODUCT',
      category: category.id,
      price: 12000,
      stock: 50
    })
    // getEffectiveStock() prefers a product_store_stock row over base
    // product.stock once one exists, and that row is lazily created
    // starting at 0 on first deduction — seed it to match, mirroring a
    // store that's already been through stock opname/goods receipt.
    await db.product_store_stock.create({
      product: product.id,
      store: location.id,
      stock: product.stock
    })
    // AUTH-1 P2: the row is the authority — assign it the store the token claims.
    await db.user.update({ store: location.id }, { where: { id: 8804 } })
    token = await signSessionToken(
      { id: 8804, userName: 'race_idempotency_cashier', roleType: 'kasir', store: location.id },
      JWT_SECRET
    )
    // P1 (DR-PAY-ATTR-02): counter sales under test require an open register.
    await db.cashRegister.destroy({ where: { store: location.id, status: 'open' }, force: true })
    await db.cashRegister.create({
      store: location.id,
      user: 8804,
      status: 'open',
      openingBalance: 0,
      openedAt: new Date()
    })
  })

  afterAll(async () => {
    await db.cashRegister.destroy({ where: { store: location.id }, force: true })
    await db.order_item.destroy({ where: {}, force: true })
    await db.transaction.destroy({ where: {}, force: true })
    await db.order_status.destroy({ where: {}, force: true })
    await db.order.destroy({ where: { store: location.id }, force: true })
    await db.best_selling.destroy({ where: { productId: product.id }, force: true })
    await db.stock_history.destroy({ where: { product: product.id }, force: true })
    await db.product_store_stock.destroy({ where: { product: product.id }, force: true })
    await db.product.destroy({ where: { id: product.id }, force: true })
    await db.category.destroy({ where: { id: category.id }, force: true })
    // Release the per-describe store assignment (user.store FK) before deleting it.
    await db.user.update({ store: null }, { where: { store: location.id } })
    await db.taxConfig.destroy({ where: { store: location.id }, force: true })
    await db.location.destroy({ where: { id: location.id }, force: true })
  })

  test('two simultaneous submits with the same idempotency key create exactly one order', async () => {
    const idempotencyKey = `race-key-${Date.now()}`
    const submit = () =>
      request(app)
        .post('/order/create')
        .set('Authorization', `Bearer ${token}`)
        .send(withIdempotencyKey({
          store: location.id,
          items: [{ product: product.id, quantity: 2 }],
          paymentMethod: 'cash',
          cashierName: 'Race Cashier',
          idempotencyKey
        }))

    const [resA, resB] = await Promise.all([submit(), submit()])

    // One of the two is the "fresh create" (201), the other is the replay
    // (200) — either the fast-path findOne caught it, or the unique-index
    // violation fallback did. Both must reference the SAME order id.
    expect([resA.status, resB.status].sort()).toEqual([200, 201])
    expect(resA.body.data.id).toBe(resB.body.data.id)

    const orderCount = await db.order.count({
      where: { store: location.id, idempotencyKey }
    })
    expect(orderCount).toBe(1)

    // Stock must only have been deducted once, not twice.
    const finalProduct = await db.product.findByPk(product.id)
    expect(Number(finalProduct.stock)).toBe(48) // 50 - 2, not 46 (50 - 2 - 2)
  })

  test('a retried submit after the first request completes also replays the same order', async () => {
    const idempotencyKey = `race-key-sequential-${Date.now()}`
    const send = () =>
      request(app)
        .post('/order/create')
        .set('Authorization', `Bearer ${token}`)
        .send(withIdempotencyKey({
          store: location.id,
          items: [{ product: product.id, quantity: 1 }],
          paymentMethod: 'cash',
          cashierName: 'Race Cashier',
          idempotencyKey
        }))

    const first = await send()
    expect(first.status).toBe(201)

    const retry = await send()
    expect(retry.status).toBe(200)
    expect(retry.body.data.id).toBe(first.body.data.id)

    const orderCount = await db.order.count({
      where: { store: location.id, idempotencyKey }
    })
    expect(orderCount).toBe(1)
  })
})

describe('Concurrent order creation — daily customer number uniqueness (order.js generateCustomerNumber)', () => {
  let location, category, product, token

  beforeAll(async () => {
    location = await db.location.create({ name: 'RACE_CUSTNUM_STORE', status: 'active' })
    // W3-3 (DR-17): PPN is explicit setup, never a fallback.
    await db.taxConfig.create({
      name: `RACE_PPN_${location.id}`,
      rate: 11,
      type: 'ppn',
      status: 'active',
      store: location.id
    })
    category = await db.category.create({ name: 'RACE_CUSTNUM_CATEGORY' })
    product = await db.product.create({
      nameProduct: 'RACE_CUSTNUM_PRODUCT',
      category: category.id,
      price: 3000,
      stock: 100
    })
    // See the note in the idempotency describe block above — seed
    // product_store_stock so 10 concurrent orders against one product
    // don't see a lazily-created, zero-baseline row as "out of stock".
    await db.product_store_stock.create({
      product: product.id,
      store: location.id,
      stock: product.stock
    })
    // AUTH-1 P2: the row is the authority — assign it the store the token claims.
    await db.user.update({ store: location.id }, { where: { id: 8805 } })
    token = await signSessionToken(
      { id: 8805, userName: 'race_custnum_cashier', roleType: 'kasir', store: location.id },
      JWT_SECRET
    )
    // P1 (DR-PAY-ATTR-02): counter sales under test require an open register.
    await db.cashRegister.destroy({ where: { store: location.id, status: 'open' }, force: true })
    await db.cashRegister.create({
      store: location.id,
      user: 8805,
      status: 'open',
      openingBalance: 0,
      openedAt: new Date()
    })
  })

  afterAll(async () => {
    await db.cashRegister.destroy({ where: { store: location.id }, force: true })
    await db.user.destroy({ where: { id: [8801, 8802, 8803, 8804, 8805] }, force: true })
    await db.order_item.destroy({ where: {}, force: true })
    await db.transaction.destroy({ where: {}, force: true })
    await db.order_status.destroy({ where: {}, force: true })
    await db.order.destroy({ where: { store: location.id }, force: true })
    await db.best_selling.destroy({ where: { productId: product.id }, force: true })
    await db.stock_history.destroy({ where: { product: product.id }, force: true })
    await db.product_store_stock.destroy({ where: { product: product.id }, force: true })
    await db.product.destroy({ where: { id: product.id }, force: true })
    await db.category.destroy({ where: { id: category.id }, force: true })
    // Release the per-describe store assignment (user.store FK) before deleting it.
    await db.user.update({ store: null }, { where: { store: location.id } })
    await db.taxConfig.destroy({ where: { store: location.id }, force: true })
    await db.location.destroy({ where: { id: location.id }, force: true })
  }, 30000)

  test(
    '10 simultaneous orders at the same store never receive a duplicate customer number',
    async () => {
      const submit = () =>
        request(app)
          .post('/order/create')
          .set('Authorization', `Bearer ${token}`)
          .send(withIdempotencyKey({
            store: location.id,
            items: [{ product: product.id, quantity: 1 }],
            paymentMethod: 'cash',
            cashierName: 'Race Cashier'
          }))

      const responses = await Promise.all(
        Array.from({ length: 10 }, () => submit())
      )

      expect(responses.every((r) => r.status === 201)).toBe(true)

      const customerNumbers = responses.map((r) => r.body.data.customerNumber)
      const uniqueNumbers = new Set(customerNumbers)
      // The old MAX(customerNumber)+1 pattern (no lock, no unique constraint)
      // could hand out the same number to two concurrent orders — with 10
      // genuinely concurrent requests this reliably reproduced a collision.
      expect(uniqueNumbers.size).toBe(customerNumbers.length)
    },
    30000 // 10 genuinely concurrent order-creation transactions serialize
    // on the shared per-store daily counter row (and the shared product
    // row's lock) — well past Jest's 5s default for a real, unmocked
    // concurrency test.
  )
})
