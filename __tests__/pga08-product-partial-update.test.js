process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// PGA-08 (product-grade audit 2026-11-02): `PUT /product/edit-product` with
// only `{ id, isAvailable: false }` reset the name to '', price/cost/points to
// 0 and global + outlet stock to 0. An edit must change only what it sends.

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { updateProductSchema } = require('../api/validation/schemas')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const USER_ID = 7481

let location = null
let category = null
let token = null

const makeProduct = async (extra = {}) => {
  const product = await db.product.create({
    nameProduct: 'PGA08_ES_JERUK',
    category: category.id,
    price: 6000,
    costPrice: 2700,
    point: 3,
    redeemPoints: 40,
    estimationTime: 5,
    stock: 100,
    minStock: 4,
    barcode: '8990000000081',
    brand: 'PGA08 Brand',
    description: 'segar',
    currencyCode: 'IDR',
    priceTiers: [{ minQty: 10, price: 5500 }],
    hasModifiers: true,
    modifiers: [{ name: 'Less ice', price: 0 }],
    isOption: true,
    options: [{ name: 'Size', options: [{ name: 'L', price: 2000 }] }],
    status: 'active',
    isAvailable: true,
    ...extra
  })
  await db.product_store.create({ product: product.id, store: location.id })
  await db.product_store_stock.create({ product: product.id, store: location.id, stock: 100 })
  return product
}

const edit = (body) =>
  request(app).put('/product/edit-product').set('Authorization', `Bearer ${token}`).send(body)

