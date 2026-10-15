process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// F-IDEM-1 regression: a same-key retry carrying a DIFFERENT payload must
// not silently replay the winner. Sales-return / split-bill / parked-cart
// already answer 409 on payload mismatch; order create paths replayed
// blindly. Persisted order_item rows are sufficient for comparison, so no
// schema change is required.

const unique = (prefix) =>
  `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

let store = null
let category = null
let productA = null
let productB = null
let token = null
// DR-23 §K full-intent fixtures
let store2 = null
let token2 = null
let memberA = null
let memberB = null
let discount = null
let qrProduct = null
const tables = {}

function orderPayload(items, key) {
  return {
    store: store.id,
    items,
    paymentMethod: 'cash',
    cashierName: 'Idempotency Cashier',
    idempotencyKey: key
  }
}

beforeAll(async () => {
  store = await db.location.create({
    name: `IDEM_STORE_${Date.now()}`,
    status: 'active'
  })
  category = await db.category.create({ name: `IDEM_CAT_${Date.now()}` })
  productA = await db.product.create({
    nameProduct: `IDEM_A_${Date.now()}`,
    category: category.id,
    price: 10000,
    stock: 50
  })
  productB = await db.product.create({
    nameProduct: `IDEM_B_${Date.now()}`,
    category: category.id,
    price: 20000,
    stock: 50
  })
  await db.product_store_stock.create({
    product: productA.id,
    store: store.id,
    stock: 50
  })
  await db.product_store_stock.create({
    product: productB.id,
    store: store.id,
    stock: 50
  })
  // P1-4: central gate denies unknown caller identities; these rows
  // satisfy the identity invariant. Assertions below are unchanged.
  await db.user.create({
    id: 7201,
    userName: 'cashier_idem',
    email: 'p14-7201-order-idempotency-payload-mismatch@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: store.id,
    status: 'active',
    fullName: 'cashier_idem'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  token = await signSessionToken(
    { id: 7201, userName: 'cashier_idem', roleType: 'kasir', store: store.id },
    JWT_SECRET
  )
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed the rate
  // so these idempotency assertions exercise configured tax.
  await db.taxConfig.create({
    name: 'IDEM_PPN',
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: store.id
  })
  // P1 (DR-PAY-ATTR-02): counter sales under test require an open register.
  await db.cashRegister.create({ store: store.id, user: 7201, status: 'open', openingBalance: 0, openedAt: new Date() })

  // DR-23 §K: members, a discount (created before any order, so it was
  // resolvable when they were created), tables, a QR product and a second
  // store with its own cashier for key scoping.
  memberA = await db.member.create({ name: unique('IDEM_MEMBER_A'), phoneNumber: `08${Math.floor(1e9 + Math.random() * 9e9)}`, store: store.id, totalPoints: 1000 })
  memberB = await db.member.create({ name: unique('IDEM_MEMBER_B'), phoneNumber: `08${Math.floor(1e9 + Math.random() * 9e9)}`, store: store.id, totalPoints: 1000 })
  discount = await db.discount.create({
    store: store.id,
    name: unique('IDEM_DISC'),
    type: 'nominal',
    value: 1000,
    status: 'active'
  })
  for (const name of ['t1', 't2', 't3', 't4', 'qr1', 'qr2', 'qr3']) {
    tables[name] = await db.table.create({ store: store.id, name: unique(`IDEM_${name}`) })
  }
  qrProduct = await db.product.create({
    nameProduct: unique('IDEM_QR'),
    category: category.id,
    price: 15000,
    stock: 50,
    isAvailable: true
  })
  await db.product_store_stock.create({ product: qrProduct.id, store: store.id, stock: 50 })
  store2 = await db.location.create({ name: unique('IDEM_STORE_2'), status: 'active' })
  await db.product_store_stock.create({ product: productA.id, store: store2.id, stock: 50 })
  await db.user.create({
    id: 7202,
    userName: 'cashier_idem2',
    email: 'p14-7202-order-idempotency-payload-mismatch@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: store2.id,
    status: 'active',
    fullName: 'cashier_idem2'
  })
  token2 = await signSessionToken(
    { id: 7202, userName: 'cashier_idem2', roleType: 'kasir', store: store2.id },
    JWT_SECRET
  )
  await db.taxConfig.create({ name: 'IDEM_PPN_2', rate: 11, type: 'ppn', status: 'active', store: store2.id })
  await db.cashRegister.create({ store: store2.id, user: 7202, status: 'open', openingBalance: 0, openedAt: new Date() })
})

afterAll(async () => {
  const storeIds = [store?.id, store2?.id].filter(Boolean)
  await db.cashRegister.destroy({ where: { store: storeIds }, force: true })
  await db.user.destroy({ where: { id: [7201, 7202] }, force: true })
  await db.taxConfig.destroy({ where: { store: storeIds }, force: true })
  await db.order_item.destroy({ where: {}, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: storeIds }, force: true })
  await db.table.destroy({ where: { store: storeIds }, force: true })
  await db.discount.destroy({ where: { store: storeIds }, force: true })
  await db.member.destroy({ where: { store: storeIds }, force: true })
  const productIds = [productA?.id, productB?.id, qrProduct?.id].filter(Boolean)
  await db.order_item.destroy({ where: {}, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order.destroy({ where: { store: store?.id }, force: true })
  await db.best_selling.destroy({ where: { productId: productIds }, force: true })
  await db.stock_history.destroy({ where: { product: productIds }, force: true })
  await db.product_store_stock.destroy({ where: { product: productIds }, force: true })
  await db.product.destroy({ where: { id: productIds }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: storeIds }, force: true })
})

async function postOrder(body) {
  return request(app)
    .post('/order/create')
    .set('Authorization', `Bearer ${token}`)
    .send(body)
}

describe('F-IDEM-1 order idempotency payload mismatch', () => {
  test('A — same key + same payload replays the original order', async () => {
    const key = unique('idemA')
    const body = orderPayload(
      [{ product: productA.id, quantity: 1, productName: 'A' }],
      key
    )
    const first = await postOrder(body)
    expect(first.status).toBe(201)

    const retry = await postOrder(body)
    expect(retry.status).toBe(200)
    expect(retry.body?.data?.id).toBe(first.body?.data?.id)
    expect(await db.order.count({ where: { idempotencyKey: key } })).toBe(1)
  })

  test('B — same key + different payload is rejected without a new order', async () => {
    const key = unique('idemB')
    const first = await postOrder(
      orderPayload([{ product: productA.id, quantity: 1, productName: 'A' }], key)
    )
    expect(first.status).toBe(201)
    const stockBefore = Number((await db.product.findByPk(productB.id)).stock)

    const retry = await postOrder(
      orderPayload([{ product: productB.id, quantity: 2, productName: 'B' }], key)
    )
    expect(retry.status).toBe(409)
    expect(await db.order.count({ where: { idempotencyKey: key } })).toBe(1)
    // The rejected retry must not have mutated anything.
    expect(Number((await db.product.findByPk(productB.id)).stock)).toBe(stockBefore)
  })

  test('C — concurrent same-key same-payload requests create exactly one order', async () => {
    const key = unique('idemC')
    const body = orderPayload(
      [{ product: productA.id, quantity: 1, productName: 'A' }],
      key
    )
    const [r1, r2] = await Promise.all([postOrder(body), postOrder(body)])
    expect([r1.status, r2.status].sort()).toEqual([200, 201])
    expect(await db.order.count({ where: { idempotencyKey: key } })).toBe(1)
  })

  test('D — different keys create independent orders', async () => {
    const r1 = await postOrder(
      orderPayload([{ product: productA.id, quantity: 1, productName: 'A' }], unique('idemD1'))
    )
    const r2 = await postOrder(
      orderPayload([{ product: productB.id, quantity: 1, productName: 'B' }], unique('idemD2'))
    )
    expect(r1.status).toBe(201)
    expect(r2.status).toBe(201)
    expect(r2.body?.data?.id).not.toBe(r1.body?.data?.id)
  })
})

// DR-23 §K (BA §35.10): "Same key and same payload: the original result is
// replayed with no new effect. Same key and different payload: refused (409
// mismatch)." The payload is the whole financial intent, not just the lines.
describe('DR-23 §K — same key compares the full order intent', () => {
  const line = (product, quantity = 1, extra = {}) => ({
    product: product.id,
    quantity,
    productName: product.nameProduct,
    ...extra
  })
  const counter = (key, extra = {}) => ({
    ...orderPayload([line(productA)], key),
    ...extra
  })

  const effects = async (key) => {
    const order = await db.order.findOne({ where: { store: store.id, idempotencyKey: key } })
    return {
      orders: await db.order.count({ where: { idempotencyKey: key } }),
      ledgerRows: await db.transaction.count(),
      outboxRows: await db.accounting_outbox.count(),
      stockA: Number((await db.product_store_stock.findOne({ where: { product: productA.id, store: store.id } })).stock),
      stockB: Number((await db.product_store_stock.findOne({ where: { product: productB.id, store: store.id } })).stock),
      redeemedA: Number((await db.member.findByPk(memberA.id)).totalPoints),
      orderId: order?.id
    }
  }

  // First request succeeds; the same key with `changed` intent is refused
  // with the field named and no financial, stock, loyalty or journal effect.
  const expectRefused = async (key, first, changed, field) => {
    const created = await postOrder(first)
    expect(created.status).toBe(201)
    const before = await effects(key)
    const retry = await postOrder(changed)
    expect(retry.status).toBe(409)
    expect(retry.body.code).toBe('IDEMPOTENCY_MISMATCH')
    expect(retry.body.fields).toContain(field)
    // the committed sale for this key is identified for reconciliation
    expect(retry.body.existingOrder).toMatchObject({
      id: created.body.data.id,
      orderNumber: created.body.data.orderNumber
    })
    expect(await effects(key)).toEqual(before)
    return retry
  }

  test('a different tender is refused', async () => {
    const key = unique('k_tender')
    await expectRefused(
      key,
      counter(key),
      counter(key, { paymentMethod: 'qris', referenceNumber: 'QR-REF-1' }),
      'paymentMethod'
    )
  })

  test('a different cash tender (cash received / change) is refused', async () => {
    const key = unique('k_cash')
    // 10,000 + 11 % PPN = 11,100 payable; exact tender first, 20,000 cash then.
    await expectRefused(
      key,
      counter(key),
      counter(key, { cashAmount: 20000, changeAmount: 8900 }),
      'cashAmount'
    )
  })

  test('a different non-cash reference is refused', async () => {
    const key = unique('k_ref')
    await expectRefused(
      key,
      counter(key, { paymentMethod: 'qris', referenceNumber: 'QR-REF-A' }),
      counter(key, { paymentMethod: 'qris', referenceNumber: 'QR-REF-B' }),
      'referenceNumber'
    )
  })

  test('waiving tax is refused', async () => {
    const key = unique('k_tax')
    await expectRefused(key, counter(key), counter(key, { useTax: false }), 'useTax')
  })

  test('adding a promo code is refused', async () => {
    const key = unique('k_promo')
    await expectRefused(key, counter(key), counter(key, { promoCode: 'NOT-A-CODE' }), 'promoCode')
  })

  test('adding a resolvable discount is refused (it would have been applied)', async () => {
    const key = unique('k_disc_add')
    await expectRefused(key, counter(key), counter(key, { discountId: discount.id }), 'discountId')
  })

  test('dropping the applied discount is refused', async () => {
    const key = unique('k_disc_drop')
    await expectRefused(key, counter(key, { discountId: discount.id }), counter(key), 'discountId')
  })

  test('redeeming points is refused', async () => {
    const key = unique('k_points')
    await expectRefused(
      key,
      counter(key, { customerId: memberA.id }),
      counter(key, { customerId: memberA.id, redeemedPoints: 100 }),
      'redeemedPoints'
    )
  })

  test('another member is refused', async () => {
    const key = unique('k_member')
    await expectRefused(
      key,
      counter(key, { customerId: memberA.id }),
      counter(key, { customerId: memberB.id }),
      'customerId'
    )
  })

  test('another table is refused', async () => {
    const key = unique('k_table')
    await expectRefused(
      key,
      counter(key, { tableId: tables.t1.id }),
      counter(key, { tableId: tables.t2.id }),
      'tableId'
    )
  })

  test('another option selection on the same line is refused', async () => {
    const key = unique('k_opts')
    await expectRefused(
      key,
      counter(key, { items: [line(productA, 1, { options: [{ name: 'Large' }] })] }),
      counter(key, { items: [line(productA, 1, { options: [{ name: 'Small' }] })] }),
      'items'
    )
  })

  test('an equivalent payload (order, case, whitespace, numeric strings) replays with no new effect', async () => {
    const key = unique('k_equiv')
    const first = counter(key, {
      items: [
        line(productA, 1, { options: [{ name: 'Ice' }, { name: 'Less Sugar' }] }),
        line(productB, 2)
      ],
      paymentMethod: 'cash',
      promoCode: 'abc',
      tableId: tables.t3.id,
      customerId: memberA.id
    })
    const created = await postOrder(first)
    expect(created.status).toBe(201)
    const before = await effects(key)

    const replay = await postOrder(
      counter(key, {
        items: [
          { ...line(productB, 2), quantity: '2' },
          line(productA, 1, { options: [{ name: 'Less Sugar' }, { name: 'Ice' }] })
        ],
        paymentMethod: 'Cash',
        promoCode: ' ABC ',
        tableId: String(tables.t3.id),
        customerId: String(memberA.id)
      })
    )
    expect(replay.status).toBe(200)
    expect(replay.body.data.id).toBe(created.body.data.id)
    expect(await effects(key)).toEqual(before)
  })

  test('concurrent same-key requests with divergent tender commit exactly one order and one ledger row', async () => {
    const key = unique('k_race')
    const [r1, r2] = await Promise.all([
      postOrder(counter(key)),
      postOrder(counter(key, { paymentMethod: 'qris', referenceNumber: 'QR-RACE' }))
    ])
    expect([r1.status, r2.status].sort()).toEqual([201, 409])
    const loser = r1.status === 409 ? r1 : r2
    expect(loser.body.code).toBe('IDEMPOTENCY_MISMATCH')
    const orders = await db.order.findAll({ where: { idempotencyKey: key } })
    expect(orders).toHaveLength(1)
    expect(await db.transaction.count({ where: { order: orders[0].id } })).toBe(1)
  })

  test('a retry after a lost response replays the committed sale with exactly-once effects', async () => {
    const key = unique('k_lost')
    const stockBefore = (await effects(key)).stockA
    const created = await postOrder(counter(key, { customerId: memberA.id }))
    expect(created.status).toBe(201) // ...but imagine the response never arrived
    const afterCommit = await effects(key)
    expect(afterCommit.stockA).toBe(stockBefore - 1)

    const retry = await postOrder(counter(key, { customerId: memberA.id }))
    expect(retry.status).toBe(200)
    expect(retry.body.data.id).toBe(created.body.data.id)
    expect(await effects(key)).toEqual(afterCommit)
    const orderId = created.body.data.id
    expect(await db.transaction.count({ where: { order: orderId } })).toBe(1)
    expect(
      await db.accounting_outbox.count({ where: { jobType: 'order_journal', referenceId: orderId } })
    ).toBe(1)
  })

  test('the same key in another store is a different sale (keys are store-scoped)', async () => {
    const key = unique('k_scope')
    const first = await postOrder(counter(key))
    expect(first.status).toBe(201)
    const other = await request(app)
      .post('/order/create')
      .set('Authorization', `Bearer ${token2}`)
      .send({ ...counter(key), store: store2.id })
    expect(other.status).toBe(201)
    expect(other.body.data.id).not.toBe(first.body.data.id)
    expect(Number(other.body.data.store)).toBe(Number(store2.id))
  })

  test('an intentional repeat sale (new key, same lines) is a new order — no content-based dedupe', async () => {
    const r1 = await postOrder(counter(unique('k_rep1')))
    const r2 = await postOrder(counter(unique('k_rep2')))
    expect(r1.status).toBe(201)
    expect(r2.status).toBe(201)
    expect(r2.body.data.id).not.toBe(r1.body.data.id)
  })
})

describe('DR-23 §K — QR customer-create compares the full order intent', () => {
  const qr = (key, table, extra = {}) => ({
    store: store.id,
    tableId: table.id,
    customerName: 'Diner',
    idempotencyKey: key,
    paymentMethod: 'QRIS',
    items: [{ productId: qrProduct.id, productName: qrProduct.nameProduct, quantity: 1 }],
    ...extra
  })
  const postQr = (body) => request(app).post('/order/customer-create').send(body)

  test('same key and same intent replays; a different payment intent is refused', async () => {
    const key = unique('qr_intent')
    const created = await postQr(qr(key, tables.qr1))
    expect(created.status).toBe(201)

    const replay = await postQr(qr(key, tables.qr1, { paymentMethod: 'qris', customerName: 'Other name' }))
    expect(replay.status).toBe(200)
    expect(replay.body.data.id).toBe(created.body.data.id)

    const refused = await postQr(qr(key, tables.qr1, { paymentMethod: 'Tunai' }))
    expect(refused.status).toBe(409)
    expect(refused.body.code).toBe('IDEMPOTENCY_MISMATCH')
    expect(refused.body.fields).toContain('paymentMethod')
    // the public QR path never discloses the existing order
    expect(refused.body).not.toHaveProperty('existingOrder')
    expect(await db.order.count({ where: { idempotencyKey: key } })).toBe(1)
  })

  test('another option selection is refused', async () => {
    const key = unique('qr_opts')
    const items = (name) => [
      { productId: qrProduct.id, productName: qrProduct.nameProduct, quantity: 1, options: [{ name }] }
    ]
    expect((await postQr(qr(key, tables.qr2, { items: items('Hot') }))).status).toBe(201)
    const refused = await postQr(qr(key, tables.qr2, { items: items('Cold') }))
    expect(refused.status).toBe(409)
    expect(refused.body.fields).toContain('items')
  })

  test('another table is refused', async () => {
    const key = unique('qr_table')
    expect((await postQr(qr(key, tables.qr3))).status).toBe(201)
    const refused = await postQr(qr(key, tables.t4))
    expect(refused.status).toBe(409)
    expect(refused.body.fields).toContain('tableId')
  })
})

// Review M1: the original request is not stored, and some persisted fields
// change legitimately after creation (member attach into an empty slot, a
// settlement overwriting the QR payment intent, PPN rows being edited). An
// identical late retry must still replay; a provably different one must
// still be refused.
describe('DR-23 §K — replay after legitimate post-create changes', () => {
  let store3 = null
  let token3 = null
  let tax3 = null
  const mTables = {}

  const line = (product, quantity = 1) => ({
    product: product.id,
    quantity,
    productName: product.nameProduct
  })
  const counter = (key, extra = {}) => ({ ...orderPayload([line(productA)], key), ...extra })
  const qr = (key, table, extra = {}) => ({
    store: store.id,
    tableId: table.id,
    customerName: 'Diner',
    idempotencyKey: key,
    paymentMethod: 'Tunai',
    items: [{ productId: qrProduct.id, productName: qrProduct.nameProduct, quantity: 1 }],
    ...extra
  })
  const postQr = (body) => request(app).post('/order/customer-create').send(body)
  const updateStatus = (orderId, body) =>
    request(app)
      .put('/order/update-status')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: orderId, store: store.id, ...body })
  const orderEffects = async (orderId) => ({
    ledgerRows: await db.transaction.count({ where: { order: orderId } }),
    orders: await db.order.count({ where: { store: [store.id, store3.id] } }),
    stockA: Number(
      (await db.product_store_stock.findOne({ where: { product: productA.id, store: store.id } })).stock
    ),
    stockQr: Number(
      (await db.product_store_stock.findOne({ where: { product: qrProduct.id, store: store.id } })).stock
    )
  })

  beforeAll(async () => {
    for (const name of ['m_qr1', 'm_qr2', 'm_qr3']) {
      mTables[name] = await db.table.create({ store: store.id, name: unique(`IDEM_${name}`) })
    }
    // A store whose PPN is explicitly 0 % — edited to 11 % mid-test.
    store3 = await db.location.create({ name: unique('IDEM_STORE_3'), status: 'active' })
    await db.product_store_stock.create({ product: productA.id, store: store3.id, stock: 50 })
    await db.user.create({
      id: 7203,
      userName: 'cashier_idem3',
      email: 'p14-7203-order-idempotency-payload-mismatch@test.com',
      roleType: 'kasir',
      userType: 'user',
      store: store3.id,
      status: 'active',
      fullName: 'cashier_idem3'
    })
    token3 = await signSessionToken(
      { id: 7203, userName: 'cashier_idem3', roleType: 'kasir', store: store3.id },
      JWT_SECRET
    )
    tax3 = await db.taxConfig.create({ name: 'IDEM_PPN_3', rate: 0, type: 'ppn', status: 'active', store: store3.id })
    await db.cashRegister.create({ store: store3.id, user: 7203, status: 'open', openingBalance: 0, openedAt: new Date() })
  })

  afterAll(async () => {
    const orders = await db.order.findAll({ where: { store: store3?.id } })
    for (const o of orders) {
      await db.order_item.destroy({ where: { order: o.id }, force: true })
      await db.order_status.destroy({ where: { order: o.id }, force: true })
      await db.transaction.destroy({ where: { order: o.id }, force: true })
      await db.order.destroy({ where: { id: o.id }, force: true })
    }
    await db.cashRegister.destroy({ where: { store: store3?.id }, force: true })
    await db.taxConfig.destroy({ where: { store: store3?.id }, force: true })
    await db.user.destroy({ where: { id: [7203] }, force: true })
    await db.product_store_stock.destroy({ where: { store: store3?.id }, force: true })
    await db.location.destroy({ where: { id: store3?.id }, force: true })
  })

  test('counter: an identical retry replays before and after a member is attached later', async () => {
    const key = unique('m_attach')
    const created = await postOrder(counter(key))
    expect(created.status).toBe(201)
    const orderId = created.body.data.id

    expect((await postOrder(counter(key))).status).toBe(200)

    const attach = await updateStatus(orderId, { status: 'served', customerId: memberB.id })
    expect(attach.status).toBe(200)
    expect(Number((await db.order.findByPk(orderId)).customerId)).toBe(Number(memberB.id))

    const before = await orderEffects(orderId)
    const replay = await postOrder(counter(key))
    expect(replay.status).toBe(200)
    expect(replay.body.data.id).toBe(orderId)
    expect(await orderEffects(orderId)).toEqual(before)
  })

  test('counter: naming a different member than the attached one is refused', async () => {
    const key = unique('m_attach_other')
    const created = await postOrder(counter(key))
    const orderId = created.body.data.id
    expect((await updateStatus(orderId, { status: 'served', customerId: memberB.id })).status).toBe(200)

    const before = await orderEffects(orderId)
    const refused = await postOrder(counter(key, { customerId: memberA.id }))
    expect(refused.status).toBe(409)
    expect(refused.body.fields).toContain('customerId')
    expect(await orderEffects(orderId)).toEqual(before)
  })

  test('counter: adding a member to an order created (and still) without one is refused', async () => {
    const key = unique('m_add')
    const created = await postOrder(counter(key))
    const before = await orderEffects(created.body.data.id)
    const refused = await postOrder(counter(key, { customerId: memberA.id }))
    expect(refused.status).toBe(409)
    expect(refused.body.fields).toEqual(['customerId'])
    expect(await orderEffects(created.body.data.id)).toEqual(before)
  })

  test('QR: an identical retry replays before and after a cash settlement rewrote the intent', async () => {
    const key = unique('m_qr_settle')
    const created = await postQr(qr(key, mTables.m_qr1))
    expect(created.status).toBe(201)
    const orderId = created.body.data.id
    expect((await postQr(qr(key, mTables.m_qr1))).status).toBe(200)

    const settle = await updateStatus(orderId, { status: 'paid', paymentMethod: 'cash' })
    expect(settle.status).toBe(200)
    expect((await db.order.findByPk(orderId)).paymentMethod).toBe('CASH')

    const before = await orderEffects(orderId)
    expect(before.ledgerRows).toBe(1)
    const replay = await postQr(qr(key, mTables.m_qr1))
    expect(replay.status).toBe(200)
    expect(replay.body.data.id).toBe(orderId)
    expect(await orderEffects(orderId)).toEqual(before)
  })

  test('QR: a split payment does not suppress the intent comparison', async () => {
    const key = unique('m_qr_split')
    const created = await postQr(qr(key, mTables.m_qr2))
    const orderId = created.body.data.id
    const total = Number(created.body.data.totalPrice)

    const split = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${token}`)
      .send({ order: orderId, items: [{ amount: 5000 }, { amount: total - 5000 }] })
    expect(split.status).toBe(201)
    const pay = await request(app)
      .put(`/split-bill/pay/${split.body.data[0].id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ paymentMethod: 'cash' })
    expect(pay.status).toBe(200)
    expect(pay.body.data.orderComplete).toBe(false)
    expect((await db.order.findByPk(orderId)).paymentMethod).toBe('Tunai')

    const before = await orderEffects(orderId)
    const refused = await postQr(qr(key, mTables.m_qr2, { paymentMethod: 'QRIS' }))
    expect(refused.status).toBe(409)
    expect(refused.body.fields).toContain('paymentMethod')
    const replay = await postQr(qr(key, mTables.m_qr2))
    expect(replay.status).toBe(200)
    expect(await orderEffects(orderId)).toEqual(before)
  })

  test('QR: a different intent is still refused while unsettled', async () => {
    const key = unique('m_qr_unsettled')
    expect((await postQr(qr(key, mTables.m_qr3))).status).toBe(201)
    const refused = await postQr(qr(key, mTables.m_qr3, { paymentMethod: 'QRIS' }))
    expect(refused.status).toBe(409)
    expect(refused.body.fields).toEqual(['paymentMethod'])
  })

  test('tax: a PPN rate edited after creation does not refuse an identical retry; an unchanged rate proves a waived-tax retry', async () => {
    const post3 = (body) =>
      request(app).post('/order/create').set('Authorization', `Bearer ${token3}`).send(body)
    const sale3 = (key, extra = {}) => ({ ...counter(key), store: store3.id, ...extra })

    // Created at 0 % with useTax=true; the store's rate is then edited to 11 %.
    const keyEdited = unique('m_tax_edit')
    const created = await post3(sale3(keyEdited))
    expect(created.status).toBe(201)
    expect(Number(created.body.data.taxRate)).toBe(0)
    await tax3.update({ rate: 11 })
    const replay = await post3(sale3(keyEdited))
    expect(replay.status).toBe(200)
    expect(replay.body.data.id).toBe(created.body.data.id)

    // At the (now unchanged) 11 %: a 0 % order can only come from useTax=false,
    // so a useTax=true retry is provably different.
    const keyWaived = unique('m_tax_waived')
    const waived = await post3(sale3(keyWaived, { useTax: false }))
    expect(waived.status).toBe(201)
    const refused = await post3(sale3(keyWaived, { useTax: true }))
    expect(refused.status).toBe(409)
    expect(refused.body.fields).toEqual(['useTax'])
  })

  test('expectedTotal: a matching or omitted value replays; a different one is a mismatch, never TOTAL_CHANGED', async () => {
    const key = unique('m_expected')
    const created = await postOrder(counter(key, { expectedTotal: 11100 }))
    expect(created.status).toBe(201)
    const orderId = created.body.data.id
    const before = await orderEffects(orderId)

    expect((await postOrder(counter(key, { expectedTotal: 11100 }))).status).toBe(200)
    expect((await postOrder(counter(key))).status).toBe(200)
    const refused = await postOrder(counter(key, { expectedTotal: 11000 }))
    expect(refused.status).toBe(409)
    expect(refused.body.code).toBe('IDEMPOTENCY_MISMATCH')
    expect(refused.body.fields).toEqual(['expectedTotal'])
    expect(refused.body.existingOrder).toMatchObject({ id: orderId, totalPrice: 11100 })
    expect(await orderEffects(orderId)).toEqual(before)
  })
})
