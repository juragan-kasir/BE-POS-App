process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// Field length audit 2026-10-24: a string longer than its VARCHAR column
// failed in Postgres (22001) and every controller answered 500. Model hooks
// now refuse the write first and the request answers 400 VALUE_TOO_LONG with
// the field and its limit; nothing is written.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { valueTooLongFromError, findTooLong } = require('../utils/valueTooLong')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const TAG = `VTL_${Date.now()}`
let store
let adminUser
let token
const categoryIds = []

// POST /accounting/accounts has no schema, so only the net guards its
// VARCHAR columns (account.name 255, account.code 20).
const addAccount = (body) =>
  request(app)
    .post('/accounting/accounts')
    .set('Authorization', `Bearer ${token}`)
    .send({ code: `${TAG}`.slice(-10) + Math.floor(Math.random() * 1e6), type: 'asset', normalBalance: 'debit', ...body })

beforeAll(async () => {
  store = await db.location.create({ name: `${TAG}_STORE`, status: 'active' })
  adminUser = await db.user.create({
    userName: `${TAG}_admin`,
    email: `${TAG}_admin@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active',
    fullName: 'VTL admin'
  })
  token = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.account.destroy({ where: { store: store.id }, force: true })
  const rows = await db.category.findAll({ where: { name: { [db.Sequelize.Op.like]: `${TAG}%` } }, paranoid: false })
  const ids = [...categoryIds, ...rows.map((r) => r.id)]
  if (db.category_store) await db.category_store.destroy({ where: { category: ids }, force: true })
  await db.category.destroy({ where: { id: ids }, force: true })
  await db.authorizationContextSession.destroy({ where: { userId: adminUser.id } })
  await db.user.destroy({ where: { id: adminUser.id }, force: true })
  await db.location.destroy({ where: { id: store.id }, force: true })
})

describe('a value longer than its column', () => {
  test('is refused with 400 VALUE_TOO_LONG naming the field, and nothing is saved', async () => {
    const name = `${TAG}_${'x'.repeat(300)}`
    const res = await addAccount({ name })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({
      success: false,
      code: 'VALUE_TOO_LONG',
      field: 'name',
      max: 255,
      errors: [{ field: 'name' }]
    })
    expect(await db.account.count({ where: { name } })).toBe(0)
  })

  test('a narrow column reports its own limit (account.code is VARCHAR(20))', async () => {
    const res = await addAccount({ name: `${TAG}_code`, code: 'C'.repeat(25) })
    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ code: 'VALUE_TOO_LONG', field: 'code', max: 20 })
  })

  test('exactly at the limit is saved', async () => {
    const name = `${TAG}_`.padEnd(255, 'y')
    const res = await addAccount({ name })
    expect(res.status).toBe(201)
    expect(await db.account.count({ where: { name } })).toBe(1)
  })

  test('characters are counted like Postgres: 255 emoji fit a VARCHAR(255)', async () => {
    const name = `${TAG}`.slice(0, 4) + '😀'.repeat(251)
    expect([...name]).toHaveLength(255)
    expect(name.length).toBeGreaterThan(255) // UTF-16 units
    const res = await addAccount({ name })
    expect(res.status).toBe(201)
  })

  test('only trailing spaces past the limit are accepted, as Postgres trims them', async () => {
    const name = `${TAG}_`.padEnd(255, 'z') + '    '
    const res = await addAccount({ name })
    expect(res.status).toBe(201)
  })

  test('Model.update and bulkCreate are refused too', async () => {
    const row = await db.category.create({ name: `${TAG}_update` })
    categoryIds.push(row.id)
    await expect(
      db.category.update({ color: 'c'.repeat(21) }, { where: { id: row.id } })
    ).rejects.toMatchObject({ code: 'VALUE_TOO_LONG', field: 'color', max: 20 })
    await expect(
      db.category.bulkCreate([{ name: `${TAG}_ok` }, { name: `${TAG}_bad`, color: 'c'.repeat(21) }])
    ).rejects.toMatchObject({ code: 'VALUE_TOO_LONG', field: 'color' })
    expect(await db.category.count({ where: { name: `${TAG}_ok` } })).toBe(0)
  })

  test('TEXT columns have no limit here', () => {
    expect(findTooLong(db.product, { description: 'd'.repeat(5000) })).toBeNull()
    expect(findTooLong(db.bom_header, { notes: 'n'.repeat(5000) })).toBeNull()
  })

  test('a raw-SQL 22001 maps to 400 with the column limit', () => {
    const error = { name: 'SequelizeDatabaseError', parent: { code: '22001', message: 'value too long for type character varying(20)' } }
    expect(valueTooLongFromError(error)).toEqual({ field: null, max: 20 })
    expect(valueTooLongFromError({ parent: { code: '23505' } })).toBeNull()
  })
})
