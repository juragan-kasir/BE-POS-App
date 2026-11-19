process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 22 Batch 19 (F22-B2-01): postPurchaseJournal (api/service/
// accountingService.js) posts Dr Inventory / Cr AP using only the
// tax-EXCLUSIVE `net` (gross items minus pro-rated PO discount) — it never
// receives or posts po.taxAmount at all. purchasePayment.js, however,
// gates and posts payments against po.finalAmount, which IS tax-inclusive
// (taxableBase + taxAmount + additionalCost). For any PO with a nonzero
// taxRate, this means Accounts Payable (account 2000) is credited for
// less than it is later debited when fully paid — the AP account never
// returns to zero after a fully-received, fully-paid taxed PO, permanently
// misstating the ledger by exactly the tax amount.

let location = null
let category = null
let product = null
let supplier = null
let adminToken = null

beforeAll(async () => {
  location = await db.location.create(await withTestTenant({ name: 'PO_TAX_ACCT_STORE', status: 'active' }))
  category = await db.category.create({ name: 'PO_TAX_ACCT_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'PO_TAX_ACCT_PRODUCT',
    category: category.id,
    price: 8000,
    costPrice: 5000,
    stock: 0
  })
  supplier = await db.supplier.create({ name: 'PO_TAX_ACCT_SUPPLIER' })
  const adminUser = await db.user.create({
    userName: 'admin_po_tax_acct',
    email: 'admin_po_tax_acct@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: location.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: location.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.accounting_outbox.destroy({ where: { store: location.id }, force: true })
  await db.journal_entry_line.destroy({ where: {}, force: true })
  await db.journal_entry.destroy({ where: { store: location.id }, force: true })
  await db.purchase_payment.destroy({ where: { store: location.id }, force: true })
  await db.goodsReceiptItem.destroy({ where: {}, force: true })
  await db.goodsReceipt.destroy({ where: { store: location.id }, force: true })
  await db.purchase_order_item.destroy({ where: {}, force: true })
  await db.purchase_order.destroy({ where: { store: location.id }, force: true })
  await db.account.destroy({ where: { store: location.id }, force: true })
  await db.supplier.destroy({ where: { id: supplier?.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { userName: 'admin_po_tax_acct' }, force: true })
  await db.location.destroy({ where: { id: location?.id }, force: true })
})

describe('F22-B2-01 — Purchase tax must be posted to the AP journal, not silently dropped', () => {
  test('a fully-received, fully-paid PO with a 10% tax rate leaves Accounts Payable at exactly zero', async () => {
    const poRes = await request(app)
      .post('/purchase-order/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: location.id,
        status: 'ordered',
        taxRate: 10,
        items: [{ product: product.id, supplier: supplier.id, quantity: 10, price: 5000 }]
      })
    expect(poRes.status).toBe(201)
    const po = poRes.body.data
    expect(po.taxAmount).toBe(5000)
    expect(po.finalAmount).toBe(55000)
    const poItemId = po.items[0].id

    const grRes = await request(app)
      .post('/goods-receipt/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        store: location.id,
        purchaseOrderId: po.id,
        status: 'completed',
        items: [{ purchaseOrderItem: poItemId, product: product.id, qtyReceived: 10, price: 5000 }]
      })
    expect(grRes.status).toBe(201)

    const payRes = await request(app)
      .post('/purchase-payment/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        purchaseOrder: po.id,
        supplier: supplier.id,
        amount: 55000,
        paymentMethod: 'cash'
      })
    expect(payRes.status).toBe(201)

    const apAccount = await db.account.findOne({ where: { store: location.id, code: '2000' } })
    expect(apAccount).not.toBeNull()

    const totalCredit = Number(
      (await db.journal_entry_line.sum('credit', { where: { account: apAccount.id } })) || 0
    )
    const totalDebit = Number(
      (await db.journal_entry_line.sum('debit', { where: { account: apAccount.id } })) || 0
    )

    // A fully-received, fully-paid PO must leave zero residual liability —
    // the AP account credited at receipt time must match what gets debited
    // at payment time exactly, including the tax portion.
    expect(totalCredit - totalDebit).toBe(0)
  })
})
