process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let location = null
let category = null
let products = []
let cashierToken = null

beforeAll(async () => {
  location = await db.location.create({ name: 'PROD_PAGE_STORE', status: 'active' })
  category = await db.category.create({ name: 'PROD_PAGE_CATEGORY', status: 'active' })
  // 5 active products is enough to exercise limit=2/page pagination
  // without a slow bulk insert.
  for (let i = 0; i < 5; i++) {
    const p = await db.product.create({
      nameProduct: `PROD_PAGE_ITEM_${i}`,
      barcode: i === 3 ? '8997788990013' : null,
      category: category.id,
      price: 1000,
      stock: 10,
      status: 'active'
    })
    products.push(p)
  }
  // P1-4: central gate denies unknown caller identities; these rows
  // satisfy the identity invariant. Assertions below are unchanged.
  await db.user.create({
    id: 7801,
    userName: 'cashier_prod_page',
    email: 'p14-7801-product-cashier-search-pagination@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: location.id,
    status: 'active',
    fullName: 'cashier_prod_page'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  cashierToken = await signSessionToken(
    { id: 7801, userName: 'cashier_prod_page', roleType: 'kasir', store: location.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.user.destroy({ where: { id: [7801] }, force: true })
  await db.product.destroy({ where: { category: category.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

describe('GET /product/get-product-by-super-admin — bounded, paginated cashier search', () => {
  test('default call returns pagination metadata and does not silently drop products under the default limit', async () => {
    const res = await request(app)
      .get('/product/get-product-by-super-admin')
      .set('Authorization', `Bearer ${cashierToken}`)
      .set('Cookie', [`store=${location.id}`])

    expect(res.status).toBe(200)
    expect(res.body.pagination).toEqual({ page: 1, limit: 200, hasMore: false })
    const names = res.body.data.map((p) => p.nameProduct)
    for (const p of products) expect(names).toContain(p.nameProduct)
  })

  test('a small limit paginates instead of returning everything, and hasMore reflects reality', async () => {
    const page1 = await request(app)
      .get('/product/get-product-by-super-admin')
      .set('Authorization', `Bearer ${cashierToken}`)
      .set('Cookie', [`store=${location.id}`])
      .query({ limit: 2, page: 1 })

    expect(page1.status).toBe(200)
    expect(page1.body.data.length).toBe(2)
    expect(page1.body.pagination).toEqual({ page: 1, limit: 2, hasMore: true })

    const page2 = await request(app)
      .get('/product/get-product-by-super-admin')
      .set('Authorization', `Bearer ${cashierToken}`)
      .set('Cookie', [`store=${location.id}`])
      .query({ limit: 2, page: 2 })

    expect(page2.status).toBe(200)
    expect(page2.body.data.length).toBe(2)

    // No overlap between consecutive pages — proves the deterministic
    // ORDER BY actually makes offset-based paging stable.
    const page1Ids = page1.body.data.map((p) => p.id)
    const page2Ids = page2.body.data.map((p) => p.id)
    expect(page1Ids.some((id) => page2Ids.includes(id))).toBe(false)
  })

  test('search finds a product by its manufacturer barcode', async () => {
    const res = await request(app)
      .get('/product/get-product-by-super-admin')
      .set('Authorization', `Bearer ${cashierToken}`)
      .set('Cookie', [`store=${location.id}`])
      .query({ search: '8997788990013' })

    expect(res.status).toBe(200)
    expect(res.body.data.map((p) => p.nameProduct)).toEqual(['PROD_PAGE_ITEM_3'])
    expect(res.body.data[0].barcode).toBe('8997788990013')
  })

  test('limit is capped at 500 even if a caller asks for more', async () => {
    const res = await request(app)
      .get('/product/get-product-by-super-admin')
      .set('Authorization', `Bearer ${cashierToken}`)
      .set('Cookie', [`store=${location.id}`])
      .query({ limit: 999999 })

    expect(res.status).toBe(200)
    expect(res.body.pagination.limit).toBe(500)
  })
})
