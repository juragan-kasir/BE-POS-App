'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// W3-6b (BE audit S-06, FIXING-PLAN K8, migration 20261119000007 / batch
// B25): queue numbers come from the outlet's daily counter — "Q001", "Q002",
// … restarting per outlet per business day — and are unique per
// ("storeId", "businessDate"). The old Q<HHmm>-<3 random digits> was unique
// globally across every outlet, forever.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { nextQueueNumber } = require('../utils/documentNumber')
const { getStoreLocalDate } = require('../utils/businessDate')
const migration = require('../db/migrations/20261119000007-queue-daily-number')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const uniq = (k) => `qdn_${k}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
const f = {}

const makeCashier = async (store) => {
  const user = await db.user.create({
    userName: uniq('kasir'), email: `${uniq('kasir')}@test.com`, roleType: 'kasir', userType: 'user',
    store: store.id, status: 'active', fullName: 'kasir qdn'
  })
  const token = await signSessionToken({ id: user.id, userName: user.userName, roleType: 'kasir', store: store.id }, JWT_SECRET)
  return { user, token }
}

const addToQueue = (who, store, name = 'Tamu') =>
  request(app).post('/queue').set('Authorization', `Bearer ${who.token}`).send({ store: store.id, customerName: name, partySize: 2 })

beforeAll(async () => {
  f.a = await db.location.create({ name: uniq('A'), status: 'active', timezone: 'Asia/Jakarta' })
  f.b = await db.location.create({ name: uniq('B'), status: 'active', timezone: 'Asia/Jakarta' })
  f.ka = await makeCashier(f.a)
  f.kb = await makeCashier(f.b)
})

afterAll(async () => {
  const stores = [f.a.id, f.b.id]
  await db.queue.destroy({ where: { storeId: stores }, force: true })
  await db.sequelize.query('DELETE FROM document_counter WHERE store IN (:stores)', { replacements: { stores } })
  for (const k of [f.ka, f.kb]) {
    await db.authorizationContextSession.destroy({ where: { userId: k.user.id } })
    await db.user.destroy({ where: { id: k.user.id }, force: true })
  }
  await db.location.destroy({ where: { id: stores }, force: true })
  await db.sequelize.close()
})

test('the unique index is per outlet per business day; the global one is gone', async () => {
  const rows = await db.sequelize.query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'queue'`, {
    type: db.sequelize.QueryTypes.SELECT
  })
  const byName = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]))
  expect(byName.queue_queue_number).toBeUndefined()
  expect(byName.uq_queue_store_day_number).toMatch(/UNIQUE.*"storeId", "businessDate", "queueNumber".*"deletedAt" IS NULL/)
})

test('each outlet numbers its own queue Q001, Q002, … with its business day', async () => {
  const a1 = await addToQueue(f.ka, f.a, 'A satu')
  const a2 = await addToQueue(f.ka, f.a, 'A dua')
  const b1 = await addToQueue(f.kb, f.b, 'B satu')
  expect([a1.status, a2.status, b1.status]).toEqual([201, 201, 201])
  expect(a1.body.data.queueNumber).toBe('Q001')
  expect(a2.body.data.queueNumber).toBe('Q002')
  expect(b1.body.data.queueNumber).toBe('Q001')

  const row = await db.queue.findByPk(a1.body.data.id)
  expect(row.storeId).toBe(f.a.id)
  expect(row.businessDate).toBe(getStoreLocalDate('Asia/Jakarta'))
  // store is a one-element JSONB array — the shape the list query matches
  expect(row.store).toEqual([f.a.id])
})

test('a created entry shows up in its outlet list and not in another outlet', async () => {
  const created = await addToQueue(f.ka, f.a, 'Cek daftar')
  const listA = await request(app).get('/queue').set('Authorization', `Bearer ${f.ka.token}`).query({ store: f.a.id })
  expect(listA.status).toBe(200)
  expect(listA.body.data.map((q) => q.id)).toContain(created.body.data.id)
  const listB = await request(app).get('/queue').set('Authorization', `Bearer ${f.kb.token}`).query({ store: f.b.id })
  expect(listB.body.data.map((q) => q.id)).not.toContain(created.body.data.id)
})

// 25 > pool max 20: before the timezone lookup ran inside the caller's
// transaction, this starved the pool and timed out.
test('25 parallel check-ins at one outlet: 25 distinct numbers, no 500', async () => {
  const before = await db.queue.count({ where: { storeId: f.b.id } })
  const res = await Promise.all(Array.from({ length: 25 }, (_, i) => addToQueue(f.kb, f.b, `Paralel ${i}`)))
  expect(res.map((r) => r.status)).toEqual(Array(25).fill(201))
  const numbers = res.map((r) => r.body.data.queueNumber)
  expect(new Set(numbers).size).toBe(25)
  const expected = Array.from({ length: 25 }, (_, i) => `Q${String(before + i + 1).padStart(3, '0')}`)
  expect([...numbers].sort()).toEqual(expected)
})

test('40 concurrent counter transactions (pool max 20) all succeed: the timezone lookup rides the caller transaction', async () => {
  // Before: resolveStoreTimezone ran outside the transaction and needed a
  // second pool connection; 20 open transactions waiting for it starved the
  // pool (2/40 ok, the rest SequelizeConnectionAcquireTimeoutError at 30 s).
  const loc = await db.location.create({ name: uniq('POOL'), status: 'active', timezone: 'Asia/Jakarta' })
  try {
    const started = Date.now()
    const results = await Promise.all(
      Array.from({ length: 40 }, () => db.sequelize.transaction((transaction) => nextQueueNumber(loc.id, { transaction })))
    )
    expect(new Set(results.map((r) => r.queueNumber)).size).toBe(40)
    expect(Date.now() - started).toBeLessThan(10000)
  } finally {
    await db.sequelize.query('DELETE FROM document_counter WHERE store = :s', { replacements: { s: loc.id } })
    await loc.destroy({ force: true })
  }
})

test('the counter restarts the next business day', async () => {
  const tomorrow = new Date(Date.now() + 86400000)
  const next = await nextQueueNumber(f.a.id, { now: tomorrow })
  expect(next.queueNumber).toBe('Q001')
  expect(next.businessDate).toBe(getStoreLocalDate('Asia/Jakarta', tomorrow))
})

test('migration backfill + replay: legacy rows get storeId/businessDate and a bare-number store becomes an array', async () => {
  const [[legacy]] = await db.sequelize.query(
    `INSERT INTO queue (store, "queueNumber", "customerName", "partySize", status, "checkedInAt", "createdAt", "updatedAt")
     VALUES ($1::jsonb, $2, 'Lama', 1, 'waiting', '2026-11-18T18:30:00Z', NOW(), NOW()) RETURNING id`,
    { bind: [String(f.a.id), uniq('Q').slice(0, 20)] }
  )
  const qi = db.sequelize.getQueryInterface()
  await migration.up(qi, db.Sequelize)
  await migration.up(qi, db.Sequelize) // replay-safe
  const row = await db.queue.findByPk(legacy.id)
  expect(row.store).toEqual([f.a.id])
  expect(row.storeId).toBe(f.a.id)
  // 18:30 UTC on 11-18 is 01:30 on 11-19 in Jakarta
  expect(row.businessDate).toBe('2026-11-19')
})
