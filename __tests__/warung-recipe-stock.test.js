process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// Warung bakso inventory MVP: the owner's actual menu, configured through
// the real authoring endpoints (opening stock via /ingredient/adjust-stock,
// recipes via /bom/add), sold through the real counter checkout
// (/order/create). Every assertion reads persisted ingredient stock and
// stock_history rows, not helper return values.
//
// Fixture decisions (owner confirmation still PENDING — see report):
//   - "Bakso halus" and "bakso polos" are ONE stock item (the owner's stock
//     note counts them on a single line: "Bakso polos/halus 83").
//   - MIE AYAM CHEESE: only Mie is active; cheese quantity is unconfirmed,
//     so cheese is NOT deducted.
//   - MISO TELUR: "1 x 4" is unresolved, so its recipe (1 of each per
//     portion, never ×4) is authored as DRAFT and cannot be sold until the
//     owner confirms and an admin activates it.

const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const ADMIN_A = 9761
const KASIR_A = 9762
const ADMIN_B = 9763

let storeA = null
let storeB = null
let category = null
let tokenAdminA = null
let tokenKasirA = null
let tokenAdminB = null
let seq = 0
const tag = (s) => `WRS-${Date.now()}-${++seq}-${s}`

// Business-facing ingredient key -> persisted ingredient row (store A).
const ING = {}
// Menu name -> product row (store A).
const MENU = {}

const OPENING = {
  halus: 83, // "Bakso polos/halus 83 pcs"
  urat: 30,
  telur: 12,
  mie: 144,
  ceker: 10,
  keju: 10
}

// Owner's recipe notes, per portion, in individual pieces.
const RECIPES = {
  'BAKSO URAT': { halus: 2, urat: 2 },
  'URAT KSG': { urat: 2, halus: 3 },
  'BAKSO HALUS': { halus: 5 },
  'HALUS KSG': { halus: 6 },
  'BAKSO TELUR': { telur: 2, halus: 2 },
  'TELUR KSG': { telur: 2, halus: 3 },
  'BAKSO KOMPLIT': { telur: 1, urat: 1, halus: 2 },
  'MIE AYAM': { mie: 1 },
  'MIE AYAM CEKER': { mie: 1, ceker: 1 },
  // cheese pending owner confirmation -> not part of the active recipe
  'MIE AYAM CHEESE': { mie: 1 },
  'MIE AYAM CHILLI': { mie: 1 },
  'MISO URAT': { urat: 1, halus: 1, mie: 1 },
  'MISO HALUS': { halus: 3, mie: 1 },
  'MISO TELUR': { telur: 1, halus: 1, mie: 1 }
}
const PENDING_NOTES = {
  'MIE AYAM CHEESE': 'PENDING KONFIRMASI: jumlah keju per porsi belum dikonfirmasi pemilik — keju belum dipotong',
  'MISO URAT': 'PENDING KONFIRMASI: "halus" vs "polos" — dipetakan ke Bakso Halus/Polos',
  'MISO TELUR': 'PENDING KONFIRMASI: catatan "1 x 4" — dibaca 1 per porsi'
}
// Recipes whose interpretation is unresolved stay draft (never deduct).
const DRAFT_RECIPES = new Set(['MISO TELUR'])

const auth = (token) => ({ Authorization: `Bearer ${token}` })

const adjust = (token, id, body) =>
  request(app).put(`/ingredient/adjust-stock/${id}`).set(auth(token)).send(body)

const sell = (lines, extra = {}) =>
  request(app)
    .post('/order/create')
    .set(auth(tokenAdminA))
    .send(
      withIdempotencyKey({
        store: storeA.id,
        items: lines.map(([menu, quantity]) => ({ product: MENU[menu].id, quantity })),
        paymentMethod: 'cash',
        cashierName: 'Warung Test',
        ...extra
      })
    )

const stockOf = async (key) => Number((await db.ingredient.findByPk(ING[key].id)).stock)

const snapshot = async () => {
  const out = {}
  for (const key of Object.keys(ING)) out[key] = await stockOf(key)
  return out
}

// Persisted per-ingredient movement of one order's 'sale' rows.
const saleMovement = async (orderId) => {
  const rows = await db.stock_history.findAll({
    where: { referenceType: 'sale', referenceId: orderId, ingredient: Object.values(ING).map((i) => i.id) }
  })
  const byKey = {}
  for (const row of rows) {
    const key = Object.keys(ING).find((k) => ING[k].id === row.ingredient)
    byKey[key] = (byKey[key] || 0) + Number(row.quantityChange)
  }
  return byKey
}

