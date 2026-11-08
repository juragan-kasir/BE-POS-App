process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// PGA-01 (writes) and PGA-12 (reads), audit product-grade-2026-11-02 sweep
// harness/40-security: a multi-outlet owner (store-bound super_admin) of
// tenant A must reach every outlet of A by id and nothing of tenant B.
// Covers the five probes that still leaked after #294/#295: price-by-store,
// ingredient edit (it also MOVED the row to the attacker's outlet), member
// edit, member point history (leaked to admins too) and the Z-report.

const PREFIX = `w1p1_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
let seq = 0
const unique = (key) => `${PREFIX}_${key}_${++seq}`.toLowerCase()
let phoneSeq = 0
const phone = () => `0812${String(Date.now()).slice(-6)}${String(++phoneSeq).padStart(2, '0')}`

const ids = { tenants: [], stores: [], users: [], products: [], categories: [], ingredients: [], members: [], registers: [] }
const s = {}
const t = {}

const makeStore = async (key, tenantId) => {
  const row = await db.location.create({ name: unique(key), status: 'active', tenantId })
  ids.stores.push(row.id)
  return row
}

const makeUser = async (key, roleType, store) => {
  const name = unique(key)
  const row = await db.user.create({
    userName: name,
    email: `${name}@test.com`,
    password: 'Rahasia123!',
    fullName: name,
    roleType,
    userType: 'admin',
    status: 'active',
    store
  })
  ids.users.push(row.id)
  return { row, token: await signSessionToken({ id: row.id, roleType, store }, JWT_SECRET) }
}

const makeProduct = async (store) => {
  const row = await db.product.create({ nameProduct: unique('PROD'), category: s.category.id, price: 10000 })
  ids.products.push(row.id)
  await db.product_store.create({ product: row.id, store: store.id })
  return row
}

const makeIngredient = async (store) => {
  const row = await db.ingredient.create({
    store: store.id,
    name: unique('ING'),
    stock: 5,
    minStock: 0,
    unit: 'pcs',
    baseUnit: 'pcs',
    conversionFactor: 1,
    costPrice: 0
  })
  ids.ingredients.push(row.id)
  return row
}

const makeMember = async (store) => {
  const row = await db.member.create({ name: unique('MEM'), phoneNumber: phone(), store: store?.id ?? null, status: 'active' })
  ids.members.push(row.id)
  return row
}

const as = (token) => ({ Authorization: `Bearer ${token}` })

beforeAll(async () => {
  const tenantA = await db.tenant.create({ code: unique('TA').toUpperCase(), name: unique('Tenant A') })
  const tenantB = await db.tenant.create({ code: unique('TB').toUpperCase(), name: unique('Tenant B') })
  ids.tenants.push(tenantA.id, tenantB.id)
  s.a1 = await makeStore('A1', tenantA.id)
  s.a2 = await makeStore('A2', tenantA.id)
  s.b1 = await makeStore('B1', tenantB.id)

  t.ownerA = (await makeUser('owner_a', 'super_admin', s.a1.id)).token
  t.adminA1 = (await makeUser('admin_a1', 'admin', s.a1.id)).token
  const adminB = await makeUser('admin_b1', 'admin', s.b1.id)
  t.global = (await makeUser('vendor', 'super_admin', null)).token

  s.category = await db.category.create({ name: unique('CAT'), status: 'active' })
  ids.categories.push(s.category.id)

  const register = await db.cashRegister.create({
    store: s.b1.id,
    user: adminB.row.id,
    status: 'open',
    openingBalance: 100000,
    openedAt: new Date()
  })
  ids.registers.push(register.id)
  s.registerB = register
})

afterAll(async () => {
  await db.cashRegister.destroy({ where: { id: ids.registers }, force: true })
  await db.member_point_history.destroy({ where: { member: ids.members } })
  await db.member.destroy({ where: { id: ids.members }, force: true })
  await db.stockHistory?.destroy({ where: { ingredient: ids.ingredients } }).catch(() => {})
  await db.ingredient.destroy({ where: { id: ids.ingredients }, force: true })
  await db.product_store_price.destroy({ where: { product: ids.products } })
  await db.product_store.destroy({ where: { product: ids.products } })
  await db.product.destroy({ where: { id: ids.products }, force: true })
  await db.category.destroy({ where: { id: ids.categories }, force: true })
  await db.user.destroy({ where: { id: ids.users }, force: true })
  await db.location.destroy({ where: { id: ids.stores }, force: true })
  await db.tenant.destroy({ where: { id: ids.tenants }, force: true })
})

describe('price by store (PGA-01)', () => {
  const put = (token, productId, storePrices) =>
    request(app).put('/pos/product/update-price-by-store').set(as(token)).send({ productId, storePrices })
  const outletPrice = async (product, store) =>
    (await db.product_store_price.findOne({ where: { product: product.id, store: store.id } }))?.price ?? null

  test('the owner prices its second outlet', async () => {
    const product = await makeProduct(s.a2)
    expect((await put(t.ownerA, product.id, [{ storeId: s.a2.id, price: 9000 }])).status).toBe(200)
    expect(Number(await outletPrice(product, s.a2))).toBe(9000)
  })

  test('another tenant\'s outlet price is refused and unchanged', async () => {
    const product = await makeProduct(s.b1)
    expect((await put(t.ownerA, product.id, [{ storeId: s.b1.id, price: 1 }])).status).toBe(403)
    expect(await outletPrice(product, s.b1)).toBeNull()
  })

  test('another tenant\'s product: its shared base price is refused and unchanged', async () => {
    const product = await makeProduct(s.b1)
    expect((await put(t.ownerA, product.id, [{ storeId: 'base', price: 1 }])).status).toBe(403)
    expect((await db.product.findByPk(product.id)).price).toBe(10000)
  })

  test('the owner sets the base price of its own product', async () => {
    const product = await makeProduct(s.a1)
    expect((await put(t.ownerA, product.id, [{ storeId: 'base', price: 12000 }])).status).toBe(200)
    expect((await db.product.findByPk(product.id)).price).toBe(12000)
  })
})

describe('ingredient edit (PGA-01)', () => {
  const put = (token, ingredient, body) =>
    request(app).put(`/ingredient/edit/${ingredient.id}`).set(as(token)).send(body)

  test('the owner edits an ingredient of its second outlet and it stays there', async () => {
    const ingredient = await makeIngredient(s.a2)
    expect((await put(t.ownerA, ingredient, { name: unique('RENAMED') })).status).toBe(200)
    const after = await db.ingredient.findByPk(ingredient.id)
    expect(after.store).toBe(s.a2.id)
  })

  test('another tenant\'s ingredient answers 404, keeps its name and its outlet', async () => {
    const ingredient = await makeIngredient(s.b1)
    expect((await put(t.ownerA, ingredient, { name: 'HACKED' })).status).toBe(404)
    const after = await db.ingredient.findByPk(ingredient.id)
    expect(after.name).toBe(ingredient.name)
    expect(after.store).toBe(s.b1.id)
  })
})

describe('member edit and delete (PGA-01)', () => {
  test('the owner edits a member of its second outlet', async () => {
    const member = await makeMember(s.a2)
    const res = await request(app).put(`/member/edit-member/${member.id}`).set(as(t.ownerA)).send({ nameMember: unique('NEWNAME') })
    expect(res.status).toBe(200)
  })

  test('another tenant\'s member is refused and unchanged', async () => {
    const member = await makeMember(s.b1)
    const res = await request(app).put(`/member/edit-member/${member.id}`).set(as(t.ownerA)).send({ nameMember: 'HACKED' })
    expect(res.status).toBe(403)
    expect((await db.member.findByPk(member.id)).name).toBe(member.name)
    expect((await request(app).delete(`/member/delete-member/${member.id}`).set(as(t.ownerA))).status).not.toBe(200)
    expect(await db.member.findByPk(member.id)).not.toBeNull()
  })

  test('a chain-wide member (no outlet) is changed only by the vendor account', async () => {
    const member = await makeMember(null)
    const owner = await request(app).put(`/member/edit-member/${member.id}`).set(as(t.ownerA)).send({ nameMember: 'HACKED' })
    expect(owner.status).toBe(403)
    expect((await db.member.findByPk(member.id)).name).toBe(member.name)
  })

  test('a store-less vendor write records the resource tenant on the audit row', async () => {
    const member = await makeMember(s.a2)
    const res = await request(app)
      .put(`/member/edit-member/${member.id}`)
      .set(as(t.global))
      .send({ nameMember: unique('VENDORNAME') })
    expect(res.status).toBe(200)
    const row = await db.auditLog.findOne({
      where: { entity: 'member', entityId: String(member.id), action: 'update' },
      order: [['id', 'DESC']]
    })
    expect(row).not.toBeNull()
    expect(row.tenantId).toBe(ids.tenants[0])
  })

  test('the member list without ?store= shows the owner\'s tenant only', async () => {
    const mine = await makeMember(s.a2)
    const theirs = await makeMember(s.b1)
    const res = await request(app).get('/member/get-member?page=1&limit=500').set(as(t.ownerA))
    expect(res.status).toBe(200)
    const listed = (res.body.data || []).map((m) => m.id)
    expect(listed).toContain(mine.id)
    expect(listed).not.toContain(theirs.id)
  })
})

describe('reads (PGA-12)', () => {
  test('member point history: own tenant yes, another tenant no (owner and admin)', async () => {
    const mine = await makeMember(s.a1)
    const theirs = await makeMember(s.b1)
    expect((await request(app).get(`/pos/member/${mine.id}/point-history`).set(as(t.ownerA))).status).toBe(200)
    expect((await request(app).get(`/pos/member/${mine.id}/point-history`).set(as(t.adminA1))).status).toBe(200)
    expect((await request(app).get(`/pos/member/${theirs.id}/point-history`).set(as(t.ownerA))).status).toBe(404)
    expect((await request(app).get(`/pos/member/${theirs.id}/point-history`).set(as(t.adminA1))).status).toBe(404)
    expect((await request(app).get(`/pos/member/${theirs.id}/point-history`).set(as(t.global))).status).toBe(200)
  })

  test('Z-report of another tenant\'s register is refused', async () => {
    const res = await request(app).get(`/cash-register/z-report/${s.registerB.id}`).set(as(t.ownerA))
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).not.toContain('openingBalance')
  })
})
