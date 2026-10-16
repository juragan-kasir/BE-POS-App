process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const crypto = require('crypto')
const app = require('../api/index')
const db = require('../db/models')

// FND-001 (security) — regression coverage for the public, unauthenticated
// receipt endpoint GET /order/receipt-html/:publicToken (getReceiptHTML).
//
// The endpoint returns raw text/html (it is intentionally not React-rendered),
// so attacker-controlled strings that were persisted by createCustomerOrder
// (client-supplied item.productName, customerName and paymentMethod) must be
// HTML-escaped at the output boundary before they are interpolated into the
// template. Regression asserts that stored <script>/event-handler payloads
// appear escaped (&lt;script&gt;, &amp;, &quot;, &#39;) and never as live
// elements — i.e. the raw payload byte-for-byte never survives, and no raw
// <script> tag or tag with an on* event attribute comes out of user data.

const assertNotExecutable = (html, payload) => {
  // Escaped bytes must not round-trip back to the raw payload.
  expect(html).not.toContain(payload)
  // No raw <script> tag anywhere in the document.
  expect(html).not.toMatch(/<script/i)
  // No on* handler injected from user data. The template ships exactly one
  // trusted static handler (the print button), so we drop it before scanning
  // for any remaining lowercase-tag with an event attribute — any other
  // on* attribute in the output can only have come from unescaped payload.
  const withoutTrustedPrintButton = html.replace(
    /onclick="window\.print\(\)"/g,
    ''
  )
  expect(withoutTrustedPrintButton).not.toMatch(/<[a-z][^>]*\son\w+\s*=/i)
}

let store = null
let category = null
let product = null
let table = null
const createdOrderIds = []

const ESCAPE_PAYLOADS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '"><script>alert(2)</script>',
  "' onmouseover='alert(3)"
]

const createOrder = async (fields) => {
  // Phase 39 — a successful QR order occupies its table until paid/cancelled/
  // void releases it. This suite creates a separate order per escaping
  // payload on the shared fixture table, so each booking starts from a freed
  // table.
  await db.table.update({ status: 'available' }, { where: { id: table.id } })
  const res = await request(app).post('/order/customer-create').send({
    store: store.id,
    tableId: table.id,
    items: [
      {
        productId: String(product.id),
        quantity: 1,
        productName: fields.productName || 'TESTABLE',
        price: 9000
      }
    ],
    customerName: fields.customerName || 'Bayu',
    paymentMethod: fields.paymentMethod || 'cash',
    idempotencyKey: `RECEIPT-XSS-${crypto.randomBytes(12).toString('hex')}`
  })
  expect(res.status).toBe(201)
  const token = res.body.data?.publicToken
  expect(token).toBeTruthy()
  createdOrderIds.push(res.body.data.id)
  return token
}

const getReceipt = (token) => request(app).get(`/order/receipt-html/${token}`)

beforeAll(async () => {
  store = await db.location.create({ name: 'RECEIPT_XSS_STORE', status: 'active' })
  category = await db.category.create({ name: 'RECEIPT_XSS_CATEGORY' })
  product = await db.product.create({
    nameProduct: 'RECEIPT_XSS_PRODUCT',
    category: category.id,
    price: 9000,
    stock: 50,
    isAvailable: true
  })
  await db.product_store.create({ product: product.id, store: store.id })
  // DR-14: the outlet row is the authoritative stock.
  await db.product_store_stock.create({ product: product.id, store: store.id, stock: 50 })
  table = await db.table.create({ store: store.id, name: 'RECEIPT_XSS_TABLE' })
  // W3-3 (DR-17): PPN is explicit setup, never a fallback — seed the rate
  // so these receipt assertions exercise configured tax.
  await db.taxConfig.create({
    name: 'RECEIPT_XSS_PPN',
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: store.id
  })
})

afterAll(async () => {
  await db.taxConfig.destroy({ where: { store: store?.id }, force: true })
  for (const orderId of createdOrderIds) {
    await db.order_item.destroy({ where: { order: orderId }, force: true })
    await db.order.destroy({ where: { id: orderId }, force: true })
  }
  await db.table.destroy({ where: { id: table?.id }, force: true })
  await db.product_store.destroy({ where: { product: product?.id }, force: true })
  await db.product_store_stock.destroy({ where: { product: product?.id }, force: true })
  await db.product.destroy({ where: { id: product?.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

describe('FND-001 — getReceiptHTML (GET /order/receipt-html/:publicToken)', () => {
  test.each(ESCAPE_PAYLOADS)(
    'productName payload %p renders escaped and never executes',
    async (payload) => {
      const token = await createOrder({ productName: payload })
      const res = await getReceipt(token)
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toMatch(/text\/html/)
      assertNotExecutable(res.text, payload)

      // Every markup-active character the payload contained is entity-encoded.
      if (payload.includes('<')) expect(res.text).toContain('&lt;')
      if (payload.includes('>')) expect(res.text).toContain('&gt;')
      if (payload.includes('"')) expect(res.text).toContain('&quot;')
      if (payload.includes("'")) expect(res.text).toContain('&#39;')
      expect(res.text).toMatch(/&(amp|lt|gt|quot|#39);/)
    }
  )

  test('customerName payload renders escaped and never executes', async () => {
    const payload = '<script>alert(1)</script>'
    const token = await createOrder({ customerName: payload })
    const res = await getReceipt(token)
    expect(res.status).toBe(200)
    expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    assertNotExecutable(res.text, payload)
  })

  test('paymentMethod payload renders escaped and never executes', async () => {
    const payload = '"><img src=x onerror=alert(4)>'
    const token = await createOrder({ paymentMethod: payload })
    const res = await getReceipt(token)
    expect(res.status).toBe(200)
    expect(res.text).toContain('&quot;&gt;&lt;img src=x onerror=alert(4)&gt;')
    assertNotExecutable(res.text, payload)
  })

  test('escapes amp, lt, gt, quot and apos special characters', async () => {
    const token = await createOrder({ productName: `A&B <C> "D" 'E'` })
    const res = await getReceipt(token)
    expect(res.status).toBe(200)
    expect(res.text).toContain('A&amp;B &lt;C&gt; &quot;D&quot; &#39;E&#39;')
    expect(res.text).not.toContain(`A&B <C> "D" 'E'`)
  })

  test('keeps a normal product name intact (no over-escaping)', async () => {
    const token = await createOrder({ productName: 'Nasi Goreng + Telur (Spesial)' })
    const res = await getReceipt(token)
    expect(res.status).toBe(200)
    expect(res.text).toContain('Nasi Goreng + Telur (Spesial)')
  })
})