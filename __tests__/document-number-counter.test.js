'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// W3-6 (BE audit S-06, FIXING-PLAN K8, migration 20261119000006 / batch
// B24): document numbers come from a counter per outlet, per type, per
// outlet-local business day — <PREFIX>-<storeId>-<YYMMDD>-<seq>. The old
// timestamp+random generators shared a tiny random space across every outlet
// of every tenant and collided on the global unique indexes at volume.
const request = require('supertest')
const { withIdempotencyKey } = require('../test-helpers/idempotency')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')
const { nextDocumentNumber } = require('../utils/documentNumber')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const uniq = (k) => `dnc_${k}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
const f = {}
const NOON_UTC = new Date('2026-11-19T05:00:00Z') // 12:00 in Asia/Jakarta

beforeAll(async () => {
  f.stores = []
  for (let i = 0; i < 5; i++) {
    f.stores.push(await db.location.create(await withTestTenant({ name: uniq(`S${i}`), status: 'active', timezone: 'Asia/Jakarta' })))
  }
  f.category = await db.category.create({ name: uniq('CAT') })
  f.product = await db.product.create({ nameProduct: uniq('P'), category: f.category.id, price: 10000, stock: 100 })
  await db.product_store_stock.create({ product: f.product.id, store: f.stores[0].id, stock: 100 })
  await db.taxConfig.create({ name: uniq('PPN'), rate: 11, type: 'ppn', status: 'active', store: f.stores[0].id })
  f.cashier = await db.user.create({
    userName: uniq('kasir'), email: `${uniq('kasir')}@test.com`, roleType: 'kasir', userType: 'user',
    store: f.stores[0].id, status: 'active', fullName: 'kasir dnc'
  })
  f.token = await signSessionToken(
    { id: f.cashier.id, userName: f.cashier.userName, roleType: 'kasir', store: f.stores[0].id },
    JWT_SECRET
  )
  await db.cashRegister.create({ store: f.stores[0].id, user: f.cashier.id, status: 'open', openingBalance: 0, openedAt: new Date() })
})

afterAll(async () => {
  const stores = f.stores.map((s) => s.id)
  const orders = await db.order.findAll({ where: { store: stores }, attributes: ['id'], paranoid: false })
  const oids = orders.map((o) => o.id)
  await db.transaction.destroy({ where: { order: oids }, force: true })
  await db.order_item.destroy({ where: { order: oids }, force: true })
  await db.order_status.destroy({ where: { order: oids }, force: true })
  await db.order.destroy({ where: { id: oids }, force: true })
  await db.sequelize.query('DELETE FROM document_counter WHERE store IN (:stores)', { replacements: { stores } })
  await db.cashRegister.destroy({ where: { store: stores }, force: true })
  await db.taxConfig.destroy({ where: { store: stores }, force: true })
  await db.stock_history.destroy({ where: { product: f.product.id }, force: true })
  await db.best_selling.destroy({ where: { productId: f.product.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: f.product.id }, force: true })
  await db.product.destroy({ where: { id: f.product.id }, force: true })
  await db.category.destroy({ where: { id: f.category.id }, force: true })
  await db.authorizationContextSession.destroy({ where: { userId: f.cashier.id } })
  await db.user.destroy({ where: { id: f.cashier.id }, force: true })
  await db.location.destroy({ where: { id: stores }, force: true })
  await db.sequelize.close()
})

test('format: <PREFIX>-<storeId>-<outlet-local YYMMDD>-<seq ≥ 4 digits>, restarting per outlet and per type', async () => {
  const [s0, s1] = f.stores
  expect(await nextDocumentNumber('delivery', s0.id, { now: NOON_UTC })).toBe(`DLV-${s0.id}-261119-0001`)
  expect(await nextDocumentNumber('delivery', s0.id, { now: NOON_UTC })).toBe(`DLV-${s0.id}-261119-0002`)
  expect(await nextDocumentNumber('delivery', s1.id, { now: NOON_UTC })).toBe(`DLV-${s1.id}-261119-0001`)
  expect(await nextDocumentNumber('goods_request', s0.id, { now: NOON_UTC })).toBe(`PB-${s0.id}-261119-0001`)
  // 23:30 UTC on the 19th is already the 20th in Jakarta (PGA-29).
  expect(await nextDocumentNumber('delivery', s0.id, { now: new Date('2026-11-19T23:30:00Z') })).toBe(`DLV-${s0.id}-261120-0001`)
})

test('an unknown type is a programming error, not a silent number', async () => {
  await expect(nextDocumentNumber('nope', f.stores[0].id)).rejects.toThrow(/unknown document type/)
})

test('1.000 parallel numbers over 5 outlets: 0 duplicates, each outlet gets 1…200 exactly', async () => {
  const now = new Date('2026-11-21T05:00:00Z')
  const calls = []
  for (let i = 0; i < 1000; i++) calls.push(nextDocumentNumber('waiter_request', f.stores[i % 5].id, { now }))
  const numbers = await Promise.all(calls)
  expect(new Set(numbers).size).toBe(1000)
  for (const store of f.stores) {
    const seqs = numbers
      .filter((n) => n.startsWith(`WR-${store.id}-`))
      .map((n) => Number(n.split('-').pop()))
      .sort((a, b) => a - b)
    expect(seqs).toEqual(Array.from({ length: 200 }, (_, i) => i + 1))
  }
})

test('a rolled-back transaction does not burn the number', async () => {
  const store = f.stores[2].id
  const now = new Date('2026-11-22T05:00:00Z')
  await db.sequelize
    .transaction(async (t) => {
      expect(await nextDocumentNumber('business_trip', store, { transaction: t, now })).toBe(`BT-${store}-261122-0001`)
      throw new Error('rollback')
    })
    .catch(() => {})
  expect(await nextDocumentNumber('business_trip', store, { now })).toBe(`BT-${store}-261122-0001`)
})

test('a real counter sale gets ORD-<store>-<date>-<seq>', async () => {
  const res = await request(app)
    .post('/order/create')
    .set('Authorization', `Bearer ${f.token}`)
    .send(withIdempotencyKey({
      store: f.stores[0].id,
      items: [{ product: f.product.id, quantity: 1 }],
      paymentMethod: 'cash',
      cashierName: 'kasir dnc'
    }))
  expect(res.status).toBe(201)
  expect(res.body.data.orderNumber).toMatch(new RegExp(`^ORD-${f.stores[0].id}-\\d{6}-\\d{4,}$`))
})
