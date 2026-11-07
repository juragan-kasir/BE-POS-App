process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// PGA-26 (product-grade audit 2026-11-02): the BISA header and the cashier
// queue rendered the raw table id ("Meja 10") because nothing could resolve
// the table's display name. This public, store-scoped lookup is what the
// order app calls.

const request = require('supertest')
const app = require('../api/index')
const db = require('../db/models')

let store = null
let otherStore = null
let table = null
let foreignTable = null

const lookup = (query) => request(app).get('/order/customer-table').query(query)

beforeAll(async () => {
  store = await db.location.create({ name: 'PGA26_STORE_A', status: 'active' })
  otherStore = await db.location.create({ name: 'PGA26_STORE_B', status: 'active' })
  table = await db.table.create({ name: 'K3-4', store: store.id })
  foreignTable = await db.table.create({ name: 'K9-9', store: otherStore.id })
})

afterAll(async () => {
  if (table || foreignTable) {
    await db.table.destroy({
      where: { id: [table?.id, foreignTable?.id].filter(Boolean) }
    })
  }
  if (store || otherStore) {
    await db.location.destroy({
      where: { id: [store?.id, otherStore?.id].filter(Boolean) }
    })
  }
})

test('resolves the table name for a table in the given store', async () => {
  const res = await lookup({ store: store.id, tableId: table.id })
  expect(res.status).toBe(200)
  expect(res.body.success).toBe(true)
  expect(res.body.data).toEqual({ id: table.id, name: 'K3-4' })
})

test('rejects a missing or non-numeric scope', async () => {
  const missing = await lookup({ store: store.id })
  expect(missing.status).toBe(400)
  expect(missing.body.code).toBe('VALIDATION_ERROR')

  const nonNumeric = await lookup({ store: 'abc', tableId: table.id })
  expect(nonNumeric.status).toBe(400)
  expect(nonNumeric.body.code).toBe('VALIDATION_ERROR')
})

test('does not leak a table belonging to another store', async () => {
  const res = await lookup({ store: store.id, tableId: foreignTable.id })
  expect(res.status).toBe(404)
  expect(res.body.code).toBe('TABLE_NOT_FOUND')
})