const expectedConsumption = (lines) => {
  const out = {}
  for (const [menu, qty] of lines) {
    for (const [key, perPortion] of Object.entries(RECIPES[menu])) {
      out[key] = (out[key] || 0) - perPortion * qty
    }
  }
  return out
}

// Sells, then proves stock moved by exactly the recipe amounts — for every
// tracked ingredient, so an unexpected deduction (e.g. cheese) also fails.
const sellAndAssert = async (lines) => {
  const before = await snapshot()
  const res = await sell(lines)
  expect(res.status).toBe(201)
  const expected = expectedConsumption(lines)
  const after = await snapshot()
  for (const key of Object.keys(ING)) {
    expect({ key, change: after[key] - before[key] }).toEqual({ key, change: expected[key] || 0 })
  }
  expect(await saleMovement(res.body.data.id)).toEqual(expected)
  return res
}

beforeAll(async () => {
  storeA = await db.location.create({ name: 'WRS_WARUNG_A', status: 'active' })
  storeB = await db.location.create({ name: 'WRS_WARUNG_B', status: 'active' })
  category = await db.category.create({ name: 'WRS_MENU' })
  await db.user.bulkCreate([
    { id: ADMIN_A, userName: 'wrs_admin_a', email: 'wrs-admin-a@test.com', roleType: 'admin', userType: 'admin', store: storeA.id, status: 'active', fullName: 'wrs_admin_a' },
    { id: KASIR_A, userName: 'wrs_kasir_a', email: 'wrs-kasir-a@test.com', roleType: 'kasir', userType: 'user', store: storeA.id, status: 'active', fullName: 'wrs_kasir_a' },
    { id: ADMIN_B, userName: 'wrs_admin_b', email: 'wrs-admin-b@test.com', roleType: 'admin', userType: 'admin', store: storeB.id, status: 'active', fullName: 'wrs_admin_b' }
  ])
  tokenAdminA = await signSessionToken({ id: ADMIN_A, userName: 'wrs_admin_a', roleType: 'admin', store: storeA.id }, JWT_SECRET)
  tokenKasirA = await signSessionToken({ id: KASIR_A, userName: 'wrs_kasir_a', roleType: 'kasir', store: storeA.id }, JWT_SECRET)
  tokenAdminB = await signSessionToken({ id: ADMIN_B, userName: 'wrs_admin_b', roleType: 'admin', store: storeB.id }, JWT_SECRET)
  for (const s of [storeA, storeB]) {
    await db.taxConfig.create({ name: `WRS_PPN_${s.id}`, rate: 11, type: 'ppn', status: 'active', store: s.id })
  }
  await db.cashRegister.create({ store: storeA.id, user: ADMIN_A, status: 'open', openingBalance: 0, openedAt: new Date() })

  // Ingredients through the real create endpoint, no stock entered yet.
  const names = {
    halus: 'Bakso Halus/Polos',
    urat: 'Bakso Urat',
    telur: 'Bakso Telur',
    mie: 'Mie',
    ceker: 'Ceker',
    keju: 'Keju (Cheese)'
  }
  for (const [key, name] of Object.entries(names)) {
    const res = await request(app)
      .post('/ingredient/add')
      .set(auth(tokenAdminA))
      .send({ name: tag(name), unit: 'pcs', baseUnit: 'pcs', status: 'active' })
    expect(res.status).toBe(201)
    ING[key] = res.body.data
  }

  // Menu products: recipe-driven (make_to_order), recipes via /bom/add.
  for (const [menu, recipe] of Object.entries(RECIPES)) {
    MENU[menu] = await db.product.create({
      nameProduct: tag(menu),
      category: category.id,
      price: 15000,
      stock: 0,
      inventoryMode: 'make_to_order'
    })
    const res = await request(app)
      .post('/bom/add')
      .set(auth(tokenAdminA))
      .send({
        productId: MENU[menu].id,
        name: `Resep ${menu}`,
        notes: PENDING_NOTES[menu] || '',
        status: DRAFT_RECIPES.has(menu) ? 'draft' : 'active',
        lines: Object.entries(recipe).map(([key, qty]) => ({ ingredientId: ING[key].id, qty, unit: 'pcs' }))
      })
    expect(res.status).toBe(201)
  }
})

