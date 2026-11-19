process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')
const {
  adjustProductStock,
  setProductStock
} = require('../api/service/stockMutationService')

let location = null
let category = null

beforeAll(async () => {
  location = await db.location.create(await withTestTenant({ name: 'STOCKMUT_STORE', status: 'active' }))
  category = await db.category.create({ name: 'STOCKMUT_CATEGORY' })
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed the rate
  // for sale-style decrements in this suite.
  await db.taxConfig.create({
    name: 'STOCKMUT_PPN',
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: location.id
  })
})

afterAll(async () => {
  await db.taxConfig.destroy({ where: { store: location?.id }, force: true })
  await db.stock_history.destroy({ where: {}, force: true })
  await db.product_store_stock.destroy({ where: { store: location.id }, force: true })
  await db.product.destroy({ where: { category: category.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

describe('adjustProductStock', () => {
  test('applies a positive delta and writes an accurate audit row', async () => {
    const product = await db.product.create({
      nameProduct: 'SM_INC', category: category.id, price: 1000, stock: 10
    })
    await db.product_store_stock.create({ product: product.id, store: location.id, stock: 10 })

    await db.sequelize.transaction(async (t) => {
      const result = await adjustProductStock({
        productId: product.id,
        store: location.id,
        deltaQty: 5,
        referenceType: 'purchase',
        transaction: t
      })
      expect(Number(result.quantityBefore)).toBe(10)
      expect(Number(result.quantityAfter)).toBe(15)
    })

    const after = await db.product.findByPk(product.id)
    expect(Number(after.stock)).toBe(15)
    const storeStock = await db.product_store_stock.findOne({
      where: { product: product.id, store: location.id }
    })
    expect(Number(storeStock.stock)).toBe(15)
    const history = await db.stock_history.findAll({ where: { product: product.id } })
    expect(history.length).toBe(1)
    expect(Number(history[0].quantityBefore)).toBe(10)
    expect(Number(history[0].quantityAfter)).toBe(15)
    expect(Number(history[0].quantityChange)).toBe(5)
  })

  test('floors a negative delta at zero instead of going negative', async () => {
    const product = await db.product.create({
      nameProduct: 'SM_FLOOR', category: category.id, price: 1000, stock: 3
    })

    await db.sequelize.transaction(async (t) => {
      const result = await adjustProductStock({
        productId: product.id,
        deltaQty: -10,
        referenceType: 'adjustment',
        transaction: t
      })
      expect(Number(result.quantityAfter)).toBe(0)
    })

    const after = await db.product.findByPk(product.id)
    expect(Number(after.stock)).toBe(0)
  })

  test('requires an explicit transaction', async () => {
    await expect(
      adjustProductStock({ productId: 1, deltaQty: 1, referenceType: 'adjustment' })
    ).rejects.toThrow(/transaction/)
  })

  test('two concurrent adjustments to the same product: neither delta is lost', async () => {
    const product = await db.product.create({
      nameProduct: 'SM_RACE', category: category.id, price: 1000, stock: 0
    })

    await Promise.all([
      db.sequelize.transaction((t) =>
        adjustProductStock({
          productId: product.id,
          deltaQty: 5,
          referenceType: 'purchase',
          transaction: t
        })
      ),
      db.sequelize.transaction((t) =>
        adjustProductStock({
          productId: product.id,
          deltaQty: 3,
          referenceType: 'purchase',
          transaction: t
        })
      )
    ])

    const after = await db.product.findByPk(product.id)
    expect(Number(after.stock)).toBe(8)
  })

  // Phase 34: adjustProductStock's other direct callers (goods receipt,
  // purchase return) are intentionally untouched by the stock-opname
  // decimal remediation — the new allowFractional flag defaults to false,
  // so a fractional deltaQty is still truncated exactly as before unless a
  // caller explicitly opts in (only setProductStock does).
  test('still truncates a fractional deltaQty by default (unrelated callers unaffected)', async () => {
    const product = await db.product.create({
      nameProduct: 'SM_TRUNC_DEFAULT', category: category.id, price: 1000, stock: 10
    })

    await db.sequelize.transaction((t) =>
      adjustProductStock({
        productId: product.id,
        deltaQty: 2.9,
        referenceType: 'purchase',
        transaction: t
      })
    )

    const after = await db.product.findByPk(product.id)
    expect(Number(after.stock)).toBe(12)
  })

  test('preserves a fractional deltaQty when allowFractional is explicitly set', async () => {
    const product = await db.product.create({
      nameProduct: 'SM_TRUNC_OPTIN', category: category.id, price: 1000, stock: 10
    })

    await db.sequelize.transaction((t) =>
      adjustProductStock({
        productId: product.id,
        deltaQty: 2.9,
        referenceType: 'adjustment',
        transaction: t,
        allowFractional: true
      })
    )

    const after = await db.product.findByPk(product.id)
    expect(Number(after.stock)).toBe(12.9)
  })
})

describe('setProductStock', () => {
  test('Phase 34: preserves a fractional newQty exactly (the stock-opname path no longer truncates)', async () => {
    const product = await db.product.create({
      nameProduct: 'SM_SET_DECIMAL', category: category.id, price: 1000, stock: 20
    })

    await db.sequelize.transaction((t) =>
      setProductStock({
        productId: product.id,
        newQty: 12.5,
        referenceType: 'adjustment',
        transaction: t
      })
    )

    const after = await db.product.findByPk(product.id)
    expect(Number(after.stock)).toBe(12.5)
  })

  test('computes the delta against the current value and writes an accurate audit row', async () => {
    const product = await db.product.create({
      nameProduct: 'SM_SET', category: category.id, price: 1000, stock: 20
    })

    await db.sequelize.transaction((t) =>
      setProductStock({
        productId: product.id,
        newQty: 33,
        referenceType: 'adjustment',
        transaction: t
      })
    )

    const after = await db.product.findByPk(product.id)
    expect(Number(after.stock)).toBe(33)
    const history = await db.stock_history.findAll({
      where: { product: product.id },
      order: [['id', 'DESC']],
      limit: 1
    })
    expect(Number(history[0].quantityBefore)).toBe(20)
    expect(Number(history[0].quantityAfter)).toBe(33)
    expect(Number(history[0].quantityChange)).toBe(13)
  })

  test('a concurrent sale-style decrement during a stock-count commit is not silently overwritten', async () => {
    // This is the exact race the audit flagged: an opname/manual "set to
    // counted value" racing a concurrent sale's atomic decrement. Before
    // this helper, an absolute overwrite computed from a stale pre-count
    // read could clobber the sale's effect entirely. setProductStock must
    // compute its delta against the freshly LOCKED value, so the sale's
    // decrement is preserved underneath the count's correction.
    const product = await db.product.create({
      nameProduct: 'SM_OPNAME_RACE', category: category.id, price: 1000, stock: 50
    })

    // "Counted 44 units" — decided based on a read taken before this
    // commits, while a concurrent sale of 5 units is also in flight. (44,
    // not 45: with 45 the sale-first ordering leaves a zero delta, so the
    // count writes no history row and the assertions below became
    // order-dependent — the suite failed intermittently in full runs.)
    await Promise.all([
      db.sequelize.transaction((t) =>
        setProductStock({
          productId: product.id,
          newQty: 44,
          referenceType: 'adjustment',
          transaction: t
        })
      ),
      db.sequelize.transaction((t) =>
        adjustProductStock({
          productId: product.id,
          deltaQty: -5,
          referenceType: 'sale',
          transaction: t
        })
      )
    ])

    const after = await db.product.findByPk(product.id)
    // Whichever ran second sees the other's committed change under its
    // lock and applies its own delta on top of it — the two operations
    // together represent "counted 44, then a 5-unit sale happened" (39)
    // or "sale of 5 from 50 leaves 45, then the count says 44" (44),
    // depending on ordering — but NEVER a stale value that ignores one
    // side entirely, and never negative.
    expect([39, 44]).toContain(Number(after.stock));
    expect(Number(after.stock)).toBeGreaterThanOrEqual(0)

    const history = await db.stock_history.findAll({
      where: { product: product.id },
      order: [['id', 'ASC']]
    })
    expect(history.length).toBe(2)
    // The second entry's "before" must equal the first entry's "after" —
    // proof the second operation read the first's committed result under
    // its own lock, not a stale pre-transaction snapshot.
    expect(Number(history[1].quantityBefore)).toBe(Number(history[0].quantityAfter))
    expect(Number(history[1].quantityAfter)).toBe(Number(after.stock))
  })
})

describe('setProductStock across multiple outlets', () => {
  test('counts one outlet against its own stock and moves the aggregate by that delta', async () => {
    const storeB = await db.location.create(await withTestTenant({ name: 'STOCKMUT_STORE_B', status: 'active' }))
    const product = await db.product.create({
      nameProduct: 'SM_MULTI_OUTLET', category: category.id, price: 1000, stock: 20
    })
    await db.product_store_stock.bulkCreate([
      { product: product.id, store: location.id, stock: 10 },
      { product: product.id, store: storeB.id, stock: 10 }
    ])

    // Counted 5.5 at outlet A. Regression: the old implementation compared
    // 5.5 against the aggregate (20) and applied a -14.5 delta to outlet A,
    // flooring it to 0 while leaving outlet B untouched.
    await db.sequelize.transaction((t) =>
      setProductStock({
        productId: product.id,
        store: location.id,
        newQty: 5.5,
        referenceType: 'opname',
        transaction: t
      })
    )

    const outletA = await db.product_store_stock.findOne({
      where: { product: product.id, store: location.id }
    })
    const outletB = await db.product_store_stock.findOne({
      where: { product: product.id, store: storeB.id }
    })
    const aggregate = await db.product.findByPk(product.id)

    expect(Number(outletA.stock)).toBeCloseTo(5.5, 4)
    expect(Number(outletB.stock)).toBe(10)
    expect(Number(aggregate.stock)).toBeCloseTo(15.5, 4)

    await db.stock_history.destroy({ where: { product: product.id }, force: true })
    await db.product_store_stock.destroy({ where: { product: product.id }, force: true })
    await db.product.destroy({ where: { id: product.id }, force: true })
    await db.location.destroy({ where: { id: storeB.id }, force: true })
  })
})
