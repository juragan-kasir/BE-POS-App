process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')
const { assertDecimalQuantity } = require('../utils/decimalQuantityGuard')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 34 — stock-opname decimal precision remediation.
// stock_opname_item's quantity columns were INTEGER, silently rounding any
// fractional physical count (e.g. "12.5 kg") before it could reach
// product.stock/ingredient.stock, which are already DECIMAL(10,4). This
// file proves the full chain — request validation, persistence, and
// downstream product/ingredient stock propagation — is now decimal-exact.

let location = null
let category = null
let product = null
let ingredient = null
let adminToken = null

beforeAll(async () => {
  location = await db.location.create(await withTestTenant({ name: `OPNAME_DEC_STORE_${Date.now()}`, status: 'active' }))
  category = await db.category.create({ name: `OPNAME_DEC_CATEGORY_${Date.now()}` })
  product = await db.product.create({
    nameProduct: `OPNAME_DEC_PRODUCT_${Date.now()}`,
    category: category.id,
    price: 6000,
    stock: 20,
    unit: 'kg'
  })
  ingredient = await db.ingredient.create({
    store: location.id,
    name: `OPNAME_DEC_ING_${Date.now()}`,
    stock: 100,
    unit: 'g',
    baseUnit: 'g',
    costPrice: 10
  })
  // P1-4: central gate denies unknown caller identities; these rows
  // satisfy the identity invariant. Assertions below are unchanged.
  await db.user.create({
    id: 7402,
    userName: 'admin_opname_decimal',
    email: 'p14-7402-stock-opname-decimal-precision@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: location.id,
    status: 'active',
    fullName: 'admin_opname_decimal'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  adminToken = await signSessionToken(
    { id: 7402, userName: 'admin_opname_decimal', roleType: 'admin', store: location.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.user.destroy({ where: { id: [7402] }, force: true })
  await db.stock_history.destroy({ where: {}, force: true })
  await db.stockOpnameItem.destroy({ where: {}, force: true })
  await db.stockOpname.destroy({ where: { store: location.id }, force: true })
  await db.ingredient.destroy({ where: { id: ingredient?.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

async function createDraft(items, overrides = {}) {
  return request(app)
    .post('/stock-opname/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ store: location.id, status: 'draft', items, ...overrides })
}

async function completeOpname(id) {
  return request(app)
    .patch(`/stock-opname/status/${id}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ status: 'completed' })
}

describe('assertDecimalQuantity (unit boundary — values JSON cannot transport as-is)', () => {
  test('rejects NaN', () => {
    expect(() => assertDecimalQuantity(NaN, 'stokFisikJumlah')).toThrow()
  })
  test('rejects Infinity', () => {
    expect(() => assertDecimalQuantity(Infinity, 'stokFisikJumlah')).toThrow()
  })
  test('rejects -Infinity', () => {
    expect(() => assertDecimalQuantity(-Infinity, 'stokFisikJumlah')).toThrow()
  })
  test('rejects a non-number type', () => {
    expect(() => assertDecimalQuantity('12.5', 'stokFisikJumlah')).toThrow()
    expect(() => assertDecimalQuantity({}, 'stokFisikJumlah')).toThrow()
  })
  test('accepts exactly the DECIMAL(10,4) magnitude boundary', () => {
    expect(assertDecimalQuantity(999999.9999, 'stokFisikJumlah')).toBe(999999.9999)
  })
  test('rejects a value beyond the DECIMAL(10,4) magnitude boundary', () => {
    expect(() => assertDecimalQuantity(1000000, 'stokFisikJumlah')).toThrow()
  })
  test('tolerates floating-point noise from decimal arithmetic without misclassifying precision', () => {
    // 12.5 + 3.25 - 1.5 is exact in binary, but this guards the general case
    // where decimal arithmetic could otherwise carry noise past 4 places.
    expect(assertDecimalQuantity(0.1 + 0.2, 'x')).toBeCloseTo(0.3, 10)
  })
  test('still rejects a genuinely higher-precision value', () => {
    expect(() => assertDecimalQuantity(1.23456, 'stokFisikJumlah')).toThrow()
  })
})

describe('POST /stock-opname/create — decimal quantity persistence (A, C, D, H)', () => {
  test('creates successfully with a fractional stokFisikJumlah and persists it exactly (A, C)', async () => {
    const res = await createDraft([
      {
        product: product.id,
        namaBarang: product.nameProduct,
        satuan: 'kg',
        stokAwalJumlah: 20,
        barangMasukJumlah: 0,
        barangKeluarJumlah: 0,
        stokAkhirJumlah: 20,
        stokFisikJumlah: 12.5,
        selisihJumlah: -7.5
      }
    ])

    expect(res.status).toBe(201)
    const persisted = await db.stockOpnameItem.findOne({ where: { stockOpname: res.body.data.id } })
    expect(Number(persisted.stokFisikJumlah)).toBe(12.5)
    expect(Number(persisted.selisihJumlah)).toBe(-7.5)
  })

  test.each([[12.5], [0.5], [1.25], [12.3456]])(
    'preserves %s exactly through create and read-back (D)',
    async (value) => {
      const res = await createDraft([
        {
          product: product.id,
          namaBarang: product.nameProduct,
          satuan: 'kg',
          stokAwalJumlah: value,
          barangMasukJumlah: 0,
          barangKeluarJumlah: 0,
          stokAkhirJumlah: value,
          stokFisikJumlah: value,
          selisihJumlah: 0
        }
      ])
      expect(res.status).toBe(201)
      const persisted = await db.stockOpnameItem.findOne({ where: { stockOpname: res.body.data.id } })
      expect(Number(persisted.stokAwalJumlah)).toBe(value)
      expect(Number(persisted.stokFisikJumlah)).toBe(value)
    }
  )

  test('accepts the maximum DECIMAL(10,4) magnitude (E)', async () => {
    const res = await createDraft([
      {
        product: product.id,
        namaBarang: product.nameProduct,
        satuan: 'kg',
        stokAwalJumlah: 999999.9999,
        barangMasukJumlah: 0,
        barangKeluarJumlah: 0,
        stokAkhirJumlah: 999999.9999,
        stokFisikJumlah: 999999.9999,
        selisihJumlah: 0
      }
    ])
    expect(res.status).toBe(201)
    const persisted = await db.stockOpnameItem.findOne({ where: { stockOpname: res.body.data.id } })
    expect(Number(persisted.stokFisikJumlah)).toBe(999999.9999)
  })

  test('rejects excess precision beyond 4 decimal places instead of silently rounding (F)', async () => {
    const res = await createDraft([
      {
        product: product.id,
        namaBarang: product.nameProduct,
        satuan: 'kg',
        stokAwalJumlah: 20,
        barangMasukJumlah: 0,
        barangKeluarJumlah: 0,
        stokAkhirJumlah: 20,
        stokFisikJumlah: 1.23456,
        selisihJumlah: -18.76544
      }
    ])
    expect(res.status).toBe(422)
    expect(res.body.success).toBe(false)
  })

  test('rejects a string value for a quantity field (G)', async () => {
    const res = await createDraft([
      {
        product: product.id,
        namaBarang: product.nameProduct,
        satuan: 'kg',
        stokAwalJumlah: 20,
        barangMasukJumlah: 0,
        barangKeluarJumlah: 0,
        stokAkhirJumlah: 20,
        stokFisikJumlah: '12.5',
        selisihJumlah: -7.5
      }
    ])
    expect(res.status).toBe(422)
  })

  test('existing whole-integer values continue to work unchanged (H)', async () => {
    const res = await createDraft([
      {
        product: product.id,
        namaBarang: product.nameProduct,
        stokAkhirJumlah: 20,
        stokFisikJumlah: 15,
        selisihJumlah: -5
      }
    ])
    expect(res.status).toBe(201)
    const persisted = await db.stockOpnameItem.findOne({ where: { stockOpname: res.body.data.id } })
    expect(Number(persisted.stokFisikJumlah)).toBe(15)
    expect(Number(persisted.selisihJumlah)).toBe(-5)
  })

  test('negative selisihJumlah remains accepted (existing behavior, not a new rule)', async () => {
    const res = await createDraft([
      {
        product: product.id,
        namaBarang: product.nameProduct,
        stokAkhirJumlah: 20,
        stokFisikJumlah: 12.5,
        selisihJumlah: -7.5
      }
    ])
    expect(res.status).toBe(201)
  })

  test('a null stokFisikJumlah/selisihJumlah is accepted, not rejected as invalid (existing || 0 persistence contract, unchanged by this batch)', async () => {
    const res = await createDraft([
      {
        product: product.id,
        namaBarang: product.nameProduct,
        stokAkhirJumlah: 20,
        stokFisikJumlah: null,
        selisihJumlah: null
      }
    ])
    // The validator must not reject a null/absent value (it is exempt, per
    // the existing "uncounted draft row" contract) — create() has always
    // coalesced it to 0 at the point of persistence (`item.x || 0`, unchanged
    // by this batch), so the correctly-preserved *request-level* semantic is
    // that this request succeeds, not that the DB row itself stores NULL.
    expect(res.status).toBe(201)
    const persisted = await db.stockOpnameItem.findOne({ where: { stockOpname: res.body.data.id } })
    expect(Number(persisted.stokFisikJumlah)).toBe(0)
  })

  test('the exact worked example 12.5 + 3.25 - 1.5 = 14.25 round-trips exactly (I)', async () => {
    const res = await createDraft([
      {
        product: product.id,
        namaBarang: product.nameProduct,
        stokAwalJumlah: 12.5,
        barangMasukJumlah: 3.25,
        barangKeluarJumlah: 1.5,
        stokAkhirJumlah: 12.5 + 3.25 - 1.5,
        stokFisikJumlah: 14.25,
        selisihJumlah: 0
      }
    ])
    expect(res.status).toBe(201)
    const persisted = await db.stockOpnameItem.findOne({ where: { stockOpname: res.body.data.id } })
    expect(Number(persisted.stokAkhirJumlah)).toBe(14.25)
  })
})

describe('PUT /stock-opname/update/:id — decimal quantity persistence (B)', () => {
  test('updating a draft with a decimal quantity persists the new exact value', async () => {
    const createRes = await createDraft([
      {
        product: product.id,
        namaBarang: product.nameProduct,
        stokAkhirJumlah: 20,
        stokFisikJumlah: 20,
        selisihJumlah: 0
      }
    ])
    expect(createRes.status).toBe(201)

    const updateRes = await request(app)
      .put(`/stock-opname/update/${createRes.body.data.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        items: [
          {
            product: product.id,
            namaBarang: product.nameProduct,
            stokAkhirJumlah: 20,
            stokFisikJumlah: 12.5,
            selisihJumlah: -7.5
          }
        ]
      })
    expect(updateRes.status).toBe(200)

    const persisted = await db.stockOpnameItem.findOne({
      where: { stockOpname: createRes.body.data.id }
    })
    expect(Number(persisted.stokFisikJumlah)).toBe(12.5)
  })

  test('rejects excess precision on update the same way as create', async () => {
    const createRes = await createDraft([
      {
        product: product.id,
        namaBarang: product.nameProduct,
        stokAkhirJumlah: 20,
        stokFisikJumlah: 20,
        selisihJumlah: 0
      }
    ])
    expect(createRes.status).toBe(201)

    const updateRes = await request(app)
      .put(`/stock-opname/update/${createRes.body.data.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        items: [
          {
            product: product.id,
            namaBarang: product.nameProduct,
            stokAkhirJumlah: 20,
            stokFisikJumlah: 1.23456,
            selisihJumlah: 0
          }
        ]
      })
    expect(updateRes.status).toBe(422)
  })
})

describe('Downstream stock propagation preserves decimals (J, K)', () => {
  test('completing a decimal opname sets product.stock to the exact counted value (catches the Math.trunc regression)', async () => {
    const createRes = await createDraft([
      {
        product: product.id,
        namaBarang: product.nameProduct,
        stokAkhirJumlah: 20,
        stokFisikJumlah: 12.5,
        selisihJumlah: -7.5
      }
    ])
    expect(createRes.status).toBe(201)

    const completeRes = await completeOpname(createRes.body.data.id)
    expect(completeRes.status).toBe(200)

    const fresh = await db.product.findByPk(product.id)
    expect(Number(fresh.stock)).toBe(12.5)

    const history = await db.stock_history.findAll({
      where: { product: product.id, referenceType: 'opname' },
      order: [['id', 'DESC']],
      limit: 1
    })
    expect(Number(history[0].quantityAfter)).toBe(12.5)
  })

  test('completing a decimal ingredient opname sets ingredient.stock to the exact counted value', async () => {
    const createRes = await createDraft([
      {
        ingredientName: ingredient.name,
        namaBarang: ingredient.name,
        satuan: 'g',
        stokFisikJumlah: 87.25,
        selisihJumlah: -12.75
      }
    ])
    expect(createRes.status).toBe(201)

    const completeRes = await completeOpname(createRes.body.data.id)
    expect(completeRes.status).toBe(200)

    const fresh = await db.ingredient.findByPk(ingredient.id)
    expect(Number(fresh.stock)).toBe(87.25)
  })
})

describe('Excel export sanity (M)', () => {
  test('exporting a decimal-valued opname does not error and returns a workbook', async () => {
    const createRes = await createDraft([
      {
        product: product.id,
        namaBarang: product.nameProduct,
        stokAkhirJumlah: 20,
        stokFisikJumlah: 12.5,
        selisihJumlah: -7.5
      }
    ])
    expect(createRes.status).toBe(201)

    const exportRes = await request(app)
      .post('/stock-opname/export-selected')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ids: [createRes.body.data.id] })

    expect(exportRes.status).toBe(200)
    expect(exportRes.headers['content-type']).toMatch(/spreadsheet/)
    expect(Number(exportRes.headers['content-length'])).toBeGreaterThan(0)
  })
})
