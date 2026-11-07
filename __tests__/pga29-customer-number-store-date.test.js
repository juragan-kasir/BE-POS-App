process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// PGA-29 (product-grade audit 2026-11-02): the daily pickup/customer number
// keyed its counter on the UTC date (`toISOString().slice(0, 10)`), so a
// Jakarta store's sequence reset at 07:00 local instead of at the store's
// own midnight (BR-SALES-011, BR-ORG-004).

const { generateCustomerNumber } = require('../api/controller/order')
const db = require('../db/models')

let jakarta = null
let jayapura = null

const counterDateFor = async (store) => {
  const rows = await db.sequelize.query(
    'SELECT "counterDate" FROM order_daily_counter WHERE store = $1',
    { bind: [store], type: db.sequelize.QueryTypes.SELECT }
  )
  const raw = rows[0]?.counterDate
  if (!raw) return null
  return typeof raw === 'string' ? raw.slice(0, 10) : raw.toISOString().slice(0, 10)
}

beforeAll(async () => {
  jakarta = await db.location.create({
    name: 'PGA29_JAKARTA',
    status: 'active',
    timezone: 'Asia/Jakarta'
  })
  jayapura = await db.location.create({
    name: 'PGA29_JAYAPURA',
    status: 'active',
    timezone: 'Asia/Jayapura'
  })
})

beforeEach(async () => {
  await db.sequelize.query('DELETE FROM order_daily_counter WHERE store IN ($1, $2)', {
    bind: [jakarta.id, jayapura.id]
  })
})

afterAll(async () => {
  await db.sequelize.query('DELETE FROM order_daily_counter WHERE store IN ($1, $2)', {
    bind: [jakarta.id, jayapura.id]
  })
  await db.location.destroy({ where: { id: [jakarta.id, jayapura.id] } })
})

test('the counter key is the store calendar date, not the UTC date', async () => {
  // 16:30Z: Jakarta is still 23:30 on 2026-11-07 while Jayapura is already
  // 01:30 on 2026-11-08. A UTC key gives both stores 2026-11-07.
  const now = new Date('2026-11-07T16:30:00.000Z')
  await generateCustomerNumber(jakarta.id, null, now)
  await generateCustomerNumber(jayapura.id, null, now)
  expect(await counterDateFor(jakarta.id)).toBe('2026-11-07')
  expect(await counterDateFor(jayapura.id)).toBe('2026-11-08')
})

test('a Jakarta store rolls over at its own midnight, not at 07:00 local', async () => {
  const now = new Date('2026-11-07T20:00:00.000Z')
  await generateCustomerNumber(jakarta.id, null, now)
  expect(await counterDateFor(jakarta.id)).toBe('2026-11-08')
})

test('an invalid store timezone falls back to Asia/Jakarta', async () => {
  const broken = await db.location.create({
    name: 'PGA29_BROKEN',
    status: 'active',
    timezone: 'Not/AZone'
  })
  const now = new Date('2026-11-07T20:00:00.000Z')
  await generateCustomerNumber(broken.id, null, now)
  expect(await counterDateFor(broken.id)).toBe('2026-11-08')
  await db.sequelize.query('DELETE FROM order_daily_counter WHERE store = $1', {
    bind: [broken.id]
  })
  await db.location.destroy({ where: { id: broken.id } })
})
