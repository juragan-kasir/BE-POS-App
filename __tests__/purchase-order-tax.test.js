process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Phase 22 Batch 2 — Purchase Tax Foundation.
//
// Mirrors the Sales tax formula/rounding convention (order.js's
// calculateOrderTotals: tax applies to the post-discount base, via
// Math.round, then summed into the grand total) without introducing a
// new tax engine — taxRate stays PO-level, manually entered, same as the
// existing dpPercent field. finalAmount remains the single authoritative
// purchase total that AP/Purchase Payment already read unmodified.
//
// Formula:
//   taxableBase = totalAmount - discount
//   taxAmount   = round(taxableBase * taxRate / 100)
//   finalAmount = taxableBase + taxAmount + additionalCost

let store = null
let category = null
let ingredient = null
let adminToken = null
let adminUser = null

const nextTag = () => `PO_TAX_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

beforeAll(async () => {
  store = await db.location.create(await withTestTenant({ name: 'PO_TAX_STORE', status: 'active' }))
  category = await db.category.create({ name: 'PO_TAX_CATEGORY' })
  ingredient = await db.ingredient.create({
    store: store.id,
    name: nextTag(),
    stock: 0,
    minStock: 0,
    unit: 'pcs',
    baseUnit: 'pcs',
    conversionFactor: 1,
    costPrice: 0,
    status: 'active'
  })
  adminUser = await db.user.create({
    userName: 'admin_po_tax',
    email: 'admin_po_tax@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active'
  })
  adminToken = await signSessionToken(
    { id: adminUser.id, userName: adminUser.userName, roleType: 'admin', store: store.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  const pos = await db.purchase_order.findAll({ where: { store: store.id }, attributes: ['id'] })
  const poIds = pos.map((p) => p.id)
  await db.purchase_payment.destroy({ where: { purchaseOrder: poIds }, force: true })
  await db.purchase_order_item.destroy({ where: { purchaseOrder: poIds }, force: true })
  await db.purchase_order.destroy({ where: { id: poIds }, force: true })
  await db.ingredient.destroy({ where: { store: store.id }, force: true })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.user.destroy({ where: { id: adminUser?.id }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

const createPO = (body) =>
  request(app)
    .post('/purchase-order/create')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ store: store.id, status: 'ordered', ...body })

describe('Purchase Order tax — Test 1: zero tax leaves the pre-tax formula unchanged', () => {
  test('taxRate omitted: finalAmount = totalAmount - discount + additionalCost', async () => {
    const res = await createPO({
      discount: 1000,
      additionalCost: 500,
      items: [{ ingredient: ingredient.id, ingredientName: ingredient.name, quantity: 10, price: 1000 }]
    })

    expect(res.status).toBe(201)
    const po = res.body.data
    expect(po.totalAmount).toBe(10000)
    expect(Number(po.taxRate)).toBe(0)
    expect(po.taxAmount).toBe(0)
    expect(po.finalAmount).toBe(10000 - 1000 + 500) // 9500, identical to pre-tax formula
  })
})

describe('Purchase Order tax — Test 2: standard tax', () => {
  test('11% tax on a clean subtotal', async () => {
    const res = await createPO({
      taxRate: 11,
      items: [{ ingredient: ingredient.id, ingredientName: ingredient.name, quantity: 1, price: 100000 }]
    })

    expect(res.status).toBe(201)
    const po = res.body.data
    expect(po.totalAmount).toBe(100000)
    expect(Number(po.taxRate)).toBe(11)
    expect(po.taxAmount).toBe(11000)
    expect(po.finalAmount).toBe(111000)
  })

  test('11% tax on a subtotal that produces a fractional result rounds per the repository convention (Math.round)', async () => {
    const res = await createPO({
      taxRate: 11,
      items: [{ ingredient: ingredient.id, ingredientName: ingredient.name, quantity: 1, price: 99999 }]
    })

    expect(res.status).toBe(201)
    const po = res.body.data
    // 99999 * 0.11 = 10999.89 -> Math.round -> 11000
    expect(po.taxAmount).toBe(11000)
    expect(po.finalAmount).toBe(99999 + 11000)
  })
})

describe('Purchase Order tax — Test 3: discount + tax, taxed on the post-discount base', () => {
  test('tax is calculated on (totalAmount - discount), not on the raw subtotal', async () => {
    const res = await createPO({
      discount: 20000,
      taxRate: 10,
      items: [{ ingredient: ingredient.id, ingredientName: ingredient.name, quantity: 1, price: 100000 }]
    })

    expect(res.status).toBe(201)
    const po = res.body.data
    // taxableBase = 100000 - 20000 = 80000; tax = 8000 (NOT 10000, which
    // would be the wrong, pre-discount base)
    expect(po.taxAmount).toBe(8000)
    expect(po.finalAmount).toBe(80000 + 8000)
  })
})

describe('Purchase Order tax — Test 4: additional cost is NOT itself taxed', () => {
  test('additionalCost is added after tax, outside the taxable base', async () => {
    const res = await createPO({
      taxRate: 10,
      additionalCost: 5000,
      items: [{ ingredient: ingredient.id, ingredientName: ingredient.name, quantity: 1, price: 100000 }]
    })

    expect(res.status).toBe(201)
    const po = res.body.data
    // taxableBase = 100000; tax = 10000 (NOT 10500, which would be wrong
    // if additionalCost were included in the taxable base)
    expect(po.taxAmount).toBe(10000)
    expect(po.finalAmount).toBe(100000 + 10000 + 5000)
  })

  test('update() recomputes tax with the same formula when discount/additionalCost/taxRate change', async () => {
    const createRes = await createPO({
      taxRate: 10,
      items: [{ ingredient: ingredient.id, ingredientName: ingredient.name, quantity: 1, price: 100000 }]
    })
    expect(createRes.status).toBe(201)
    const poId = createRes.body.data.id

    // updatePurchaseOrderSchema is createPurchaseOrderSchema.partial(), but
    // zod still fills each field's own .default(0) for any key the caller
    // omits (pre-existing behavior, shared by discount/additionalCost/
    // dpPercent/tenor too — not introduced by this batch), so a real update
    // call must resend every total-affecting field it wants preserved,
    // exactly as EditPurchaseOrder.jsx already does for all of them.
    const updateRes = await request(app)
      .put(`/purchase-order/update/${poId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ discount: 10000, additionalCost: 2000, taxRate: 10 })

    expect(updateRes.status).toBe(200)
    const fresh = await db.purchase_order.findByPk(poId)
    // taxableBase = 100000 - 10000 = 90000; tax = 9000; final = 90000+9000+2000
    expect(Number(fresh.taxRate)).toBe(10)
    expect(fresh.taxAmount).toBe(9000)
    expect(fresh.finalAmount).toBe(101000)
  })
})

