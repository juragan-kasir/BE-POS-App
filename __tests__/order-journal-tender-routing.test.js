process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const db = require('../db/models')
const { postOrderJournal } = require('../api/service/accountingService')

let store = null

beforeAll(async () => {
  store = await db.location.create({ name: 'JOURNAL_TENDER_STORE', status: 'active' })
  await db.user.create({
    id: 98021,
    userName: 'journal_tender_admin',
    email: 'p14-98021-order-journal-tender@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active',
    fullName: 'journal_tender_admin'
  })
})

afterAll(async () => {
  await db.journal_entry_line.destroy({ where: {}, force: true })
  await db.journal_entry.destroy({ where: { store: store.id }, force: true })
  await db.user.destroy({ where: { id: [98021] }, force: true })
  await db.location.destroy({ where: { id: store.id }, force: true })
})

afterEach(async () => {
  await db.journal_entry_line.destroy({ where: {}, force: true })
  await db.journal_entry.destroy({ where: { store: store.id }, force: true })
})

const postSale = (paymentMethod) =>
  postOrderJournal({
    store: store.id,
    orderId: Math.floor(Math.random() * 1e9),
    orderNumber: `JT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    subTotal: 50000,
    discountAmount: 0,
    taxAmount: 0,
    serviceChargeAmount: 0,
    totalPrice: 50000,
    date: new Date(),
    createdBy: 98021,
    paymentMethod
  })

const debitAccountCode = async () => {
  const rows = await db.sequelize.query(
    `SELECT a.code FROM journal_entry_line l JOIN journal_entry j ON j.id=l."journalEntry" JOIN account a ON a.id=l.account WHERE j.store=:store AND l.debit > 0`,
    { replacements: { store: store.id }, type: db.sequelize.QueryTypes.SELECT }
  )
  return rows.length ? rows[0].code : null
}

describe('postOrderJournal tender routing (cash vs QR/non-cash)', () => {
  test('cash sale debits 1000 Cash', async () => {
    await postSale('CASH')
    expect(await debitAccountCode()).toBe('1000')
  })

  test('QRIS sale debits 1400 Bank & E-Wallet, not 1000 Cash', async () => {
    await postSale('QRIS')
    expect(await debitAccountCode()).toBe('1400')
  })
})