afterAll(async () => {
  const stores = [storeA?.id, storeB?.id].filter(Boolean)
  const orderIds = (await db.order.findAll({ where: { store: stores }, attributes: ['id'] })).map((o) => o.id)
  await db.stock_history.destroy({ where: { store: stores }, force: true })
  const boms = await db.bom_header.findAll({ where: { store: stores }, paranoid: false })
  await db.bom_line.destroy({ where: { bomHeaderId: boms.map((b) => b.id) }, force: true })
  await db.bom_header.destroy({ where: { store: stores }, force: true })
  await db.order_item.destroy({ where: { order: orderIds }, force: true })
  await db.transaction.destroy({ where: { order: orderIds }, force: true })
  await db.order_status.destroy({ where: { order: orderIds }, force: true })
  await db.order.destroy({ where: { id: orderIds }, force: true })
  await db.table.destroy({ where: { store: stores }, force: true })
  await db.cashRegister.destroy({ where: { store: stores }, force: true })
  await db.taxConfig.destroy({ where: { store: stores }, force: true })
  await db.product_store_stock.destroy({ where: { store: stores }, force: true })
  const products = await db.product.findAll({ where: { category: category.id }, attributes: ['id'] })
  await db.best_selling.destroy({ where: { productId: products.map((p) => p.id) }, force: true })
  await db.product.destroy({ where: { category: category.id }, force: true })
  await db.ingredient.destroy({ where: { store: stores }, force: true, paranoid: false })
  await db.user.destroy({ where: { id: [ADMIN_A, KASIR_A, ADMIN_B] }, force: true })
  await db.category.destroy({ where: { id: category.id }, force: true })
  await db.location.destroy({ where: { id: stores }, force: true })
})

describe('opening stock — unknown is never a verified zero', () => {
  test('a newly created ingredient with no stock entered is reported as not initialized', async () => {
    const res = await request(app).get(`/ingredient/get-by-id/${ING.halus.id}`).set(auth(tokenAdminA))
    expect(res.status).toBe(200)
    expect(Number(res.body.data.stock)).toBe(0)
    expect(res.body.data.openingStockRecorded).toBe(false)
    expect(res.body.data.stockState).toBe('uninitialized')
    expect(res.body.data.lastStockRecordedAt).toBeNull()
  })

  test('a legacy non-zero stock with no recorded event stays visible as unverified, never hidden as zero', async () => {
    const legacy = await db.ingredient.create({
      store: storeA.id,
      name: tag('Legacy stock'),
      stock: 42,
      unit: 'pcs',
      baseUnit: 'pcs',
      status: 'active'
    })
    const res = await request(app).get(`/ingredient/get-by-id/${legacy.id}`).set(auth(tokenAdminA))
    expect(res.status).toBe(200)
    expect(Number(res.body.data.stock)).toBe(42)
    expect(res.body.data.openingStockRecorded).toBe(false)
    expect(res.body.data.stockState).toBe('unrecorded')
  })

  test('an uninitialized ingredient refuses a sale instead of going negative or guessing', async () => {
    const before = await snapshot()
    const res = await sell([['BAKSO URAT', 1]])
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('INGREDIENT_STOCK_CONFLICT')
    expect(await snapshot()).toEqual(before)
  })

  test('opening stock is entered through the authorized adjust-stock workflow and recorded in the ledger', async () => {
    for (const [key, qty] of Object.entries(OPENING)) {
      const res = await adjust(tokenAdminA, ING[key].id, { type: 'set', quantity: qty, notes: 'Stok awal demo' })
      expect(res.status).toBe(200)
      expect(res.body.data.quantityBefore).toBe(0)
      expect(res.body.data.quantityAfter).toBe(qty)
      expect(await stockOf(key)).toBe(qty)
      const rows = await db.stock_history.findAll({ where: { ingredient: ING[key].id, referenceType: 'adjustment' } })
      expect(rows).toHaveLength(1)
      expect(Number(rows[0].quantityChange)).toBe(qty)
      expect(rows[0].store).toBe(storeA.id)
      expect(rows[0].createdBy).toBe(ADMIN_A)
      expect(rows[0].notes).toBe('Stok awal demo')
    }
    const list = await request(app).get('/ingredient/get-all?limit=50').set(auth(tokenAdminA))
    const ours = list.body.data.filter((i) => Object.values(ING).some((x) => x.id === i.id))
    expect(ours).toHaveLength(6)
    expect(ours.every((i) => i.openingStockRecorded === true)).toBe(true)
  })

  test('a counted zero is recorded (distinct from never entered)', async () => {
    const created = await request(app)
      .post('/ingredient/add')
      .set(auth(tokenAdminA))
      .send({ name: tag('Cup'), unit: 'pcs', baseUnit: 'pcs', status: 'active' })
    const id = created.body.data.id
    const res = await adjust(tokenAdminA, id, { type: 'set', quantity: 0, notes: 'Dihitung: habis' })
    expect(res.status).toBe(200)
    const read = await request(app).get(`/ingredient/get-by-id/${id}`).set(auth(tokenAdminA))
    expect(Number(read.body.data.stock)).toBe(0)
    expect(read.body.data.openingStockRecorded).toBe(true)
  })

  test('an ingredient created WITH opening stock gets a ledger row for it', async () => {
    const created = await request(app)
      .post('/ingredient/add')
      .set(auth(tokenAdminA))
      .send({ name: tag('Jeruk'), unit: 'pcs', baseUnit: 'pcs', stock: 20, status: 'active' })
    expect(created.status).toBe(201)
    expect(Number(created.body.data.stock)).toBe(20)
    const rows = await db.stock_history.findAll({ where: { ingredient: created.body.data.id } })
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].quantityBefore)).toBe(0)
    expect(Number(rows[0].quantityAfter)).toBe(20)
  })
})

