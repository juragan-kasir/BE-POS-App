// Phase 11 — store-price FE<->BE contract alignment.
//
// Canonical GET contract (per item):
//   { id, product, store, storeId, storeName, price }
//   - storeId == store (legacy FK name), storeName from the location
//     association (as: 'storeData'), price = persisted store price.
//
// Canonical UPDATE contract:
//   { productId, storePrices: [ { storeId, price } ] }  (JSON body)
//   - storeId is a numeric store or the literal 'base' sentinel
//     ('base' writes the shared product.price, super_admin only).
//
// These tests drive the controller directly with a mocked db so they are
// deterministic and DB-light (the broader tenant-isolation behaviour is
// already covered by __tests__/security-n2-*.test.js and
// __tests__/security-c11-*.test.js against the real route chain).

jest.mock('../db/models', () => {
  const product = {
    findByPk: jest.fn(),
    update: jest.fn()
  }
  const product_store_price = {
    findAll: jest.fn(),
    findOne: jest.fn(),
    upsert: jest.fn()
  }
  const location = {
    findByPk: jest.fn()
  }
  // Sweep stage 2: the product is sold at store 1.
  const product_store = {
    findAll: jest.fn().mockResolvedValue([{ store: 1 }])
  }
  const sequelize = {
    transaction: jest.fn((cb) => cb({}))
  }
  return { product, product_store_price, product_store, location, sequelize }
})

jest.mock('../utils/auditLog', () => ({
  redactAndAudit: jest.fn(() => Promise.resolve()),
  AUDIT_ACTIONS: { UPDATE: 'UPDATE' }
}))

const posController = require('../api/controller/pos')
const db = require('../db/models')
const { updatePriceByStoreSchema } = require('../api/validation/schemas')

const mockRes = () => {
  const res = { json: jest.fn(), status: jest.fn(() => res) }
  return res
}

const superReq = (body, query = {}) => ({
  user: { roleType: 'super_admin', id: 1 },
  body,
  query
})

beforeEach(() => {
  jest.clearAllMocks()
  db.product.findByPk.mockResolvedValue({ id: 5, nameProduct: 'Kopi', price: 20000 })
  db.product.update.mockResolvedValue({})
  db.product_store_price.findAll.mockResolvedValue([])
  db.product_store_price.findOne.mockResolvedValue(null)
  db.product_store_price.upsert.mockResolvedValue({})
})

describe('GET /pos/product/price-by-store — canonical contract', () => {
  test('serializes storeId + storeName + price from the storeData association and keeps legacy fields', async () => {
    db.product_store_price.findAll.mockResolvedValue([
      {
        id: 301,
        product: 5,
        store: 1,
        price: 25000,
        storeData: { id: 1, name: 'Toko A' }
      },
      {
        id: 302,
        product: 5,
        store: 2,
        price: 26000,
        storeData: { id: 2, name: 'Toko B' }
      }
    ])

    const req = superReq({}, { productId: '5', storeIds: '1,2' })
    const res = mockRes()
    await posController.getPriceByStore(req, res)

    // The query must load the location via the existing association (one
    // include — no N+1 per-row lookups).
    expect(db.product_store_price.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.arrayContaining([
          expect.objectContaining({ as: 'storeData', model: db.location })
        ])
      })
    )

    const { storePrices } = res.json.mock.calls[0][0].data
    expect(storePrices).toHaveLength(2)
    expect(storePrices[0]).toMatchObject({
      id: 301,
      product: 5,
      store: 1,
      storeId: 1,
      storeName: 'Toko A',
      price: 25000
    })
    expect(storePrices[1]).toMatchObject({
      storeId: 2,
      storeName: 'Toko B',
      price: 26000
    })
  })

  test('falls back to an empty storeName when the store is missing', async () => {
    db.product_store_price.findAll.mockResolvedValue([
      { id: 301, product: 5, store: 1, price: 25000, storeData: null }
    ])

    const req = superReq({}, { productId: '5', storeIds: '1' })
    const res = mockRes()
    await posController.getPriceByStore(req, res)

    const { storePrices } = res.json.mock.calls[0][0].data
    expect(storePrices[0].storeId).toBe(1)
    expect(storePrices[0].storeName).toBeNull()
    expect(storePrices[0].price).toBe(25000)
  })

  test('non-super-admin scopes storeIds to their own store before querying', async () => {
    const req = {
      user: { roleType: 'admin', id: 7, store: 1 },
      storeId: 1,
      query: { productId: '5', storeIds: '1,2' }
    }
    const res = mockRes()
    await posController.getPriceByStore(req, res)

    expect(db.product_store_price.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ store: [1] }) })
    )
    expect(res.json).toHaveBeenCalled()
  })
})

