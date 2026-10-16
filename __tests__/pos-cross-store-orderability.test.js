process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// F-ORDER-1 regression: POS create-order must enforce the same
// store-orderability contract as the customer paths
// (isProductOrderableAtStore / isBundleOrderableAtStore).
//
// Domain contract (established from models + helpers + customer tests):
// - products are global-unless-assigned (no product_store rows → orderable
//   everywhere; rows exist → only assigned stores)
// - bundles assigned to another store are unavailable here; unassigned
//   bundles remain orderable on the authenticated POS path (legacy global
//   bundles, as exercised by order-create-flow.test.js)

const unique = (prefix) =>
  `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

let storeA = null
let storeB = null
let category = null
let foreignProduct = null
let globalProduct = null
let localProduct = null
let foreignBundle = null
let globalBundle = null
let localBundle = null
let tokenA = null

async function makeProduct(name, stock = 10) {
  return db.product.create({
    nameProduct: name,
    category: category.id,
    price: 15000,
    stock
  })
}

async function makeBundle(name, store) {
  const payload = {
    name,
    bundlePrice: 8000,
    isAvailable: true,
    status: 'active'
  }
  if (store !== undefined) payload.store = store
  return db.product_bundle.create(payload)
}

async function orderAsA(items, key) {
  return request(app)
    .post('/order/create')
    .set('Authorization', `Bearer ${tokenA}`)
    .send(withIdempotencyKey({
      store: storeA.id,
      items,
      paymentMethod: 'cash',
      cashierName: 'Ownership Cashier',
      ...(key ? { idempotencyKey: key } : {})
    }))
}

beforeAll(async () => {
  storeA = await db.location.create({
    name: `OWN_STORE_A_${Date.now()}`,
    status: 'active'
  })
  storeB = await db.location.create({
    name: `OWN_STORE_B_${Date.now()}`,
    status: 'active'
  })
  category = await db.category.create({ name: `OWN_CAT_${Date.now()}` })

  // Product assigned ONLY to store B.
  foreignProduct = await makeProduct(`OWN_FOREIGN_${Date.now()}`)
  await db.product_store.create({
    product: foreignProduct.id,
    store: storeB.id
  })
  await db.product_store_stock.create({
    product: foreignProduct.id,
    store: storeB.id,
    stock: foreignProduct.stock
  })

  // Product with no assignment anywhere → globally orderable.
  globalProduct = await makeProduct(`OWN_GLOBAL_${Date.now()}`)

  // Product assigned to store A.
  localProduct = await makeProduct(`OWN_LOCAL_${Date.now()}`)
  await db.product_store.create({
    product: localProduct.id,
    store: storeA.id
  })

  // getEffectiveStock() prefers a product_store_stock row once one exists
  // for the store — seed store-A rows like a stocked store would have
  // (mirrors order-create-flow.test.js).
  await db.product_store_stock.create({
    product: globalProduct.id,
    store: storeA.id,
    stock: globalProduct.stock
  })
  await db.product_store_stock.create({
    product: localProduct.id,
    store: storeA.id,
    stock: localProduct.stock
  })

  // Bundles: foreign-assigned, unassigned (POS-global), store-A-assigned.
  // Components use the global product so component scoping never interferes.
  for (const [slot, store] of [
    ['foreign', storeB.id],
    ['global', undefined],
    ['local', storeA.id]
  ]) {
    const bundle = await makeBundle(`OWN_BUNDLE_${slot}_${Date.now()}`, store)
    await db.product_bundle_item.create({
      bundleId: bundle.id,
      product: globalProduct.id,
      quantity: 1
    })
    if (slot === 'foreign') foreignBundle = bundle
    if (slot === 'global') globalBundle = bundle
    if (slot === 'local') localBundle = bundle
  }

  // P1-4: central gate denies unknown caller identities; these rows
  // satisfy the identity invariant. Assertions below are unchanged.
  await db.user.create({
    id: 7101,
    userName: 'cashier_ownership',
    email: 'p14-7101-pos-cross-store-orderability@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: storeA.id,
    status: 'active',
    fullName: 'cashier_ownership'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  tokenA = await signSessionToken(
    { id: 7101, userName: 'cashier_ownership', roleType: 'kasir', store: storeA.id },
    JWT_SECRET
  )
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed rates for
  // both stores so these orderability assertions exercise configured tax.
  for (const s of [storeA, storeB]) {
    await db.taxConfig.create({
      name: `OWN_PPN_${s.id}`,
      rate: 11,
      type: 'ppn',
      status: 'active',
      store: s.id
    })
  }
  // P1 (DR-PAY-ATTR-02): counter sales under test require an open register.
  await db.cashRegister.create({ store: storeA.id, user: 7101, status: 'open', openingBalance: 0, openedAt: new Date() })
})

afterAll(async () => {
  await db.cashRegister.destroy({ where: { store: storeA?.id }, force: true })
  await db.user.destroy({ where: { id: [7101] }, force: true })
  await db.taxConfig.destroy({
    where: { store: [storeA?.id, storeB?.id].filter(Boolean) },
    force: true
  })
  const productIds = [foreignProduct?.id, globalProduct?.id, localProduct?.id].filter(Boolean)
  const bundleIds = [foreignBundle?.id, globalBundle?.id, localBundle?.id].filter(Boolean)
  await db.order_item.destroy({ where: {}, force: true })
  await db.transaction.destroy({ where: {}, force: true })
  await db.order_status.destroy({ where: {}, force: true })
  await db.order.destroy({
    where: { store: [storeA?.id, storeB?.id].filter(Boolean) },
    force: true
  })
  await db.best_selling.destroy({ where: { productId: productIds }, force: true })
  await db.stock_history.destroy({ where: { product: productIds }, force: true })
  await db.product_store_stock.destroy({ where: { product: productIds }, force: true })
  await db.product_store.destroy({ where: { product: productIds }, force: true })
  await db.product_bundle_item.destroy({ where: { bundleId: bundleIds }, force: true })
  await db.product_bundle.destroy({ where: { id: bundleIds }, force: true })
  await db.product.destroy({ where: { id: productIds }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({
    where: { id: [storeA?.id, storeB?.id].filter(Boolean) },
    force: true
  })
})

describe('F-ORDER-1 POS cross-store orderability', () => {
  test('TEST A — foreign-store PRODUCT rejected with no side effects', async () => {
    const key = unique('ownA')
    const before = await db.product.findByPk(foreignProduct.id)
    const txBefore = await db.transaction.count()
    const res = await orderAsA(
      [{ product: foreignProduct.id, quantity: 1, productName: 'foreign' }],
      key
    )

    expect(res.status).toBe(400)
    expect(await db.order.findOne({ where: { idempotencyKey: key } })).toBeNull()
    const after = await db.product.findByPk(foreignProduct.id)
    expect(Number(after.stock)).toBe(Number(before.stock))
    expect(await db.transaction.count()).toBe(txBefore)
  })

  test('TEST B — foreign-store BUNDLE rejected with no side effects', async () => {
    const key = unique('ownB')
    const res = await orderAsA(
      [
        {
          product: globalProduct.id,
          bundleId: foreignBundle.id,
          quantity: 1,
          productName: foreignBundle.name
        }
      ],
      key
    )

    expect(res.status).toBe(400)
    expect(await db.order.findOne({ where: { idempotencyKey: key } })).toBeNull()
  })

  test('TEST C — same-store + global PRODUCTS remain valid', async () => {
    const beforeLocal = await db.product.findByPk(localProduct.id)
    const res = await orderAsA([
      { product: localProduct.id, quantity: 1, productName: 'local' },
      { product: globalProduct.id, quantity: 1, productName: 'global' }
    ])

    expect(res.status).toBe(201)
    const afterLocal = await db.product.findByPk(localProduct.id)
    expect(Number(afterLocal.stock)).toBe(Number(beforeLocal.stock) - 1)
  })

  test('TEST D — same-store + unassigned BUNDLES remain valid', async () => {
    for (const bundle of [localBundle, globalBundle]) {
      const res = await orderAsA([
        {
          product: globalProduct.id,
          bundleId: bundle.id,
          quantity: 1,
          productName: bundle.name
        }
      ])
      expect(res.status).toBe(201)
    }
  })
})