describe('recipe deduction — one portion of each menu', () => {
  test.each([
    ['BAKSO URAT'],
    ['URAT KSG'],
    ['BAKSO HALUS'],
    ['HALUS KSG'],
    ['BAKSO TELUR'],
    ['TELUR KSG'],
    ['BAKSO KOMPLIT'],
    ['MIE AYAM'],
    ['MIE AYAM CEKER'],
    ['MIE AYAM CHILLI'],
    ['MISO HALUS']
  ])('%s deducts exactly its recipe', async (menu) => {
    await sellAndAssert([[menu, 1]])
  })

  test('MIE AYAM CHEESE deducts mie only — unconfirmed cheese is never deducted', async () => {
    const kejuBefore = await stockOf('keju')
    await sellAndAssert([['MIE AYAM CHEESE', 1]])
    expect(await stockOf('keju')).toBe(kejuBefore)
  })

  test('MISO URAT (pending naming) deducts urat 1, halus/polos 1, mie 1 under the single-item mapping', async () => {
    await sellAndAssert([['MISO URAT', 1]])
  })

  test('MISO TELUR (pending "1 x 4") is refused while its recipe is draft; once activated it deducts 1 of each, never ×4', async () => {
    const before = await snapshot()
    const refused = await sell([['MISO TELUR', 1]])
    expect(refused.status).toBe(409)
    expect(refused.body.error).toMatch(/tidak memiliki BOM aktif/)
    expect(await snapshot()).toEqual(before)

    // Simulates the admin step that follows an owner confirmation — the
    // confirmation itself is NOT recorded anywhere by this test.
    const bom = await db.bom_header.findOne({ where: { productId: MENU['MISO TELUR'].id } })
    const activated = await request(app)
      .put(`/bom/edit/${bom.id}`)
      .set(auth(tokenAdminA))
      .send({ status: 'active' })
    expect(activated.status).toBe(200)
    await sellAndAssert([['MISO TELUR', 1]])
  })

  test('pending recipes stay visibly flagged in the recipe list', async () => {
    const res = await request(app).get('/bom/get-all?limit=50').set(auth(tokenAdminA))
    expect(res.status).toBe(200)
    for (const [menu, note] of Object.entries(PENDING_NOTES)) {
      const bom = res.body.data.find((b) => b.productId === MENU[menu].id)
      expect(bom.notes).toBe(note)
    }
  })
})