describe('PUT /pos/product/update-price-by-store — canonical payload contract', () => {
  // These tests simulate the post-validation req.body where strToNum / coerce
  // have already run (so values are numbers, not strings).
  test('accepts a canonical JSON bulk payload and persists each store price', async () => {
    const req = superReq({
      productId: 5,
      storePrices: [{ storeId: 1, price: 25000 }]
    })
    const res = mockRes()
    await posController.updatePriceByStore(req, res)

    expect(db.product_store_price.upsert).toHaveBeenCalledWith(
      { product: 5, store: 1, price: 25000 },
      expect.objectContaining({ transaction: {} })
    )
    expect(db.product.update).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true })
    )
  })

  test('the base sentinel updates the shared product.price', async () => {
    const product = { id: 5, update: jest.fn().mockResolvedValue({}) }
    db.product.findByPk.mockResolvedValue(product)
    const req = superReq({
      productId: 5,
      storePrices: [{ storeId: 'base', price: 30000 }]
    })
    const res = mockRes()
    await posController.updatePriceByStore(req, res)

    expect(product.update).toHaveBeenCalledWith(
      { price: 30000 },
      expect.objectContaining({ transaction: {} })
    )
    expect(res.status).toHaveBeenCalledWith(200)
  })

  test('rejects requests without productId or an empty storePrices array', async () => {
    let req = superReq({ storePrices: [{ storeId: '1', price: 100 }] })
    let res = mockRes()
    await posController.updatePriceByStore(req, res)
    expect(res.status).toHaveBeenCalledWith(400)

    jest.clearAllMocks()
    req = superReq({ productId: '5', storePrices: [] })
    res = mockRes()
    await posController.updatePriceByStore(req, res)
    expect(res.status).toHaveBeenCalledWith(400)
  })

  test('non-super-admin cannot update foreign stores or the base price', async () => {
    let req = {
      user: { roleType: 'admin', id: 7 },
      storeId: 1,
      body: { productId: '5', storePrices: [{ storeId: '2', price: 99999 }] }
    }
    let res = mockRes()
    await posController.updatePriceByStore(req, res)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(db.product_store_price.upsert).not.toHaveBeenCalled()

    jest.clearAllMocks()
    db.product.findByPk.mockResolvedValue({ id: 5 })
    req = {
      user: { roleType: 'admin', id: 7 },
      storeId: 1,
      body: { productId: '5', storePrices: [{ storeId: 'base', price: 7777 }] }
    }
    res = mockRes()
    await posController.updatePriceByStore(req, res)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(db.product.update).not.toHaveBeenCalled()
  })

  test('returns 404 when the product does not exist', async () => {
    db.product.findByPk.mockResolvedValue(null)
    const req = superReq({
      productId: '999',
      storePrices: [{ storeId: '1', price: 100 }]
    })
    const res = mockRes()
    await posController.updatePriceByStore(req, res)
    expect(res.status).toHaveBeenCalledWith(404)
  })
})

describe('updatePriceByStoreSchema — canonical validation', () => {
  test('accepts the canonical payload and coerces string fields', () => {
    const parsed = updatePriceByStoreSchema.parse({
      productId: '5',
      storePrices: [{ storeId: '1', price: '25000' }]
    })
    expect(parsed.productId).toBe(5)
    expect(parsed.storePrices[0].storeId).toBe(1)
    expect(parsed.storePrices[0].price).toBe(25000)
  })

  test('accepts the base sentinel', () => {
    const parsed = updatePriceByStoreSchema.parse({
      productId: 5,
      storePrices: [{ storeId: 'base', price: 30000 }]
    })
    expect(parsed.storePrices[0].storeId).toBe('base')
  })

  test('rejects a missing productId', () => {
    expect(() =>
      updatePriceByStoreSchema.parse({ storePrices: [{ storeId: '1', price: 100 }] })
    ).toThrow()
  })

  test('rejects a non-array storePrices', () => {
    expect(() =>
      updatePriceByStoreSchema.parse({ productId: 5, storePrices: '1,2' })
    ).toThrow()
  })

  test('rejects an empty storePrices array', () => {
    expect(() =>
      updatePriceByStoreSchema.parse({ productId: 5, storePrices: [] })
    ).toThrow()
  })

  test('rejects an invalid store id', () => {
    expect(() =>
      updatePriceByStoreSchema.parse({
        productId: 5,
        storePrices: [{ storeId: 'abc', price: 100 }]
      })
    ).toThrow()
  })

  test('rejects an invalid (non-numeric) price', () => {
    expect(() =>
      updatePriceByStoreSchema.parse({
        productId: 5,
        storePrices: [{ storeId: '1', price: 'abc' }]
      })
    ).toThrow()
  })
})