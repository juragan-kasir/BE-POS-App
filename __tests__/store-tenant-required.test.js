'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// W3-z / Z2 (BE audit README): a row owned by an existing outlet that has no
// tenant (an unassigned draft outlet) is refused with 422
// STORE_TENANT_REQUIRED before it reaches the database — on every model that
// derives its tenant from a scalar `store` (utils/storeTenant
// attachStoreTenant), and through the HTTP layer even though the controller
// itself answers 500 for any error (storeTenantResponder, DR-28 pattern).
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { StoreTenantRequiredError, STORE_TENANT_REQUIRED } = require('../utils/storeTenant')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const uniq = (k) => `str_${k}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
const f = {}

beforeAll(async () => {
  f.draft = await db.location.create({ name: uniq('DRAFT'), status: 'draft', tenantId: null })
  f.owned = await db.location.create(await withTestTenant({ name: uniq('OWNED'), status: 'active' }))
  const user = await db.user.create({
    userName: uniq('gsa'), email: `${uniq('gsa')}@test.com`, roleType: 'super_admin', userType: 'admin',
    store: null, status: 'active', fullName: 'global sa'
  })
  f.gsa = { user, token: await signSessionToken({ id: user.id, userName: user.userName, roleType: 'super_admin', store: null }, JWT_SECRET) }
})

afterAll(async () => {
  await db.expense.destroy({ where: { store: [f.draft.id, f.owned.id] }, force: true })
  await db.type_payment.destroy({ where: { store: [f.draft.id, f.owned.id] }, force: true })
  await db.type_payment.destroy({ where: { name: { [db.Sequelize.Op.like]: 'str_%' } }, force: true })
  await db.authorizationContextSession.destroy({ where: { userId: f.gsa.user.id } })
  await db.user.destroy({ where: { id: f.gsa.user.id }, force: true })
  await db.location.destroy({ where: { id: [f.draft.id, f.owned.id] }, force: true })
  await db.sequelize.close()
})

const expenseRow = (store) => ({ expenseNumber: uniq('EN').slice(0, 20), name: uniq('EXP'), amount: 1000, store, date: new Date() })

describe('model layer', () => {
  test('create on a tenant-less outlet is refused; nothing is written', async () => {
    await expect(db.expense.create(expenseRow(f.draft.id))).rejects.toBeInstanceOf(StoreTenantRequiredError)
    expect(await db.expense.count({ where: { store: f.draft.id } })).toBe(0)
  })

  test('bulkCreate is refused when any row targets a tenant-less outlet', async () => {
    await expect(db.expense.bulkCreate([expenseRow(f.owned.id), expenseRow(f.draft.id)])).rejects.toMatchObject({
      code: STORE_TENANT_REQUIRED,
      statusCode: 422
    })
  })

  test('moving a row to a tenant-less outlet (instance and static update) is refused', async () => {
    const row = await db.expense.create(expenseRow(f.owned.id))
    expect(row.tenantId).toBe(f.owned.tenantId)
    await expect(row.update({ store: f.draft.id })).rejects.toBeInstanceOf(StoreTenantRequiredError)
    await expect(db.expense.update({ store: f.draft.id }, { where: { id: row.id } })).rejects.toBeInstanceOf(StoreTenantRequiredError)
    expect((await db.expense.findByPk(row.id)).store).toBe(f.owned.id)
  })

  test('an outlet with a tenant, a platform row (store NULL) and an unknown outlet id keep working', async () => {
    const owned = await db.type_payment.create({ name: uniq('TPO'), store: f.owned.id, type: 'cash', status: 'active' })
    expect(owned.tenantId).toBe(f.owned.tenantId)
    const platform = await db.type_payment.create({ name: uniq('TPP'), store: null, type: 'cash', status: 'active' })
    expect(platform.tenantId).toBeNull()
    const unknown = await db.type_payment.create({ name: uniq('TPU'), store: 2147480000, type: 'cash', status: 'active' })
    expect(unknown.tenantId).toBeNull()
    await db.type_payment.destroy({ where: { id: [owned.id, platform.id, unknown.id] }, force: true })
  })
})

describe('HTTP layer', () => {
  test('a write targeting a tenant-less outlet answers 422 STORE_TENANT_REQUIRED, not 500', async () => {
    const name = uniq('TPH')
    const res = await request(app)
      .post('/type-payment/add-new-type-payment')
      .set('Authorization', `Bearer ${f.gsa.token}`)
      .send({ name, type: 'cash', store: [f.draft.id] })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe(STORE_TENANT_REQUIRED)
    expect(res.body.storeId).toBe(f.draft.id)
    expect(await db.type_payment.count({ where: { name } })).toBe(0)
  })

  test('the same write on an outlet with a tenant succeeds', async () => {
    const name = uniq('TPH')
    const res = await request(app)
      .post('/type-payment/add-new-type-payment')
      .set('Authorization', `Bearer ${f.gsa.token}`)
      .send({ name, type: 'cash', store: [f.owned.id] })
    expect(res.status).toBe(200)
    expect((await db.type_payment.findOne({ where: { name } })).tenantId).toBe(f.owned.tenantId)
  })
})
