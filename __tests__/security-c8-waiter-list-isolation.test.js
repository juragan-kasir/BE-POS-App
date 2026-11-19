process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// C-8 regression — public waiter-request/customer-list cross-tenant read.
//
// GET /waiter-request/customer-list is unauthenticated and accepted a
// client `store` (+ optional `tableId`), so an attacker could enumerate store
// ids and dump ANY tenant's waiter requests (customerName, orderId, notes,
// type, status) — a cross-tenant PII disclosure with no auth at all.
//
// Remediation (preserves the legitimate customer "see my table's requests"
// flow): require BOTH store and tableId, verify the table physically belongs
// to that store (same capability check as customer-create), and return only
// that exact table's requests. This removes the store-only mass dump and the
// store-A/table-B cross-tenant mismatch.

const request = require('supertest')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

let storeA = null
let storeB = null
let tableA = null
let tableB = null
let reqA = null
let reqB = null

beforeAll(async () => {
  storeA = await db.location.create(await withTestTenant({ name: 'C8_STORE_A', status: 'active' }))
  storeB = await db.location.create(await withTestTenant({ name: 'C8_STORE_B', status: 'active' }))
  tableA = await db.table.create({ store: storeA.id, name: 'C8_TABLE_A' })
  tableB = await db.table.create({ store: storeB.id, name: 'C8_TABLE_B' })
  reqA = await db.waiter_request.create({
    store: [storeA.id],
    requestNumber: `C8WR-A-${Date.now()}`,
    tableId: tableA.id,
    type: 'bill',
    customerName: 'C8_Secret_Customer_A',
    notes: 'C8_SECRET_NOTE_A',
    status: 'pending'
  })
  reqB = await db.waiter_request.create({
    store: [storeB.id],
    requestNumber: `C8WR-B-${Date.now()}`,
    tableId: tableB.id,
    type: 'refill',
    customerName: 'C8_Secret_Customer_B',
    notes: 'C8_SECRET_NOTE_B',
    status: 'pending'
  })
})

afterAll(async () => {
  await db.waiter_request.destroy({ where: { id: [reqA?.id, reqB?.id] }, force: true })
  await db.table.destroy({ where: { id: [tableA?.id, tableB?.id] }, force: true })
  await db.location.destroy({ where: { id: [storeA?.id, storeB?.id] }, force: true })
})

describe('C-8 waiter-request/customer-list tenant isolation', () => {
  test('store-only listing (no tableId) is rejected — prevents mass dump', async () => {
    const res = await request(app)
      .get('/waiter-request/customer-list')
      .query({ store: storeA.id })
    expect(res.status).toBe(400)
  })

  test('store A + table B (mismatch, cross-tenant) is rejected', async () => {
    const res = await request(app)
      .get('/waiter-request/customer-list')
      .query({ store: storeA.id, tableId: tableB.id })
    expect(res.status).toBe(400)
  })

  test('valid own table returns only that table\'s requests (its own store rows)', async () => {
    const res = await request(app)
      .get('/waiter-request/customer-list')
      .query({ store: storeA.id, tableId: tableA.id })
    expect(res.status).toBe(200)
    const data = res.body.data || []
    expect(data.length).toBe(1)
    expect(data[0].id).toBe(reqA.id)
    expect(data[0].customerName).toBe('C8_Secret_Customer_A')
  })

  test('does NOT leak another store\'s customer rows via a valid table match', async () => {
    const res = await request(app)
      .get('/waiter-request/customer-list')
      .query({ store: storeA.id, tableId: tableA.id })
    const data = res.body.data || []
    const names = data.map((r) => r.customerName)
    expect(names).not.toContain('C8_Secret_Customer_B')
  })

  test('missing store is rejected', async () => {
    const res = await request(app)
      .get('/waiter-request/customer-list')
      .query({ tableId: tableA.id })
    expect(res.status).toBe(400)
  })
})
