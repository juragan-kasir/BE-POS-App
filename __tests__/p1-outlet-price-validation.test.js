// P1 Outlet Pricing Hardening: Fix B — Outlet Price Write Validation
//
// Regression tests covering invalid outlet-price acceptance in updatePriceByStore.
// The defect: schema coerces invalid prices (negative, fractional, unsafe integers).
// Base price of 0 is skipped due to truthiness check.
//
// Required behavior:
// - Price must be numeric integer, >= 0, <= 2147483647 (PostgreSQL INTEGER max).
// - Reject negative, fractional, null, boolean, non-numeric strings, unsafe integers.
// - Preserve explicit zero as valid.
// - Audit must record prior and new price.
// - Invalid requests must not reach database.

jest.mock('../db/models', () => ({
  product: {
    findByPk: jest.fn().mockImplementation(() => {
      return {
        update: jest.fn()
      }
    }),
    update: jest.fn()
  },
  product_store_price: {
    findOne: jest.fn(),
    upsert: jest.fn()
  },
  location: {
    findByPk: jest.fn().mockResolvedValue(null)
  },
  sequelize: {
    transaction: jest.fn((cb) => cb({}))
  }
}))

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

const superReq = (body) => ({
  user: { roleType: 'super_admin', id: 1 },
  body
})

beforeEach(() => {
  jest.clearAllMocks()
  const mockProductInstance = {
    id: 5,
    nameProduct: 'Kopi',
    price: 20000,
    update: jest.fn()
  }
  db.product.findByPk.mockResolvedValue(mockProductInstance)
  db.product.update.mockResolvedValue({})
  db.product_store_price.findOne.mockResolvedValue(null)
  db.product_store_price.upsert.mockResolvedValue({})
})

describe('updatePriceByStore — price validation', () => {
  test('valid zero price on outlet → persisted', async () => {
    const req = superReq({
      productId: 5,
      storePrices: [{ storeId: 1, price: 0 }]
    })
    const res = mockRes()

    await posController.updatePriceByStore(req, res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(db.product_store_price.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ price: 0 }),
      expect.anything()
    )
  })

  test('valid positive integer → persisted', async () => {
    const req = superReq({
      productId: 5,
      storePrices: [{ storeId: 1, price: 15000 }]
    })
    const res = mockRes()

    await posController.updatePriceByStore(req, res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(db.product_store_price.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ price: 15000 }),
      expect.anything()
    )
  })

  test('negative integer → schema rejects', () => {
    expect(() => {
      updatePriceByStoreSchema.parse({
        productId: 5,
        storePrices: [{ storeId: 1, price: -100 }]
      })
    }).toThrow()
  })

  test('fractional value → schema rejects', () => {
    expect(() => {
      updatePriceByStoreSchema.parse({
        productId: 5,
        storePrices: [{ storeId: 1, price: 100.5 }]
      })
    }).toThrow()
  })

  test('empty string → schema rejects', () => {
    expect(() => {
      updatePriceByStoreSchema.parse({
        productId: 5,
        storePrices: [{ storeId: 1, price: '' }]
      })
    }).toThrow()
  })

  test('null price → schema rejects', () => {
    expect(() => {
      updatePriceByStoreSchema.parse({
        productId: 5,
        storePrices: [{ storeId: 1, price: null }]
      })
    }).toThrow()
  })

  test('boolean true → schema rejects', () => {
    expect(() => {
      updatePriceByStoreSchema.parse({
        productId: 5,
        storePrices: [{ storeId: 1, price: true }]
      })
    }).toThrow()
  })

  test('boolean false → schema rejects', () => {
    expect(() => {
      updatePriceByStoreSchema.parse({
        productId: 5,
        storePrices: [{ storeId: 1, price: false }]
      })
    }).toThrow()
  })

  test('non-numeric string → schema rejects', () => {
    expect(() => {
      updatePriceByStoreSchema.parse({
        productId: 5,
        storePrices: [{ storeId: 1, price: 'abc' }]
      })
    }).toThrow()
  })

  test('max technical bound (2147483647) → accepted', () => {
    const parsed = updatePriceByStoreSchema.parse({
      productId: 5,
      storePrices: [{ storeId: 1, price: 2147483647 }]
    })
    expect(parsed.storePrices[0].price).toBe(2147483647)
  })

  test('value above max (2147483648) → schema rejects', () => {
    expect(() => {
      updatePriceByStoreSchema.parse({
        productId: 5,
        storePrices: [{ storeId: 1, price: 2147483648 }]
      })
    }).toThrow()
  })

  test('unsafe integer (Number.MAX_SAFE_INTEGER + 1) → schema rejects', () => {
    expect(() => {
      updatePriceByStoreSchema.parse({
        productId: 5,
        storePrices: [{ storeId: 1, price: Number.MAX_SAFE_INTEGER + 1 }]
      })
    }).toThrow()
  })

  test('base price zero → persisted (not skipped by truthiness)', async () => {
    const req = superReq({
      productId: 5,
      storePrices: [{ storeId: 'base', price: 0 }]
    })
    const res = mockRes()

    await posController.updatePriceByStore(req, res)

    const productInstance = await db.product.findByPk.mock.results[0].value
    expect(res.status).toHaveBeenCalledWith(200)
    expect(productInstance.update).toHaveBeenCalledWith(
      expect.objectContaining({ price: 0 }),
      expect.anything()
    )
  })

  test('invalid request → no database mutation', async () => {
    const req = superReq({
      productId: 5,
      storePrices: [{ storeId: 1, price: -100 }]
    })
    const res = mockRes()

    try {
      await posController.updatePriceByStore(req, res)
    } catch {
      // Schema validation fails before controller
    }

    expect(db.product.update).not.toHaveBeenCalled()
    expect(db.product_store_price.upsert).not.toHaveBeenCalled()
  })
})
