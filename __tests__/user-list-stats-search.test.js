process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// GET /auth/get-all-user backs the User List page (FE AdminList), which
// reads `stats`, `total` and `pagination` and sends page/limit/search. The
// endpoint returned only `data`, so every summary card read 0 and the
// search box and pager did nothing.

const PREFIX = `uls_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
let seq = 0
const unique = (key) => `${PREFIX}_${key}_${++seq}`.toLowerCase()

let store = null
let token = null
const createdUserIds = []

const makeUser = async (key, attrs) => {
  const name = unique(key)
  const row = await db.user.create({
    userName: name,
    email: `${name}@test.com`,
    password: 'Rahasia123!',
    fullName: name,
    roleType: 'user',
    userType: 'user',
    status: 'active',
    store: store.id,
    ...attrs
  })
  createdUserIds.push(row.id)
  return row
}

beforeAll(async () => {
  store = await db.location.create({ name: unique('STORE'), status: 'active' })
  // A store-bound super_admin sees its own store's non-super_admin users:
  // a fixed audience for exact counts.
  const viewer = await makeUser('viewer', { roleType: 'super_admin', userType: 'admin' })
  token = await signSessionToken({ id: viewer.id, roleType: 'super_admin', store: store.id }, JWT_SECRET)

  await makeUser('kasir_a', { status: 'active' })
  await makeUser('kasir_b', { status: 'active' })
  await makeUser('logged_out', { status: 'inactive' })
  await makeUser('draft', { status: 'pending' })
  await makeUser('needle_disabled', { status: 'active', disabledAt: new Date() })
})

afterAll(async () => {
  await db.user.destroy({ where: { id: createdUserIds }, force: true }).catch(() => {})
  await db.location.destroy({ where: { id: store?.id }, force: true }).catch(() => {})
})

const list = (query = '') =>
  request(app).get(`/auth/get-all-user${query}`).set({ Authorization: `Bearer ${token}` })

test('stats summarise the visible audience with the list badge buckets', async () => {
  const res = await list('?page=1&limit=10&search=')
  expect(res.status).toBe(200)
  // A disabled account is neither active nor pending — it counts as inactive.
  expect(res.body.stats).toEqual({ total: 5, active: 2, pending: 1, inactive: 2, disabled: 1 })
  expect(res.body.total).toBe(5)
  expect(res.body.data.every((u) => u.password === undefined)).toBe(true)
})

test('search narrows the rows and the total, not the summary cards', async () => {
  const res = await list('?page=1&limit=10&search=NEEDLE')
  expect(res.status).toBe(200)
  expect(res.body.data).toHaveLength(1)
  expect(res.body.data[0].userName).toContain('needle_disabled')
  expect(res.body.total).toBe(1)
  expect(res.body.stats.total).toBe(5)
})

test('page and limit page the rows', async () => {
  const first = await list('?page=1&limit=2')
  const third = await list('?page=3&limit=2')
  expect(first.body.data).toHaveLength(2)
  expect(third.body.data).toHaveLength(1)
  expect(first.body.pagination).toEqual({ page: 1, limit: 2, total: 5, totalPages: 3 })
  const ids = [...first.body.data, ...third.body.data].map((u) => u.id)
  expect(new Set(ids).size).toBe(3)
})

test('without page/limit the full list is returned as before', async () => {
  const res = await list()
  expect(res.status).toBe(200)
  expect(res.body.data).toHaveLength(5)
  expect(res.body.pagination.totalPages).toBe(1)
})
