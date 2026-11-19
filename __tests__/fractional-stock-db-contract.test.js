process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

describe('TDD DB DECIMAL contract - fractional stock', () => {
  let cat
  beforeAll(async () => {
    cat = await db.category.create({ name: 'FRAC_DB_CAT' })
  })
  afterAll(async () => {
    await db.category.destroy({ where: { id: cat.id }, force: true })
  })
  test('product.stock stores 1.5 and 1.2345', async () => {
    const p = await db.product.create({ nameProduct: 'FRAC_DB_PROD', category: cat.id, price: 100, stock: 0 })
    await p.update({ stock: 1.5 })
    const fresh = await db.product.findByPk(p.id)
    expect(Number(fresh.stock)).toBeCloseTo(1.5, 4)
    await p.update({ stock: 1.2345 })
    const fresh2 = await db.product.findByPk(p.id)
    expect(Number(fresh2.stock)).toBeCloseTo(1.2345, 4)
    await db.product.destroy({ where: { id: p.id }, force: true })
  })
  test('ingredient.stock stores 1.5', async () => {
    const loc = await db.location.create(await withTestTenant({ name: 'FRAC_DB_LOC', status: 'active' }))
    const ing = await db.ingredient.create({ store: loc.id, name: 'FRAC_DB_ING', stock: 0, unit: 'kg' })
    await ing.update({ stock: 1.5 })
    const fresh = await db.ingredient.findByPk(ing.id)
    expect(Number(fresh.stock)).toBeCloseTo(1.5, 4)
    await db.ingredient.destroy({ where: { id: ing.id }, force: true })
    await db.location.destroy({ where: { id: loc.id }, force: true })
  })
  test('stock_history preserves 1.5', async () => {
    const sh = await db.stock_history.create({ store: 1, referenceType: 'adjustment', quantityBefore: 10, quantityChange: 1.5, quantityAfter: 11.5, unit: 'kg' })
    const fresh = await db.stock_history.findByPk(sh.id)
    expect(Number(fresh.quantityBefore)).toBeCloseTo(10, 4)
    expect(Number(fresh.quantityChange)).toBeCloseTo(1.5, 4)
    expect(Number(fresh.quantityAfter)).toBeCloseTo(11.5, 4)
    await db.stock_history.destroy({ where: { id: sh.id }, force: true })
  })
  test('non-negative constraint remains for product stock', async () => {
    const p = await db.product.create({ nameProduct: 'FRAC_DB_NEG', category: cat.id, price: 100, stock: 0 })
    await expect(p.update({ stock: -1 })).rejects.toThrow()
    await db.product.destroy({ where: { id: p.id }, force: true })
  })
})
