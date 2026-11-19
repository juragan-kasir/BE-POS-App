process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// F-STOCK-2 regression: ingredient opname completion must serialize on the
// opname header (exactly-once) and must not lose concurrent mutations via
// unlocked absolute writes.

let store = null
let ingredient = null
let adminToken = null

async function makeDraftOpname(counted) {
  const res = await request(app)
    .post('/stock-opname/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      store: store.id,
      status: 'draft',
      items: [
        {
          ingredientName: ingredient.name,
          stokFisikJumlah: counted,
          selisihJumlah: counted - 100,
          satuan: 'g'
        }
      ]
    })
  if (res.status !== 201) throw new Error('opname setup failed: ' + JSON.stringify(res.body))
  return res.body.data
}

async function completeOpname(id) {
  return request(app)
    .patch(`/stock-opname/status/${id}`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ status: 'completed' })
}

async function ingredientStock() {
  return Number((await db.ingredient.findByPk(ingredient.id)).stock)
}

beforeAll(async () => {
  store = await db.location.create(await withTestTenant({ name: `OPAT_STORE_${Date.now()}`, status: 'active' }))
  ingredient = await db.ingredient.create({
    store: store.id,
    name: `OPAT_ING_${Date.now()}`,
    stock: 100,
    unit: 'g',
    baseUnit: 'g',
    costPrice: 10
  })
  const adminUser = await db.user.create({
    userName: `admin_opat_${Date.now()}`,
    email: `admin_opat_${Date.now()}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.stock_history.destroy({ where: { ingredient: ingredient?.id }, force: true })
  await db.stockOpnameItem.destroy({ where: {}, force: true })
  await db.stockOpname.destroy({ where: { store: store?.id }, force: true })
  await db.ingredient.destroy({ where: { id: ingredient?.id }, force: true })
  await db.user.destroy({ where: { store: store?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('F-STOCK-2 opname ingredient atomicity', () => {
  test('concurrent completions of the same opname apply exactly once', async () => {
    const opname = await makeDraftOpname(60)

    const [r1, r2] = await Promise.all([
      completeOpname(opname.id),
      completeOpname(opname.id)
    ])
    // One winner completes; the loser sees the terminal state.
    expect([r1.status, r2.status].sort()).toEqual([200, 400])
    expect(await ingredientStock()).toBe(60)

    // Exactly one coherent opname history row for this completion.
    const histories = await db.stock_history.findAll({
      where: { ingredient: ingredient.id, referenceType: 'opname' },
      order: [['id', 'ASC']]
    })
    expect(histories.length).toBe(1)
    expect(Number(histories[0].quantityBefore)).toBe(100)
    expect(Number(histories[0].quantityAfter)).toBe(60)

    await db.stock_history.destroy({ where: { ingredient: ingredient.id }, force: true })
    await db.ingredient.update({ stock: 100 }, { where: { id: ingredient.id } })
  })

  test('repeat completion is rejected without a second delta', async () => {
    const opname = await makeDraftOpname(70)
    const first = await completeOpname(opname.id)
    expect(first.status).toBe(200)
    expect(await ingredientStock()).toBe(70)

    const second = await completeOpname(opname.id)
    expect(second.status).toBe(400)
    expect(await ingredientStock()).toBe(70)
  })

  test('two opnames racing on the same ingredient leave exactly one winner value', async () => {
    await db.ingredient.update({ stock: 100 }, { where: { id: ingredient.id } })
    await db.stock_history.destroy({ where: { ingredient: ingredient.id }, force: true })
    const opA = await makeDraftOpname(40)
    const opB = await makeDraftOpname(90)

    const [rA, rB] = await Promise.all([
      completeOpname(opA.id),
      completeOpname(opB.id)
    ])
    expect(rA.status).toBe(200)
    expect(rB.status).toBe(200)
    // Each completion is atomic: the final value must be exactly one of
    // the two counted values, never a torn mix.
    expect([40, 90]).toContain(await ingredientStock())
  })
})
