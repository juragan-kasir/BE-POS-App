process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let storeA = null
let storeB = null
let category = null
let productAdjust = null
let productTransfer = null
let adminAUser = null
let superAdminUser = null
let adminAToken = null
let superAdminToken = null

beforeAll(async () => {
  storeA = await db.location.create({ name: 'POS_FLOW_STORE_A', status: 'active' })
  storeB = await db.location.create({ name: 'POS_FLOW_STORE_B', status: 'active' })
  category = await db.category.create({ name: 'POS_FLOW_CATEGORY' })

  productAdjust = await db.product.create({
    nameProduct: 'POS_FLOW_ADJUST_PRODUCT',
    category: category.id,
    price: 3000,
    stock: 10
  })
  productTransfer = await db.product.create({
    nameProduct: 'POS_FLOW_TRANSFER_PRODUCT',
    category: category.id,
    price: 4000,
    stock: 15
  })
  // transfer reads availability from product_store_stock at the source
  // store, not the base product.stock — seed it like a store that has
  // already been through stock opname/goods receipt.
  await db.product_store_stock.create({
    product: productTransfer.id,
    store: storeA.id,
    stock: 15
  })

  // stock_transfer.createdBy FKs to user.id (unlike order/transaction/
  // stock_history, which don't) — the token subject needs a real user row.
  adminAUser = await db.user.create({
    userName: 'admin_pos_flow_a',
    email: 'admin_pos_flow_a@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: storeA.id,
    status: 'active'
  })
  superAdminUser = await db.user.create({
    userName: 'superadmin_pos_flow',
    email: 'superadmin_pos_flow@test.com',
    roleType: 'super_admin',
    userType: 'admin',
    status: 'active'
  })

  adminAToken = await signSessionToken(
    {
      id: adminAUser.id,
      userName: adminAUser.userName,
      roleType: 'admin',
      store: storeA.id
    },
    JWT_SECRET
  )
  superAdminToken = await signSessionToken(
    { id: superAdminUser.id, userName: superAdminUser.userName, roleType: 'super_admin' },
    JWT_SECRET
  )
})

// GAP-2 tenant-boundary fixtures. Shared storeA/storeB stay tenantless so the
// platform NULL→NULL staging proof below keeps its meaning; tenant-bound
// coverage uses dedicated stores.
let tenantX = null
let tenantY = null
let storeTX1 = null
let storeTX2 = null
let storeTY1 = null
let storeTN = null
let storeRET = null
let storeQUAR = null
let adminTXUser = null
let adminTXToken = null
let categoryTX = null
const g2ProdIds = []
const g2CatIds = []
const g2LocIds = []

// F1: fixture ids come from the sequence (never MAX+1). The production
// create path is sequence-authoritative, so a MAX+1 fixture can land
// exactly on the sequence's next value and collide with a later create.
const nextDirectLocationId = async () => {
  const [rows] = await db.sequelize.query("SELECT nextval('location_id_seq') AS id")
  return Number(rows?.[0]?.id)
}

const g2stamp = () => `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`

const makeG2Store = async (name, tenantId, status = 'active') => {
  const row = await db.location.create({
    id: await nextDirectLocationId(),
    name: `${name}_${g2stamp()}`,
    status,
    phoneNumber: '081234567890',
    email: `${name.toLowerCase()}_${g2stamp()}@test.com`,
    tenantId: tenantId ?? null,
    createdBy: superAdminUser.id
  })
  g2LocIds.push(row.id)
  return row
}

