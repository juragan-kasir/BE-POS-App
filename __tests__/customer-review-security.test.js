process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const crypto = require('crypto')
const app = require('../api/index')
const db = require('../db/models')

// SEC-007 — security regression coverage for the public customer review
// endpoint (POST /order/customer-review). Pin the non-breaking hardening:
//   * product ↔ store tenancy (reuse isProductOrderableAtStore, the exact
//     membership rule the customer menu applies),
//   * optional same-device idempotency backed by the partial UNIQUE index
//     uq_product_review_device (race-safe, SQLSTATE 23505 recovery),
//   * optional but verified order claims (exists + same store + product in
//     order) — never rejects the official flow, which sends no orderId yet,
//   * comment/name length caps and an optional moderation gate
//     (REVIEW_AUTO_PUBLISH=false → status 'pending').

let store1 = null
let store2 = null
let category = null
let globalProduct = null
let store1Product = null
let store2Product = null
const createdOrderIds = []

const makeOrder = async (storeId, productId) => {
  const order = await db.order.create({
    orderNumber: `REV-${crypto.randomBytes(6).toString('hex')}`,
    store: storeId,
    source: 'qr',
    status: 'pending',
    paymentStatus: 'unpaid',
    subTotal: 10000,
    totalPrice: 10000,
    publicToken: crypto.randomBytes(24).toString('hex')
  })
  await db.order_item.create({
    order: order.id,
    product: productId,
    productName: 'SEC007_ITEM',
    quantity: 1,
    price: 10000,
    totalPrice: 10000
  })
  createdOrderIds.push(order.id)
  return order
}

let reviewSeq = 0
const postReview = (payload) =>
  request(app)
    .post('/order/customer-review')
    .send({
      ...payload,
      deviceId:
        payload.deviceId || `sec007-auto-${Date.now()}-${++reviewSeq}`
    })

beforeAll(async () => {
  store1 = await db.location.create({ name: 'SEC007_STORE_1', status: 'active' })
  store2 = await db.location.create({ name: 'SEC007_STORE_2', status: 'active' })
  category = await db.category.create({ name: 'SEC007_CATEGORY' })

  globalProduct = await db.product.create({
    nameProduct: 'SEC007_GLOBAL',
    category: category.id,
    price: 12000,
    stock: 50,
    isAvailable: true
  })

  store1Product = await db.product.create({
    nameProduct: 'SEC007_PRODUCT_S1',
    category: category.id,
    price: 13000,
    stock: 10,
    isAvailable: true
  })
  await db.product_store.create({ product: store1Product.id, store: store1.id })

  store2Product = await db.product.create({
    nameProduct: 'SEC007_PRODUCT_S2',
    category: category.id,
    price: 14000,
    stock: 10,
    isAvailable: true
  })
  await db.product_store.create({ product: store2Product.id, store: store2.id })
})

afterAll(async () => {
  for (const orderId of createdOrderIds) {
    await db.order_item.destroy({ where: { order: orderId }, force: true })
    await db.order.destroy({ where: { id: orderId }, force: true })
  }
  await db.product_review.destroy({
    where: { productId: [globalProduct?.id, store1Product?.id, store2Product?.id].filter(Boolean) },
    force: true
  })
  await db.product_store.destroy({
    where: { product: [store1Product?.id, store2Product?.id].filter(Boolean) },
    force: true
  })
  await db.product.destroy({
    where: { id: [globalProduct?.id, store1Product?.id, store2Product?.id].filter(Boolean) },
    force: true
  })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({
    where: { id: [store1?.id, store2?.id].filter(Boolean) },
    force: true
  })
  delete process.env.REVIEW_AUTO_PUBLISH
})

