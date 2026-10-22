process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Regression tests for the confirmed cross-tenant IDOR fix: purchasePayment,
// queue, promo (campaigns), and delivery all used to fetch a tenant-owned
// record by raw id (findByPk) with no check that the record's own `store`
// matched the caller's store — validateStoreAccess only restricts which
// store value a caller may CLAIM in the request, it never inspects the
// fetched record. These tests fire real HTTP requests through the actual
// route/middleware/controller chain and assert both the HTTP status AND
// that the target row was actually left untouched in the database — a test
// that only checks the status code would pass even if the controller
// leaked the record body while still 403'ing, or vice versa.

let store1 = null
let store2 = null
let superAdminToken = null
let adminStore1Token = null
let adminStore2Token = null
let kasirStore1Token = null

// purchasePayment fixtures
let supplier = null
let po1 = null
let po2 = null
let payment1 = null
let payment2 = null

// queue fixtures
let queue1 = null
let queue2 = null

// promo fixtures
let campaign1 = null
let campaign2 = null
let campaignGlobal = null

// delivery fixtures
let delivery1 = null
let delivery2 = null

// employee fixtures
let employee1 = null
let employee2 = null

// discount fixtures
let discount1 = null
let discount2 = null

// splitBill fixtures
let sbOrder1 = null
let sbOrder2 = null

// productBundle fixtures
let bundle1 = null
let bundle2 = null

// shiftSwap fixtures
let shiftA = null
let shiftB = null
let userReq1 = null
let userTgt1 = null
let userReq2 = null
let userTgt2 = null
let swap1 = null
let swap2 = null

// category fixtures
let category1 = null
let category2 = null

// supplier bank account / contact fixtures
let bankSupplier1 = null
let bankSupplier2 = null
let bankSupplierGlobal = null
let bankAccount1 = null
let bankAccount2 = null
let bankAccountGlobal = null
let contact1 = null
let contact2 = null

// notification fixtures
let notification1 = null
let notification2 = null
let notificationGlobal = null

// reservation fixtures
let reservation1 = null
let reservation2 = null

// type_payment fixtures
let typePayment1 = null
let typePayment2 = null

// waiter_request fixtures
let waiterRequest1 = null
let waiterRequest2 = null

// table fixtures
let table1 = null
let table2 = null

// taxConfig fixtures
let taxConfig1 = null
let taxConfig2 = null

// shift_template fixtures
let shiftTemplate1 = null
let shiftTemplate2 = null

// product fixtures (ownership via product_store junction)
let productCategory = null
let idorProduct1 = null
let idorProduct2 = null

// position fixtures
let position1 = null
let position2 = null

// shift fixtures
let idorShift1 = null
let idorShift2 = null

// social_media fixtures
let socialMedia1 = null
let socialMedia2 = null

// product_batch fixtures
let batch1 = null
let batch2 = null

// supplier_score fixtures
let supplierScore1 = null
let supplierScore2 = null

// invoice_setting fixture
let invoiceSetting2 = null

// driver fixtures (reviewer-report P1 fixes)
let driver1 = null
let driver2 = null

beforeAll(async () => {
  store1 = await db.location.create({ name: 'IDOR_STORE_1', status: 'active' })
  store2 = await db.location.create({ name: 'IDOR_STORE_2', status: 'active' })


  // P1-4: central per-request gate denies unknown caller identities, so the
  // tokens above must belong to real rows (all test assertions unchanged).
  await db.user.create({
    id: 70001,
    userName: 'idor_super',
    email: 'idor_super@test.com',
    roleType: 'super_admin',
    userType: 'admin',
    store: null,
    status: 'active',
    fullName: 'IDOR_SUPER'
  })
  await db.user.create({
    id: 70002,
    userName: 'idor_admin1',
    email: 'idor_admin1@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store1.id,
    status: 'active',
    fullName: 'IDOR_ADMIN_1'
  })
  await db.user.create({
    id: 70003,
    userName: 'idor_admin2',
    email: 'idor_admin2@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store2.id,
    status: 'active',
    fullName: 'IDOR_ADMIN_2'
  })
  await db.user.create({
    id: 70004,
    userName: 'idor_kasir1',
    email: 'idor_kasir1@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: store1.id,
    status: 'active',
    fullName: 'IDOR_KASIR_1'
  })

  // ---- purchasePayment fixtures ----
  supplier = await db.supplier.create({ name: 'IDOR_SUPPLIER', phone: '0800000000' })
  po1 = await db.purchase_order.create({
    store: store1.id,
    orderNumber: 'IDOR-PO-1',
    finalAmount: 100000,
    status: 'ordered'
  })
  po2 = await db.purchase_order.create({
    store: store2.id,
    orderNumber: 'IDOR-PO-2',
    finalAmount: 200000,
    status: 'ordered'
  })
  payment1 = await db.purchase_payment.create({
    store: store1.id,
    purchaseOrder: po1.id,
    supplier: supplier.id,
    amount: 50000,
    paymentMethod: 'cash'
  })
  payment2 = await db.purchase_payment.create({
    store: store2.id,
    purchaseOrder: po2.id,
    supplier: supplier.id,
    amount: 75000,
    paymentMethod: 'cash'
  })

  // ---- queue fixtures ----
  queue1 = await db.queue.create({
    store: store1.id,
    queueNumber: 'IDOR-Q1',
    customerName: 'IDOR_CUSTOMER_1',
    partySize: 2
  })
  queue2 = await db.queue.create({
    store: store2.id,
    queueNumber: 'IDOR-Q2',
    customerName: 'IDOR_CUSTOMER_2',
    partySize: 4
  })

  // ---- promo campaign fixtures ----
  const startDate = new Date()
  const endDate = new Date(Date.now() + 30 * 86400000)
  campaign1 = await db.promo_campaign.create({
    store: store1.id,
    name: 'IDOR_CAMPAIGN_1',
    type: 'manual',
    startDate,
    endDate
  })
  campaign2 = await db.promo_campaign.create({
    store: store2.id,
    name: 'IDOR_CAMPAIGN_2',
    type: 'manual',
    startDate,
    endDate
  })
  campaignGlobal = await db.promo_campaign.create({
    store: null,
    name: 'IDOR_CAMPAIGN_GLOBAL',
    type: 'manual',
    startDate,
    endDate
  })

  // ---- delivery order fixtures ----
  delivery1 = await db.delivery_order.create({
    store: store1.id,
    orderNumber: 'IDOR-DLV-1',
    customerName: 'IDOR_DLV_CUSTOMER_1',
    customerPhone: '0811111111',
    deliveryAddress: 'Address 1',
    status: 'pending'
  })
  delivery2 = await db.delivery_order.create({
    store: store2.id,
    orderNumber: 'IDOR-DLV-2',
    customerName: 'IDOR_DLV_CUSTOMER_2',
    customerPhone: '0822222222',
    deliveryAddress: 'Address 2',
    status: 'pending'
  })

  // ---- employee fixtures ----
  employee1 = await db.user.create({
    userName: 'idor_employee1',
    email: 'idor_employee1@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: store1.id,
    status: 'active',
    fullName: 'IDOR_EMPLOYEE_1'
  })
  employee2 = await db.user.create({
    userName: 'idor_employee2',
    email: 'idor_employee2@test.com',
    roleType: 'kasir',
    userType: 'user',
    store: store2.id,
    status: 'active',
    fullName: 'IDOR_EMPLOYEE_2'
  })

  // ---- discount fixtures ----
  discount1 = await db.discount.create({
    store: store1.id,
    name: 'IDOR_DISCOUNT_1',
    type: 'percent',
    value: 10
  })
  discount2 = await db.discount.create({
    store: store2.id,
    name: 'IDOR_DISCOUNT_2',
    type: 'percent',
    value: 20
  })

  // ---- splitBill fixtures (orders) ----
  sbOrder1 = await db.order.create({
    orderNumber: 'IDOR-SB-ORDER-1',
    store: store1.id,
    status: 'pending',
    paymentStatus: 'unpaid',
    totalPrice: 100000
  })
  sbOrder2 = await db.order.create({
    orderNumber: 'IDOR-SB-ORDER-2',
    store: store2.id,
    status: 'pending',
    paymentStatus: 'unpaid',
    totalPrice: 200000
  })

  // ---- productBundle fixtures ----
  bundle1 = await db.product_bundle.create({
    store: store1.id,
    name: 'IDOR_BUNDLE_1',
    bundlePrice: 10000
  })
  bundle2 = await db.product_bundle.create({
    store: store2.id,
    name: 'IDOR_BUNDLE_2',
    bundlePrice: 20000
  })

  // ---- shiftSwap fixtures ----
  shiftA = await db.shift.create({ name: 'IDOR_SHIFT_A', startTime: '08:00', endTime: '16:00' })
  shiftB = await db.shift.create({ name: 'IDOR_SHIFT_B', startTime: '16:00', endTime: '00:00' })
  userReq1 = await db.user.create({
    userName: 'idor_swap_req1', email: 'idor_swap_req1@test.com',
    roleType: 'kasir', userType: 'user', store: store1.id, status: 'active'
  })
  userTgt1 = await db.user.create({
    userName: 'idor_swap_tgt1', email: 'idor_swap_tgt1@test.com',
    roleType: 'kasir', userType: 'user', store: store1.id, status: 'active'
  })
  userReq2 = await db.user.create({
    userName: 'idor_swap_req2', email: 'idor_swap_req2@test.com',
    roleType: 'kasir', userType: 'user', store: store2.id, status: 'active'
  })
  userTgt2 = await db.user.create({
    userName: 'idor_swap_tgt2', email: 'idor_swap_tgt2@test.com',
    roleType: 'kasir', userType: 'user', store: store2.id, status: 'active'
  })
  await shiftA.update({ store: store1.id, karyawan: [70004] })
  await shiftB.update({ store: store1.id, karyawan: [userTgt1.id] })
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
  superAdminToken = await signSessionToken(
    { id: 70001, userName: 'idor_super', roleType: 'super_admin' },
    JWT_SECRET
  )
  adminStore1Token = await signSessionToken(
    { id: 70002, userName: 'idor_admin1', roleType: 'admin', store: store1.id },
    JWT_SECRET
  )
  adminStore2Token = await signSessionToken(
    { id: 70003, userName: 'idor_admin2', roleType: 'admin', store: store2.id },
    JWT_SECRET
  )
  kasirStore1Token = await signSessionToken(
    { id: 70004, userName: 'idor_kasir1', roleType: 'kasir', store: store1.id },
    JWT_SECRET
  )
  swap1 = await db.shift_swap.create({
    store: store1.id,
    requesterId: userReq1.id,
    targetId: userTgt1.id,
    requesterShiftId: shiftA.id,
    targetShiftId: shiftB.id,
    status: 'pending'
  })
  swap2 = await db.shift_swap.create({
    store: store2.id,
    requesterId: userReq2.id,
    targetId: userTgt2.id,
    requesterShiftId: shiftA.id,
    targetShiftId: shiftB.id,
    status: 'pending'
  })

  // ---- category fixtures (ownership via category_store junction) ----
  category1 = await db.category.create({ name: 'IDOR_CATEGORY_1' })
  category2 = await db.category.create({ name: 'IDOR_CATEGORY_2' })
  await db.category_store.create({ category: category1.id, store: store1.id })
  await db.category_store.create({ category: category2.id, store: store2.id })

  // ---- supplier bank account / contact fixtures ----
  // supplier.store is a genuine JSONB array in real data (supplier.js's own
  // create/update always writes `[storeId]`, never a bare scalar) — the
  // fixture must match that shape or it doesn't exercise the real code path.
  bankSupplier1 = await db.supplier.create({ name: 'IDOR_BANK_SUPPLIER_1', store: [store1.id] })
  bankSupplier2 = await db.supplier.create({ name: 'IDOR_BANK_SUPPLIER_2', store: [store2.id] })
  bankSupplierGlobal = await db.supplier.create({ name: 'IDOR_BANK_SUPPLIER_GLOBAL', store: [] })
  bankAccount1 = await db.supplier_bank_account.create({
    supplier: bankSupplier1.id, bankName: 'BCA', accountNumber: '1111', accountName: 'ACC_1'
  })
  bankAccount2 = await db.supplier_bank_account.create({
    supplier: bankSupplier2.id, bankName: 'BCA', accountNumber: '2222', accountName: 'ACC_2'
  })
  bankAccountGlobal = await db.supplier_bank_account.create({
    supplier: bankSupplierGlobal.id, bankName: 'BCA', accountNumber: '3333', accountName: 'ACC_GLOBAL'
  })
  contact1 = await db.supplier_contact.create({ supplier: bankSupplier1.id, fullName: 'IDOR_CONTACT_1' })
  contact2 = await db.supplier_contact.create({ supplier: bankSupplier2.id, fullName: 'IDOR_CONTACT_2' })

  // ---- notification fixtures ----
  notification1 = await db.notification.create({
    store: store1.id, type: 'test', title: 'IDOR_NOTIF_1', isRead: false
  })
  notification2 = await db.notification.create({
    store: store2.id, type: 'test', title: 'IDOR_NOTIF_2', isRead: false
  })
  notificationGlobal = await db.notification.create({
    store: null, type: 'test', title: 'IDOR_NOTIF_GLOBAL', isRead: false
  })

  // ---- reservation fixtures ----
  reservation1 = await db.reservation.create({
    store: store1.id,
    customerName: 'IDOR_RESV_1',
    reservationDate: '2026-12-01',
    startTime: '18:00'
  })
  reservation2 = await db.reservation.create({
    store: store2.id,
    customerName: 'IDOR_RESV_2',
    reservationDate: '2026-12-01',
    startTime: '19:00'
  })

  // ---- type_payment fixtures ----
  typePayment1 = await db.type_payment.create({ store: store1.id, name: 'IDOR_TP_1' })
  typePayment2 = await db.type_payment.create({ store: store2.id, name: 'IDOR_TP_2' })

  // ---- waiter_request fixtures ----
  // store is written as a real JSONB array on create ([storeId]) — match
  // that shape, same reasoning as the supplier fixture correction above.
  waiterRequest1 = await db.waiter_request.create({
    store: [store1.id], requestNumber: 'IDOR-WR-1', type: 'call', status: 'pending'
  })
  waiterRequest2 = await db.waiter_request.create({
    store: [store2.id], requestNumber: 'IDOR-WR-2', type: 'call', status: 'pending'
  })

  // ---- table fixtures ----
  table1 = await db.table.create({ store: store1.id, name: 'IDOR_TABLE_1', status: 'available' })
  table2 = await db.table.create({ store: store2.id, name: 'IDOR_TABLE_2', status: 'available' })

  // ---- taxConfig fixtures ----
  taxConfig1 = await db.taxConfig.create({ store: store1.id, name: 'IDOR_TAX_1', rate: 10 })
  taxConfig2 = await db.taxConfig.create({ store: store2.id, name: 'IDOR_TAX_2', rate: 11 })

  // ---- shift_template fixtures ----
  shiftTemplate1 = await db.shift_template.create({
    store: store1.id, name: 'IDOR_SHIFTTPL_1', startTime: '08:00', endTime: '16:00'
  })
  shiftTemplate2 = await db.shift_template.create({
    store: store2.id, name: 'IDOR_SHIFTTPL_2', startTime: '16:00', endTime: '00:00'
  })

  // ---- product fixtures (ownership via product_store junction) ----
  productCategory = await db.category.create({ name: 'IDOR_PRODUCT_CATEGORY' })
  idorProduct1 = await db.product.create({
    nameProduct: 'IDOR_PRODUCT_1', category: productCategory.id, price: 1000, costPrice: 500
  })
  idorProduct2 = await db.product.create({
    nameProduct: 'IDOR_PRODUCT_2', category: productCategory.id, price: 2000, costPrice: 900
  })
  await db.product_store.create({ product: idorProduct1.id, store: store1.id })
  await db.product_store.create({ product: idorProduct2.id, store: store2.id })

  // ---- position fixtures ----
  position1 = await db.position.create({ store: store1.id, name: 'IDOR_POSITION_1' })
  position2 = await db.position.create({ store: store2.id, name: 'IDOR_POSITION_2' })

  // ---- shift fixtures ----
  idorShift1 = await db.shift.create({
    store: store1.id, name: 'IDOR_SHIFT_1', startTime: '08:00', endTime: '16:00'
  })
  idorShift2 = await db.shift.create({
    store: store2.id, name: 'IDOR_SHIFT_2', startTime: '16:00', endTime: '00:00'
  })

  // ---- social_media fixtures ----
  socialMedia1 = await db.social_media.create({ store: store1.id, name: 'IDOR_SOCIAL_1', link: 'https://x.test/1' })
  socialMedia2 = await db.social_media.create({ store: store2.id, name: 'IDOR_SOCIAL_2', link: 'https://x.test/2' })

  // ---- product_batch fixtures ----
  batch1 = await db.product_batch.create({
    store: store1.id, product: idorProduct1.id, batchCode: 'IDOR-BATCH-1', expiryDate: '2027-01-01', qty: 10
  })
  batch2 = await db.product_batch.create({
    store: store2.id, product: idorProduct2.id, batchCode: 'IDOR-BATCH-2', expiryDate: '2027-01-01', qty: 20
  })

  // ---- supplier_score fixtures (store written as a real JSONB array by
  // calculateSupplierScore's own create path — match that shape) ----
  supplierScore1 = await db.supplier_score.create({
    store: [store1.id], supplierId: bankSupplier1.id, period: 'monthly'
  })
  supplierScore2 = await db.supplier_score.create({
    store: [store2.id], supplierId: bankSupplier2.id, period: 'monthly'
  })

  // ---- invoice_setting fixture (store 2 only — the malicious-update test
  // asserts fail-closed behavior, so no store-1 setting is ever created) ----
  invoiceSetting2 = await db.invoice_setting.create({ store: store2.id, footer: 'IDOR_INVOICE_2' })

  // ---- driver fixtures ----
  driver1 = await db.driver.create({ store: [store1.id], name: 'IDOR_DRIVER_1' })
  driver2 = await db.driver.create({ store: [store2.id], name: 'IDOR_DRIVER_2' })

  // P1 (DR-PAY-ATTR-02): split settlement under test requires an open
  // register per store. Cross-store isolation assertions are unaffected:
  // the order lookup is store-scoped before any register logic runs.
  await db.cashRegister.create({ store: store1.id, user: 70002, status: 'open', openingBalance: 0, openedAt: new Date() })
  await db.cashRegister.create({ store: store2.id, user: 70003, status: 'open', openingBalance: 0, openedAt: new Date() })
})

