process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// F-PAY-2 regression (purchase-payment half): deleting a payment whose
// journal is already posted would orphan a posted GL entry (Dr AP / Cr
// Cash) with no reversal — the architecture reverses posted effects, it
// does not delete them. Payments with no posted effect remain deletable
// (existing tenant-isolation contract).

let store = null
let adminToken = null
let supplier = null
let po = null

beforeAll(async () => {
  store = await db.location.create(await withTestTenant({ name: `PPDEL_STORE_${Date.now()}`, status: 'active' }))
  const adminUser = await db.user.create({
    userName: `admin_ppdel_${Date.now()}`,
    email: `admin_ppdel_${Date.now()}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
  supplier = await db.supplier.create({
    name: `PPDEL_SUP_${Date.now()}`,
    phone: '0800000001'
  })
  po = await db.purchase_order.create({
    store: store.id,
    supplier: supplier.id,
    orderNumber: `PPDEL-PO-${Date.now()}`,
    totalAmount: 500000,
    finalAmount: 500000,
    status: 'ordered'
  })
})

afterAll(async () => {
  await db.purchase_payment.destroy({ where: { purchaseOrder: po?.id }, force: true })
  const journals = await db.journal_entry.findAll({
    where: { store: store?.id, sourceType: 'purchase_payment' }
  })
  for (const j of journals) {
    await db.journal_entry_line.destroy({ where: { journalEntry: j.id }, force: true })
  }
  await db.journal_entry.destroy({
    where: { store: store?.id, sourceType: 'purchase_payment' },
    force: true
  })
  await db.accounting_outbox.destroy({ where: { store: store?.id }, force: true })
  await db.purchase_order.destroy({ where: { id: po?.id }, force: true })
  await db.supplier.destroy({ where: { id: supplier?.id }, force: true })
  await db.user.destroy({ where: { store: store?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

async function postPayment(amount, reference) {
  const res = await request(app)
    .post('/purchase-payment/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      store: store.id,
      purchaseOrder: po.id,
      supplier: supplier.id,
      amount,
      paymentMethod: 'cash',
      reference
    })
  if (![200, 201].includes(res.status)) {
    throw new Error('payment setup failed: ' + JSON.stringify(res.body))
  }
  return res.body.data
}

describe('F-PAY-2 purchase-payment delete guards', () => {
  test('payment with a posted journal cannot be deleted', async () => {
    const payment = await postPayment(100000, `ppdel-ref-${Date.now()}`)
    const journals = await db.journal_entry.findAll({
      where: { store: store.id, sourceType: 'purchase_payment', referenceId: payment.id }
    })
    expect(journals.length).toBe(1)

    const res = await request(app)
      .delete(`/purchase-payment/delete/${payment.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect([400, 409]).toContain(res.status)

    expect(await db.purchase_payment.findByPk(payment.id)).not.toBeNull()
    expect(
      await db.journal_entry.count({
        where: { store: store.id, sourceType: 'purchase_payment', referenceId: payment.id }
      })
    ).toBe(1)
  })

  test('payment with no posted effect can still be deleted', async () => {
    const throwaway = await db.purchase_payment.create({
      store: store.id,
      purchaseOrder: po.id,
      supplier: supplier.id,
      amount: 1000,
      paymentMethod: 'cash'
    })
    const res = await request(app)
      .delete(`/purchase-payment/delete/${throwaway.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(await db.purchase_payment.findByPk(throwaway.id)).toBeNull()
  })
})
