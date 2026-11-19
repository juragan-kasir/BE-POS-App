process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const util = require('util')
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// SEC-LOG-1 — the application must never write database credentials to its
// logs, and must run on exactly one database pool (db/models' Sequelize).
// Previously config/database.js — required at startup by the best-selling
// controller — console.log'd its full config object (password included,
// POSTGRES_PASSWORD in production) and opened a second, independent pool.

// Deterministic fake secret — never a real credential.
const FAKE_DB_SECRET = 'sec-log-1-fake-db-secret-5d2c91'
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug']

// Loads the whole application in a fresh module registry with the fake
// secret as the active database password, so any module that logs its DB
// configuration at load time would print it. Returns everything logged plus
// the Sequelize instances constructed while loading.
const loadAppIsolated = () => {
  const savedEnv = {
    DB_DEV_PASSWORD: process.env.DB_DEV_PASSWORD,
    POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD
  }
  process.env.DB_DEV_PASSWORD = FAKE_DB_SECRET
  process.env.POSTGRES_PASSWORD = FAKE_DB_SECRET

  const logged = []
  const spies = CONSOLE_METHODS.map((m) =>
    jest.spyOn(console, m).mockImplementation((...args) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 6 }))).join(' '))
    })
  )
  const created = []
  try {
    jest.isolateModules(() => {
      jest.doMock('sequelize', () => {
        const actual = jest.requireActual('sequelize')
        class CountingSequelize extends actual {
          constructor(...args) {
            super(...args)
            created.push(this)
          }
        }
        CountingSequelize.Sequelize = CountingSequelize
        CountingSequelize.default = CountingSequelize
        return CountingSequelize
      })
      require('../api/index')
    })
  } finally {
    spies.forEach((s) => s.mockRestore())
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  return { logged, created }
}

let isolated = null
let store = null
let otherStore = null
let adminToken = null
const orderIds = []

beforeAll(async () => {
  isolated = loadAppIsolated()

  store = await db.location.create(await withTestTenant({ name: `SEC_LOG_1_STORE_${Date.now()}`, status: 'active' }))
  otherStore = await db.location.create(await withTestTenant({ name: `SEC_LOG_1_OTHER_${Date.now()}`, status: 'active' }))

  // P1-4: central gate denies unknown caller identities; this row gives the
  // caller id a real identity. Assertions below are unchanged.
  await db.user.create({
    id: 9801,
    userName: 'sec_log_1_admin',
    email: 'p14-9801-seclog1@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active',
    fullName: 'sec_log_1_admin'
  })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  adminToken = await signSessionToken(
    { id: 9801, userName: 'sec_log_1_admin', roleType: 'admin', store: store.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  // The isolated load never queries, but its pools must still be closed.
  await Promise.all((isolated?.created || []).map((s) => s.close().catch(() => {})))
  await db.user.destroy({ where: { id: [9801] }, force: true })
  await db.order.destroy({ where: { id: orderIds }, force: true })
  await db.location.destroy({ where: { id: [store?.id, otherStore?.id].filter(Boolean) }, force: true })
})

describe('SEC-LOG-1 — database credentials are never logged', () => {
  test('loading the application does not write the database password anywhere to the console', () => {
    expect(isolated.logged.some((line) => line.includes(FAKE_DB_SECRET))).toBe(false)
  })

  test('loading the application does not dump a database configuration object', () => {
    expect(isolated.logged.some((line) => /DB CONFIG/i.test(line))).toBe(false)
  })
})

describe('SEC-LOG-1 — a single database pool', () => {
  test('loading the whole application constructs exactly one Sequelize instance', () => {
    expect(isolated.created).toHaveLength(1)
  })
})

describe('SEC-LOG-1 — best-selling chart still works on the canonical pool', () => {
  const mkPaidOrder = async (storeId, isoDate, totalPrice, paymentStatus = 'paid') => {
    const order = await db.order.create({
      orderNumber: `SECLOG1-${storeId}-${Math.random().toString(36).slice(2, 9)}`,
      store: storeId,
      status: paymentStatus === 'paid' ? 'paid' : 'pending',
      paymentStatus,
      subTotal: totalPrice,
      totalPrice,
      source: 'pos'
    })
    orderIds.push(order.id)
    await db.sequelize.query('UPDATE "order" SET "createdAt" = :at WHERE id = :id', {
      replacements: { at: isoDate, id: order.id }
    })
    return order
  }

  test('GET /best-selling/get-chart-by-year aggregates paid orders per month for the caller store only', async () => {
    await mkPaidOrder(store.id, '2031-03-15T12:00:00+07:00', 10000)
    await mkPaidOrder(store.id, '2031-03-16T12:00:00+07:00', 5000)
    await mkPaidOrder(store.id, '2031-07-15T12:00:00+07:00', 7000)
    await mkPaidOrder(store.id, '2031-07-16T12:00:00+07:00', 99000, 'unpaid')
    await mkPaidOrder(otherStore.id, '2031-03-15T12:00:00+07:00', 123000)

    const res = await request(app)
      .get('/best-selling/get-chart-by-year')
      .query({ year: 2031 })
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(12)
    const byMonth = Object.fromEntries(
      res.body.data.map((r) => [r.month, { total: Number(r.totalAmount), count: Number(r.countCheckout) }])
    )
    expect(byMonth['2031-03']).toEqual({ total: 15000, count: 2 })
    expect(byMonth['2031-07']).toEqual({ total: 7000, count: 1 })
    expect(byMonth['2031-01']).toEqual({ total: 0, count: 0 })
  })
})
