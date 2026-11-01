process.env.NODE_ENV = 'test'

const db = require('../db/models')
const { addOrderRounds, dropOrderRounds } = require('../db/migrations/20261101000002-order-rounds')

// Batch B9: up replays safely on a database that already has the table and
// column; down never drops recorded rounds.

const qi = () => db.sequelize.getQueryInterface()
let store = null
let order = null

const objectsPresent = async () => {
  const [[{ tables }]] = await db.sequelize.query(
    "SELECT COUNT(*)::int AS tables FROM information_schema.tables WHERE table_name = 'order_round'"
  )
  const [[{ columns }]] = await db.sequelize.query(
    "SELECT COUNT(*)::int AS columns FROM information_schema.columns WHERE table_name = 'order_item' AND column_name = 'roundId'"
  )
  return tables === 1 && columns === 1
}

beforeAll(async () => {
  store = await db.location.create({ name: `B9_STORE_${Date.now()}`, status: 'active' })
  order = await db.order.create({ orderNumber: `B9-${Date.now()}`, store: store.id, status: 'pending' })
})

afterAll(async () => {
  await db.order_round.destroy({ where: { order: order.id } })
  await db.order.destroy({ where: { id: order.id }, force: true })
  await db.location.destroy({ where: { id: store.id }, force: true })
})

describe('B9 order rounds migration', () => {
  test('up replays safely where the table and column already exist', async () => {
    await addOrderRounds(qi())
    await addOrderRounds(qi())
    expect(await objectsPresent()).toBe(true)
  })

  test('down refuses while a round is recorded and changes nothing', async () => {
    await db.order_round.create({ order: order.id, idempotencyKey: 'b9-guard', source: 'cashier' })
    await expect(dropOrderRounds(qi())).rejects.toThrow(/round\(s\) recorded/)
    expect(await objectsPresent()).toBe(true)
  })
})
