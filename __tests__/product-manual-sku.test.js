process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')
const { createProductSchema, updateProductSchema } = require('../api/validation/schemas')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Retail form audit 2026-11-21 R4: createProductSchema had no `sku`, so zod
// stripped the SKU typed in the product form and BE always wrote PRD-xxxxx.
// A typed SKU is now kept (unique per tenant); an empty one is generated.

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
const stamp = String(Date.now()).slice(-6)

let store = null
let otherTenant = null
let otherStore = null
let category = null
const userIds = []
let token = null
let otherToken = null
const productIds = []

const makeAdmin = async (location) => {
  const user = await db.user.create({
    userName: unique('sku_admin'),
    email: `${unique('sku_admin')}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: location.id,
    status: 'active'
  })
  userIds.push(user.id)
  return signSessionToken({ id: user.id, userName: user.userName, roleType: 'admin', store: location.id }, JWT_SECRET)
}

const add = (body, auth = token, storeId = store.id) =>
  request(app)
    .post('/product/add-product')
    .set('Authorization', `Bearer ${auth}`)
    .send({ nameProduct: unique('SKU_P'), category: category.id, price: 5000, stores: [storeId], ...body })
    .then((res) => {
      if (res.body?.data?.id) productIds.push(res.body.data.id)
      return res
    })

const edit = (body) =>
  request(app).put('/product/edit-product').set('Authorization', `Bearer ${token}`).send(body)

const storedSku = async (id) => (await db.product.findByPk(id, { paranoid: false, raw: true })).sku

beforeAll(async () => {
  store = await db.location.create(await withTestTenant({ name: unique('SKU_STORE'), status: 'active' }))
  otherTenant = await db.tenant.create({ code: `sku-b-${stamp}`, name: 'SKU Tenant B' })
  otherStore = await db.location.create({ name: unique('SKU_STORE_B'), status: 'active', tenantId: otherTenant.id })
  category = await db.category.create({ name: unique('SKU_CAT') })
  token = await makeAdmin(store)
  otherToken = await makeAdmin(otherStore)
})

afterAll(async () => {
  await db.stock_history.destroy({ where: { product: productIds }, force: true }).catch(() => {})
  await db.product_store_stock.destroy({ where: { product: productIds }, force: true }).catch(() => {})
  await db.product_store.destroy({ where: { product: productIds }, force: true }).catch(() => {})
  await db.product.destroy({ where: { id: productIds }, force: true }).catch(() => {})
  await db.category.destroy({ where: { id: category?.id }, force: true }).catch(() => {})
  await db.user.destroy({ where: { id: userIds }, force: true }).catch(() => {})
  await db.location.destroy({ where: { id: [store?.id, otherStore?.id] }, force: true }).catch(() => {})
  await db.tenant.destroy({ where: { id: otherTenant?.id }, force: true }).catch(() => {})
})

describe('product SKU typed in the form', () => {
  test('schemas keep sku (was stripped) and cap it at 50', () => {
    expect(createProductSchema.parse({ sku: ' RTL-001 ' }).sku).toBe('RTL-001')
    expect(updateProductSchema.parse({ id: 1, sku: 'RTL-002' }).sku).toBe('RTL-002')
    expect(createProductSchema.safeParse({ sku: 'x'.repeat(51) }).success).toBe(false)
  })

  test('create keeps a typed SKU', async () => {
    const res = await add({ sku: `RTL-${stamp}-A` })
    expect(res.status).toBe(200)
    expect(res.body.data.sku).toBe(`RTL-${stamp}-A`)
    expect(await storedSku(res.body.data.id)).toBe(`RTL-${stamp}-A`)
  })

  test('create without SKU still generates PRD-xxxxx', async () => {
    const res = await add({ sku: '  ' })
    expect(res.status).toBe(200)
    expect(await storedSku(res.body.data.id)).toBe(`PRD-${String(res.body.data.id).padStart(5, '0')}`)
  })

  test('a SKU already used in the tenant is refused with 409, another tenant may use it', async () => {
    const dup = await add({ sku: `RTL-${stamp}-A` })
    expect(dup.status).toBe(409)
    expect(dup.body).toMatchObject({ code: 'SKU_TAKEN', field: 'sku' })

    const otherTenantRes = await add({ sku: `RTL-${stamp}-A` }, otherToken, otherStore.id)
    expect(otherTenantRes.status).toBe(200)
    expect(otherTenantRes.body.data.sku).toBe(`RTL-${stamp}-A`)
  })

  test('a SKU held by a deleted product is refused with its own message', async () => {
    const res = await add({ sku: `RTL-${stamp}-DEL` })
    await db.product.destroy({ where: { id: res.body.data.id } })
    const again = await add({ sku: `RTL-${stamp}-DEL` })
    expect(again.status).toBe(409)
    expect(again.body.message).toMatch(/sudah dihapus/)
  })

  test('auto SKU skips a code someone typed by hand', async () => {
    const [{ next }] = await db.sequelize.query("SELECT last_value + 1 AS next FROM product_id_seq", { type: db.sequelize.QueryTypes.SELECT })
    const handTyped = `PRD-${String(Number(next) + 1).padStart(5, '0')}`
    const typed = await add({ sku: handTyped })
    expect(typed.status).toBe(200)
    const auto = await add({})
    expect(auto.status).toBe(200)
    const autoSku = await storedSku(auto.body.data.id)
    expect(autoSku).not.toBe(handTyped)
    expect(autoSku).toMatch(/^PRD-\d{5}/)
  })

  test('edit changes the SKU, keeps it when empty or omitted, refuses a taken one', async () => {
    const res = await add({ sku: `RTL-${stamp}-E` })
    const id = res.body.data.id

    const changed = await edit({ id, sku: `RTL-${stamp}-E2` })
    expect(changed.status).toBe(200)
    expect(await storedSku(id)).toBe(`RTL-${stamp}-E2`)

    const blank = await edit({ id, sku: '' })
    expect(blank.status).toBe(200)
    expect(await storedSku(id)).toBe(`RTL-${stamp}-E2`)

    const omitted = await edit({ id, price: 7000 })
    expect(omitted.status).toBe(200)
    expect(await storedSku(id)).toBe(`RTL-${stamp}-E2`)

    const same = await edit({ id, sku: `RTL-${stamp}-E2` })
    expect(same.status).toBe(200)

    const taken = await edit({ id, sku: `RTL-${stamp}-A` })
    expect(taken.status).toBe(409)
    expect(taken.body.code).toBe('SKU_TAKEN')
    expect(await storedSku(id)).toBe(`RTL-${stamp}-E2`)
  })
})