describe('inventory integrity', () => {
  test('multiple portions multiply: 2 × BAKSO URAT = urat -4, halus -4', async () => {
    const res = await sellAndAssert([['BAKSO URAT', 2]])
    const movement = await saleMovement(res.body.data.id)
    expect(movement).toEqual({ urat: -4, halus: -4 })
  })

  test('different lines aggregate per ingredient; history keeps per-menu attribution', async () => {
    const lines = [['BAKSO URAT', 1], ['BAKSO KOMPLIT', 2], ['MISO HALUS', 1]]
    const res = await sellAndAssert(lines)
    expect(await saleMovement(res.body.data.id)).toEqual({ halus: -9, urat: -4, telur: -2, mie: -1 })
    const halusRows = await db.stock_history.findAll({
      where: { referenceType: 'sale', referenceId: res.body.data.id, ingredient: ING.halus.id },
      order: [['id', 'ASC']]
    })
    expect(halusRows).toHaveLength(3)
    // running before/after stays coherent across the per-product rows
    for (let i = 1; i < halusRows.length; i++) {
      expect(Number(halusRows[i].quantityBefore)).toBe(Number(halusRows[i - 1].quantityAfter))
    }
  })

  test('insufficient stock refuses the WHOLE order: no partial deduction, no order, no ledger rows', async () => {
    await adjust(tokenAdminA, ING.telur.id, { type: 'set', quantity: 1, notes: 'test kurang' })
    const before = await snapshot()
    const historyBefore = await db.stock_history.count({ where: { store: storeA.id } })
    const ordersBefore = await db.order.count({ where: { store: storeA.id } })

    // BAKSO HALUS alone would be fine; BAKSO TELUR needs 2 telur (only 1)
    const res = await sell([['BAKSO HALUS', 1], ['BAKSO TELUR', 1]])
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('INGREDIENT_STOCK_CONFLICT')
    expect(res.body.error).toMatch(/Bakso Telur.*tidak mencukupi\. Tersedia: 1, dibutuhkan: 2$/)

    expect(await snapshot()).toEqual(before)
    expect(await db.stock_history.count({ where: { store: storeA.id } })).toBe(historyBefore)
    expect(await db.order.count({ where: { store: storeA.id } })).toBe(ordersBefore)
  })

  test('a failure after finished-good stock moved rolls the finished good back too', async () => {
    const bottled = await db.product.create({
      nameProduct: tag('LE MINERALE'),
      category: category.id,
      price: 5000,
      stock: 8,
      inventoryMode: 'stocked'
    })
    await db.product_store_stock.create({ product: bottled.id, store: storeA.id, stock: 8 })
    await adjust(tokenAdminA, ING.telur.id, { type: 'set', quantity: 1, notes: 'test rollback' })
    const res = await request(app)
      .post('/order/create')
      .set(auth(tokenAdminA))
      .send(
        withIdempotencyKey({
          store: storeA.id,
          items: [
            { product: bottled.id, quantity: 2 },
            { product: MENU['BAKSO TELUR'].id, quantity: 1 }
          ],
          paymentMethod: 'cash',
          cashierName: 'Warung Test'
        })
      )
    expect(res.status).toBe(409)
    const row = await db.product_store_stock.findOne({ where: { product: bottled.id, store: storeA.id } })
    expect(Number(row.stock)).toBe(8)
    expect(await db.stock_history.count({ where: { product: bottled.id } })).toBe(0)
  })

  test('replaying the same idempotency key never deducts twice', async () => {
    await adjust(tokenAdminA, ING.telur.id, { type: 'set', quantity: 12, notes: 'restock test' })
    const key = tag('replay-key')
    const before = await snapshot()
    const first = await sell([['BAKSO KOMPLIT', 1]], { idempotencyKey: key })
    expect(first.status).toBe(201)
    const replay = await sell([['BAKSO KOMPLIT', 1]], { idempotencyKey: key })
    expect([200, 201]).toContain(replay.status)
    expect(replay.body.data.id).toBe(first.body.data.id)

    const after = await snapshot()
    expect(after.telur - before.telur).toBe(-1)
    expect(after.urat - before.urat).toBe(-1)
    expect(after.halus - before.halus).toBe(-2)
    expect(await db.order.count({ where: { idempotencyKey: key } })).toBe(1)
    expect(await saleMovement(first.body.data.id)).toEqual({ telur: -1, urat: -1, halus: -2 })
  })

  test('concurrent sales cannot oversell the last pieces', async () => {
    await adjust(tokenAdminA, ING.telur.id, { type: 'set', quantity: 2, notes: 'race test' })
    const results = await Promise.all([1, 2, 3].map(() => sell([['BAKSO TELUR', 1]])))
    const statuses = results.map((r) => r.status).sort()
    expect(statuses).toEqual([201, 409, 409])
    expect(await stockOf('telur')).toBe(0)
    const winner = results.find((r) => r.status === 201)
    expect(await saleMovement(winner.body.data.id)).toEqual({ telur: -2, halus: -2 })
    await adjust(tokenAdminA, ING.telur.id, { type: 'set', quantity: 12, notes: 'restock after race' })
  })

  test('concurrent stock entries are never lost (locked delta, not read-modify-write)', async () => {
    const before = await stockOf('ceker')
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() => adjust(tokenAdminA, ING.ceker.id, { type: 'add', quantity: 1, notes: 'race add' }))
    )
    expect(results.every((r) => r.status === 200)).toBe(true)
    expect(await stockOf('ceker')).toBe(before + 5)
  })

  test('voiding a paid order restores exactly what the sale consumed', async () => {
    const before = await snapshot()
    const res = await sell([['BAKSO KOMPLIT', 1], ['MIE AYAM CEKER', 1]])
    expect(res.status).toBe(201)
    const voided = await request(app)
      .put('/order/update-status')
      .set(auth(tokenAdminA))
      .send({ id: res.body.data.id, status: 'void', reason: 'Salah input pesanan' })
    expect(voided.status).toBe(200)
    expect(await snapshot()).toEqual(before)
    const reversal = await db.stock_history.findAll({
      where: { referenceType: 'sale_reversal', referenceId: res.body.data.id, ingredient: Object.values(ING).map((i) => i.id) }
    })
    expect(reversal.reduce((sum, r) => sum + Number(r.quantityChange), 0)).toBe(1 + 1 + 2 + 1 + 1)
  })

  test('a menu with only a draft (pending) recipe is refused, nothing deducted', async () => {
    const product = await db.product.create({
      nameProduct: tag('ES TEH'),
      category: category.id,
      price: 5000,
      stock: 0,
      inventoryMode: 'make_to_order'
    })
    const bom = await request(app)
      .post('/bom/add')
      .set(auth(tokenAdminA))
      .send({
        productId: product.id,
        notes: 'PENDING KONFIRMASI: resep es teh belum diberikan',
        status: 'draft',
        lines: [{ ingredientId: ING.mie.id, qty: 1, unit: 'pcs' }]
      })
    expect(bom.status).toBe(201)
    expect(bom.body.data.status).toBe('draft')
    const before = await snapshot()
    const res = await request(app)
      .post('/order/create')
      .set(auth(tokenAdminA))
      .send(withIdempotencyKey({ store: storeA.id, items: [{ product: product.id, quantity: 1 }], paymentMethod: 'cash', cashierName: 'Warung Test' }))
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/tidak memiliki BOM aktif/)
    expect(await snapshot()).toEqual(before)
  })

  test('a menu with no recipe at all is refused, nothing deducted', async () => {
    const product = await db.product.create({
      nameProduct: tag('ES KAMPUL'),
      category: category.id,
      price: 5000,
      stock: 0,
      inventoryMode: 'make_to_order'
    })
    const before = await snapshot()
    const res = await request(app)
      .post('/order/create')
      .set(auth(tokenAdminA))
      .send(withIdempotencyKey({ store: storeA.id, items: [{ product: product.id, quantity: 1 }], paymentMethod: 'cash', cashierName: 'Warung Test' }))
    expect(res.status).toBe(409)
    expect(await snapshot()).toEqual(before)
  })

  test('an unknown recipe status is refused at authoring (a typo cannot silently disable deduction)', async () => {
    const res = await request(app)
      .put(`/bom/edit/${(await db.bom_header.findOne({ where: { productId: MENU['MIE AYAM'].id } })).id}`)
      .set(auth(tokenAdminA))
      .send({ status: 'aktif' })
    expect(res.status).toBe(400)
    const bom = await db.bom_header.findOne({ where: { productId: MENU['MIE AYAM'].id } })
    expect(bom.status).toBe('active')
  })
})

