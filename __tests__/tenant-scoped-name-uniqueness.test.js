process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

describe('category and product names are unique per tenant, not globally', () => {
  let token = null
  let admin = null
  let tenantX = null
  let tenantY = null
  let storeX1 = null
  let storeX2 = null
  let storeY = null
  let baseCategoryX = null
  let baseCategoryY = null
  const locIds = []
  const catIds = []
  const prodIds = []
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

  const nextLocationId = async () => {
    const [rows] = await db.sequelize.query("SELECT nextval('location_id_seq') AS id")
    return Number(rows?.[0]?.id)
  }

  const makeStore = async (label, tenantId) => {
    const row = await db.location.create({
      id: await nextLocationId(),
      name: `TSN_${label}_${stamp}`,
      status: 'active',
      phoneNumber: '081234567890',
      email: `tsn_${label.toLowerCase()}_${stamp}@test.com`,
      tenantId,
      createdBy: admin.id
    })
    locIds.push(row.id)
    return row
  }

  const addCategory = (name, stores) =>
    request(app)
      .post('/category/add-new-category')
      .set('Authorization', `Bearer ${token}`)
      .send({ name, status: 'active', store: stores })

  const addProduct = (nameProduct, stores, extra = {}) =>
    request(app)
      .post('/product/add-product')
      .set('Authorization', `Bearer ${token}`)
      .send({
        nameProduct,
        category: stores && stores.includes(storeY.id) ? baseCategoryY.id : baseCategoryX.id,
        price: 5000,
        costPrice: 3000,
        status: 'active',
        isAvailable: true,
        ...(stores ? { stores } : {}),
        ...extra
      })

  const track = (res, list) => {
    const id = res.body?.data?.id
    if (id) list.push(id)
    return res
  }

  beforeAll(async () => {
    tenantX = await db.tenant.create({ code: `tsnx-${stamp}`, name: 'TSN Tenant X' })
    tenantY = await db.tenant.create({ code: `tsny-${stamp}`, name: 'TSN Tenant Y' })
    admin = await db.user.create({
      userName: `tsn_admin_${stamp}`,
      email: `tsn_admin_${stamp}@test.com`,
      roleType: 'super_admin',
      userType: 'admin',
      store: null,
      status: 'active'
    })
    token = await signSessionToken(
      { id: admin.id, userName: admin.userName, roleType: 'super_admin', store: null },
      JWT_SECRET
    )
    storeX1 = await makeStore('X1', tenantX.id)
    storeX2 = await makeStore('X2', tenantX.id)
    storeY = await makeStore('Y', tenantY.id)
    baseCategoryX = await db.category.create({ name: `TSN_BASE_X_${stamp}`, status: 'active' })
    baseCategoryY = await db.category.create({ name: `TSN_BASE_Y_${stamp}`, status: 'active' })
    catIds.push(baseCategoryX.id, baseCategoryY.id)
    await db.category_store.bulkCreate([
      { category: baseCategoryX.id, store: storeX1.id },
      { category: baseCategoryX.id, store: storeX2.id },
      { category: baseCategoryY.id, store: storeY.id }
    ])
  })

  afterAll(async () => {
    await db.product_store_stock.destroy({ where: { product: prodIds }, force: true }).catch(() => {})
    await db.stock_history.destroy({ where: { product: prodIds }, force: true }).catch(() => {})
    await db.product_store.destroy({ where: { product: prodIds }, force: true }).catch(() => {})
    await db.product.destroy({ where: { id: prodIds }, force: true }).catch(() => {})
    await db.category_store.destroy({ where: { category: catIds }, force: true }).catch(() => {})
    await db.category.destroy({ where: { id: catIds }, force: true }).catch(() => {})
    await db.location.destroy({ where: { id: locIds }, force: true }).catch(() => {})
    await db.tenant.destroy({ where: { id: [tenantX?.id, tenantY?.id] }, force: true }).catch(() => {})
    await db.user.destroy({ where: { id: admin?.id }, force: true }).catch(() => {})
  })

  describe('category', () => {
    const name = `Makanan_${stamp}`

    test('two businesses can both have the same category name', async () => {
      const first = track(await addCategory(name, [storeX1.id]), catIds)
      expect([200, 201]).toContain(first.status)
      const second = track(await addCategory(name, [storeY.id]), catIds)
      expect([200, 201]).toContain(second.status)
    })

    test('the same business still cannot repeat a category name', async () => {
      const res = track(await addCategory(name, [storeX2.id]), catIds)
      expect(res.status).toBe(409)
      expect(res.body).toMatchObject({ code: 'NAME_TAKEN', message: 'Category Sudah Terdaftar' })
    })

    test('renaming is checked inside the category own tenant only', async () => {
      const own = track(await addCategory(`Minuman_${stamp}`, [storeY.id]), catIds)
      expect([200, 201]).toContain(own.status)
      const onlyInX = track(await addCategory(`Snack_${stamp}`, [storeX1.id]), catIds)
      expect([200, 201]).toContain(onlyInX.status)

      const free = await request(app)
        .put(`/category/edit-category/${own.body.data.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `Snack_${stamp}` })
      expect(free.status).toBe(200)

      const taken = await request(app)
        .put(`/category/edit-category/${own.body.data.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name })
      expect(taken.status).toBe(409)
      expect(taken.body.code).toBe('NAME_TAKEN')
    })
  })

  describe('product', () => {
    const name = `Air Mineral 600ml ${stamp}`

    test('two businesses can both sell a product with the same name', async () => {
      const first = track(await addProduct(name, [storeX1.id]), prodIds)
      expect([200, 201]).toContain(first.status)
      const second = track(await addProduct(name, [storeY.id]), prodIds)
      expect([200, 201]).toContain(second.status)
    })

    test('the same business still cannot repeat a product name', async () => {
      const res = track(await addProduct(name, [storeX2.id]), prodIds)
      expect(res.status).toBe(409)
      expect(res.body).toMatchObject({
        code: 'NAME_TAKEN',
        field: 'nameProduct',
        message: 'Product with this name already exists.'
      })
    })

    test('a product without stores is checked against every business', async () => {
      const res = track(
        await addProduct(name, undefined, { status: 'draft', isAvailable: false }),
        prodIds
      )
      expect(res.status).toBe(409)
    })

    test('a product shown in every store blocks the name everywhere', async () => {
      const globalName = `Kantong Plastik ${stamp}`
      const unassigned = await db.product.create({
        nameProduct: globalName,
        category: baseCategoryX.id,
        price: 500,
        status: 'active'
      })
      prodIds.push(unassigned.id)
      const res = track(await addProduct(globalName, [storeY.id]), prodIds)
      expect(res.status).toBe(409)
    })
  })
})
