process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const app = require('../api/index')
const db = require('../db/models')

let store = null
let category = null
let product = null
let discount = null

beforeAll(async () => {
  store = await db.location.create({
    name: 'PUBLIC_SURFACE_STORE',
    status: 'active'
  })
  category = await db.category.create({ name: 'PUBLIC_SURFACE_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'PUBLIC_SURFACE_PRODUCT',
    category: category.id,
    price: 10000,
    stock: 10,
    isAvailable: true
  })
  discount = await db.discount.create({
    store: store.id,
    name: 'Public surface promo',
    type: 'percent',
    value: 10,
    minimumOrder: 25000,
    maximumDiscount: 50000,
    code: `PUBLIC${Date.now()}`,
    status: 'active',
    conditions: { internalOnly: true },
    startDate: new Date(Date.now() - 60 * 60 * 1000),
    endDate: new Date(Date.now() + 60 * 60 * 1000)
  })
})

afterAll(async () => {
  await db.discount.destroy({ where: { id: discount?.id }, force: true })
  await db.product_review.destroy({ where: { productId: product?.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('public surface hardening', () => {
  test('the member-name lookup is gone', async () => {
    const res = await request(app).get('/order/customer-member').query({
      store: store.id,
      name: 'Budi'
    })

    expect(res.status).toBe(404)
  })

  test('the discount lookup returns only the public summary', async () => {
    const res = await request(app)
      .get(`/discount/lookup-by-code/${discount.code}`)
      .query({ store: store.id })

    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({
      valid: true,
      description: discount.name,
      type: discount.type,
      value: discount.value,
      minOrder: discount.minimumOrder
    })
    expect(res.body.data).not.toHaveProperty('conditions')
    expect(res.body.data).not.toHaveProperty('store')
    expect(res.body.data).not.toHaveProperty('id')
  })

  test('the FAQ list is bounded and honours the FE parameter names', async () => {
    const res = await request(app).get('/faq/faq?search=bayar&limit=5')

    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body.length).toBeLessThanOrEqual(5)
  })

  test('the FAQ list never returns the whole dataset', async () => {
    const unbounded = await request(app).get('/faq/faq')
    const capped = await request(app).get('/faq/faq?limit=1000')

    expect(unbounded.status).toBe(200)
    expect(unbounded.body.length).toBeLessThanOrEqual(20)
    expect(capped.status).toBe(200)
    expect(capped.body.length).toBeLessThanOrEqual(50)
  })

  test('a customer review with an over-long comment is rejected', async () => {
    const res = await request(app)
      .post('/order/customer-review')
      .send({
        name: 'Public Surface Tester',
        productId: String(product.id),
        store: store.id,
        rating: 5,
        comment: 'x'.repeat(501),
        deviceId: `public-surface-${Date.now()}`
      })

    expect(res.status).toBe(400)
  })
})