describe('QR table order (BISA-MAKAN) — same recipe, deducted exactly once at payment', () => {
  test('no deduction when the table order is placed; one deduction when it is paid; a second pay never re-deducts', async () => {
    const table = await db.table.create({ store: storeA.id, name: tag('MEJA') })
    const before = await snapshot()
    const created = await request(app)
      .post('/order/customer-create')
      .send({
        tableId: table.id,
        store: storeA.id,
        paymentMethod: 'cash',
        customerName: 'Tamu Meja',
        items: [{ productId: MENU['BAKSO URAT'].id, productName: MENU['BAKSO URAT'].nameProduct, quantity: 2 }]
      })
    expect(created.status).toBe(201)
    expect(created.body.data.paymentStatus).toBe('unpaid')
    expect(await snapshot()).toEqual(before)

    const pay = () =>
      request(app)
        .put('/order/update-status')
        .set(auth(tokenAdminA))
        .send({ id: created.body.data.id, status: 'paid' })
    const paid = await pay()
    expect(paid.status).toBe(200)
    const afterPaid = await snapshot()
    expect(afterPaid.urat - before.urat).toBe(-4)
    expect(afterPaid.halus - before.halus).toBe(-4)

    const again = await pay()
    expect(again.status).not.toBe(200)
    expect(await snapshot()).toEqual(afterPaid)
    expect(await saleMovement(created.body.data.id)).toEqual({ urat: -4, halus: -4 })
  })

  // DR-18: an already-taken table order is never refused at payment for
  // stock; the uncovered amount is recorded, stock never goes below zero.
  test('a table order paid while short on telur settles, clamps at 0 and records the shortfall', async () => {
    await adjust(tokenAdminA, ING.telur.id, { type: 'set', quantity: 1, notes: 'test DR-18' })
    const table = await db.table.create({ store: storeA.id, name: tag('MEJA-2') })
    const created = await request(app)
      .post('/order/customer-create')
      .send({
        tableId: table.id,
        store: storeA.id,
        paymentMethod: 'cash',
        customerName: 'Tamu Meja',
        items: [{ productId: MENU['BAKSO TELUR'].id, productName: MENU['BAKSO TELUR'].nameProduct, quantity: 1 }]
      })
    expect(created.status).toBe(201)
    const halusBefore = await stockOf('halus')
    const paid = await request(app)
      .put('/order/update-status')
      .set(auth(tokenAdminA))
      .send({ id: created.body.data.id, status: 'paid' })
    expect(paid.status).toBe(200)
    expect(paid.body.stockShortages).toEqual([
      expect.objectContaining({ type: 'ingredient', id: ING.telur.id, required: 2, deducted: 1, shortfall: 1 })
    ])
    expect(await stockOf('telur')).toBe(0)
    expect(await stockOf('halus')).toBe(halusBefore - 2)
    const [row] = await db.stock_history.findAll({
      where: { referenceType: 'sale', referenceId: created.body.data.id, ingredient: ING.telur.id }
    })
    expect(Number(row.quantityChange)).toBe(-1)
    expect(row.notes).toMatch(/KURANG 1/)
    await adjust(tokenAdminA, ING.telur.id, { type: 'set', quantity: 12, notes: 'restock after DR-18' })
  })
})

