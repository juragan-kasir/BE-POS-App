process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// E2E audit (2026-10-31): a cashier saw another business's 2,021
// notifications. Only `admin` and `user` were filtered by store — a kasir
// listed, counted and marked-all-read every store's notifications. Searching
// also failed with 500 (it filtered a non-existent `message` column).

const SUFFIX = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`
let ownStore = null
let otherStore = null
let kasirToken = null
const userIds = []
const notificationIds = []

const as = (method, path) =>
  request(app)[method](path).set('Authorization', `Bearer ${kasirToken}`)

const notify = async (store, title) => {
  const row = await db.notification.create({
    store: store.id,
    type: 'info',
    title,
    description: `${title} description`,
    isRead: false
  })
  notificationIds.push(row.id)
  return row
}

beforeAll(async () => {
  ownStore = await db.location.create({ name: `NKS_OWN_${SUFFIX}`, status: 'active' })
  otherStore = await db.location.create({ name: `NKS_OTHER_${SUFFIX}`, status: 'active' })
  const kasir = await db.user.create({
    userName: `nks_kasir_${SUFFIX}`,
    email: `nks_kasir_${SUFFIX}@test.com`,
    roleType: 'kasir',
    userType: 'user',
    store: ownStore.id,
    status: 'active'
  })
  userIds.push(kasir.id)
  kasirToken = await signSessionToken(
    { id: kasir.id, userName: kasir.userName, roleType: 'kasir', store: ownStore.id },
    JWT_SECRET
  )
  await notify(ownStore, `NKS own ${SUFFIX}`)
  await notify(otherStore, `NKS other ${SUFFIX}`)
})

afterAll(async () => {
  await db.notification.destroy({ where: { id: notificationIds }, force: true })
  await db.authorizationContextSession.destroy({ where: { userId: userIds } })
  await db.user.destroy({ where: { id: userIds }, force: true })
  await db.location.destroy({ where: { id: [ownStore.id, otherStore.id] }, force: true })
})

describe('a kasir only sees and touches their own store notifications', () => {
  test('the list holds only their store', async () => {
    const res = await as('get', '/notification').query({ limit: 100, search: `NKS` })
    expect(res.status).toBe(200)
    const stores = res.body.data.map((n) => n.store)
    expect(stores).toContain(ownStore.id)
    expect(stores).not.toContain(otherStore.id)
  })

  test('the unread count counts only their store', async () => {
    const res = await as('get', '/notification/unread')
    expect(res.status).toBe(200)
    const ownUnread = await db.notification.count({ where: { store: ownStore.id, isRead: false } })
    expect(res.body.data.unreadCount).toBe(ownUnread)
  })

  test('mark all as read leaves another store untouched', async () => {
    const res = await as('put', '/notification/read-all')
    expect(res.status).toBe(200)
    const other = await db.notification.findOne({ where: { store: otherStore.id } })
    expect(other.isRead).toBe(false)
    const own = await db.notification.findOne({ where: { store: ownStore.id } })
    expect(own.isRead).toBe(true)
  })
})