beforeAll(async () => {
  tenantX = await db.tenant.create({ code: `G2TX_${Date.now()}`, name: 'G2 Tenant X' })
  tenantY = await db.tenant.create({ code: `G2TY_${Date.now()}`, name: 'G2 Tenant Y' })
  storeTX1 = await makeG2Store('G2_STORE_TX1', tenantX.id)
  storeTX2 = await makeG2Store('G2_STORE_TX2', tenantX.id)
  storeTY1 = await makeG2Store('G2_STORE_TY1', tenantY.id)
  storeTN = await makeG2Store('G2_STORE_TN', null)
  storeRET = await makeG2Store('G2_STORE_RET', tenantX.id, 'retired')
  storeQUAR = await makeG2Store('G2_STORE_QUAR', tenantX.id, 'quarantined')
  categoryTX = await db.category.create({ name: `G2_CAT_TX_${g2stamp()}`, createdBy: superAdminUser.id })
  g2CatIds.push(categoryTX.id)
  await db.category_store.create({ category: categoryTX.id, store: storeTX1.id })
  adminTXUser = await db.user.create({
    userName: `admin_g2_tx_${Date.now()}`,
    email: `admin_g2_tx_${Date.now()}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: storeTX1.id,
    status: 'active'
  })
  adminTXToken = await signSessionToken(
    {
      id: adminTXUser.id,
      userName: adminTXUser.userName,
      roleType: 'admin',
      store: storeTX1.id
    },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.stock_transfer.destroy({
    where: { fromStore: [storeTX1?.id, storeTX2?.id, storeTY1?.id, storeTN?.id].filter(Boolean) },
    force: true
  }).catch(() => {})
  await db.stock_history.destroy({ where: { product: g2ProdIds }, force: true }).catch(() => {})
  await db.product_store_stock.destroy({ where: { product: g2ProdIds }, force: true }).catch(() => {})
  await db.product_store.destroy({ where: { product: g2ProdIds }, force: true }).catch(() => {})
  await db.category_store.destroy({ where: { category: g2CatIds }, force: true }).catch(() => {})
  await db.product.destroy({ where: { id: g2ProdIds }, force: true }).catch(() => {})
  await db.category.destroy({ where: { id: g2CatIds }, force: true }).catch(() => {})
  // Users before locations: user.store is a real FK to location
  // (user_store_fkey); deleting tenant-bound stores first violates it.
  await db.user.destroy({ where: { id: [adminTXUser?.id].filter(Boolean) }, force: true }).catch(() => {})
  await db.location.destroy({ where: { id: g2LocIds }, force: true }).catch(() => {})
  await db.tenant.destroy({ where: { id: [tenantX?.id, tenantY?.id].filter(Boolean) }, force: true }).catch(() => {})
})

afterAll(async () => {
  await db.stock_transfer_item.destroy({ where: {}, force: true })
  await db.stock_transfer.destroy({
    where: { fromStore: [storeA?.id, storeB?.id].filter(Boolean) },
    force: true
  })
  await db.user.destroy({
    where: { id: [adminAUser?.id, superAdminUser?.id].filter(Boolean) },
    force: true
  })
  await db.stock_history.destroy({
    where: { product: [productAdjust?.id, productTransfer?.id] },
    force: true
  })
  await db.product_store_stock.destroy({
    where: { product: [productAdjust?.id, productTransfer?.id] },
    force: true
  })
  await db.product.destroy({
    where: { id: [productAdjust?.id, productTransfer?.id] },
    force: true
  })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: [storeA?.id, storeB?.id] }, force: true })
})

describe('POST /pos/adjust — stock adjustment', () => {
  test('positive adjustment increases stock and records stock_history', async () => {
    const res = await request(app)
      .post('/pos/adjust')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({ productId: productAdjust.id, qty: 5, reason: 'Restock' })

    expect(res.status).toBe(200)

    const fresh = await db.product.findByPk(productAdjust.id)
    expect(Number(fresh.stock)).toBe(15)

    const history = await db.stock_history.findAll({
      where: { product: productAdjust.id, referenceType: 'adjustment' }
    })
    expect(history.length).toBe(1)
    expect(Number(history[0].quantityChange)).toBe(5)
  })

  test('rejects an adjustment that would take stock negative', async () => {
    const res = await request(app)
      .post('/pos/adjust')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({ productId: productAdjust.id, qty: -999, reason: 'Bad adjustment' })

    expect(res.status).toBe(400)

    const fresh = await db.product.findByPk(productAdjust.id)
    expect(Number(fresh.stock)).toBe(15)
  })

  test('fractional qty: stock, history, per-store stock and response share one floored delta', async () => {
    const before = Number((await db.product.findByPk(productAdjust.id)).stock)
    const [[storeBeforeRow]] = await db.sequelize.query(
      'SELECT stock FROM product_store_stock WHERE product = $1 AND store = $2',
      { bind: [productAdjust.id, storeA.id] }
    )
    const storeBefore = Number(storeBeforeRow?.stock || 0)

    const res = await request(app)
      .post('/pos/adjust')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({ productId: productAdjust.id, qty: 2.7, reason: 'Fractional restock' })

    expect(res.status).toBe(200)

    // KF-NEW-07: only Math.floor(qty) = 2 is ever applied to stock, so the
    // history row, the per-store row and the response must record the same
    // delta — never the raw 2.7 and never a pre-transaction stock read.
    const fresh = await db.product.findByPk(productAdjust.id)
    expect(Number(fresh.stock)).toBe(before + 2)

    const history = await db.stock_history.findAll({
      where: { product: productAdjust.id, referenceType: 'adjustment' },
      order: [['id', 'ASC']]
    })
    const row = history[history.length - 1]
    expect(Number(row.quantityBefore)).toBe(before)
    expect(Number(row.quantityChange)).toBe(2)
    expect(Number(row.quantityAfter)).toBe(before + 2)

    expect(Number(res.body.data.adjustment.oldStock)).toBe(before)
    expect(Number(res.body.data.adjustment.qty)).toBe(2)
    expect(Number(res.body.data.adjustment.newStock)).toBe(before + 2)

    const [[storeStock]] = await db.sequelize.query(
      'SELECT stock FROM product_store_stock WHERE product = $1 AND store = $2',
      { bind: [productAdjust.id, storeA.id] }
    )
    expect(Number(storeStock.stock)).toBe(storeBefore + 2)
  })
})

describe('POST /pos/transfer — inter-store stock transfer', () => {
  test('non-platform transfer between tenantless stores is rejected', async () => {
    // GAP-2 contract flip: tenantless→tenantless is platform-only staging.
    // The original success intent now lives in the same-tenant T1 case below.
    const res = await request(app)
      .post('/pos/transfer')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        fromStore: storeA.id,
        toStore: storeB.id,
        items: [{ productId: productTransfer.id, qty: 6 }]
      })

    expect(res.status).toBe(422)
    expect(res.body.code).toBe('STORE_TENANT_REQUIRED')

    const sourceStock = await db.product_store_stock.findOne({
      where: { product: productTransfer.id, store: storeA.id }
    })
    expect(Number(sourceStock.stock)).toBe(15)
  })

  test('rejects a transfer with the same source and destination store', async () => {
    const res = await request(app)
      .post('/pos/transfer')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        fromStore: storeA.id,
        toStore: storeA.id,
        items: [{ productId: productTransfer.id, qty: 1 }]
      })

    expect(res.status).toBe(400)
  })

  test('rejects a transfer sourced from a store the admin does not belong to', async () => {
    const res = await request(app)
      .post('/pos/transfer')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({
        fromStore: storeB.id, // adminAToken belongs to storeA, not storeB
        toStore: storeA.id,
        items: [{ productId: productTransfer.id, qty: 1 }]
      })

    expect(res.status).toBe(403)
  })

  test('super_admin can transfer from any store', async () => {
    const before = await db.product_store_stock.findOne({
      where: { product: productTransfer.id, store: storeA.id }
    })

    const res = await request(app)
      .post('/pos/transfer')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        fromStore: storeA.id,
        toStore: storeB.id,
        items: [{ productId: productTransfer.id, qty: 2 }]
      })

    expect(res.status).toBe(201)

    const after = await db.product_store_stock.findOne({
      where: { product: productTransfer.id, store: storeA.id }
    })
    expect(Number(after.stock)).toBe(Number(before.stock) - 2)
  })

  test('several transfers created in the same instant get distinct transferNumbers, not a unique-constraint 500', async () => {
    // Regression test: transferNumber used to be `TRF-${Date.now()}` with
    // no random component — concurrent requests landing in the same
    // millisecond (exactly what Promise.all produces) previously hit a
    // hard unique-constraint violation instead of succeeding.
    const requests = Array.from({ length: 4 }, () =>
      request(app)
        .post('/pos/transfer')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({
          fromStore: storeA.id,
          toStore: storeB.id,
          items: [{ productId: productTransfer.id, qty: 1 }]
        })
    )
    const results = await Promise.all(requests)

    for (const res of results) {
      expect(res.status).toBe(201)
    }
    const transferNumbers = results.map((r) => r.body.data.transferNumber)
    expect(new Set(transferNumbers).size).toBe(transferNumbers.length)
  })
})

describe('POST /pos/transfer — tenant boundary (GAP-2)', () => {
  const makeTransferProduct = async (tag, categoryId, storeId, stock) => {
    const product = await db.product.create({
      nameProduct: `G2_PROD_${tag}_${g2stamp()}`,
      category: categoryId,
      price: 5000,
      stock
    })
    g2ProdIds.push(product.id)
    await db.product_store_stock.create({ product: product.id, store: storeId, stock })
    return product
  }

  const storeStock = async (productId, storeId) =>
    Number(
      (
        await db.product_store_stock.findOne({
          where: { product: productId, store: storeId }
        })
      ).stock
    )

  const sendTransfer = (token, fromStore, toStore, productId, qty = 2) =>
    request(app)
      .post('/pos/transfer')
      .set('Authorization', `Bearer ${token}`)
      .send({ fromStore, toStore, items: [{ productId, qty }] })

  test('T1 non-platform same-tenant transfer succeeds', async () => {
    const product = await makeTransferProduct('T1', categoryTX.id, storeTX1.id, 1000)
    const res = await sendTransfer(adminTXToken, storeTX1.id, storeTX2.id, product.id, 6)
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('sent')
    expect(await storeStock(product.id, storeTX1.id)).toBe(994)
  })

  test('T2 non-platform cross-tenant transfer is rejected', async () => {
    const product = await makeTransferProduct('T2', categoryTX.id, storeTX1.id, 1000)
    const before = await storeStock(product.id, storeTX1.id)
    const res = await sendTransfer(adminTXToken, storeTX1.id, storeTY1.id, product.id)
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('TENANT_SCOPE_MISMATCH')
    expect(await storeStock(product.id, storeTX1.id)).toBe(before)
    expect(
      await db.stock_transfer.count({ where: { fromStore: storeTX1.id, toStore: storeTY1.id } })
    ).toBe(0)
  })

  test('T3 non-platform tenantless source is rejected', async () => {
    const res = await sendTransfer(adminAToken, storeA.id, storeB.id, productTransfer.id)
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('STORE_TENANT_REQUIRED')
  })

  test('T4 non-platform tenantless destination is rejected', async () => {
    const product = await makeTransferProduct('T4', categoryTX.id, storeTX1.id, 1000)
    const res = await sendTransfer(adminTXToken, storeTX1.id, storeTN.id, product.id)
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('STORE_TENANT_REQUIRED')
  })

  test('T5 platform same-tenant transfer succeeds', async () => {
    const product = await makeTransferProduct('T5', categoryTX.id, storeTX1.id, 1000)
    const res = await sendTransfer(superAdminToken, storeTX1.id, storeTX2.id, product.id, 4)
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('sent')
    expect(await storeStock(product.id, storeTX1.id)).toBe(996)
  })

  // T6 platform NULL→NULL staging is covered by the preserved
  // 'super_admin can transfer from any store' case above (must stay green).

  test('T7 platform NULL→owned transfer is rejected', async () => {
    const product = await makeTransferProduct('T7', categoryTX.id, storeTN.id, 1000)
    const res = await sendTransfer(superAdminToken, storeTN.id, storeTX1.id, product.id)
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('STORE_TENANT_REQUIRED')
  })

  test('T8 platform owned→NULL transfer is rejected', async () => {
    const product = await makeTransferProduct('T8', categoryTX.id, storeTX1.id, 1000)
    const res = await sendTransfer(superAdminToken, storeTX1.id, storeTN.id, product.id)
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('STORE_TENANT_REQUIRED')
  })

  test('T9 platform cross-tenant transfer is rejected', async () => {
    const product = await makeTransferProduct('T9', categoryTX.id, storeTX1.id, 1000)
    const res = await sendTransfer(superAdminToken, storeTX1.id, storeTY1.id, product.id)
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('TENANT_SCOPE_MISMATCH')
  })

  test('T10 nonexistent destination returns 404, never a raw FK 500', async () => {
    const product = await makeTransferProduct('T10', categoryTX.id, storeTX1.id, 1000)
    const res = await sendTransfer(superAdminToken, storeTX1.id, 999999, product.id)
    expect(res.status).toBe(404)
    expect(res.body.message).toBe('Location not found.')
  })

  test('T11 terminal destinations are rejected', async () => {
    const product = await makeTransferProduct('T11', categoryTX.id, storeTX1.id, 1000)
    const retired = await sendTransfer(superAdminToken, storeTX1.id, storeRET.id, product.id)
    expect(retired.status).toBe(422)
    expect(retired.body.code).toBe('STORE_STATUS_IRREVERSIBLE')
    const quarantined = await sendTransfer(superAdminToken, storeTX1.id, storeQUAR.id, product.id)
    expect(quarantined.status).toBe(422)
    expect(quarantined.body.code).toBe('STORE_STATUS_IRREVERSIBLE')
  })

  test('T13 same-tenant receive propagates guarded junctions', async () => {
    const cat = await db.category.create({ name: `G2_C13_${g2stamp()}`, createdBy: superAdminUser.id })
    g2CatIds.push(cat.id)
    await db.category_store.create({ category: cat.id, store: storeTX1.id })
    const product = await makeTransferProduct('T13', cat.id, storeTX1.id, 1000)
    const sent = await sendTransfer(superAdminToken, storeTX1.id, storeTX2.id, product.id)
    expect(sent.status).toBe(201)
    const received = await request(app)
      .put(`/pos/transfer/${sent.body.data.id}/receive`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({})
    expect(received.status).toBe(200)
    expect(
      await db.product_store.count({ where: { product: product.id, store: storeTX2.id } })
    ).toBe(1)
    expect(
      await db.category_store.count({ where: { category: cat.id, store: storeTX2.id } })
    ).toBe(1)
  })

  test('T12 receive revalidates a re-tenanted destination', async () => {
    const product = await makeTransferProduct('T12', categoryTX.id, storeTX1.id, 1000)
    const sent = await sendTransfer(superAdminToken, storeTX1.id, storeTX2.id, product.id)
    expect(sent.status).toBe(201)
    const before = await storeStock(product.id, storeTX2.id).catch(() => 0)
    await db.location.update(
      { tenantId: tenantY.id },
      { where: { id: storeTX2.id }, allowTenantReassignment: true }
    )
    const received = await request(app)
      .put(`/pos/transfer/${sent.body.data.id}/receive`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({})
    expect(received.status).toBe(422)
    expect(received.body.code).toBe('TENANT_SCOPE_MISMATCH')
    expect((await db.stock_transfer.findByPk(sent.body.data.id)).status).toBe('sent')
    expect(await storeStock(product.id, storeTX2.id).catch(() => 0)).toBe(before)
    expect(
      await db.product_store.count({ where: { product: product.id, store: storeTX2.id } })
    ).toBe(0)
    await db.location.update(
      { tenantId: tenantX.id },
      { where: { id: storeTX2.id }, allowTenantReassignment: true }
    )
  })

  test('T14 detached destination is held at sent with no propagation', async () => {
    const product = await makeTransferProduct('T14', categoryTX.id, storeTX1.id, 1000)
    const sent = await sendTransfer(superAdminToken, storeTX1.id, storeTX2.id, product.id)
    expect(sent.status).toBe(201)
    await db.location.update({ tenantId: null }, { where: { id: storeTX2.id } })
    const received = await request(app)
      .put(`/pos/transfer/${sent.body.data.id}/receive`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({})
    expect(received.status).toBe(422)
    expect(received.body.code).toBe('STORE_TENANT_REQUIRED')
    expect((await db.stock_transfer.findByPk(sent.body.data.id)).status).toBe('sent')
    expect(
      await db.product_store.count({ where: { product: product.id, store: storeTX2.id } })
    ).toBe(0)
    expect(
      await db.category_store.count({ where: { category: categoryTX.id, store: storeTX2.id } })
    ).toBe(0)
    await db.location.update({ tenantId: tenantX.id }, { where: { id: storeTX2.id } })
  })
})