beforeAll(async () => {
  location = await db.location.create({ name: 'PGA08_STORE', status: 'active' })
  category = await db.category.create({ name: 'PGA08_CATEGORY' })
  await db.user.create({
    id: USER_ID,
    userName: 'admin_pga08',
    email: 'pga08-7481@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: location.id,
    status: 'active',
    fullName: 'admin_pga08'
  })
  token = await signSessionToken(
    { id: USER_ID, userName: 'admin_pga08', roleType: 'admin', store: location.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  const ids = (await db.product.findAll({ where: { category: category.id }, attributes: ['id'], raw: true })).map((r) => r.id)
  await db.stock_history.destroy({ where: { product: ids }, force: true })
  await db.product_store_stock.destroy({ where: { store: location.id }, force: true })
  await db.product_store.destroy({ where: { store: location.id }, force: true })
  await db.product.destroy({ where: { category: category.id }, force: true })
  await db.user.destroy({ where: { id: USER_ID }, force: true })
  await db.category.destroy({ where: { id: category.id }, force: true })
  await db.location.destroy({ where: { id: location.id }, force: true })
})

describe('PGA-08 — updateProductSchema fills no defaults', () => {
  test('a partial body parses to exactly the keys it sent', () => {
    expect(updateProductSchema.parse({ id: '5', isAvailable: false })).toEqual({ id: 5, isAvailable: false })
  })

  test('explicit empties survive so a field can still be cleared', () => {
    expect(updateProductSchema.parse({ id: 5, barcode: '', tax: '', description: '' })).toEqual({
      id: 5,
      barcode: '',
      tax: null,
      description: ''
    })
  })
})

describe('PGA-08 — PUT /product/edit-product partial update', () => {
  test('{ id, isAvailable: false } changes availability and nothing else', async () => {
    const product = await makeProduct()
    const before = (await db.product.findByPk(product.id, { raw: true }))

    const res = await edit({ id: product.id, isAvailable: false })
    expect(res.status).toBe(200)

    const after = await db.product.findByPk(product.id, { raw: true })
    expect(after.isAvailable).toBe(false)
    for (const key of [
      'nameProduct',
      'category',
      'status',
      'description',
      'unit',
      'baseUnit',
      'barcode',
      'brand',
      'currencyCode',
      'tipeProduk',
      'hasModifiers',
      'isOption'
    ]) {
      expect([key, after[key]]).toEqual([key, before[key]])
    }
    for (const key of ['price', 'costPrice', 'point', 'redeemPoints', 'estimationTime', 'stock', 'minStock', 'conversionFactor']) {
      expect([key, Number(after[key])]).toEqual([key, Number(before[key])])
    }
    expect(after.modifiers).toEqual(before.modifiers)
    expect(after.options).toEqual(before.options)
    expect(after.priceTiers).toEqual(before.priceTiers)

    const outlet = await db.product_store_stock.findOne({ where: { product: product.id, store: location.id } })
    expect(Number(outlet.stock)).toBe(100)
    const history = await db.stock_history.count({ where: { product: product.id } })
    expect(history).toBe(0)
  })

  test('a partial price edit keeps stock and the outlet row untouched', async () => {
    const product = await makeProduct()
    const res = await edit({ id: product.id, price: 6500 })
    expect(res.status).toBe(200)

    const after = await db.product.findByPk(product.id, { raw: true })
    expect(Number(after.price)).toBe(6500)
    expect(after.nameProduct).toBe('PGA08_ES_JERUK')
    expect(Number(after.stock)).toBe(100)
    const outlet = await db.product_store_stock.findOne({ where: { product: product.id, store: location.id } })
    expect(Number(outlet.stock)).toBe(100)
  })

  test('sending an empty value still clears a nullable field', async () => {
    const product = await makeProduct()
    const res = await edit({ id: product.id, barcode: '', brand: '', description: '' })
    expect(res.status).toBe(200)

    const after = await db.product.findByPk(product.id, { raw: true })
    expect(after.barcode).toBeNull()
    expect(after.brand).toBeNull()
    expect(after.description).toBe('')
    expect(after.nameProduct).toBe('PGA08_ES_JERUK')
  })

  test('hasModifiers: false clears the list; sending the flag alone keeps a list on', async () => {
    const product = await makeProduct()
    expect((await edit({ id: product.id, hasModifiers: 'false' })).status).toBe(200)
    let after = await db.product.findByPk(product.id, { raw: true })
    expect(after.modifiers).toEqual([])
    expect(after.options).toEqual([{ name: 'Size', options: [{ name: 'L', price: 2000 }] }])

    expect((await edit({ id: product.id, isOption: true })).status).toBe(200)
    after = await db.product.findByPk(product.id, { raw: true })
    expect(after.options).toEqual([{ name: 'Size', options: [{ name: 'L', price: 2000 }] }])
  })

  test('the update notification names the stored product, not ""', async () => {
    const product = await makeProduct()
    expect((await edit({ id: product.id, isAvailable: false })).status).toBe(200)
    // createNotification is fire-and-forget; let it land.
    await new Promise((r) => setTimeout(r, 300))
    const note = await db.notification.findOne({
      where: { referenceId: product.id, type: 'product_updated' },
      order: [['id', 'DESC']],
      raw: true
    })
    expect(note).toBeTruthy()
    expect(JSON.stringify(note)).toContain('PGA08_ES_JERUK')
  })

  test('a full form payload (FE shape) still updates every field it sends', async () => {
    const product = await makeProduct()
    const res = await edit({
      id: product.id,
      nameProduct: 'PGA08_RENAMED',
      price: 7000,
      costPrice: 3000,
      stock: 80,
      minStock: 2,
      point: 1,
      redeemPoints: 0,
      estimationTime: 0,
      description: 'baru',
      status: 'active',
      isAvailable: true,
      hasModifiers: false,
      modifiers: '[]',
      isOption: false,
      options: '[]',
      storeId: location.id
    })
    expect(res.status).toBe(200)
    const after = await db.product.findByPk(product.id, { raw: true })
    expect(after.nameProduct).toBe('PGA08_RENAMED')
    expect(Number(after.price)).toBe(7000)
    expect(Number(after.stock)).toBe(80)
    expect(after.modifiers).toEqual([])
    expect(after.options).toEqual([])
    const outlet = await db.product_store_stock.findOne({ where: { product: product.id, store: location.id } })
    expect(Number(outlet.stock)).toBe(80)
  })
})
