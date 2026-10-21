process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const cashFlowDef = require('../api/service/reportDefs/cashFlow')
const { bucketCashFlowTenders } = require('../api/service/canonicalPayment')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// TDD RED: cash-flow tender bucketing folds CARD/OTHER/POINTS into
// Penerimaan Tunai, contradicting the locked canonical taxonomy
// (api/service/canonicalPayment.js) and the cashRegister breakdown precedent
// (bucketPaymentsByCanonical). Only CASH may contribute to Tunai; QRIS and
// E_WALLET belong to the QRIS bucket; BANK_TRANSFER to Transfer; CARD,
// OTHER, POINTS and UNRECONCILED to Lainnya.
const SUFFIX = Date.now()

let store = null
let adminToken = null
let orderId = null

// Tender -> amount fixture table.
//
// Canonical spellings only: since migration 20261013000005 the
// `transaction_typepayment_canonical` CHECK constraint rejects legacy
// spellings on INSERT, so a row can no longer be written as 'debit' /
// 'other' / 'TRANSFER'. The legacy -> canonical alias mapping itself is
// covered by __tests__/canonical-payment.test.js.
const TENDERS = [
  ['CASH', 100000],
  ['CARD', 200000],
  ['QRIS', 50000],
  ['POINTS', 10000],
  ['OTHER', 5000],
  ['BANK_TRANSFER', 30000]
]

const EXPECTED = { tunai: 100000, qris: 50000, transfer: 30000, lainnya: 215000 }

beforeAll(async () => {
  store = await db.location.create({ name: `CF_STORE_${SUFFIX}`, status: 'active' })
  await db.user.create({
    id: 7201,
    userName: `cashier_cf_${SUFFIX}`,
    email: `p14-7201-cf-${SUFFIX}@test.com`,
    roleType: 'admin',
    userType: 'user',
    store: store.id,
    status: 'active',
    fullName: `cashier_cf_${SUFFIX}`
  })
  adminToken = await signSessionToken(
    { id: 7201, userName: `cashier_cf_${SUFFIX}`, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  const order = await db.order.create({
    orderNumber: `CF-ORD-${SUFFIX}`,
    store: store.id,
    status: 'paid',
    paymentStatus: 'paid',
    source: 'pos',
    totalPrice: 395000
  })
  orderId = order.id
  for (const [typePayment, amount] of TENDERS) {
    await db.transaction.create({ order: orderId, typePayment, amount })
  }
})

afterAll(async () => {
  await db.transaction.destroy({ where: { order: orderId }, force: true })
  await db.order.destroy({ where: { id: orderId }, force: true })
  await db.user.destroy({ where: { id: [7201] }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

const reqFor = (storeId) => ({ storeId, query: {}, user: { roleType: 'admin', store: storeId } })

describe('cash-flow tender buckets (reportDefs/cashFlow.getData)', () => {
  test('only CASH contributes to Penerimaan Tunai', async () => {
    const { rows } = await cashFlowDef.getData(reqFor(store.id))
    const byKeterangan = Object.fromEntries(rows.map((r) => [r.keterangan, r.nominal]))
    expect(byKeterangan['Penerimaan Tunai']).toBe(EXPECTED.tunai)
    expect(byKeterangan['Penerimaan QRIS']).toBe(EXPECTED.qris)
    expect(byKeterangan['Penerimaan Transfer']).toBe(EXPECTED.transfer)
    expect(byKeterangan['Lainnya']).toBe(EXPECTED.lainnya)
  })

  test('rows keep the established structure, fields and order', async () => {
    const { rows } = await cashFlowDef.getData(reqFor(store.id))
    expect(rows.map((r) => r.keterangan)).toEqual([
      'Penerimaan Tunai',
      'Penerimaan QRIS',
      'Penerimaan Transfer',
      'Lainnya',
      'Penerimaan Retur Pembelian',
      'Pengeluaran Expense',
      'Pengeluaran Purchase Payment'
    ])
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['flow', 'keterangan', 'nominal'])
    }
    expect(rows.filter((r) => r.flow === 'in')).toHaveLength(5)
    expect(rows.filter((r) => r.flow === 'out')).toHaveLength(2)
  })
})

describe('cash-flow tender buckets (GET /report/cash-flow)', () => {
  test('only CASH contributes to penerimaanTunai over HTTP', async () => {
    const res = await request(app)
      .get('/report/cash-flow')
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    const d = res.body.data
    expect(d.penerimaanTunai).toBe(EXPECTED.tunai)
    expect(d.penerimaanQris).toBe(EXPECTED.qris)
    expect(d.penerimaanTransfer).toBe(EXPECTED.transfer)
    // The controller embeds Lainnya in totalKasMasuk (no dedicated field):
    // Tunai + QRIS + Transfer + Retur + Lainnya must equal totalKasMasuk.
    expect(d.totalKasMasuk - d.penerimaanTunai - d.penerimaanQris - d.penerimaanTransfer - d.penerimaanReturPembelian).toBe(EXPECTED.lainnya)
  })
})

describe('cash-flow tender edge cases', () => {
  test('unknown tender never inflates Tunai and never throws', () => {
    // Since migration 20261013000005 the `transaction_typepayment_canonical`
    // CHECK constraint rejects a non-canonical typePayment on INSERT, so an
    // unknown tender can no longer exist in the table. The report's defence
    // against one is asserted here as a pure unit call, and the new database
    // invariant is asserted separately below.
    const buckets = bucketCashFlowTenders([{ typePayment: 'CRYPTOPAY', total: 7000 }])
    expect(buckets.tunai).toBe(0)
    expect(buckets.lainnya).toBe(7000)
  })

  test('the database rejects a non-canonical tender outright', async () => {
    const otherStore = await db.location.create({ name: `CF_UNKNOWN_${SUFFIX}`, status: 'active' })
    try {
      const order = await db.order.create({
        orderNumber: `CF-UNK-${SUFFIX}`,
        store: otherStore.id,
        status: 'paid',
        paymentStatus: 'paid',
        source: 'pos',
        totalPrice: 7000
      })
      await expect(
        db.transaction.create({ order: order.id, typePayment: 'CRYPTOPAY', amount: 7000 })
      ).rejects.toThrow()
      await db.order.destroy({ where: { id: order.id }, force: true })
    } finally {
      await db.location.destroy({ where: { id: otherStore.id }, force: true })
    }
  })

  test('empty data preserves zero behavior and shape', async () => {
    const emptyStore = await db.location.create({ name: `CF_EMPTY_${SUFFIX}`, status: 'active' })
    try {
      const { rows } = await cashFlowDef.getData(reqFor(emptyStore.id))
      const byKeterangan = Object.fromEntries(rows.map((r) => [r.keterangan, r.nominal]))
      expect(byKeterangan['Penerimaan Tunai']).toBe(0)
      expect(byKeterangan['Penerimaan QRIS']).toBe(0)
      expect(byKeterangan['Penerimaan Transfer']).toBe(0)
      expect(byKeterangan['Lainnya']).toBe(0)
      expect(rows).toHaveLength(7)
    } finally {
      await db.location.destroy({ where: { id: emptyStore.id }, force: true })
    }
  })
})