describe('ingredient edit never corrupts stock', () => {
  test('editing only the name keeps stock, unit and cost (zod-4 partial-default regression)', async () => {
    await db.ingredient.update({ costPrice: 1200, minStock: 5 }, { where: { id: ING.mie.id } })
    const before = await db.ingredient.findByPk(ING.mie.id)
    const res = await request(app)
      .put(`/ingredient/edit/${ING.mie.id}`)
      .set(auth(tokenAdminA))
      .send({ name: before.name })
    expect(res.status).toBe(200)
    const after = await db.ingredient.findByPk(ING.mie.id)
    expect(Number(after.stock)).toBe(Number(before.stock))
    expect(after.unit).toBe(before.unit)
    expect(after.costPrice).toBe(1200)
    expect(after.minStock).toBe(5)
    expect(after.status).toBe('active')
  })

  test('a changed stock value in the edit form goes through the ledger with the ingredient id', async () => {
    const res = await request(app)
      .put(`/ingredient/edit/${ING.ceker.id}`)
      .set(auth(tokenAdminA))
      .send({ stock: 10 })
    expect(res.status).toBe(200)
    expect(await stockOf('ceker')).toBe(10)
    const last = await db.stock_history.findOne({
      where: { ingredient: ING.ceker.id, referenceType: 'adjustment' },
      order: [['id', 'DESC']]
    })
    expect(Number(last.quantityAfter)).toBe(10)
    expect(last.notes).toBe('Ubah stok dari form bahan baku')
  })
})

