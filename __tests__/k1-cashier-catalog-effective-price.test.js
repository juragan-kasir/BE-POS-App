process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// W3-4 K1 (DR-11): the cashier catalog (GET /product/get-product-by-super-admin)
// exposes the outlet-authoritative effectivePrice through the existing W3-1
// batched helper. Products are isolated from shared/global catalog rows via a
// unique name prefix used as the endpoint's `search` term.

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const PREFIX = 'K1EP_'
const URL = '/product/get-product-by-super-admin'

let storeA = null
let storeB = null
let category = null
let product = null
let baseOnlyProduct = null
let zeroProduct = null
let bundle = null
let cashierAToken = null
let superToken = null

beforeAll(async () => {
  storeA = await db.location.create(await withTestTenant({ name: 'K1EP_STORE_A', status: 'active' }))
  storeB = await db.location.create(await withTestTenant({ name: 'K1EP_STORE_B', status: 'active' }))
  // The cashier catalog inner-joins an active category.
  category = await db.category.create({ name: 'K1EP_CAT', status: 'active' })
  // Created in this order so id ASC paging is deterministic: product,
  // baseOnlyProduct, zeroProduct.
  product = await db.product.create({
    nameProduct: `${PREFIX}PRODUCT`,
    category: category.id,
    price: 10000,
    stock: 100,
    status: 'active'
  })
  baseOnlyProduct = await db.product.create({
    nameProduct: `${PREFIX}BASE_ONLY`,
    category: category.id,
    price: 20000,
    stock: 100,
    status: 'active'
  })
  zeroProduct = await db.product.create({
    nameProduct: `${PREFIX}ZERO`,
    category: category.id,
    price: 10000,
    stock: 100,
    status: 'active'
  })
  for (const p of [product, baseOnlyProduct, zeroProduct]) {
    await db.product_store.create({ product: p.id, store: storeA.id })
    await db.product_store.create({ product: p.id, store: storeB.id })
    await db.product_store_stock.create({ product: p.id, store: storeA.id, stock: 37 })
    await db.product_store_stock.create({ product: p.id, store: storeB.id, stock: 58 })
  }
  // Outlet prices: product differs per outlet; zero only at A; baseOnly none.
  await db.product_store_price.create({ product: product.id, store: storeA.id, price: 12000 })
  await db.product_store_price.create({ product: product.id, store: storeB.id, price: 15000 })
  await db.product_store_price.create({ product: zeroProduct.id, store: storeA.id, price: 0 })

  bundle = await db.product_bundle.create({
    name: 'K1EP_BUNDLE',
    bundlePrice: 5000,
    isAvailable: true,
    status: 'active',
    store: storeA.id
  })
  await db.product_bundle_item.create({ bundleId: bundle.id, product: product.id, quantity: 1 })

  await db.user.create({
    id: 9961,
    userName: 'k1ep_kasir_a',
    email: 'k1ep-9961@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: storeA.id,
    status: 'active',
    fullName: 'k1ep_kasir_a'
  })
  await db.user.create({
    id: 9962,
    userName: 'k1ep_super',
    email: 'k1ep-9962@test.com',
    roleType: 'super_admin',
    userType: 'admin',
    store: null,
    status: 'active',
    fullName: 'k1ep_super'
  })
  // Sessions need their user rows (FK), so mint tokens after them.
  cashierAToken = await signSessionToken(
    { id: 9961, userName: 'k1ep_kasir_a', roleType: 'kasir', store: storeA.id },
    JWT_SECRET
  )
  superToken = await signSessionToken(
    { id: 9962, userName: 'k1ep_super', roleType: 'super_admin', store: null },
    JWT_SECRET
  )
})

