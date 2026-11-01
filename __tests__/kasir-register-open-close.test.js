process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

// Q-FIN-05 (product owner, 2026-11-01): a cashier opens and closes their own
// store's register when their role grants "Tambah" on Kas Register; the close
// is a blind count, so the counted cash must be stated. Cash movements stay
// with admins, and another store's register stays out of reach.

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
let seq = 0
const unique = (p) => `${p}_${Date.now()}_${++seq}`

const REGISTER_MENU = '/cash-register/current'
const cashierMenu = (canOpen) => [
  { menu: '/home', view: true, add: true },
  { menu: REGISTER_MENU, view: true, add: canOpen }
]

let store
let otherStore
const users = []

const cashier = async ({ canOpen = true, home = store } = {}) => {
  const user = await db.user.create({
    userName: unique('krg'),
    email: `${unique('krg')}@test.com`,
    roleType: 'kasir',
    userType: 'user',
    store: home.id,
    status: 'active',
    accessMenu: cashierMenu(canOpen)
  })
  users.push(user.id)
  return signSessionToken(
    { id: user.id, userName: user.userName, roleType: 'kasir', store: home.id },
    JWT_SECRET
  )
}

const as = (token, method, path, query) =>
  request(app)[method](path).set('Authorization', `Bearer ${token}`).query(query)

const openFor = (token, target = store) =>
  as(token, 'post', '/cash-register/open', { store: target.id }).send({ openingBalance: 100000 })

const closeFor = (token, id, body) =>
  as(token, 'put', `/cash-register/close/${id}`, { store: store.id }).send(body)

beforeAll(async () => {
  store = await db.location.create({ name: unique('KRG_STORE'), status: 'active' })
  otherStore = await db.location.create({ name: unique('KRG_OTHER'), status: 'active' })
})

afterEach(async () => {
  await db.cashMovement.destroy({ where: { store: [store.id, otherStore.id] }, force: true })
  await db.cashRegister.destroy({ where: { store: [store.id, otherStore.id] }, force: true })
})

afterAll(async () => {
  await db.auditLog.destroy({ where: { userId: users }, force: true, __auditMaintenance: true })
  await db.authorizationContextSession.destroy({ where: { userId: users } })
  await db.user.destroy({ where: { id: users }, force: true })
  await db.location.destroy({ where: { id: [store.id, otherStore.id] }, force: true })
})

describe('cashier opens and closes their own register (Q-FIN-05)', () => {
  test('a cashier whose role grants it opens, then closes with the counted cash', async () => {
    const token = await cashier()
    const opened = await openFor(token)
    expect(opened.status).toBe(201)

    const closed = await closeFor(token, opened.body.data.id, { closingBalance: 100000 })
    expect(closed.status).toBe(200)
    const register = await db.cashRegister.findByPk(opened.body.data.id)
    expect(register.status).toBe('closed')
    expect(Number(register.closingBalance)).toBe(100000)
  })

  test('a cashier close without the counted cash is refused and the register stays open', async () => {
    const token = await cashier()
    const opened = await openFor(token)

    const res = await closeFor(token, opened.body.data.id, {})
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('CLOSING_BALANCE_REQUIRED')
    expect((await db.cashRegister.findByPk(opened.body.data.id)).status).toBe('open')
  })

  test('a counted zero is a valid blind count', async () => {
    const token = await cashier()
    const opened = await openFor(token)
    const res = await closeFor(token, opened.body.data.id, { closingBalance: 0 })
    expect(res.status).toBe(200)
  })

  test('a cashier whose role does not grant "Tambah" on Kas Register cannot open', async () => {
    const token = await cashier({ canOpen: false })
    const res = await openFor(token)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('MENU_ACTION_DENIED')
    expect(await db.cashRegister.count({ where: { store: store.id } })).toBe(0)
  })

  test("a cashier cannot open another store's register", async () => {
    const token = await cashier()
    const res = await openFor(token, otherStore)
    expect(res.status).toBe(403)
    expect(await db.cashRegister.count({ where: { store: otherStore.id } })).toBe(0)
  })

  test('cash movements stay with admins', async () => {
    const token = await cashier()
    const opened = await openFor(token)
    const res = await as(token, 'post', `/cash-register/${opened.body.data.id}/movement`, {
      store: store.id
    }).send({ type: 'cash_in', amount: 10000, reasonCode: 'other', notes: 'test' })
    expect(res.status).toBe(403)
  })
})