describe('authorization and store isolation', () => {
  test('a cashier cannot adjust stock or edit recipes (backend 403, nothing changes)', async () => {
    const before = await stockOf('urat')
    const adj = await adjust(tokenKasirA, ING.urat.id, { type: 'set', quantity: 999 })
    expect(adj.status).toBe(403)
    const bomId = (await db.bom_header.findOne({ where: { productId: MENU['BAKSO URAT'].id } })).id
    const edit = await request(app)
      .put(`/bom/edit/${bomId}`)
      .set(auth(tokenKasirA))
      .send({ lines: [{ ingredientId: ING.urat.id, qty: 1, unit: 'pcs' }] })
    expect(edit.status).toBe(403)
    const summary = await request(app).get('/ingredient/stock-summary').set(auth(tokenKasirA))
    expect(summary.status).toBe(403)
    expect(await stockOf('urat')).toBe(before)
    const lines = await db.bom_line.findAll({ where: { bomHeaderId: bomId } })
    expect(lines.map((l) => l.qty).sort()).toEqual([2, 2])
  })

  test("another store's admin can neither adjust nor see store A's stock", async () => {
    const before = await stockOf('urat')
    const adj = await adjust(tokenAdminB, ING.urat.id, { type: 'set', quantity: 0 })
    expect(adj.status).toBe(404)
    expect(await stockOf('urat')).toBe(before)
    const summary = await request(app).get('/ingredient/stock-summary').set(auth(tokenAdminB))
    expect(summary.status).toBe(200)
    expect(summary.body.data.store).toBe(storeB.id)
    expect(summary.body.data.items.some((i) => i.id === ING.urat.id)).toBe(false)
  })

  test('a recipe cannot reference another store\'s ingredient', async () => {
    const foreign = await db.ingredient.create({ store: storeB.id, name: tag('B-only'), stock: 50, unit: 'pcs', baseUnit: 'pcs' })
    const product = await db.product.create({ nameProduct: tag('X'), category: category.id, price: 1, stock: 0, inventoryMode: 'make_to_order' })
    const res = await request(app)
      .post('/bom/add')
      .set(auth(tokenAdminA))
      .send({ productId: product.id, lines: [{ ingredientId: foreign.id, qty: 1, unit: 'pcs' }] })
    expect(res.status).toBe(400)
  })

  test('adjust-stock input is validated (negative, unknown type, over-subtract)', async () => {
    expect((await adjust(tokenAdminA, ING.urat.id, { type: 'set', quantity: -1 })).status).toBe(400)
    expect((await adjust(tokenAdminA, ING.urat.id, { type: 'reset', quantity: 1 })).status).toBe(400)
    const before = await stockOf('urat')
    const over = await adjust(tokenAdminA, ING.urat.id, { type: 'subtract', quantity: before + 1 })
    expect(over.status).toBe(409)
    expect(over.body.code).toBe('INGREDIENT_STOCK_CONFLICT')
    expect(await stockOf('urat')).toBe(before)
  })
})

describe('remaining-stock summary', () => {
  test('ledger summary reconciles opening + movements = current, and separates menu units from pieces', async () => {
    const res = await request(app).get('/ingredient/stock-summary').set(auth(tokenAdminA))
    expect(res.status).toBe(200)
    const items = res.body.data.items
    for (const key of Object.keys(ING)) {
      const item = items.find((i) => i.id === ING[key].id)
      expect(item.openingStockRecorded).toBe(true)
      expect(item.unit).toBe('pcs')
      // no period: opening is 0 (all history included) and closing = current
      expect(item.openingBalance).toBe(0)
      expect(item.closingBalance).toBe(await stockOf(key))
      expect(item.currentStock).toBe(await stockOf(key))
      const sum = item.openingBalance - item.consumed + item.restored + item.adjusted + item.counted + item.received + item.other
      expect(Math.round(sum * 10000) / 10000).toBe(item.closingBalance)
    }
    const halus = items.find((i) => i.id === ING.halus.id)
    const halusSales = await db.stock_history.sum('quantityChange', {
      where: { ingredient: ING.halus.id, referenceType: 'sale' }
    })
    expect(halus.consumed).toBe(-Number(halusSales))
    expect(halus.consumed).toBeGreaterThan(0)

    // menu portions sold are reported in portions, voided orders excluded
    const komplit = res.body.data.menuSold.find((m) => m.productId === MENU['BAKSO KOMPLIT'].id)
    expect(komplit.quantity).toBe(1 /* matrix */ + 2 /* aggregate */ + 1 /* replay, once */)
    const urat = res.body.data.menuSold.find((m) => m.productId === MENU['BAKSO URAT'].id)
    expect(urat.quantity).toBe(1 /* matrix */ + 2 /* multiply */ + 1 /* aggregate */ + 2 /* QR paid */)
  })

  test('a period window splits opening and closing balances', async () => {
    const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10)
    const res = await request(app)
      .get(`/ingredient/stock-summary?startDate=${tomorrow}&endDate=${tomorrow}`)
      .set(auth(tokenAdminA))
    expect(res.status).toBe(200)
    const urat = res.body.data.items.find((i) => i.id === ING.urat.id)
    expect(urat.consumed).toBe(0)
    expect(urat.openingBalance).toBe(await stockOf('urat'))
    expect(res.body.data.menuSold).toEqual([])

    const bad = await request(app).get('/ingredient/stock-summary?startDate=kemarin').set(auth(tokenAdminA))
    expect(bad.status).toBe(400)
  })
})
