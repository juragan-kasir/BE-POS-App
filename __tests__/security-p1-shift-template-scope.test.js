process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let store1 = null
let store2 = null
let admin1 = null
let superAdmin = null
let admin1Token = null
let superToken = null
let ownTemplate = null
let foreignTemplate = null
let globalTemplate = null

beforeAll(async () => {
  store1 = await db.location.create({ name: 'TPL_SCOPE_STORE_1', status: 'active' })
  store2 = await db.location.create({ name: 'TPL_SCOPE_STORE_2', status: 'active' })

  admin1 = await db.user.create({
    id: 99011,
    userName: 'tpl_scope_admin1',
    email: 'tpl_scope_admin1@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store1.id,
    status: 'active',
    fullName: 'TPL_SCOPE_ADMIN_1'
  })
  superAdmin = await db.user.create({
    id: 99010,
    userName: 'tpl_scope_super',
    email: 'tpl_scope_super@test.com',
    roleType: 'super_admin',
    userType: 'admin',
    store: null,
    status: 'active',
    fullName: 'TPL_SCOPE_SUPER'
  })

  admin1Token = await signSessionToken(
    { id: admin1.id, userName: admin1.userName, roleType: 'admin', store: store1.id },
    JWT_SECRET
  )
  superToken = await signSessionToken(
    { id: superAdmin.id, userName: superAdmin.userName, roleType: 'super_admin' },
    JWT_SECRET
  )

  ownTemplate = await db.shift_template.create({
    store: store1.id,
    name: 'TPL_SCOPE_OWN',
    startTime: '08:00',
    endTime: '16:00'
  })
  foreignTemplate = await db.shift_template.create({
    store: store2.id,
    name: 'TPL_SCOPE_FOREIGN',
    startTime: '16:00',
    endTime: '00:00'
  })
  globalTemplate = await db.shift_template.create({
    store: null,
    name: 'TPL_SCOPE_GLOBAL',
    startTime: '00:00',
    endTime: '08:00'
  })
})

afterAll(async () => {
  await db.shift_template.destroy({
    where: { id: [ownTemplate?.id, foreignTemplate?.id, globalTemplate?.id].filter(Boolean) },
    force: true
  })
  await db.user.destroy({ where: { id: [99010, 99011] }, force: true })
  await db.location.destroy({
    where: { id: [store1?.id, store2?.id].filter(Boolean) },
    force: true
  })
})

describe('shift template store scoping', () => {
  test('store 1 admin list excludes store 2 templates but includes global + own', async () => {
    const res = await request(app)
      .get('/shift-template/get-shift-template')
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(200)
    const ids = res.body.data.map((t) => t.id)
    expect(ids).toContain(ownTemplate.id)
    expect(ids).toContain(globalTemplate.id)
    expect(ids).not.toContain(foreignTemplate.id)
  })

  test('store 1 admin table list excludes store 2 templates', async () => {
    const res = await request(app)
      .get('/shift-template/get-shift-template-all')
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(200)
    const ids = res.body.data.map((t) => t.id)
    expect(ids).toContain(ownTemplate.id)
    expect(ids).toContain(globalTemplate.id)
    expect(ids).not.toContain(foreignTemplate.id)
  })

  test('store 1 admin cannot read store 2 template by id', async () => {
    const res = await request(app)
      .get(`/shift-template/get-shift-template/${foreignTemplate.id}`)
      .set('Authorization', `Bearer ${admin1Token}`)

    expect(res.status).toBe(404)
  })

  test('store 1 admin create without store is pinned to own store, not global', async () => {
    const res = await request(app)
      .post('/shift-template/add-new-shift-template')
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({
        name: 'TPL_SCOPE_PINNED',
        startTime: '09:00',
        endTime: '17:00'
      })

    expect(res.status).toBe(200)
    expect(res.body.data.store).toBe(store1.id)
    const row = await db.shift_template.findByPk(res.body.data.id)
    expect(row.store).toBe(store1.id)
    await row.destroy({ force: true })
  })

  test('store 1 admin cannot create a store 2 template', async () => {
    const before = await db.shift_template.count({ where: { store: store2.id } })
    const res = await request(app)
      .post('/shift-template/add-new-shift-template')
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({
        store: store2.id,
        name: 'TPL_SCOPE_FOREIGN_CREATE',
        startTime: '09:00',
        endTime: '17:00'
      })

    expect(res.status).toBe(403)
    const after = await db.shift_template.count({ where: { store: store2.id } })
    expect(after).toBe(before)
  })

  test('store 1 admin cannot move own template to store 2', async () => {
    const res = await request(app)
      .put(`/shift-template/edit-shift-template/${ownTemplate.id}`)
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({
        name: 'TPL_SCOPE_OWN_RENAMED',
        startTime: '08:00',
        endTime: '16:00',
        store: store2.id
      })

    expect(res.status).toBe(403)
    const row = await db.shift_template.findByPk(ownTemplate.id)
    expect(row.store).toBe(store1.id)
    expect(row.name).toBe('TPL_SCOPE_OWN')
  })

  test('global super_admin still sees every template', async () => {
    const res = await request(app)
      .get('/shift-template/get-shift-template-all')
      .set('Authorization', `Bearer ${superToken}`)

    expect(res.status).toBe(200)
    const ids = res.body.data.map((t) => t.id)
    expect(ids).toContain(ownTemplate.id)
    expect(ids).toContain(foreignTemplate.id)
    expect(ids).toContain(globalTemplate.id)
  })
})
