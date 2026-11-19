process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// N-2 regression: pos getPriceByStore/updatePriceByStore trusted client
// query.storeIds and storePrices[].storeId as tenant authority, so a store A
// admin could read and write store B's product prices. Store selection must
// derive from req.storeId for non-super-admin and reject cross-store selectors.

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let store1 = null
let store2 = null
let category = null
let product = null
let userAdmin1 = null
let userSuper = null
let admin1Token = null
let superToken = null

beforeAll(async () => {
  store1 = await db.location.create(await withTestTenant({ name: 'N2_STORE_A', status: 'active' }))
  store2 = await db.location.create(await withTestTenant({ name: 'N2_STORE_B', status: 'active' }))
  category = await db.category.create({ name: 'N2_CAT', status: 'active' })
  product = await db.product.create({
    nameProduct: 'N2_Product',
    category: category.id,
    price: 1000,
    costPrice: 500,
    stock: 10
  })

  const suffix = Date.now()
  userAdmin1 = await db.user.create({
    id: 9601,
    userName: `n2_admin_a_${suffix}`,
    roleType: 'admin',
    store: store1.id,
    password: 'x'
  })
  userSuper = await db.user.create({
    id: 9600,
    userName: `n2_super_${suffix}`,
    roleType: 'super_admin',
    password: 'x'
  })

  admin1Token = await signSessionToken(
    { id: userAdmin1.id, userName: userAdmin1.userName, roleType: 'admin', store: store1.id },
    JWT_SECRET
  )
  superToken = await signSessionToken(
    { id: userSuper.id, userName: userSuper.userName, roleType: 'super_admin' },
    JWT_SECRET
  )

  // A pre-existing store2 product price row the store A admin must not read/write
  await db.product_store_price.findOrCreate({
    where: { product: product.id, store: store1.id },
    defaults: { price: 2000 }
  })
  await db.product_store_price.findOrCreate({
    where: { product: product.id, store: store2.id },
    defaults: { price: 3000 }
  })
})

afterAll(async () => {
  await db.product_store_price.destroy({
    where: { product: product?.id, store: { [db.Sequelize.Op.in]: [store1?.id, store2?.id].filter(Boolean) } },
    force: true
  })
  await db.stock_history.destroy({ where: { product: product?.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.auditLog.destroy({ where: { userId: [userAdmin1?.id, userSuper?.id].filter(Boolean) }, force: true, __auditMaintenance: true })
  await db.user.destroy({ where: { id: [userAdmin1?.id, userSuper?.id].filter(Boolean) }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: [store1?.id, store2?.id].filter(Boolean) }, force: true })
})

describe('N-2 POS product price tenant isolation', () => {
  test('store A admin querying store B price via storeIds cannot read store B price', async () => {
    const res = await request(app)
      .get('/pos/product/price-by-store')
      .query({ productId: product.id, storeIds: `${store1.id},${store2.id}` })
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(200)
    const storePrices = res.body.data?.storePrices || []
    const storeIdsReturned = storePrices.map((p) => Number(p.store))
    expect(storeIdsReturned).toContain(store1.id)
    expect(storeIdsReturned).not.toContain(store2.id)
    expect(storePrices.every((p) => Number(p.store) === store1.id)).toBe(true)
  })

  test('store A admin cannot create/update store B product price', async () => {
    const res = await request(app)
      .put('/pos/product/update-price-by-store')
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({
        productId: product.id,
        storePrices: [{ storeId: String(store2.id), price: 99999 }]
      })

    expect([403, 400]).toContain(res.status)
    const row = await db.product_store_price.findOne({
      where: { product: product.id, store: store2.id }
    })
    expect(Number(row.price)).toBe(3000)
  })

  test('store A admin cannot overwrite existing store B price (DB unchanged)', async () => {
    const before = await db.product_store_price.findOne({
      where: { product: product.id, store: store2.id }
    })
    await request(app)
      .put('/pos/product/update-price-by-store')
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({
        productId: product.id,
        storePrices: [{ storeId: String(store2.id), price: 55555 }]
      })
    const after = await db.product_store_price.findOne({
      where: { product: product.id, store: store2.id }
    })
    expect(Number(after.price)).toBe(Number(before.price))
  })

  test('body storeId cannot override req.storeId for store A admin', async () => {
    const res = await request(app)
      .put('/pos/product/update-price-by-store')
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({
        productId: product.id,
        storePrices: [{ storeId: String(store1.id), price: 7777 }, { storeId: String(store2.id), price: 8888 }]
      })
    expect([403, 400]).toContain(res.status)
    const b2 = await db.product_store_price.findOne({
      where: { product: product.id, store: store2.id }
    })
    expect(Number(b2.price)).toBe(3000)
  })

  test('store A admin can update their OWN store price (mutation preserved)', async () => {
    const res = await request(app)
      .put('/pos/product/update-price-by-store')
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({
        productId: product.id,
        storePrices: [{ storeId: String(store1.id), price: 4000 }]
      })
    expect(res.status).toBe(200)
    const row = await db.product_store_price.findOne({
      where: { product: product.id, store: store1.id }
    })
    expect(Number(row.price)).toBe(4000)
  })

  test('super_admin can still set a store B price (intentional global scope)', async () => {
    const res = await request(app)
      .put('/pos/product/update-price-by-store')
      .set('Authorization', `Bearer ${superToken}`)
      .send({
        productId: product.id,
        storePrices: [{ storeId: String(store2.id), price: 6000 }]
      })
    expect(res.status).toBe(200)
    const row = await db.product_store_price.findOne({
      where: { product: product.id, store: store2.id }
    })
    expect(Number(row.price)).toBe(6000)
    // restore for state cleanliness
    await db.product_store_price.update({ price: 3000 }, { where: { product: product.id, store: store2.id } })
  })
})