afterAll(async () => {
  await db.driver.destroy({ where: { id: [driver1?.id, driver2?.id] }, force: true })
  await db.invoice_setting.destroy({ where: { store: [store1?.id, store2?.id] }, force: true })
  await db.supplier_score.destroy({ where: { id: [supplierScore1?.id, supplierScore2?.id] }, force: true })
  await db.product_batch.destroy({ where: { id: [batch1?.id, batch2?.id] }, force: true })
  await db.social_media.destroy({ where: { id: [socialMedia1?.id, socialMedia2?.id] }, force: true })
  await db.shift.destroy({ where: { id: [idorShift1?.id, idorShift2?.id] }, force: true })
  await db.position.destroy({ where: { id: [position1?.id, position2?.id] }, force: true })
  await db.product_store.destroy({ where: { product: [idorProduct1?.id, idorProduct2?.id] }, force: true })
  await db.product.destroy({ where: { id: [idorProduct1?.id, idorProduct2?.id] }, force: true })
  await db.category.destroy({ where: { id: productCategory?.id }, force: true })
  await db.shift_template.destroy({ where: { id: [shiftTemplate1?.id, shiftTemplate2?.id] }, force: true })
  await db.taxConfig.destroy({ where: { id: [taxConfig1?.id, taxConfig2?.id] }, force: true })
  await db.table.destroy({ where: { id: [table1?.id, table2?.id] }, force: true })
  await db.waiter_request.destroy({ where: { id: [waiterRequest1?.id, waiterRequest2?.id] }, force: true })
  await db.type_payment.destroy({ where: { id: [typePayment1?.id, typePayment2?.id] }, force: true })
  await db.reservation.destroy({ where: { id: [reservation1?.id, reservation2?.id] }, force: true })
  await db.notification.destroy({
    where: { id: [notification1?.id, notification2?.id, notificationGlobal?.id] },
    force: true
  })
  await db.supplier_contact.destroy({ where: { id: [contact1?.id, contact2?.id] }, force: true })
  await db.supplier_bank_account.destroy({
    where: { id: [bankAccount1?.id, bankAccount2?.id, bankAccountGlobal?.id] },
    force: true
  })
  await db.supplier.destroy({
    where: { id: [bankSupplier1?.id, bankSupplier2?.id, bankSupplierGlobal?.id] },
    force: true
  })
  await db.category_store.destroy({ where: { category: [category1?.id, category2?.id] }, force: true })
  await db.category.destroy({ where: { id: [category1?.id, category2?.id] }, force: true })
  await db.shift_swap.destroy({ where: { id: [swap1?.id, swap2?.id] }, force: true })
  await db.user.destroy({
    where: { id: [userReq1?.id, userTgt1?.id, userReq2?.id, userTgt2?.id] },
    force: true
  })
  await db.shift.destroy({ where: { id: [shiftA?.id, shiftB?.id] }, force: true })
  await db.product_bundle.destroy({ where: { id: [bundle1?.id, bundle2?.id] }, force: true })
  await db.split_bill.destroy({ where: { order: [sbOrder1?.id, sbOrder2?.id] }, force: true })
  await db.transaction.destroy({ where: { order: [sbOrder1?.id, sbOrder2?.id] }, force: true })
  await db.order.destroy({ where: { id: [sbOrder1?.id, sbOrder2?.id] }, force: true })
  await db.discount.destroy({ where: { id: [discount1?.id, discount2?.id] }, force: true })
  await db.user.destroy({ where: { id: [employee1?.id, employee2?.id] }, force: true })
  // P1-4 caller-identity fixtures (see beforeAll).
  // P1 registers reference their opener users — destroy registers first.
  await db.cashRegister.destroy({ where: { store: [store1?.id, store2?.id] }, force: true })
  await db.user.destroy({ where: { id: [70001, 70002, 70003, 70004] }, force: true })
  await db.delivery_status_history.destroy({ where: {}, force: true })
  await db.delivery_order.destroy({
    where: { store: [store1?.id, store2?.id] },
    force: true
  })
  await db.promo_campaign.destroy({
    where: { id: [campaign1?.id, campaign2?.id, campaignGlobal?.id] },
    force: true
  })
  await db.queue.destroy({ where: { store: [store1?.id, store2?.id] }, force: true })
  await db.purchase_payment.destroy({
    where: { id: [payment1?.id, payment2?.id] },
    force: true
  })
  await db.purchase_order.destroy({
    where: { id: [po1?.id, po2?.id] },
    force: true
  })
  await db.supplier.destroy({ where: { id: supplier?.id }, force: true })
  await db.location.destroy({ where: { id: [store1?.id, store2?.id] }, force: true })
})

