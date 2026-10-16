process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const app = require('../api/index')
const db = require('../db/models')

let storeA, storeB, category, tableA, tableB
let productZ, productMissing, productMTO

describe('F4-03 /order/customer-menu — authoritative per-store effective stock', () => {
  beforeAll(async () => {
    storeA = await db.location.create({ name: 'F403_STORE_A', status: 'active' })
    storeB = await db.location.create({ name: 'F403_STORE_B', status: 'active' })
    category = await db.category.create({ name: 'F403_CATEGORY' })
    tableA = await db.table.create({ store: storeA.id, name: 'F403_TABLE_A' })
    tableB = await db.table.create({ store: storeB.id, name: 'F403_TABLE_B' })

    // productZ: base stock 100, assigned to BOTH stores. Store A has an
    // explicit store-stock row of 0, store B an explicit row of 20.
    productZ = await db.product.create({
      nameProduct: 'F403_PRODUCT_Z',
      category: category.id,
      price: 10000,
      stock: 100,
      isAvailable: true
    })
    await db.product_store.create({ product: productZ.id, store: storeA.id })
    await db.product_store.create({ product: productZ.id, store: storeB.id })
    await db.product_store_stock.create({ product: productZ.id, store: storeA.id, stock: 0 })
    await db.product_store_stock.create({ product: productZ.id, store: storeB.id, stock: 20 })

    // productMissing: base stock 100, assigned to Store A only, NO
    // product_store_stock row anywhere -> the outlet has none of it (DR-14:
    // the global stock is never an availability fallback).
    productMissing = await db.product.create({
      nameProduct: 'F403_PRODUCT_MISSING',
      category: category.id,
      price: 11000,
      stock: 100,
      isAvailable: true
    })
    await db.product_store.create({ product: productMissing.id, store: storeA.id })

    // productMTO: make_to_order — store stock 0 but finished-good stock is
    // not authoritative for this mode. The menu must still expose the store-
    // resolved effective stock (0) AND inventoryMode so consumers can decide
    // what stock-independence means.
    productMTO = await db.product.create({
      nameProduct: 'F403_PRODUCT_MTO',
      category: category.id,
      price: 12000,
      stock: 100,
      isAvailable: true,
      inventoryMode: 'make_to_order'
    })
    await db.product_store.create({ product: productMTO.id, store: storeA.id })
    await db.product_store_stock.create({ product: productMTO.id, store: storeA.id, stock: 0 })
  })

  afterAll(async () => {
    const productIds = [productZ?.id, productMissing?.id, productMTO?.id].filter(Boolean)
    await db.product_store_stock.destroy({ where: { product: productIds }, force: true })
    await db.product_store.destroy({ where: { product: productIds }, force: true })
    await db.product.destroy({ where: { id: productIds }, force: true })
    await db.table.destroy({ where: { id: [tableA?.id, tableB?.id] }, force: true })
    await db.category.destroy({ where: { id: category?.id }, force: true })
    await db.location.destroy({ where: { id: [storeA?.id, storeB?.id] }, force: true })
  })

  const menuFor = async (storeId) => {
    const res = await request(app).get('/order/customer-menu').query({ store: storeId })
    expect(res.status).toBe(200)
    return res.body.data.products
  }

  test('BE-1 — store-specific row of 0 is authoritative (effectiveStock 0, raw stock 100)', async () => {
    const products = await menuFor(storeA.id)
    const found = products.find((p) => String(p.id) === String(productZ.id))
    expect(found).toBeDefined()
    expect(found.effectiveStock).toBe(0)
    expect(Number(found.stock)).toBe(100)
  })

  test('BE-2 — store-specific positive row wins (effectiveStock 20)', async () => {
    const products = await menuFor(storeB.id)
    const found = products.find((p) => String(p.id) === String(productZ.id))
    expect(found).toBeDefined()
    expect(found.effectiveStock).toBe(20)
    expect(Number(found.stock)).toBe(100)
  })

  test('BE-3 — missing store row is 0, never the base stock (DR-14, BA 027)', async () => {
    const products = await menuFor(storeA.id)
    const found = products.find((p) => String(p.id) === String(productMissing.id))
    expect(found).toBeDefined()
    expect(found.effectiveStock).toBe(0)
  })

  test('BE-4 — different stores produce different effective stock (A=0 vs B=20)', async () => {
    const productsA = await menuFor(storeA.id)
    const productsB = await menuFor(storeB.id)
    const a = productsA.find((p) => String(p.id) === String(productZ.id))
    const b = productsB.find((p) => String(p.id) === String(productZ.id))
    expect(a.effectiveStock).toBe(0)
    expect(b.effectiveStock).toBe(20)
  })

  test('BE-5 — zero is NOT treated as missing (must not fall back to 100)', async () => {
    const products = await menuFor(storeA.id)
    const found = products.find((p) => String(p.id) === String(productZ.id))
    expect(found.effectiveStock).toBe(0)
    expect(found.effectiveStock).not.toBe(100)
  })

  test('BE-6 — customer-menu effectiveStock agrees with order-validation authority', async () => {
    // Store A: menu effectiveStock 0 -> ordering 1 unit must be rejected with Tersedia: 0
    const resZ = await request(app).post('/order/customer-create').send({
      store: storeA.id,
      tableId: tableA.id,
      paymentMethod: 'cash',
      customerName: 'F4-03 consistency',
      items: [
        { productId: productZ.id, productName: productZ.nameProduct, quantity: 1 }
      ]
    })
    expect(resZ.status).toBe(400)
    expect(resZ.body.message).toContain('Tersedia: 0')

    // productMissing: menu effectiveStock 0 (no outlet row) -> ordering 1
    // is rejected with Tersedia: 0, never judged against the base stock 100
    const resM = await request(app).post('/order/customer-create').send({
      store: storeA.id,
      tableId: tableA.id,
      paymentMethod: 'cash',
      customerName: 'F4-03 consistency',
      items: [
        { productId: productMissing.id, productName: productMissing.nameProduct, quantity: 1 }
      ]
    })
    expect(resM.status).toBe(400)
    expect(resM.body.message).toContain('Tersedia: 0')
  })

  test('BE-7 — products stay scoped to their store (no cross-store stock leak)', async () => {
    const productsA = await menuFor(storeA.id)
    const productsB = await menuFor(storeB.id)
    // productMissing is Store A only
    expect(productsB.find((p) => String(p.id) === String(productMissing.id))).toBeUndefined()
    // productZ in both, each with its own effective stock
    const a = productsA.find((p) => String(p.id) === String(productZ.id))
    const b = productsB.find((p) => String(p.id) === String(productZ.id))
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a.effectiveStock).toBe(0)
    expect(b.effectiveStock).toBe(20)
  })

  test('BE-8 — inventoryMode is exposed so consumers can honor make_to_order', async () => {
    const products = await menuFor(storeA.id)
    const stocked = products.find((p) => String(p.id) === String(productZ.id))
    const mto = products.find((p) => String(p.id) === String(productMTO.id))
    expect(stocked.inventoryMode).toBe('stocked')
    expect(mto.inventoryMode).toBe('make_to_order')
    expect(mto.effectiveStock).toBe(0)
  })
})