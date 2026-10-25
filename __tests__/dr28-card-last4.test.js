process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// BA DR-28 decision 5: a payment row keeps only the last 4 digits of a card
// number. The model setter enforces it for every write path — create, an
// instance update and a bulk update — so no caller can store the full number.
const db = require('../db/models')
const { lastFourDigits } = require('../utils/cardNumber')

const SUFFIX = `DR28C_${Date.now()}`
let store
let order

beforeAll(async () => {
  store = await db.location.create({ name: `${SUFFIX}_STORE`, status: 'active' })
  order = await db.order.create({
    orderNumber: `${SUFFIX}_ORD`,
    store: store.id,
    status: 'paid',
    paymentStatus: 'paid',
    subTotal: 50000,
    discountAmount: 0,
    totalQuantity: 1,
    totalPrice: 50000
  })
})

afterAll(async () => {
  if (order?.id) {
    await db.transaction.destroy({ where: { order: order.id }, force: true })
    await db.order.destroy({ where: { id: order.id }, force: true })
  }
  if (store?.id) await db.location.destroy({ where: { id: store.id }, force: true })
  await db.sequelize.close()
})

describe('lastFourDigits', () => {
  test.each([
    ['4111111111111111', '1111'],
    ['4111 1111 1111 1234', '1234'],
    ['4111-1111-1111-5678', '5678'],
    ['****9012', '9012'],
    [4111111111113456, '3456'],
    ['12', '12'],
    ['', null],
    ['   ', null],
    ['VISA', null],
    [null, null],
    [undefined, null]
  ])('%p → %p', (input, expected) => {
    expect(lastFourDigits(input)).toBe(expected)
  })
})

describe('transaction.cardNumber keeps the last 4 digits only', () => {
  const stored = async (id) =>
    (await db.sequelize.query('SELECT "cardNumber" FROM "transaction" WHERE id = :id', {
      replacements: { id },
      type: db.sequelize.QueryTypes.SELECT
    }))[0].cardNumber

  test('on create', async () => {
    const row = await db.transaction.create({
      order: order.id,
      typePayment: 'CARD',
      amount: 50000,
      cardNumber: '4111 1111 1111 1111'
    })
    expect(row.cardNumber).toBe('1111')
    expect(await stored(row.id)).toBe('1111')
  })

  test('on an instance update', async () => {
    const row = await db.transaction.create({ order: order.id, typePayment: 'CARD', amount: 1 })
    await row.update({ cardNumber: '5500000000000004' })
    expect(await stored(row.id)).toBe('0004')
  })

  test('on a bulk update', async () => {
    const row = await db.transaction.create({ order: order.id, typePayment: 'CARD', amount: 1 })
    await db.transaction.update({ cardNumber: '340000000000009' }, { where: { id: row.id } })
    expect(await stored(row.id)).toBe('0009')
  })

  test('a value with no digits is stored as no card number', async () => {
    const row = await db.transaction.create({
      order: order.id,
      typePayment: 'CARD',
      amount: 1,
      cardNumber: 'VISA'
    })
    expect(await stored(row.id)).toBeNull()
  })
})