describe('SEC-007 — createCustomerReview (POST /order/customer-review)', () => {
  test('a valid review by a store customer is accepted and auto-published', async () => {
    const res = await postReview({
      name: 'Budi',
      productId: String(globalProduct.id),
      store: store1.id,
      rating: 5,
      comment: 'Enak banget!'
    })
    expect(res.status).toBe(201)
    expect(res.body.success).toBe(true)
    expect(res.body.data.productId).toBe(globalProduct.id)
    expect(res.body.data.store).toBe(store1.id)
    expect(res.body.data.userName).toBe('Budi')
    expect(res.body.data.rating).toBe(5)
    expect(res.body.data.comment).toBe('Enak banget!')
    expect(res.body.data.orderId).toBeNull()
    expect(res.body.data.status).toBe('published')
  })

  test('store-assigned product accepts a review at its own store', async () => {
    const res = await postReview({
      name: 'Ayu',
      productId: String(store1Product.id),
      store: store1.id,
      rating: 4,
      comment: 'ok'
    })
    expect(res.status).toBe(201)
    expect(res.body.data.store).toBe(store1.id)
  })

  test('rejects a review attributing a store2-owned product to store1 (cross-store)', async () => {
    const res = await postReview({
      name: 'Mallory',
      productId: String(store2Product.id),
      store: store1.id,
      rating: 1,
      comment: 'bombard'
    })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/not available at this store/i)
  })

  test('a global (unassigned) product is reviewable at any store', async () => {
    const res = await postReview({
      name: 'Citra',
      productId: String(globalProduct.id),
      store: store2.id,
      rating: 3,
      comment: 'lumayan'
    })
    expect(res.status).toBe(201)
    expect(res.body.data.store).toBe(store2.id)
  })

  test('legacy store-less submission still works (non-breaking)', async () => {
    const res = await postReview({
      name: 'Tanpa Toko',
      productId: String(globalProduct.id),
      rating: 2,
      comment: 'legacy path'
    })
    expect(res.status).toBe(201)
    expect(res.body.data.store).toBeNull()
  })

  test('unknown product is not found', async () => {
    const res = await postReview({
      name: 'X',
      productId: '999999999',
      store: store1.id,
      rating: 5,
      comment: 'no product'
    })
    expect(res.status).toBe(404)
  })

  test('missing rating is rejected', async () => {
    const res = await postReview({
      name: 'X',
      productId: String(globalProduct.id),
      store: store1.id,
      comment: 'no rating'
    })
    expect(res.status).toBe(400)
  })

  test('out-of-range rating is rejected', async () => {
    const res = await postReview({
      name: 'X',
      productId: String(globalProduct.id),
      store: store1.id,
      rating: 6,
      comment: 'bad rating'
    })
    expect(res.status).toBe(400)
  })

  test('overlong comments are rejected instead of truncated', async () => {
    // BA DR-28 decision 6: a review comment holds 255 characters
    const long = 'x'.repeat(256)
    const res = await postReview({
      name: 'Panjang',
      productId: String(globalProduct.id),
      store: store1.id,
      rating: 4,
      comment: long
    })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: 'VALUE_TOO_LONG', field: 'comment', max: 255 })
  })

  test('an order claim must reference an existing order in the same store', async () => {
    const res = await postReview({
      name: 'Fake Order',
      productId: String(globalProduct.id),
      store: store1.id,
      rating: 5,
      comment: 'fake',
      orderId: '999999999'
    })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/invalid order/i)
  })

  test("an order claim from another store is rejected even if the order exists", async () => {
    const foreignOrder = await makeOrder(store2.id, globalProduct.id)
    const res = await postReview({
      name: 'Foreign',
      productId: String(globalProduct.id),
      store: store1.id,
      rating: 5,
      comment: 'foreign order',
      orderId: String(foreignOrder.id)
    })
    expect(res.status).toBe(400)
  })

  test('an order claim that does not contain the reviewed product is rejected', async () => {
    const order = await makeOrder(store1.id, store1Product.id)
    const res = await postReview({
      name: 'Wrong Product',
      productId: String(globalProduct.id),
      store: store1.id,
      rating: 5,
      comment: 'not in order',
      orderId: String(order.id)
    })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/not part of the claimed order/i)
  })

  test('a valid order claim (same store + product in order) is accepted', async () => {
    const order = await makeOrder(store1.id, store1Product.id)
    const res = await postReview({
      name: 'Verified',
      productId: String(store1Product.id),
      store: store1.id,
      rating: 5,
      comment: 'verified',
      orderId: String(order.id)
    })
    expect(res.status).toBe(201)
    expect(res.body.data.orderId).toBe(order.id)
  })

  test('repeated submissions with the same deviceId return the same review', async () => {
    const deviceId = `sec007-device-${Date.now()}`
    const first = await postReview({
      name: 'Dedupe',
      productId: String(globalProduct.id),
      store: store1.id,
      rating: 5,
      comment: 'once',
      deviceId
    })
    expect(first.status).toBe(201)

    const second = await postReview({
      name: 'Dedupe',
      productId: String(globalProduct.id),
      store: store1.id,
      rating: 5,
      comment: 'once',
      deviceId
    })
    expect(second.status).toBe(200)
    expect(second.body.success).toBe(true)
    expect(second.body.data.id).toBe(first.body.data.id)
    expect(
      await db.product_review.count({ where: { productId: globalProduct.id, deviceId } })
    ).toBe(1)
  })

  test('two concurrent identical deviceId submissions produce exactly one review', async () => {
    const deviceId = `sec007-race-${Date.now()}`
    const req = () =>
      postReview({
        name: 'Race',
        productId: String(globalProduct.id),
        store: store1.id,
        rating: 5,
        comment: 'race',
        deviceId
      })

    const [resA, resB] = await Promise.all([req(), req()])

    expect([resA.status, resB.status].sort()).toEqual([200, 201])
    expect(resA.body.data.id).toBe(resB.body.data.id)
    expect(
      await db.product_review.count({ where: { productId: globalProduct.id, deviceId } })
    ).toBe(1)
  })

  test('REVIEW_AUTO_PUBLISH=false queues reviews as pending (not displayed)', async () => {
    process.env.REVIEW_AUTO_PUBLISH = 'false'
    try {
      const res = await postReview({
        name: 'Moderated',
        productId: String(globalProduct.id),
        store: store1.id,
        rating: 1,
        comment: 'queued'
      })
      expect(res.status).toBe(201)
      expect(res.body.data.status).toBe('pending')

      const list = await request(app)
        .get('/order/customer-reviews')
        .query({ productId: String(globalProduct.id) })
      const pending = (list.body.data.reviews || []).filter(
        (r) => r.userName === 'Moderated'
      )
      expect(pending.length).toBe(0)
    } finally {
      delete process.env.REVIEW_AUTO_PUBLISH
    }
  })
})