// ============================== purchasePayment ==============================

describe('GET /purchase-payment/detail/:id — tenant isolation', () => {
  test('store 1 admin can read own payment', async () => {
    const res = await request(app)
      .get(`/purchase-payment/detail/${payment1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(payment1.id)
  })

  test('store 1 admin cannot read store 2 payment (404, no data leaked)', async () => {
    const res = await request(app)
      .get(`/purchase-payment/detail/${payment2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
    expect(res.body.data).toBeUndefined()
    // supplier phone / amount must never appear in the response body
    expect(JSON.stringify(res.body)).not.toContain('75000')
  })

  test('super_admin can read any store payment', async () => {
    const res = await request(app)
      .get(`/purchase-payment/detail/${payment2.id}`)
      .set('Authorization', `Bearer ${superAdminToken}`)

    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(payment2.id)
  })
})

describe('DELETE /purchase-payment/delete/:id — tenant isolation', () => {
  test('store 1 admin cannot delete store 2 payment; row survives', async () => {
    const res = await request(app)
      .delete(`/purchase-payment/delete/${payment2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)

    const stillThere = await db.purchase_payment.findByPk(payment2.id)
    expect(stillThere).not.toBeNull()
    expect(Number(stillThere.amount)).toBe(75000)
  })

  test('store 1 admin can delete own payment', async () => {
    const throwaway = await db.purchase_payment.create({
      store: store1.id,
      purchaseOrder: po1.id,
      supplier: supplier.id,
      amount: 1000,
      paymentMethod: 'cash'
    })

    const res = await request(app)
      .delete(`/purchase-payment/delete/${throwaway.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    const deleted = await db.purchase_payment.findByPk(throwaway.id)
    expect(deleted).toBeNull()
  })
})

// GET /list previously derived scope from req.cookies.store only (which the
// FE never sets) and never consulted req.storeId — so a non-super-admin saw
// every store's payments. Regression: non-super-admins must be scoped to
// their own store via req.storeId; super_admin scoping via query store.

describe('GET /purchase-payment/list — tenant isolation', () => {
  test('store 1 admin sees only store 1 payments, never store 2', async () => {
    const res = await request(app)
      .get('/purchase-payment/list')
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    const ids = (res.body.data || []).map((p) => p.id)
    expect(ids).toContain(payment1.id)
    expect(ids).not.toContain(payment2.id)
    // store 2's PO number and amount must never appear in the body
    expect(JSON.stringify(res.body)).not.toContain('IDOR-PO-2')
    expect(JSON.stringify(res.body)).not.toContain('75000')
  })

  test('store 1 admin claiming store 2 via query is rejected (403)', async () => {
    const res = await request(app)
      .get(`/purchase-payment/list?store=${store2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(403)
  })

  test('store 1 admin passing own store scope still sees only own payments', async () => {
    const res = await request(app)
      .get(`/purchase-payment/list?store=${store1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    const ids = (res.body.data || []).map((p) => p.id)
    expect(ids).toContain(payment1.id)
    expect(ids).not.toContain(payment2.id)
  })

  test('super_admin scoping with store=1 query sees only store 1 payments', async () => {
    const res = await request(app)
      .get(`/purchase-payment/list?store=${store1.id}`)
      .set('Authorization', `Bearer ${superAdminToken}`)

    expect(res.status).toBe(200)
    const ids = (res.body.data || []).map((p) => p.id)
    expect(ids).toContain(payment1.id)
    expect(ids).not.toContain(payment2.id)
  })
})

// ==================================== queue ====================================

describe('GET /queue/:id — tenant isolation', () => {
  test('store 1 admin can read own queue entry', async () => {
    const res = await request(app)
      .get(`/queue/${queue1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.customerName).toBe('IDOR_CUSTOMER_1')
  })

  test('store 1 admin cannot read store 2 queue entry (no data leaked)', async () => {
    const res = await request(app)
      .get(`/queue/${queue2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
    expect(JSON.stringify(res.body)).not.toContain('IDOR_CUSTOMER_2')
  })
})

describe('PUT /queue/:id — tenant isolation', () => {
  test('store 1 admin cannot update store 2 queue entry; row unchanged', async () => {
    const res = await request(app)
      .put(`/queue/${queue2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ customerName: 'HACKED' })

    expect(res.status).toBe(404)

    const unchanged = await db.queue.findByPk(queue2.id)
    expect(unchanged.customerName).toBe('IDOR_CUSTOMER_2')
  })

  test('store 1 kasir can update own queue entry', async () => {
    const res = await request(app)
      .put(`/queue/${queue1.id}`)
      .set('Authorization', `Bearer ${kasirStore1Token}`)
      .send({ customerName: 'IDOR_CUSTOMER_1_UPDATED' })

    expect(res.status).toBe(200)
    await queue1.reload()
    expect(queue1.customerName).toBe('IDOR_CUSTOMER_1_UPDATED')

    await queue1.update({ customerName: 'IDOR_CUSTOMER_1' })
  })

  test('super_admin can update store 2 queue entry', async () => {
    const res = await request(app)
      .put(`/queue/${queue2.id}`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ customerName: 'IDOR_CUSTOMER_2_SUPER_EDIT' })

    expect(res.status).toBe(200)
    await queue2.reload()
    expect(queue2.customerName).toBe('IDOR_CUSTOMER_2_SUPER_EDIT')

    await queue2.update({ customerName: 'IDOR_CUSTOMER_2' })
  })
})

describe('PUT /queue/:id/status — tenant isolation', () => {
  test('store 1 admin cannot change status of store 2 queue entry', async () => {
    const res = await request(app)
      .put(`/queue/${queue2.id}/status`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ status: 'seated' })

    expect(res.status).toBe(404)

    const unchanged = await db.queue.findByPk(queue2.id)
    expect(unchanged.status).toBe('waiting')
  })
})

describe('DELETE /queue/:id — tenant isolation', () => {
  test('store 1 admin cannot delete store 2 queue entry; row survives', async () => {
    const res = await request(app)
      .delete(`/queue/${queue2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
    const stillThere = await db.queue.findByPk(queue2.id)
    expect(stillThere).not.toBeNull()
  })
})

// ================================ promo campaign ================================

describe('GET /promo/campaigns/:id — tenant isolation', () => {
  test('store 1 admin can read own campaign', async () => {
    const res = await request(app)
      .get(`/promo/campaigns/${campaign1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('IDOR_CAMPAIGN_1')
  })

  test('store 1 admin cannot read store 2 campaign (no config leaked)', async () => {
    const res = await request(app)
      .get(`/promo/campaigns/${campaign2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
    expect(JSON.stringify(res.body)).not.toContain('IDOR_CAMPAIGN_2')
  })
})

describe('PUT /promo/campaigns/:id — tenant isolation', () => {
  test('store 1 admin cannot update store 2 campaign; row unchanged', async () => {
    const res = await request(app)
      .put(`/promo/campaigns/${campaign2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ name: 'HACKED' })

    expect(res.status).toBe(404)

    const unchanged = await db.promo_campaign.findByPk(campaign2.id)
    expect(unchanged.name).toBe('IDOR_CAMPAIGN_2')
  })

  test('store 1 admin can update own campaign', async () => {
    const res = await request(app)
      .put(`/promo/campaigns/${campaign1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ name: 'IDOR_CAMPAIGN_1_UPDATED' })

    expect(res.status).toBe(200)
    await campaign1.reload()
    expect(campaign1.name).toBe('IDOR_CAMPAIGN_1_UPDATED')

    await campaign1.update({ name: 'IDOR_CAMPAIGN_1' })
  })

  test('store 1 admin cannot update a global (all-store) campaign', async () => {
    // Design decision: `store: null` means "applies to every store" on the
    // read/apply side, but a single store's admin editing a company-wide
    // campaign is a bigger blast radius than editing their own store's —
    // only super_admin can mutate a global campaign. See tenantScope.js.
    const res = await request(app)
      .put(`/promo/campaigns/${campaignGlobal.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ name: 'HACKED_GLOBAL' })

    expect(res.status).toBe(404)
    const unchanged = await db.promo_campaign.findByPk(campaignGlobal.id)
    expect(unchanged.name).toBe('IDOR_CAMPAIGN_GLOBAL')
  })

  test('super_admin can update a global campaign', async () => {
    const res = await request(app)
      .put(`/promo/campaigns/${campaignGlobal.id}`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ name: 'IDOR_CAMPAIGN_GLOBAL_EDITED' })

    expect(res.status).toBe(200)
    await campaignGlobal.reload()
    expect(campaignGlobal.name).toBe('IDOR_CAMPAIGN_GLOBAL_EDITED')

    await campaignGlobal.update({ name: 'IDOR_CAMPAIGN_GLOBAL' })
  })
})

describe('PUT /promo/campaigns/:id/status — tenant isolation', () => {
  test('store 1 admin cannot change status of store 2 campaign', async () => {
    const res = await request(app)
      .put(`/promo/campaigns/${campaign2.id}/status`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ status: 'paused' })

    expect(res.status).toBe(404)
    const unchanged = await db.promo_campaign.findByPk(campaign2.id)
    expect(unchanged.status).toBe('draft')
  })
})

describe('DELETE /promo/campaigns/:id — tenant isolation', () => {
  test('store 1 admin cannot delete store 2 campaign; row survives', async () => {
    const res = await request(app)
      .delete(`/promo/campaigns/${campaign2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
    const stillThere = await db.promo_campaign.findByPk(campaign2.id)
    expect(stillThere).not.toBeNull()
  })
})

// ================================= delivery order =================================

describe('GET /delivery/orders/:id — tenant isolation', () => {
  test('store 1 admin can read own delivery order', async () => {
    const res = await request(app)
      .get(`/delivery/orders/${delivery1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.customerName).toBe('IDOR_DLV_CUSTOMER_1')
  })

  test('store 1 admin cannot read store 2 delivery order (phone/address not leaked)', async () => {
    const res = await request(app)
      .get(`/delivery/orders/${delivery2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
    const body = JSON.stringify(res.body)
    expect(body).not.toContain('IDOR_DLV_CUSTOMER_2')
    expect(body).not.toContain('0822222222')
  })
})

describe('PUT /delivery/orders/status — tenant isolation', () => {
  test('store 1 admin cannot update status of store 2 delivery order; row unchanged', async () => {
    const res = await request(app)
      .put('/delivery/orders/status')
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ id: delivery2.id, status: 'picked_up' })

    expect(res.status).toBe(404)

    const unchanged = await db.delivery_order.findByPk(delivery2.id)
    expect(unchanged.status).toBe('pending')
  })

  test('store 1 admin can update status of own delivery order', async () => {
    const res = await request(app)
      .put('/delivery/orders/status')
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ id: delivery1.id, status: 'picked_up' })

    expect(res.status).toBe(200)
    await delivery1.reload()
    expect(delivery1.status).toBe('picked_up')

    await delivery1.update({ status: 'pending' })
  })
})

describe('PUT /delivery/orders/:orderId/assign-driver — tenant isolation', () => {
  test('store 1 admin cannot assign a driver to store 2 delivery order', async () => {
    const res = await request(app)
      .put(`/delivery/orders/${delivery2.id}/assign-driver`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ driverId: 999999 })

    expect(res.status).toBe(404)
    const unchanged = await db.delivery_order.findByPk(delivery2.id)
    expect(unchanged.driverId).toBeNull()
  })
})

describe('PUT /delivery/orders/:id/cancel — tenant isolation', () => {
  test('store 1 admin cannot cancel store 2 delivery order; row survives unchanged', async () => {
    const res = await request(app)
      .put(`/delivery/orders/${delivery2.id}/cancel`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ reason: 'test' })

    expect(res.status).toBe(404)
    const unchanged = await db.delivery_order.findByPk(delivery2.id)
    expect(unchanged.status).toBe('pending')
  })

  test('store 1 admin can cancel own delivery order', async () => {
    const throwaway = await db.delivery_order.create({
      store: store1.id,
      orderNumber: 'IDOR-DLV-3',
      customerName: 'IDOR_DLV_CUSTOMER_3',
      deliveryAddress: 'Address 3',
      status: 'pending'
    })

    const res = await request(app)
      .put(`/delivery/orders/${throwaway.id}/cancel`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ reason: 'test cancel' })

    expect(res.status).toBe(200)
    await throwaway.reload()
    expect(throwaway.status).toBe('cancelled')

    await throwaway.destroy({ force: true })
  })
})

// ==================================== employee ====================================

describe('GET /employee/get-employee/:id — tenant isolation', () => {
  test('store 1 admin can read own employee', async () => {
    const res = await request(app)
      .get(`/employee/get-employee/${employee1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.fullName).toBe('IDOR_EMPLOYEE_1')
  })

  test('store 1 admin cannot read store 2 employee (no PII leaked)', async () => {
    const res = await request(app)
      .get(`/employee/get-employee/${employee2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
    expect(JSON.stringify(res.body)).not.toContain('idor_employee2@test.com')
  })

  test('super_admin can read any store employee', async () => {
    const res = await request(app)
      .get(`/employee/get-employee/${employee2.id}`)
      .set('Authorization', `Bearer ${superAdminToken}`)

    expect(res.status).toBe(200)
  })
})

describe('PUT /employee/edit-employee — tenant isolation', () => {
  test('store 1 admin cannot update store 2 employee; row unchanged', async () => {
    const res = await request(app)
      .put('/employee/edit-employee')
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ id: employee2.id, fullName: 'HACKED' })

    expect(res.status).toBe(404)

    const unchanged = await db.user.findByPk(employee2.id)
    expect(unchanged.fullName).toBe('IDOR_EMPLOYEE_2')
  })

  test('store 1 admin can update own employee', async () => {
    const res = await request(app)
      .put('/employee/edit-employee')
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ id: employee1.id, fullName: 'IDOR_EMPLOYEE_1_UPDATED' })

    expect(res.status).toBe(200)
    await employee1.reload()
    expect(employee1.fullName).toBe('IDOR_EMPLOYEE_1_UPDATED')

    await employee1.update({ fullName: 'IDOR_EMPLOYEE_1' })
  })
})

describe('DELETE /employee/delete-employee/:id — tenant isolation', () => {
  test('store 1 admin cannot delete store 2 employee; row survives', async () => {
    const res = await request(app)
      .delete(`/employee/delete-employee/${employee2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)

    const stillThere = await db.user.findByPk(employee2.id)
    expect(stillThere).not.toBeNull()
  })

  test('store 1 admin can delete own employee', async () => {
    const throwaway = await db.user.create({
      userName: 'idor_employee_throwaway',
      email: 'idor_employee_throwaway@test.com',
      roleType: 'kasir',
      userType: 'user',
      store: store1.id,
      status: 'active',
      fullName: 'IDOR_EMPLOYEE_THROWAWAY'
    })

    const res = await request(app)
      .delete(`/employee/delete-employee/${throwaway.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    const deleted = await db.user.findByPk(throwaway.id)
    expect(deleted).toBeNull()

    // deleteEmployee soft-deletes (paranoid model, matching pre-existing
    // behavior) — hard-delete here so this throwaway row doesn't keep
    // referencing store1 and block the afterAll location cleanup.
    await db.user.destroy({ where: { id: throwaway.id }, force: true })
  })
})

// ==================================== discount ====================================

describe('GET /discount/get-discount/:id — tenant isolation', () => {
  test('store 1 admin can read own discount', async () => {
    const res = await request(app)
      .get(`/discount/get-discount/${discount1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
  })

  test('store 1 admin cannot read store 2 discount', async () => {
    const res = await request(app)
      .get(`/discount/get-discount/${discount2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
  })
})

describe('PUT /discount/edit-discount/:id — tenant isolation', () => {
  test('store 1 admin cannot update store 2 discount; row unchanged', async () => {
    const res = await request(app)
      .put(`/discount/edit-discount/${discount2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ name: 'HACKED', type: 'percent', value: 99 })

    expect(res.status).toBe(404)

    const unchanged = await db.discount.findByPk(discount2.id)
    expect(unchanged.name).toBe('IDOR_DISCOUNT_2')
    expect(unchanged.value).toBe(20)
  })

  test('store 1 admin can update own discount', async () => {
    const res = await request(app)
      .put(`/discount/edit-discount/${discount1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ name: 'IDOR_DISCOUNT_1_UPDATED', type: 'percent', value: 15 })

    expect(res.status).toBe(200)

    const updated = await db.discount.findByPk(discount1.id)
    expect(updated.name).toBe('IDOR_DISCOUNT_1_UPDATED')

    await updated.update({ name: 'IDOR_DISCOUNT_1', value: 10 })
  })
})

describe('DELETE /discount/delete-discount/:id — tenant isolation', () => {
  test('store 1 admin cannot delete store 2 discount; row survives', async () => {
    const res = await request(app)
      .delete(`/discount/delete-discount/${discount2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    // deleteDiscountById's existing affected-row branch returns 403, not
    // 404, for "nothing was deleted" — preserved as-is (not part of this
    // fix's scope), documented here rather than silently changed.
    expect(res.status).toBe(403)

    const stillThere = await db.discount.findByPk(discount2.id)
    expect(stillThere).not.toBeNull()
  })

  test('store 1 admin can delete own discount', async () => {
    const throwaway = await db.discount.create({
      store: store1.id,
      name: 'IDOR_DISCOUNT_THROWAWAY',
      type: 'percent',
      value: 5
    })

    const res = await request(app)
      .delete(`/discount/delete-discount/${throwaway.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    const deleted = await db.discount.findByPk(throwaway.id)
    expect(deleted).toBeNull()
  })
})

// ==================================== splitBill ====================================

describe('POST /split-bill/create — tenant isolation', () => {
  test('store 1 admin cannot create split bills against store 2 order', async () => {
    const res = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ order: sbOrder2.id, items: [{ amount: 50000 }, { amount: 150000 }] })

    expect(res.status).toBe(404)

    const splits = await db.split_bill.findAll({ where: { order: sbOrder2.id } })
    expect(splits.length).toBe(0)
  })

  test('store 1 admin can create split bills against own order', async () => {
    const res = await request(app)
      .post('/split-bill/create')
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ order: sbOrder1.id, items: [{ amount: 40000 }, { amount: 60000 }] })

    expect(res.status).toBe(201)
    expect(res.body.data.length).toBe(2)
  })
})

describe('GET /split-bill/get-by-order/:orderId — tenant isolation', () => {
  test('store 1 admin cannot read store 2 order splits', async () => {
    const res = await request(app)
      .get(`/split-bill/get-by-order/${sbOrder2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
  })

  test('store 1 admin can read own order splits', async () => {
    const res = await request(app)
      .get(`/split-bill/get-by-order/${sbOrder1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.splits.length).toBe(2)
  })
})

describe('PUT /split-bill/pay/:id — tenant isolation', () => {
  test('store 1 admin cannot pay a split belonging to a store 2 order', async () => {
    const foreignSplit = await db.split_bill.create({
      order: sbOrder2.id,
      splitNumber: 'IDOR-SPLIT-PAY-FOREIGN',
      amount: 25000,
      status: 'pending'
    })

    const res = await request(app)
      .put(`/split-bill/pay/${foreignSplit.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ paymentMethod: 'cash' })

    expect(res.status).toBe(404)

    const unchanged = await db.split_bill.findByPk(foreignSplit.id)
    expect(unchanged.status).toBe('pending')

    await foreignSplit.destroy({ force: true })
  })

  test('store 1 admin can pay a split belonging to their own order', async () => {
    const ownSplit = await db.split_bill.findOne({
      where: { order: sbOrder1.id, status: 'pending' }
    })

    const res = await request(app)
      .put(`/split-bill/pay/${ownSplit.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ paymentMethod: 'cash' })

    expect(res.status).toBe(200)

    await ownSplit.reload()
    expect(ownSplit.status).toBe('paid')
  })
})

describe('DELETE /split-bill/cancel/:id — tenant isolation', () => {
  test('store 1 admin cannot cancel a split belonging to a store 2 order', async () => {
    const foreignSplit = await db.split_bill.create({
      order: sbOrder2.id,
      splitNumber: 'IDOR-SPLIT-CANCEL-FOREIGN',
      amount: 30000,
      status: 'pending'
    })

    const res = await request(app)
      .delete(`/split-bill/cancel/${foreignSplit.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)

    const stillThere = await db.split_bill.findByPk(foreignSplit.id)
    expect(stillThere).not.toBeNull()

    await foreignSplit.destroy({ force: true })
  })

  test('store 1 admin can cancel a pending split belonging to their own order', async () => {
    const ownSplit = await db.split_bill.create({
      order: sbOrder1.id,
      splitNumber: 'IDOR-SPLIT-CANCEL-OWN',
      amount: 10000,
      status: 'pending'
    })

    const res = await request(app)
      .delete(`/split-bill/cancel/${ownSplit.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    const deleted = await db.split_bill.findByPk(ownSplit.id)
    expect(deleted).toBeNull()
  })
})

describe('POST /split-bill/merge — tenant isolation', () => {
  test('store 1 admin cannot merge splits belonging to a store 2 order', async () => {
    const s1 = await db.split_bill.create({
      order: sbOrder2.id,
      splitNumber: 'IDOR-SPLIT-MERGE-A',
      amount: 10000,
      status: 'pending'
    })
    const s2 = await db.split_bill.create({
      order: sbOrder2.id,
      splitNumber: 'IDOR-SPLIT-MERGE-B',
      amount: 20000,
      status: 'pending'
    })

    const res = await request(app)
      .post('/split-bill/merge')
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ order: sbOrder2.id, splitIds: [s1.id, s2.id] })

    expect(res.status).toBe(404)

    const survivors = await db.split_bill.findAll({
      where: { id: [s1.id, s2.id] }
    })
    expect(survivors.length).toBe(2)

    await db.split_bill.destroy({ where: { id: [s1.id, s2.id] }, force: true })
  })

  test('store 1 admin can merge splits belonging to their own order', async () => {
    const s1 = await db.split_bill.create({
      order: sbOrder1.id,
      splitNumber: 'IDOR-SPLIT-MERGE-OWN-A',
      amount: 10000,
      status: 'pending'
    })
    const s2 = await db.split_bill.create({
      order: sbOrder1.id,
      splitNumber: 'IDOR-SPLIT-MERGE-OWN-B',
      amount: 20000,
      status: 'pending'
    })

    const res = await request(app)
      .post('/split-bill/merge')
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ order: sbOrder1.id, splitIds: [s1.id, s2.id] })

    expect(res.status).toBe(201)
    expect(res.body.data.amount).toBe(30000)
  })
})

// ==================================== productBundle ====================================

describe('GET /product-bundle/get-by-id/:id — tenant isolation', () => {
  test('store 1 admin can read own bundle', async () => {
    const res = await request(app)
      .get(`/product-bundle/get-by-id/${bundle1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('IDOR_BUNDLE_1')
  })

  test('store 1 admin cannot read store 2 bundle', async () => {
    const res = await request(app)
      .get(`/product-bundle/get-by-id/${bundle2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
  })
})

describe('PUT /product-bundle/update/:id — tenant isolation', () => {
  test('store 1 admin cannot update store 2 bundle; row unchanged', async () => {
    const res = await request(app)
      .put(`/product-bundle/update/${bundle2.id}`)
      .field('data', JSON.stringify({ name: 'HACKED' }))
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
    const unchanged = await db.product_bundle.findByPk(bundle2.id)
    expect(unchanged.name).toBe('IDOR_BUNDLE_2')
  })
})

describe('DELETE /product-bundle/delete/:id — tenant isolation', () => {
  test('store 1 admin cannot delete store 2 bundle; row survives', async () => {
    const res = await request(app)
      .delete(`/product-bundle/delete/${bundle2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
    const stillThere = await db.product_bundle.findByPk(bundle2.id)
    expect(stillThere).not.toBeNull()
  })
})

describe('PATCH /product-bundle/status/:id — tenant isolation', () => {
  test('store 1 admin cannot change status of store 2 bundle; row unchanged', async () => {
    const res = await request(app)
      .patch(`/product-bundle/status/${bundle2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ status: 'inactive' })

    expect(res.status).toBe(404)
    const unchanged = await db.product_bundle.findByPk(bundle2.id)
    expect(unchanged.status).toBe('active')
  })
})

// ==================================== shiftSwap ====================================

describe('PUT /shift-swap/update-swap-status/:id — tenant isolation', () => {
  test('store 1 admin cannot decide store 2 swap; row unchanged', async () => {
    const res = await request(app)
      .put(`/shift-swap/update-swap-status/${swap2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ status: 'rejected' })

    expect(res.status).toBe(404)
    const unchanged = await db.shift_swap.findByPk(swap2.id)
    expect(unchanged.status).toBe('pending')
  })

  test('store 1 admin can decide own store swap', async () => {
    const res = await request(app)
      .put(`/shift-swap/update-swap-status/${swap1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ status: 'rejected' })

    expect(res.status).toBe(200)
    const updated = await db.shift_swap.findByPk(swap1.id)
    expect(updated.status).toBe('rejected')
  })
})

describe('PUT /shift-swap/cancel/:id — tenant isolation', () => {
  test('store 1 admin cannot cancel store 2 swap; row unchanged', async () => {
    const foreignSwap = await db.shift_swap.create({
      store: store2.id,
      requesterId: userReq2.id,
      targetId: userTgt2.id,
      requesterShiftId: shiftA.id,
      targetShiftId: shiftB.id,
      status: 'pending'
    })

    const res = await request(app)
      .put(`/shift-swap/cancel/${foreignSwap.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
    const unchanged = await db.shift_swap.findByPk(foreignSwap.id)
    expect(unchanged.status).toBe('pending')

    await foreignSwap.destroy({ force: true })
  })

  test('store 1 admin can cancel own store swap', async () => {
    const ownSwap = await db.shift_swap.create({
      store: store1.id,
      requesterId: userReq1.id,
      targetId: userTgt1.id,
      requesterShiftId: shiftA.id,
      targetShiftId: shiftB.id,
      status: 'pending'
    })

    const res = await request(app)
      .put(`/shift-swap/cancel/${ownSwap.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    const updated = await db.shift_swap.findByPk(ownSwap.id)
    expect(updated.status).toBe('cancelled')

    await ownSwap.destroy({ force: true })
  })
})

// ==================================== category ====================================

describe('GET /category/get-category/:id — tenant isolation', () => {
  test('store 1 admin can read own category', async () => {
    const res = await request(app)
      .get(`/category/get-category/${category1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('IDOR_CATEGORY_1')
  })

  test('store 1 admin cannot read store 2 category', async () => {
    const res = await request(app)
      .get(`/category/get-category/${category2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
  })

  test('super_admin can read store 2 category', async () => {
    const res = await request(app)
      .get(`/category/get-category/${category2.id}`)
      .set('Authorization', `Bearer ${superAdminToken}`)

    expect(res.status).toBe(200)
  })
})

describe('PUT /category/edit-category/:id — tenant isolation', () => {
  test('store 1 admin cannot update store 2 category; row unchanged', async () => {
    const res = await request(app)
      .put(`/category/edit-category/${category2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ name: 'HACKED' })

    expect(res.status).toBe(404)
    const unchanged = await db.category.findByPk(category2.id)
    expect(unchanged.name).toBe('IDOR_CATEGORY_2')
  })

  test('store 1 admin can update own category', async () => {
    const res = await request(app)
      .put(`/category/edit-category/${category1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ name: 'IDOR_CATEGORY_1_UPDATED' })

    expect(res.status).toBe(200)
    const updated = await db.category.findByPk(category1.id)
    expect(updated.name).toBe('IDOR_CATEGORY_1_UPDATED')

    await updated.update({ name: 'IDOR_CATEGORY_1' })
  })
})

describe('DELETE /category/delete-category/:id — tenant isolation', () => {
  test('store 1 admin cannot delete store 2 category; row survives', async () => {
    const res = await request(app)
      .delete(`/category/delete-category/${category2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
    const stillThere = await db.category.findByPk(category2.id)
    expect(stillThere).not.toBeNull()
  })

  test('store 1 admin can delete own category', async () => {
    const throwaway = await db.category.create({ name: 'IDOR_CATEGORY_THROWAWAY' })
    await db.category_store.create({ category: throwaway.id, store: store1.id })

    const res = await request(app)
      .delete(`/category/delete-category/${throwaway.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    const deleted = await db.category.findByPk(throwaway.id)
    expect(deleted).toBeNull()

    await db.category_store.destroy({ where: { category: throwaway.id }, force: true })
    await db.category.destroy({ where: { id: throwaway.id }, force: true })
  })
})

// ==================================== supplierBankAccount ====================================

describe('GET /supplier-bank-account/:id — tenant isolation (relation-based via supplier.store)', () => {
  test('store 1 admin can read own bank account', async () => {
    const res = await request(app)
      .get(`/supplier-bank-account/${bankAccount1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.accountNumber).toBe('1111')
  })

  test('store 1 admin cannot read store 2 bank account (no data leaked)', async () => {
    const res = await request(app)
      .get(`/supplier-bank-account/${bankAccount2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
    expect(JSON.stringify(res.body)).not.toContain('2222')
  })

  // supplier.js's own list endpoint treats an unassigned supplier
  // (store: [] or null) as visible to every store, not just super_admin —
  // this locks in that the bank-account fix mirrors the same convention
  // rather than accidentally being stricter than the supplier module itself.
  test('store 1 admin can read a bank account belonging to a global (unassigned) supplier', async () => {
    const res = await request(app)
      .get(`/supplier-bank-account/${bankAccountGlobal.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.accountNumber).toBe('3333')
  })
})

describe('PUT /supplier-bank-account/:id — tenant isolation', () => {
  test('store 1 admin cannot update store 2 bank account; row unchanged', async () => {
    const res = await request(app)
      .put(`/supplier-bank-account/${bankAccount2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ bankName: 'HACKED' })

    expect(res.status).toBe(404)
    const unchanged = await db.supplier_bank_account.findByPk(bankAccount2.id)
    expect(unchanged.bankName).toBe('BCA')
    expect(unchanged.accountNumber).toBe('2222')
  })
})

describe('DELETE /supplier-bank-account/:id — tenant isolation', () => {
  test('store 1 admin cannot delete store 2 bank account; row survives', async () => {
    const res = await request(app)
      .delete(`/supplier-bank-account/${bankAccount2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
    const stillThere = await db.supplier_bank_account.findByPk(bankAccount2.id)
    expect(stillThere).not.toBeNull()
  })
})

// ==================================== supplierContact ====================================

describe('GET /supplier-contact/:id — tenant isolation (relation-based via supplier.store)', () => {
  test('store 1 admin can read own contact', async () => {
    const res = await request(app)
      .get(`/supplier-contact/${contact1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
  })

  test('store 1 admin cannot read store 2 contact', async () => {
    const res = await request(app)
      .get(`/supplier-contact/${contact2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
    expect(JSON.stringify(res.body)).not.toContain('IDOR_CONTACT_2')
  })
})

describe('DELETE /supplier-contact/:id — tenant isolation', () => {
  test('store 1 admin cannot delete store 2 contact; row survives', async () => {
    const res = await request(app)
      .delete(`/supplier-contact/${contact2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
    const stillThere = await db.supplier_contact.findByPk(contact2.id)
    expect(stillThere).not.toBeNull()
  })
})

// ==================================== notification ====================================

describe('PUT /notification/:id/read — tenant isolation', () => {
  test('store 1 admin cannot mark store 2 notification as read; row unchanged', async () => {
    const res = await request(app)
      .put(`/notification/${notification2.id}/read`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
    const unchanged = await db.notification.findByPk(notification2.id)
    expect(unchanged.isRead).toBe(false)
  })

  test('store 1 admin can mark own store notification as read', async () => {
    const res = await request(app)
      .put(`/notification/${notification1.id}/read`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    const updated = await db.notification.findByPk(notification1.id)
    expect(updated.isRead).toBe(true)

    await updated.update({ isRead: false })
  })

  test('store 1 admin can mark a global (store: null) notification as read', async () => {
    const res = await request(app)
      .put(`/notification/${notificationGlobal.id}/read`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    const updated = await db.notification.findByPk(notificationGlobal.id)
    expect(updated.isRead).toBe(true)

    await updated.update({ isRead: false })
  })
})

// ==================================== reservation ====================================

describe('PUT /reservation/:id — tenant isolation', () => {
  test('store 1 admin cannot update store 2 reservation; row unchanged', async () => {
    const res = await request(app)
      .put(`/reservation/${reservation2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ customerName: 'HACKED' })

    expect(res.status).toBe(404)
    const unchanged = await db.reservation.findByPk(reservation2.id)
    expect(unchanged.customerName).toBe('IDOR_RESV_2')
  })

  // The specific exploit validateStoreAccess does NOT catch on its own:
  // validateStoreAccess resolves requestedStore as
  // `query.store || body.store`, so an attacker who puts their OWN store in
  // the query string satisfies the middleware while a DIFFERENT store in
  // the body reaches the controller. The old `store = req.body.store ||
  // req.user?.store` trusted that body value directly as the authorization
  // boundary. This must be blocked by the controller itself, not the
  // middleware.
  test('malicious req.body.store cannot be used to reach store 2 reservation while req.query.store claims store 1', async () => {
    const res = await request(app)
      .put(`/reservation/${reservation2.id}?store=${store1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ store: store2.id, customerName: 'HACKED_VIA_BODY_STORE' })

    // Fail-closed (KF-NEW-06/07): conflicting query.store + body.store is
    // rejected at the middleware layer before reaching the controller.
    expect(res.status).toBe(403)
    const unchanged = await db.reservation.findByPk(reservation2.id)
    expect(unchanged.customerName).toBe('IDOR_RESV_2')
  })

  test('store 1 admin can update own reservation', async () => {
    const res = await request(app)
      .put(`/reservation/${reservation1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ customerName: 'IDOR_RESV_1_UPDATED' })

    expect(res.status).toBe(200)
    const updated = await db.reservation.findByPk(reservation1.id)
    expect(updated.customerName).toBe('IDOR_RESV_1_UPDATED')

    await updated.update({ customerName: 'IDOR_RESV_1' })
  })
})

describe('DELETE /reservation/:id — tenant isolation', () => {
  test('store 1 admin cannot delete store 2 reservation; row survives', async () => {
    const res = await request(app)
      .delete(`/reservation/${reservation2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
    const stillThere = await db.reservation.findByPk(reservation2.id)
    expect(stillThere).not.toBeNull()
  })

  test('malicious req.body.store cannot be used to delete store 2 reservation while req.query.store claims store 1', async () => {
    const res = await request(app)
      .delete(`/reservation/${reservation2.id}?store=${store1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ store: store2.id })

    // Fail-closed (KF-NEW-06/07): conflicting identifiers rejected at middleware.
    expect(res.status).toBe(403)
    const stillThere = await db.reservation.findByPk(reservation2.id)
    expect(stillThere).not.toBeNull()
  })
})

// ==================================== type-payment ====================================

describe('DELETE /type-payment/delete-type-payment/:id — tenant isolation', () => {
  test('store 1 admin cannot delete store 2 type_payment; row survives', async () => {
    const res = await request(app)
      .delete(`/type-payment/delete-type-payment/${typePayment2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(403)
    const stillThere = await db.type_payment.findByPk(typePayment2.id)
    expect(stillThere).not.toBeNull()
  })

  // Exact scenario named in the audit: req.body.store = Store B (the
  // victim), authenticated user.store = Store A. A bare DELETE with only
  // body.store set is already rejected upstream by validateStoreAccess
  // (it reads body.store too and 403s on mismatch) — the real exploit
  // needs query.store set to the attacker's OWN store to satisfy that
  // middleware while body.store carries the victim's store into the
  // controller, which is exactly what the old `store = body.store ||
  // req.user?.store` trusted directly as the deletion's authorization
  // boundary.
  test('malicious req.body.store cannot be used to delete store 2 type_payment while req.query.store claims store 1', async () => {
    const res = await request(app)
      .delete(`/type-payment/delete-type-payment/${typePayment2.id}?store=${store1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ store: store2.id })

    expect(res.status).toBe(403)
    const stillThere = await db.type_payment.findByPk(typePayment2.id)
    expect(stillThere).not.toBeNull()
  })

  test('store 1 admin can delete own type_payment', async () => {
    const throwaway = await db.type_payment.create({ store: store1.id, name: 'IDOR_TP_THROWAWAY' })

    const res = await request(app)
      .delete(`/type-payment/delete-type-payment/${throwaway.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    const deleted = await db.type_payment.findByPk(throwaway.id)
    expect(deleted).toBeNull()
  })
})

// ==================================== waiter-request ====================================

describe('PUT /waiter-request/:id/status — tenant isolation', () => {
  test('store 1 kasir cannot decide store 2 waiter request; row unchanged', async () => {
    const res = await request(app)
      .put(`/waiter-request/${waiterRequest2.id}/status`)
      .set('Authorization', `Bearer ${kasirStore1Token}`)
      .send({ status: 'done' })

    expect(res.status).toBe(404)
    const unchanged = await db.waiter_request.findByPk(waiterRequest2.id)
    expect(unchanged.status).toBe('pending')
  })

  test('store 1 kasir can decide own store waiter request', async () => {
    const res = await request(app)
      .put(`/waiter-request/${waiterRequest1.id}/status`)
      .set('Authorization', `Bearer ${kasirStore1Token}`)
      .send({ status: 'done' })

    expect(res.status).toBe(200)
    const updated = await db.waiter_request.findByPk(waiterRequest1.id)
    expect(updated.status).toBe('done')

    await updated.update({ status: 'pending' })
  })
})

// ==================================== table ====================================

describe('PUT /table/update/:id — tenant isolation', () => {
  test('store 1 admin cannot update store 2 table; row unchanged', async () => {
    const res = await request(app)
      .put(`/table/update/${table2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ id: table2.id, name: 'HACKED' })

    expect(res.status).toBe(404)
    const unchanged = await db.table.findByPk(table2.id)
    expect(unchanged.name).toBe('IDOR_TABLE_2')
  })

  // Real exploit: query.store claims the attacker's own store (satisfies
  // validateStoreAccess), body.store carries the victim's — the old
  // `store = req.body.store || req.user?.store` trusted that body value
  // directly as the query's authorization boundary.
  test('malicious req.body.store cannot be used to reach store 2 table while req.query.store claims store 1', async () => {
    const res = await request(app)
      .put(`/table/update/${table2.id}?store=${store1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ id: table2.id, store: store2.id, name: 'HACKED_VIA_BODY_STORE' })

    // Fail-closed (KF-NEW-06/07): conflicting identifiers rejected at middleware.
    expect(res.status).toBe(403)
    const unchanged = await db.table.findByPk(table2.id)
    expect(unchanged.name).toBe('IDOR_TABLE_2')
  })

  test('store 1 admin can update own table', async () => {
    const res = await request(app)
      .put(`/table/update/${table1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ id: table1.id, name: 'IDOR_TABLE_1_UPDATED' })

    expect(res.status).toBe(200)
    const updated = await db.table.findByPk(table1.id)
    expect(updated.name).toBe('IDOR_TABLE_1_UPDATED')

    await updated.update({ name: 'IDOR_TABLE_1' })
  })
})

describe('PUT /table/update-status/:id — tenant isolation', () => {
  test('store 1 admin cannot update status of store 2 table; row unchanged', async () => {
    const res = await request(app)
      .put(`/table/update-status/${table2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ id: table2.id, status: 'occupied' })

    expect(res.status).toBe(404)
    const unchanged = await db.table.findByPk(table2.id)
    expect(unchanged.status).toBe('available')
  })
})

describe('DELETE /table/delete/:id — tenant isolation', () => {
  test('store 1 admin cannot delete store 2 table; row survives', async () => {
    const res = await request(app)
      .delete(`/table/delete/${table2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
    const stillThere = await db.table.findByPk(table2.id)
    expect(stillThere).not.toBeNull()
  })

  test('store 1 admin can delete own table', async () => {
    const throwaway = await db.table.create({ store: store1.id, name: 'IDOR_TABLE_THROWAWAY', status: 'available' })

    const res = await request(app)
      .delete(`/table/delete/${throwaway.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    const deleted = await db.table.findByPk(throwaway.id)
    expect(deleted).toBeNull()
  })
})

// ==================================== taxConfig ====================================

describe('PUT /tax-config/edit-tax-config/:id — tenant isolation', () => {
  test('store 1 admin cannot update store 2 tax config; row unchanged', async () => {
    const res = await request(app)
      .put(`/tax-config/edit-tax-config/${taxConfig2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ name: 'HACKED', rate: 99 })

    expect(res.status).toBe(404)
    const unchanged = await db.taxConfig.findByPk(taxConfig2.id)
    expect(unchanged.name).toBe('IDOR_TAX_2')
    expect(unchanged.rate).toBe(11)
  })

  test('store 1 admin can update own tax config', async () => {
    const res = await request(app)
      .put(`/tax-config/edit-tax-config/${taxConfig1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ name: 'IDOR_TAX_1_UPDATED', rate: 12 })

    expect(res.status).toBe(200)
    const updated = await db.taxConfig.findByPk(taxConfig1.id)
    expect(updated.name).toBe('IDOR_TAX_1_UPDATED')

    await updated.update({ name: 'IDOR_TAX_1', rate: 10 })
  })
})

// ==================================== shift_template ====================================

describe('PUT /shift-template/edit-shift-template/:id — tenant isolation', () => {
  test('store 1 admin cannot update store 2 shift template; row unchanged', async () => {
    const res = await request(app)
      .put(`/shift-template/edit-shift-template/${shiftTemplate2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ id: shiftTemplate2.id, name: 'HACKED' })

    expect(res.status).toBe(404)
    const unchanged = await db.shift_template.findByPk(shiftTemplate2.id)
    expect(unchanged.name).toBe('IDOR_SHIFTTPL_2')
  })

  test('store 1 admin can update own shift template', async () => {
    const res = await request(app)
      .put(`/shift-template/edit-shift-template/${shiftTemplate1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ id: shiftTemplate1.id, name: 'IDOR_SHIFTTPL_1_UPDATED' })

    expect(res.status).toBe(200)
    const updated = await db.shift_template.findByPk(shiftTemplate1.id)
    expect(updated.name).toBe('IDOR_SHIFTTPL_1_UPDATED')

    await updated.update({ name: 'IDOR_SHIFTTPL_1' })
  })
})

describe('DELETE /shift-template/delete-shift-template/:id — tenant isolation', () => {
  test('store 1 admin cannot delete store 2 shift template; row survives', async () => {
    const res = await request(app)
      .delete(`/shift-template/delete-shift-template/${shiftTemplate2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
    const stillThere = await db.shift_template.findByPk(shiftTemplate2.id)
    expect(stillThere).not.toBeNull()
  })

  test('store 1 admin can delete own shift template', async () => {
    const throwaway = await db.shift_template.create({
      store: store1.id, name: 'IDOR_SHIFTTPL_THROWAWAY', startTime: '08:00', endTime: '16:00'
    })

    const res = await request(app)
      .delete(`/shift-template/delete-shift-template/${throwaway.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    const deleted = await db.shift_template.findByPk(throwaway.id)
    expect(deleted).toBeNull()
  })
})

// ==================================== product ====================================

describe('GET /product/get-by-id/:id — tenant isolation (relation-based via product_store)', () => {
  test('store 1 admin can read own product', async () => {
    const res = await request(app)
      .get(`/product/get-by-id/${idorProduct1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.nameProduct).toBe('IDOR_PRODUCT_1')
  })

  test('store 1 admin cannot read store 2 product (cost price not leaked)', async () => {
    const res = await request(app)
      .get(`/product/get-by-id/${idorProduct2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
    expect(JSON.stringify(res.body)).not.toContain('IDOR_PRODUCT_2')
  })

  test('super_admin can read store 2 product', async () => {
    const res = await request(app)
      .get(`/product/get-by-id/${idorProduct2.id}`)
      .set('Authorization', `Bearer ${superAdminToken}`)

    expect(res.status).toBe(200)
  })
})

describe('PUT /product/edit-product — tenant isolation', () => {
  test('store 1 admin cannot update store 2 product; row unchanged', async () => {
    const res = await request(app)
      .put('/product/edit-product')
      .field('id', String(idorProduct2.id))
      .field('nameProduct', 'HACKED')
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
    const unchanged = await db.product.findByPk(idorProduct2.id)
    expect(unchanged.nameProduct).toBe('IDOR_PRODUCT_2')
  })

  test('store 1 admin can update own product', async () => {
    const res = await request(app)
      .put('/product/edit-product')
      .field('id', String(idorProduct1.id))
      .field('nameProduct', 'IDOR_PRODUCT_1_UPDATED')
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    const updated = await db.product.findByPk(idorProduct1.id)
    expect(updated.nameProduct).toBe('IDOR_PRODUCT_1_UPDATED')

    await updated.update({ nameProduct: 'IDOR_PRODUCT_1' })
  })
})

describe('DELETE /product/delete-product/:id — tenant isolation', () => {
  test('store 1 admin cannot delete store 2 product; row survives', async () => {
    const res = await request(app)
      .delete(`/product/delete-product/${idorProduct2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ id: idorProduct2.id })

    expect(res.status).toBe(404)
    const stillThere = await db.product.findByPk(idorProduct2.id)
    expect(stillThere).not.toBeNull()
  })

  test('store 1 admin can delete own product', async () => {
    const throwaway = await db.product.create({
      nameProduct: 'IDOR_PRODUCT_THROWAWAY', category: productCategory.id, price: 500
    })
    await db.product_store.create({ product: throwaway.id, store: store1.id })

    const res = await request(app)
      .delete(`/product/delete-product/${throwaway.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ id: throwaway.id })

    expect(res.status).toBe(200)
    const deleted = await db.product.findByPk(throwaway.id)
    expect(deleted).toBeNull()

    // deleteProductByIdAndLocation soft-deletes (paranoid model) — hard-
    // delete here so this throwaway row doesn't keep referencing
    // productCategory and block the afterAll cleanup below.
    await db.product_store.destroy({ where: { product: throwaway.id }, force: true })
    await db.product.destroy({ where: { id: throwaway.id }, force: true })
  })
})

// ==================================== position ====================================

describe('GET /position/get-position/:id — tenant isolation', () => {
  test('store 1 admin can read own position', async () => {
    const res = await request(app)
      .get(`/position/get-position/${position1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
  })

  test('store 1 kasir cannot read store 2 position', async () => {
    const res = await request(app)
      .get(`/position/get-position/${position2.id}`)
      .set('Authorization', `Bearer ${kasirStore1Token}`)

    expect(res.status).toBe(404)
  })
})

describe('PUT /position/edit-position/:id — tenant isolation', () => {
  test('store 1 admin cannot update store 2 position; row unchanged', async () => {
    const res = await request(app)
      .put(`/position/edit-position/${position2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ id: position2.id, name: 'HACKED' })

    expect(res.status).toBe(404)
    const unchanged = await db.position.findByPk(position2.id)
    expect(unchanged.name).toBe('IDOR_POSITION_2')
  })

  test('store 1 admin can update own position', async () => {
    const res = await request(app)
      .put(`/position/edit-position/${position1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ id: position1.id, name: 'IDOR_POSITION_1_UPDATED' })

    expect(res.status).toBe(200)
    const updated = await db.position.findByPk(position1.id)
    expect(updated.name).toBe('IDOR_POSITION_1_UPDATED')

    await updated.update({ name: 'IDOR_POSITION_1' })
  })
})

describe('DELETE /position/delete-position/:id — tenant isolation', () => {
  test('store 1 admin cannot delete store 2 position; row survives, no cross-tenant User side effect', async () => {
    const res = await request(app)
      .delete(`/position/delete-position/${position2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
    const stillThere = await db.position.findByPk(position2.id)
    expect(stillThere).not.toBeNull()
  })

  test('store 1 admin can delete own position', async () => {
    const throwaway = await db.position.create({ store: store1.id, name: 'IDOR_POSITION_THROWAWAY' })

    const res = await request(app)
      .delete(`/position/delete-position/${throwaway.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    const deleted = await db.position.findByPk(throwaway.id)
    expect(deleted).toBeNull()
  })
})

// ==================================== shift ====================================

describe('GET /shift/get-shift/:id — tenant isolation', () => {
  test('store 1 admin can read own shift', async () => {
    const res = await request(app)
      .get(`/shift/get-shift/${idorShift1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
  })

  test('store 1 kasir cannot read store 2 shift', async () => {
    const res = await request(app)
      .get(`/shift/get-shift/${idorShift2.id}`)
      .set('Authorization', `Bearer ${kasirStore1Token}`)

    expect(res.status).toBe(404)
  })
})

describe('PUT /shift/edit-shift/:id — tenant isolation', () => {
  test('store 1 admin cannot update store 2 shift; row unchanged', async () => {
    const res = await request(app)
      .put(`/shift/edit-shift/${idorShift2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ id: idorShift2.id, nama_shift: 'HACKED', jam_mulai: '08:00', jam_selesai: '16:00' })

    expect(res.status).toBe(404)
    const unchanged = await db.shift.findByPk(idorShift2.id)
    expect(unchanged.name).toBe('IDOR_SHIFT_2')
  })

  test('store 1 admin can update own shift', async () => {
    const res = await request(app)
      .put(`/shift/edit-shift/${idorShift1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ id: idorShift1.id, nama_shift: 'IDOR_SHIFT_1_UPDATED', jam_mulai: '08:00', jam_selesai: '16:00' })

    expect(res.status).toBe(200)
    const updated = await db.shift.findByPk(idorShift1.id)
    expect(updated.name).toBe('IDOR_SHIFT_1_UPDATED')

    await updated.update({ name: 'IDOR_SHIFT_1' })
  })
})

describe('DELETE /shift/delete-shift/:id — tenant isolation', () => {
  test('store 1 admin cannot delete store 2 shift; row survives, no cross-tenant User side effect', async () => {
    const res = await request(app)
      .delete(`/shift/delete-shift/${idorShift2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
    const stillThere = await db.shift.findByPk(idorShift2.id)
    expect(stillThere).not.toBeNull()
  })

  test('store 1 admin can delete own shift', async () => {
    const throwaway = await db.shift.create({
      store: store1.id, name: 'IDOR_SHIFT_THROWAWAY', startTime: '08:00', endTime: '16:00'
    })

    const res = await request(app)
      .delete(`/shift/delete-shift/${throwaway.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    const deleted = await db.shift.findByPk(throwaway.id)
    expect(deleted).toBeNull()
  })
})

// ==================================== social-media ====================================

describe('PUT /social-media/edit-social-media/:id — tenant isolation', () => {
  test('store 1 admin cannot update store 2 social media; row unchanged', async () => {
    const res = await request(app)
      .put(`/social-media/edit-social-media/${socialMedia2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ name: 'HACKED' })

    expect(res.status).toBe(404)
    const unchanged = await db.social_media.findByPk(socialMedia2.id)
    expect(unchanged.name).toBe('IDOR_SOCIAL_2')
  })

  // Real exploit: query.store claims the attacker's own store (satisfies
  // validateStoreAccess), body.store carries the victim's.
  test('malicious req.body.store cannot be used to reach store 2 social media while req.query.store claims store 1', async () => {
    const res = await request(app)
      .put(`/social-media/edit-social-media/${socialMedia2.id}?store=${store1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ store: store2.id, name: 'HACKED_VIA_BODY_STORE' })

    // Fail-closed (KF-NEW-06/07): conflicting identifiers rejected at middleware.
    expect(res.status).toBe(403)
    const unchanged = await db.social_media.findByPk(socialMedia2.id)
    expect(unchanged.name).toBe('IDOR_SOCIAL_2')
  })

  test('store 1 admin can update own social media', async () => {
    const res = await request(app)
      .put(`/social-media/edit-social-media/${socialMedia1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ name: 'IDOR_SOCIAL_1_UPDATED' })

    expect(res.status).toBe(200)
    const updated = await db.social_media.findByPk(socialMedia1.id)
    expect(updated.name).toBe('IDOR_SOCIAL_1_UPDATED')

    await updated.update({ name: 'IDOR_SOCIAL_1' })
  })
})

describe('DELETE /social-media/delete-social-media/:id — tenant isolation', () => {
  test('store 1 admin cannot delete store 2 social media; row survives', async () => {
    const res = await request(app)
      .delete(`/social-media/delete-social-media/${socialMedia2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    // deleteSocialMediaById's existing affected-row branch returns 403,
    // not 404, for "nothing was deleted" — same pre-existing convention
    // as discount.deleteDiscountById, preserved as-is (not part of this
    // fix's scope).
    expect(res.status).toBe(403)
    const stillThere = await db.social_media.findByPk(socialMedia2.id)
    expect(stillThere).not.toBeNull()
  })
})

// ==================================== inventory (product_batch) ====================================

describe('GET /inventory/batch/:id — tenant isolation', () => {
  test('store 1 admin can read own batch', async () => {
    const res = await request(app)
      .get(`/inventory/batch/${batch1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
  })

  test('store 1 kasir cannot read store 2 batch (supplier data not leaked)', async () => {
    const res = await request(app)
      .get(`/inventory/batch/${batch2.id}`)
      .set('Authorization', `Bearer ${kasirStore1Token}`)

    expect(res.status).toBe(404)
    expect(JSON.stringify(res.body)).not.toContain('IDOR-BATCH-2')
  })
})

// ==================================== supplier-performance ====================================

describe('GET /supplier-performance/scores/:id — tenant isolation', () => {
  test('store 1 admin can read own supplier score', async () => {
    const res = await request(app)
      .get(`/supplier-performance/scores/${supplierScore1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
  })

  test('store 1 admin cannot read store 2 supplier score (supplier contact info not leaked)', async () => {
    const res = await request(app)
      .get(`/supplier-performance/scores/${supplierScore2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
    expect(JSON.stringify(res.body)).not.toContain('IDOR_BANK_SUPPLIER_2')
  })
})

describe('PUT /supplier-performance/scores/:id/notes — tenant isolation', () => {
  test('store 1 admin cannot update notes on store 2 supplier score; row unchanged', async () => {
    const res = await request(app)
      .put(`/supplier-performance/scores/${supplierScore2.id}/notes`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ notes: 'HACKED' })

    expect(res.status).toBe(404)
    const unchanged = await db.supplier_score.findByPk(supplierScore2.id)
    expect(unchanged.notes).toBeFalsy()
  })

  test('store 1 admin can update notes on own supplier score', async () => {
    const res = await request(app)
      .put(`/supplier-performance/scores/${supplierScore1.id}/notes`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ notes: 'IDOR_NOTE_1' })

    expect(res.status).toBe(200)
    const updated = await db.supplier_score.findByPk(supplierScore1.id)
    expect(updated.notes).toBe('IDOR_NOTE_1')
  })
})

// ==================================== invoice ====================================

describe('PUT /invoice/setting — tenant isolation', () => {
  // No :id in this route — ownership is entirely determined by the
  // `store` the controller resolves. The exploit: query.store claims the
  // attacker's own store (satisfies validateStoreAccess), body.store
  // carries the victim's — the old code used body.store directly with no
  // check, so this landed on the victim's row. After the fix, a
  // non-super-admin's `store` is always their own regardless of body
  // content, so this now succeeds but against the ATTACKER's own store.
  test('malicious req.body.store cannot redirect the update to store 2\'s invoice setting', async () => {
    const res = await request(app)
      .put(`/invoice/setting?store=${store1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ store: store2.id, footer: 'HACKED_VIA_BODY_STORE' })

    // Fail-closed (KF-NEW-06/07): conflicting query.store + body.store is
    // rejected at the middleware layer, so no write lands anywhere.
    expect(res.status).toBe(403)

    // Store 2's setting must be completely untouched.
    const store2Setting = await db.invoice_setting.findOne({ where: { store: store2.id } })
    expect(store2Setting.footer).toBe('IDOR_INVOICE_2')

    // Nothing was written to the attacker's own store either.
    const store1Setting = await db.invoice_setting.findOne({ where: { store: store1.id } })
    expect(store1Setting).toBeNull()
  })
})

// ==================================== reviewer-report fixes: P0/P1/P2 ====================================

describe('POST /purchase-payment/create — cross-tenant PO payment (P0)', () => {
  test('store 1 admin cannot record a payment against store 2\'s purchase order; nothing persisted', async () => {
    const before = await db.purchase_payment.count({ where: { purchaseOrder: po2.id } })

    const res = await request(app)
      .post('/purchase-payment/create')
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ purchaseOrder: po2.id, amount: 10000, paymentMethod: 'cash', supplier: supplier.id })

    expect(res.status).toBe(404)
    const after = await db.purchase_payment.count({ where: { purchaseOrder: po2.id } })
    expect(after).toBe(before)
  })

  test('the over-payment error message no longer leaks store 2\'s PO financials to a store 1 admin', async () => {
    const res = await request(app)
      .post('/purchase-payment/create')
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ purchaseOrder: po2.id, amount: 999999999, paymentMethod: 'cash', supplier: supplier.id })

    expect(res.status).toBe(404)
    expect(res.body.message).not.toMatch(/remaining|Total paid/)
  })

  test('store 1 admin can record a payment against their own purchase order', async () => {
    // purchase_payment.createdBy has a real FK to user.id. adminStore1Token's
    // subject (70002) is a real store-1 admin row (P1-4), and under AUTH-1 P2
    // the row — not an `admin` claim on a kasir account — is the authority.
    const res = await request(app)
      .post('/purchase-payment/create')
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ purchaseOrder: po1.id, amount: 10000, paymentMethod: 'cash', supplier: supplier.id })

    expect(res.status).toBe(201)
    expect(res.body.data.store).toBe(store1.id)

    await db.purchase_payment.destroy({ where: { id: res.body.data.id }, force: true })
  })
})

describe('GET /type-payment/get-by-id/:id — tenant isolation (P1)', () => {
  test('store 1 kasir cannot read store 2 type_payment', async () => {
    const res = await request(app)
      .get(`/type-payment/get-by-id/${typePayment2.id}`)
      .set('Authorization', `Bearer ${kasirStore1Token}`)

    expect(res.status).toBe(404)
  })

  test('store 1 kasir can read own store type_payment', async () => {
    const res = await request(app)
      .get(`/type-payment/get-by-id/${typePayment1.id}`)
      .set('Authorization', `Bearer ${kasirStore1Token}`)

    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('IDOR_TP_1')
  })
})

describe('Driver endpoints — tenant isolation (P1)', () => {
  test('GET /delivery/drivers/:id — store 1 admin cannot read store 2 driver', async () => {
    const res = await request(app)
      .get(`/delivery/drivers/${driver2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
  })

  test('PUT /delivery/drivers/:id — store 1 admin cannot update store 2 driver; row unchanged', async () => {
    const res = await request(app)
      .put(`/delivery/drivers/${driver2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ name: 'HACKED' })

    expect(res.status).toBe(404)
    const unchanged = await db.driver.findByPk(driver2.id)
    expect(unchanged.name).toBe('IDOR_DRIVER_2')
  })

  test('PUT /delivery/drivers/:id/status — store 1 admin cannot update store 2 driver status', async () => {
    const res = await request(app)
      .put(`/delivery/drivers/${driver2.id}/status`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ status: 'inactive' })

    expect(res.status).toBe(404)
  })

  test('DELETE /delivery/drivers/:id — store 1 admin cannot delete store 2 driver; row survives', async () => {
    const res = await request(app)
      .delete(`/delivery/drivers/${driver2.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(404)
    const stillThere = await db.driver.findByPk(driver2.id)
    expect(stillThere).not.toBeNull()
  })

  test('store 1 admin can read and update their own driver', async () => {
    const readRes = await request(app)
      .get(`/delivery/drivers/${driver1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
    expect(readRes.status).toBe(200)

    const updateRes = await request(app)
      .put(`/delivery/drivers/${driver1.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ name: 'IDOR_DRIVER_1_UPDATED' })
    expect(updateRes.status).toBe(200)

    const updated = await db.driver.findByPk(driver1.id)
    expect(updated.name).toBe('IDOR_DRIVER_1_UPDATED')
    await updated.update({ name: 'IDOR_DRIVER_1' })
  })
})

describe('POST /shift-swap/create-swap — cross-store swap creation (P1)', () => {
  test('store 1 kasir cannot create a swap between two store 2 employees', async () => {
    // userReq2/userTgt2 already have a pending swap from the swap2 fixture
    // (created in beforeAll) — assert the count doesn't INCREASE, rather
    // than asserting an absolute 0, so this doesn't collide with that
    // unrelated fixture.
    const before = await db.shift_swap.count({
      where: { requesterId: userReq2.id, targetId: userTgt2.id, status: 'pending' }
    })

    const res = await request(app)
      .post('/shift-swap/create-swap')
      .set('Authorization', `Bearer ${kasirStore1Token}`)
      .send({
        requesterId: userReq2.id,
        targetId: userTgt2.id,
        requesterShiftId: shiftA.id,
        targetShiftId: shiftB.id
      })

    expect(res.status).toBe(403)
    const after = await db.shift_swap.count({
      where: { requesterId: userReq2.id, targetId: userTgt2.id, status: 'pending' }
    })
    expect(after).toBe(before)
  })

  test('store 1 kasir can create a valid swap for themselves', async () => {
    const res = await request(app)
      .post('/shift-swap/create-swap')
      .set('Authorization', `Bearer ${kasirStore1Token}`)
      .send({
        requesterId: 70004,
        targetId: userTgt1.id,
        requesterShiftId: shiftA.id,
        targetShiftId: shiftB.id
      })

    expect(res.status).toBe(201)
    await db.shift_swap.destroy({
      where: { requesterId: 70004, targetId: userTgt1.id, status: 'pending' },
      force: true
    })
  })
})

describe('POST/PUT /supplier — store-array injection on create/update (P2)', () => {
  test('store 1 admin cannot assign a new supplier to store 2 via body.store', async () => {
    const res = await request(app)
      .post('/supplier')
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ name: 'IDOR_SUPPLIER_INJECTION_TEST', phone: '0810000001', store: [store1.id, store2.id, 999999] })

    // A store-1 admin requesting a foreign/multi-store array is a scope-
    // expansion attempt. Fail closed: the WHOLE request is rejected (no
    // supplier is created, so no cross-tenant write can occur).
    expect(res.status).toBe(403)
    const created = await db.supplier.findOne({ where: { name: 'IDOR_SUPPLIER_INJECTION_TEST' } })
    expect(created).toBeNull()
  })

  test('store 1 admin cannot expand an existing own-store supplier\'s store array via update', async () => {
    const sup = await db.supplier.create({ name: 'IDOR_SUPPLIER_UPDATE_TEST', store: [store1.id] })

    const res = await request(app)
      .put(`/supplier/${sup.id}`)
      .set('Authorization', `Bearer ${adminStore1Token}`)
      .send({ store: [store1.id, store2.id] })

    expect(res.status).toBe(403)
    const updated = await db.supplier.findByPk(sup.id)
    expect(updated.store).toEqual([store1.id])

    await db.supplier.destroy({ where: { id: sup.id }, force: true })
  })

  test('super_admin can still assign an arbitrary store array on create', async () => {
    const res = await request(app)
      .post('/supplier')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ name: 'IDOR_SUPPLIER_SUPERADMIN_TEST', phone: '0810000002', store: [store1.id, store2.id] })

    expect(res.status).toBe(201)
    const created = await db.supplier.findByPk(res.body.data.id)
    expect(created.store).toEqual([store1.id, store2.id])

    await db.supplier.destroy({ where: { id: created.id }, force: true })
  })
})

describe('Product create/edit — cross-tenant taxConfig disclosure (P2)', () => {
  test('store 1 admin referencing store 2\'s tax config on product update does not have it applied', async () => {
    const res = await request(app)
      .put('/product/edit-product')
      .field('id', String(idorProduct1.id))
      .field('nameProduct', 'IDOR_PRODUCT_1')
      .field('tax', String(taxConfig2.id))
      .set('Authorization', `Bearer ${adminStore1Token}`)

    expect(res.status).toBe(200)
    const updated = await db.product.findByPk(idorProduct1.id)
    if (updated.tax) {
      const parsedTax = typeof updated.tax === 'string' ? JSON.parse(updated.tax) : updated.tax
      expect(parsedTax?.name).not.toBe('IDOR_TAX_2')
    }
  })
})

// ==================================== super_admin ====================================

describe('super_admin cross-store access is preserved', () => {
  test('super_admin can read store 1 and store 2 purchase payments', async () => {
    const [r1, r2] = await Promise.all([
      request(app)
        .get(`/purchase-payment/detail/${payment1.id}`)
        .set('Authorization', `Bearer ${superAdminToken}`),
      request(app)
        .get(`/purchase-payment/detail/${payment2.id}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
    ])
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
  })

  test('super_admin can read store 1 and store 2 delivery orders', async () => {
    const [r1, r2] = await Promise.all([
      request(app)
        .get(`/delivery/orders/${delivery1.id}`)
        .set('Authorization', `Bearer ${superAdminToken}`),
      request(app)
        .get(`/delivery/orders/${delivery2.id}`)
        .set('Authorization', `Bearer ${superAdminToken}`)
    ])
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
  })
})