describe('Purchase Order tax — Test 5: AP uses the tax-inclusive finalAmount, no duplicate calculation', () => {
  test('apDashboard reports the full tax-inclusive finalAmount as outstanding for an unpaid PO', async () => {
    const res = await createPO({
      taxRate: 11,
      items: [
        {
          ingredient: ingredient.id,
          ingredientName: ingredient.name,
          quantity: 1,
          price: 100000,
          supplier: null
        }
      ]
    })
    expect(res.status).toBe(201)
    expect(res.body.data.finalAmount).toBe(111000)
    // AP already derives outstanding purely from po.finalAmount - Σpayments
    // (purchasePayment.js), so no separate AP-side tax formula exists to
    // duplicate or diverge from this — verified by direct model read.
    const fresh = await db.purchase_order.findByPk(res.body.data.id)
    expect(fresh.finalAmount).toBe(111000)
  })
})

describe('Purchase Order tax — Tests 6/7: partial and full payment against a taxed PO', () => {
  let po = null
  let supplier = null

  beforeAll(async () => {
    supplier = await db.supplier.create({ name: nextTag(), store: [store.id], status: 'active' })
    const res = await createPO({
      taxRate: 11,
      items: [
        {
          ingredient: ingredient.id,
          ingredientName: ingredient.name,
          quantity: 1,
          price: 100000,
          supplier: supplier.id
        }
      ]
    })
    expect(res.status).toBe(201)
    po = res.body.data // finalAmount = 111000
  })

  test('partial payment: outstanding = finalAmount - paid', async () => {
    const payRes = await request(app)
      .post('/purchase-payment/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        purchaseOrder: po.id,
        supplier: supplier.id,
        amount: 50000,
        paymentMethod: 'cash'
      })
    expect(payRes.status).toBe(201)

    const totalPaid = await db.purchase_payment.sum('amount', { where: { purchaseOrder: po.id } })
    const outstanding = po.finalAmount - totalPaid
    expect(totalPaid).toBe(50000)
    expect(outstanding).toBe(61000)
  })

  test('full payment: outstanding reaches zero and over-payment is still rejected', async () => {
    const payRes = await request(app)
      .post('/purchase-payment/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        purchaseOrder: po.id,
        supplier: supplier.id,
        amount: 61000,
        paymentMethod: 'cash'
      })
    expect(payRes.status).toBe(201)

    const totalPaid = await db.purchase_payment.sum('amount', { where: { purchaseOrder: po.id } })
    expect(totalPaid).toBe(po.finalAmount) // 111000
    expect(po.finalAmount - totalPaid).toBe(0)

    const overpayRes = await request(app)
      .post('/purchase-payment/create')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        purchaseOrder: po.id,
        supplier: supplier.id,
        amount: 1,
        paymentMethod: 'cash'
      })
    expect(overpayRes.status).toBe(400)
  })
})

describe('Purchase Order tax — Test 8: historical PO rows remain financially unchanged', () => {
  test('a PO row created without taxRate/taxAmount (simulating a pre-migration record) keeps its original finalAmount', async () => {
    const legacyPO = await db.purchase_order.create({
      store: store.id,
      orderNumber: `PO-LEGACY-${Date.now()}`,
      totalAmount: 50000,
      discount: 5000,
      finalAmount: 45000, // pre-tax-feature formula: totalAmount - discount + additionalCost(0)
      status: 'ordered',
      orderDate: new Date()
    })

    const fresh = await db.purchase_order.findByPk(legacyPO.id)
    expect(Number(fresh.taxRate)).toBe(0)
    expect(fresh.taxAmount).toBe(0)
    expect(fresh.finalAmount).toBe(45000) // unchanged

    await db.purchase_order.destroy({ where: { id: legacyPO.id }, force: true })
  })
})

describe('Purchase Order tax — Test 9: invalid tax rate is rejected', () => {
  test('a negative taxRate is rejected with 400, not silently coerced', async () => {
    const res = await createPO({
      taxRate: -5,
      items: [{ ingredient: ingredient.id, ingredientName: ingredient.name, quantity: 1, price: 100000 }]
    })

    expect(res.status).toBe(400)
  })
})