afterAll(async () => {
  const ids = [product?.id, baseOnlyProduct?.id, zeroProduct?.id].filter(Boolean)
  await db.user.destroy({ where: { id: [9961, 9962] }, force: true })
  await db.product_bundle_item.destroy({ where: { bundleId: bundle?.id }, force: true })
  await db.product_bundle.destroy({ where: { id: bundle?.id }, force: true })
  await db.product_store_price.destroy({ where: { product: ids }, force: true })
  await db.product_store_stock.destroy({ where: { product: ids }, force: true })
  await db.product_store.destroy({ where: { product: ids }, force: true })
  await db.product.destroy({ where: { id: ids }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({
    where: { id: [storeA?.id, storeB?.id].filter(Boolean) },
    force: true
  })
})

afterEach(() => {
  jest.restoreAllMocks()
})

const catalog = (token, query = {}) =>
  request(app)
    .get(URL)
    .query({ search: PREFIX, ...query })
    .set('Authorization', `Bearer ${token}`)

const byId = (res) => new Map(res.body.data.map((p) => [Number(p.id), p]))

describe('W3-4 K1 cashier catalog effectivePrice (DR-11)', () => {
  test('1. no outlet row: effectivePrice is the base price and price stays base', async () => {
    const res = await catalog(cashierAToken)

    expect(res.status).toBe(200)
    const row = byId(res).get(Number(baseOnlyProduct.id))
    expect(row).toBeDefined()
    expect(row.effectivePrice).toBe(20000)
    expect(Number(row.price)).toBe(20000)
  })

  test('2. outlet row: effectivePrice is the outlet price and price stays base', async () => {
    const res = await catalog(cashierAToken)

    expect(res.status).toBe(200)
    const row = byId(res).get(Number(product.id))
    expect(row.effectivePrice).toBe(12000)
    expect(Number(row.price)).toBe(10000)
  })

  test('3. explicit outlet price 0 stays 0 (not replaced by the base price)', async () => {
    const res = await catalog(cashierAToken)

    expect(res.status).toBe(200)
    const row = byId(res).get(Number(zeroProduct.id))
    expect(row.effectivePrice).toBe(0)
    expect(Number(row.price)).toBe(10000)
  })

  test('4. multiple products each get their own price from one batched lookup', async () => {
    const spy = jest.spyOn(db.product_store_price, 'findAll')

    const res = await catalog(cashierAToken)

    expect(res.status).toBe(200)
    const rows = byId(res)
    expect(rows.get(Number(product.id)).effectivePrice).toBe(12000)
    expect(rows.get(Number(baseOnlyProduct.id)).effectivePrice).toBe(20000)
    expect(rows.get(Number(zeroProduct.id)).effectivePrice).toBe(0)
    // Batch-based: exactly one price query for the whole page, never per product.
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0].where.store).toBe(Number(storeA.id))
  })

  test('5. outlets do not cross-contaminate: cashier A sees A prices, super_admin at B sees B prices', async () => {
    const resA = await catalog(cashierAToken)
    const resB = await catalog(superToken, { store: storeB.id })

    expect(resA.status).toBe(200)
    expect(resB.status).toBe(200)
    const a = byId(resA)
    const b = byId(resB)
    expect(a.get(Number(product.id)).effectivePrice).toBe(12000)
    expect(b.get(Number(product.id)).effectivePrice).toBe(15000)
    // A's explicit 0 never leaks to B; B has no row, so base applies.
    expect(a.get(Number(zeroProduct.id)).effectivePrice).toBe(0)
    expect(b.get(Number(zeroProduct.id)).effectivePrice).toBe(10000)
    expect(b.get(Number(baseOnlyProduct.id)).effectivePrice).toBe(20000)
  })

  test('6. a non-super-admin requesting a foreign store gets the existing 403 and no catalog data', async () => {
    const res = await catalog(cashierAToken, { store: storeB.id })

    expect(res.status).toBe(403)
    expect(res.body.data).toBeUndefined()
  })

  test('7. super_admin without a store gets effectivePrice null', async () => {
    const spy = jest.spyOn(db.product_store_price, 'findAll')

    const res = await catalog(superToken)

    expect(res.status).toBe(200)
    const rows = byId(res)
    for (const p of [product, baseOnlyProduct, zeroProduct]) {
      const row = rows.get(Number(p.id))
      expect(row).toBeDefined()
      expect(row.effectivePrice).toBeNull()
    }
    expect(Number(rows.get(Number(product.id)).price)).toBe(10000)
    expect(spy).not.toHaveBeenCalled()
  })

  test('8. existing response fields are unchanged: price, stock, bundles, pagination', async () => {
    const res = await catalog(cashierAToken)

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.pagination).toEqual({ page: 1, limit: 200, hasMore: false })
    const row = byId(res).get(Number(product.id))
    expect(Number(row.price)).toBe(10000)
    expect(Number(row.stock)).toBe(37)
    expect(row.categoryData).toBeDefined()
    expect(row).not.toHaveProperty('storeStocks')
    const b = res.body.bundles.find((x) => Number(x.id) === Number(bundle.id))
    expect(b).toBeDefined()
    expect(Number(b.bundlePrice)).toBe(5000)
    expect(b).not.toHaveProperty('effectivePrice')
  })

  test('9. pagination: page 2 rows are priced correctly and the limit+1 probe row is never priced or returned', async () => {
    const spy = jest.spyOn(db.product_store_price, 'findAll')

    const page1 = await catalog(cashierAToken, { limit: 2, page: 1 })

    expect(page1.status).toBe(200)
    expect(page1.body.pagination).toEqual({ page: 1, limit: 2, hasMore: true })
    expect(page1.body.data.map((p) => Number(p.id))).toEqual([
      Number(product.id),
      Number(baseOnlyProduct.id)
    ])
    // Only the returned page slice is priced — the probe row (zeroProduct)
    // is fetched to compute hasMore but never sent to the price lookup.
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0].where.product.map(Number).sort((x, y) => x - y)).toEqual(
      [Number(product.id), Number(baseOnlyProduct.id)].sort((x, y) => x - y)
    )

    const page2 = await catalog(cashierAToken, { limit: 2, page: 2 })

    expect(page2.status).toBe(200)
    expect(page2.body.pagination).toEqual({ page: 2, limit: 2, hasMore: false })
    expect(page2.body.data).toHaveLength(1)
    expect(Number(page2.body.data[0].id)).toBe(Number(zeroProduct.id))
    expect(page2.body.data[0].effectivePrice).toBe(0)
  })

  test('10. empty catalog: 200 with data [] and no price lookup', async () => {
    const spy = jest.spyOn(db.product_store_price, 'findAll')

    const res = await catalog(cashierAToken, { search: `${PREFIX}NO_MATCH_${Date.now()}` })

    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })
})
