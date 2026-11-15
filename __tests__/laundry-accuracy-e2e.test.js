// E2E akurasi perhitungan laundry (Skema E2E Real-World Laundry, 2026-11-15).
// Real HTTP (supertest) against the test DB. Every check is soft-collected so
// one run reports every golden case; results land in
// LAUNDRY_E2E_OUT (default: <os tmpdir>/laundry-accuracy-e2e.json) and the final
// test fails when any check does not match the golden number.
process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const fs = require('fs')
const os = require('os')
const path = require('path')
const bcrypt = require('bcrypt')
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const RUN = Date.now()
const OUT = process.env.LAUNDRY_E2E_OUT || path.join(os.tmpdir(), 'laundry-accuracy-e2e.json')
const results = []
const soft = (id, label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ id, label, expected, actual, ok })
  return ok
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const hours = (open, close, closed = []) =>
  DAYS.map((day) => (closed.includes(day) ? { day, isOpen: false } : { day, open, close }))

const created = { tenants: [], stores: [], users: [], products: [], campaigns: [], categories: [] }
const ctx = {}

const mkTenant = async (code) => {
  const t = await db.tenant.create({ code: `${code}_${RUN}`.slice(0, 40), name: `${code} ${RUN}`, status: 'active' })
  created.tenants.push(t.id)
  return t
}
const mkStore = async (name, tenantId, openingHours, pin = '1234') => {
  const s = await db.location.create({
    name: `${name}_${RUN}`,
    status: 'active',
    businessType: 'laundry',
    tenantId,
    timezone: 'Asia/Jakarta',
    openingHours,
    laundrySettings: { serviceModel: 'hybrid', minDpPercent: 20, storageDays: 30, ownerPinHash: await bcrypt.hash(pin, 4) }
  })
  created.stores.push(s.id)
  return s
}
const mkAdmin = async (store, tenantId) => {
  const u = await db.user.create({
    userName: `lacc_${store.id}_${RUN}`,
    email: `lacc_${store.id}_${RUN}@t.test`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    tenantId,
    status: 'active',
    fullName: `Admin ${store.name}`
  })
  created.users.push(u.id)
  const token = await signSessionToken({ id: u.id, userName: u.userName, roleType: 'admin', store: store.id }, JWT_SECRET)
  return { Authorization: `Bearer ${token}` }
}
let saAuth
const mkService = async (store, name, price, serviceConfig, unit) => {
  const res = await request(app)
    .post('/product/add-product')
    .set(saAuth)
    .send({
      nameProduct: `${name} ${RUN}`,
      category: ctx.category.id,
      price,
      status: 'active',
      isAvailable: true,
      stores: [store.id],
      tipeProduk: 'laundry_service',
      inventoryMode: 'make_to_order',
      allowDecimalQty: serviceConfig.pricingType === 'kiloan',
      unit: unit || (serviceConfig.pricingType === 'kiloan' ? 'kg' : 'pcs'),
      serviceConfig: { channel: 'full', pricingMode: 'unit', minQty: 1, rounding: 1, ...serviceConfig }
    })
  if (res.status !== 200) throw new Error(`add-product ${name}: ${res.status} ${JSON.stringify(res.body)}`)
  created.products.push(res.body.data.id)
  return res.body.data
}
const mkTurnaround = async (auth, store, name, durationHours, surchargeType, surchargeValue, isDefault = false) => {
  const res = await request(app).post('/laundry/turnaround').set(auth)
    .send({ store: store.id, name, durationHours, surchargeType, surchargeValue, isDefault, status: 'active' })
  if (res.status !== 201) throw new Error(`turnaround ${name}: ${res.status}`)
  return res.body.data
}
const mkPromo = async (tenantId, store, code, rewardType, rewardValue, { maxRewardValue, minPurchase, maxUsageTotal, priority = 1, applicableIds } = {}) => {
  const c = await db.promo_campaign.create({
    name: `LACC_${code}_${RUN}`,
    code,
    type: 'manual',
    status: 'active',
    tenantId,
    store: [store.id],
    startDate: new Date(Date.now() - 86400000),
    endDate: new Date(Date.now() + 86400000),
    minPurchase: minPurchase || 0,
    maxUsageTotal: maxUsageTotal || null,
    currentUsage: 0,
    priority,
    ...(applicableIds ? { applicableTo: 'specific_products', applicableIds } : {})
  })
  await db.promo_reward.create({ campaignId: c.id, rewardType, rewardValue, maxRewardValue: maxRewardValue || null, isActive: true })
  created.campaigns.push(c.id)
  return c
}
const openRegister = async (auth, store, openingBalance) => {
  const res = await request(app).post('/cash-register/open').set(auth).send({ store: store.id, openingBalance, shift: 1 })
  if (![200, 201].includes(res.status)) throw new Error(`open register: ${res.status} ${JSON.stringify(res.body)}`)
  return res.body.data
}
let seq = 0
const key = (p) => `lacc-${p}-${RUN}-${++seq}`
const createOrder = (auth, store, body) =>
  request(app).post('/laundry/order').set(auth).send({ store: store.id, idempotencyKey: key('o'), pieceCount: 5, ...body })
const quote = (auth, store, body) => request(app).post('/laundry/quote').set(auth).send({ store: store.id, ...body })
const txSum = (order) => (order.transactions || []).reduce((s, t) => s + Number(t.amount), 0)
const orderTx = (id) => db.transaction.findAll({ where: { order: id }, order: [['id', 'ASC']] })

beforeAll(async () => {
  const sa = await db.user.create({ userName: `lacc_sa_${RUN}`, email: `lacc_sa_${RUN}@t.test`, roleType: 'super_admin', userType: 'super_admin', status: 'active' })
  created.users.push(sa.id)
  saAuth = { Authorization: `Bearer ${await signSessionToken({ id: sa.id, userName: sa.userName, roleType: 'super_admin' }, JWT_SECRET)}` }
  ctx.category = await db.category.create({ name: `LACC_CAT_${RUN}`, status: 'active' })
  created.categories.push(ctx.category.id)

  // T1 — Cuci Kilat Pak Budi: 07:00–22:00 every day, many promos
  ctx.t1 = await mkTenant('T1')
  ctx.s1 = await mkStore('T1_CempakaPutih', ctx.t1.id, hours('07:00', '22:00'))
  ctx.a1 = await mkAdmin(ctx.s1, ctx.t1.id)
  ctx.ckl = await mkService(ctx.s1, 'Cuci Kering Lipat', 7000, { pricingType: 'kiloan', minQty: 3, rounding: 0.5, costComponents: [{ kind: 'deterjen', amount: 600 }, { kind: 'pewangi', amount: 350 }] })
  ctx.bc = await mkService(ctx.s1, 'Bed Cover', 25000, { pricingType: 'satuan' })
  ctx.selfWash = await mkService(ctx.s1, 'Self Cuci', 8000, { pricingType: 'satuan', channel: 'self', pricingMode: 'cycle' }, 'siklus')
  ctx.selfDry = await mkService(ctx.s1, 'Self Kering', 8000, { pricingType: 'satuan', channel: 'self', pricingMode: 'cycle' }, 'siklus')
  ctx.reg1 = await mkTurnaround(ctx.a1, ctx.s1, 'Reguler', 72, 'none', 0, true)
  ctx.kilat1 = await mkTurnaround(ctx.a1, ctx.s1, 'Kilat', 6, 'percent', 30)
  await mkPromo(ctx.t1.id, ctx.s1, 'HEMAT10', 'discount_percentage', 10, { maxRewardValue: 10000, minPurchase: 30000 })
  await mkPromo(ctx.t1.id, ctx.s1, 'KILAT5', 'discount_fixed', 5000, { minPurchase: 50000 })
  await mkPromo(ctx.t1.id, ctx.s1, 'CUCI20', 'discount_percentage', 20, { maxRewardValue: 20000, maxUsageTotal: 1 })
  await mkPromo(ctx.t1.id, ctx.s1, 'BCONLY20', 'discount_percentage', 20, { applicableIds: [ctx.bc.id] })
  ctx.register1 = await openRegister(ctx.a1, ctx.s1, 0)

  // T2 — Beres Laundry: 08:00–20:00, Sunday closed; report store
  ctx.t2 = await mkTenant('T2')
  ctx.s2 = await mkStore('T2_Antapani', ctx.t2.id, hours('08:00', '20:00', ['sunday']))
  ctx.a2 = await mkAdmin(ctx.s2, ctx.t2.id)
  ctx.ckl2 = await mkService(ctx.s2, 'Cuci Kering Lipat T2', 7000, { pricingType: 'kiloan', minQty: 3, rounding: 0.5, costComponents: [{ kind: 'deterjen', amount: 600 }, { kind: 'pewangi', amount: 350 }] })
  ctx.bc2 = await mkService(ctx.s2, 'Bed Cover T2', 25000, { pricingType: 'satuan' })
  ctx.self2 = await mkService(ctx.s2, 'Self Cuci T2', 8000, { pricingType: 'satuan', channel: 'self', pricingMode: 'cycle' }, 'siklus')
  ctx.reg2 = await mkTurnaround(ctx.a2, ctx.s2, 'Reguler', 48, 'none', 0, true)
  ctx.credit2 = await db.member.create({ store: ctx.s2.id, name: `Bu Langganan ${RUN}`, phoneNumber: `081${String(RUN).slice(-9)}`, status: 'active', isCredit: true, creditLimit: 500000 })
  await openRegister(ctx.a2, ctx.s2, 0)

  // T3 — 2 outlets (isolation)
  ctx.t3 = await mkTenant('T3')
  ctx.s3a = await mkStore('T3_Tunjungan', ctx.t3.id, hours('07:30', '21:30'))
  // Outlet B saved the way FE-LAUNDRY sends it (compact format)
  ctx.s3b = await mkStore('T3_Rungkut', ctx.t3.id, { open: '08:00', close: '20:00', closedDays: [0] })
  ctx.a3a = await mkAdmin(ctx.s3a, ctx.t3.id)
  ctx.a3b = await mkAdmin(ctx.s3b, ctx.t3.id)
  ctx.bc3a = await mkService(ctx.s3a, 'Bed Cover T3A', 25000, { pricingType: 'satuan' })
  await mkTurnaround(ctx.a3a, ctx.s3a, 'Reguler', 72, 'none', 0, true)

  // T5 — Laundry Hemat: shift & kas
  ctx.t5 = await mkTenant('T5')
  ctx.s5 = await mkStore('T5_Tembalang', ctx.t5.id, hours('08:00', '18:00', ['sunday']))
  ctx.a5 = await mkAdmin(ctx.s5, ctx.t5.id)
  ctx.bc5 = await mkService(ctx.s5, 'Bed Cover T5', 25000, { pricingType: 'satuan' })
  ctx.pcs5 = await mkService(ctx.s5, 'Satuan 80k T5', 80000, { pricingType: 'satuan' })
  ctx.pcs20 = await mkService(ctx.s5, 'Satuan 20k T5', 20000, { pricingType: 'satuan' })
  ctx.pcs130 = await mkService(ctx.s5, 'Satuan 130k T5', 130000, { pricingType: 'satuan' })
  await mkTurnaround(ctx.a5, ctx.s5, 'Reguler', 72, 'none', 0, true)

  // T6 — Premium Dry & Care
  ctx.t6 = await mkTenant('T6')
  ctx.s6 = await mkStore('T6_Kemang', ctx.t6.id, hours('09:00', '20:00', ['sunday']))
  ctx.a6 = await mkAdmin(ctx.s6, ctx.t6.id)
  ctx.jas = await mkService(ctx.s6, 'Jas', 60000, { pricingType: 'satuan', costComponents: [{ kind: 'dry_clean', amount: 9000 }, { kind: 'plastik', amount: 1000 }] })
  ctx.sepatu = await mkService(ctx.s6, 'Sepatu', 50000, { pricingType: 'satuan' }, 'pasang')
  ctx.bck = await mkService(ctx.s6, 'Bed Cover King', 45000, { pricingType: 'satuan' })
  await mkTurnaround(ctx.a6, ctx.s6, 'Reguler', 72, 'none', 0, true)
  ctx.ekspres6 = await mkTurnaround(ctx.a6, ctx.s6, 'Ekspres', 24, 'percent', 20)
  await mkPromo(ctx.t6.id, ctx.s6, 'VIP10', 'discount_percentage', 10, { maxRewardValue: 50000, minPurchase: 150000 })
  await openRegister(ctx.a6, ctx.s6, 0)
}, 120000)

afterAll(async () => {
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2))
  const stores = created.stores
  const orders = await db.order.findAll({ where: { store: stores }, attributes: ['id'] })
  const orderIds = orders.map((o) => o.id)
  const laundry = await db.laundry_order.findAll({ where: { store: stores }, attributes: ['id'] })
  const clean = async (fn) => { try { await fn() } catch {} }
  await clean(() => db.laundry_status_history.destroy({ where: { laundryOrderId: laundry.map((l) => l.id) }, force: true }))
  await clean(() => db.laundry_order.destroy({ where: { store: stores }, force: true }))
  await clean(() => db.promo_usage.destroy({ where: { campaignId: created.campaigns }, force: true }))
  await clean(() => db.transaction.destroy({ where: { order: orderIds }, force: true }))
  await clean(() => db.order_item.destroy({ where: { order: orderIds }, force: true }))
  await clean(() => db.order.destroy({ where: { id: orderIds }, force: true }))
  await clean(() => db.expense.destroy({ where: { store: stores }, force: true }))
  await clean(() => db.cash_movement.destroy({ where: { store: stores }, force: true }))
  await clean(() => db.cashRegister.destroy({ where: { store: stores }, force: true }))
  await clean(() => db.laundry_turnaround.destroy({ where: { store: stores }, force: true }))
  await clean(() => db.promo_reward.destroy({ where: { campaignId: created.campaigns }, force: true }))
  await clean(() => db.promo_campaign.destroy({ where: { id: created.campaigns }, force: true }))
  await clean(() => db.product_store_stock.destroy({ where: { store: stores }, force: true }))
  await clean(() => db.product.destroy({ where: { id: created.products }, force: true }))
  await clean(() => db.member.destroy({ where: { store: stores }, force: true }))
  await clean(() => db.category.destroy({ where: { id: created.categories }, force: true }))
  await clean(() => db.user.destroy({ where: { id: created.users }, force: true }))
  await clean(() => db.location.destroy({ where: { id: stores }, force: true }))
  await clean(() => db.tenant.destroy({ where: { id: created.tenants }, force: true }))
})

describe('T1 — ramai, banyak promo', () => {
  test('3.1 kiloan rounding via /laundry/quote', async () => {
    for (const [qty, bill, sub, hpp] of [[2.0, 3, 21000, 2850], [3.2, 3.5, 24500, 3325], [4.7, 5, 35000, 4750]]) {
      const r = await quote(ctx.a1, ctx.s1, { items: [{ product: ctx.ckl.id, quantity: qty }], turnaroundId: ctx.reg1.id })
      const l = r.body.data?.lines?.[0] || {}
      soft(`3.1 ${qty}kg`, 'billQty/subtotal/hppTotal', [l.billQty, r.body.data?.subtotal, l.hppTotal], [bill, sub, hpp])
    }
  })

  test('3.5 multi-item + HEMAT10 (quote)', async () => {
    const r = await quote(ctx.a1, ctx.s1, { items: [{ product: ctx.ckl.id, quantity: 4.7 }, { product: ctx.bc.id, quantity: 2 }], turnaroundId: ctx.reg1.id, promoCode: 'HEMAT10' })
    const d = r.body.data || {}
    soft('3.5', 'subtotal/discount/total (doc golden)', [d.subtotal, d.discountAmount, d.total], [85000, 8500, 76500])
    soft('3.5 promo name', 'promo applied is HEMAT10', String(d.promoCampaignName || '').includes('HEMAT10'), true)
  })

  test('3.4 scope layanan: BCONLY20 hanya atas Bed Cover', async () => {
    const r = await quote(ctx.a1, ctx.s1, { items: [{ product: ctx.ckl.id, quantity: 5 }, { product: ctx.bc.id, quantity: 2 }], turnaroundId: ctx.reg1.id, promoCode: 'BCONLY20' })
    soft('3.4 scope', '20% of eligible 50000 (of 85000) = 10000', [r.body.data?.discountAmount, r.body.data?.total], [10000, 75000])
  })

  test('T1-S3 promoCode KILAT5 applies KILAT5 only', async () => {
    const r = await quote(ctx.a1, ctx.s1, { items: [{ product: ctx.bc.id, quantity: 4 }], turnaroundId: ctx.reg1.id, promoCode: 'KILAT5' })
    soft('T1-S3 KILAT5', 'discount = 5000 on 100000', r.body.data?.discountAmount, 5000)
  })

  test('promoCode tidak dikenal → tidak ada diskon / ditolak', async () => {
    const r = await quote(ctx.a1, ctx.s1, { items: [{ product: ctx.bc.id, quantity: 4 }], turnaroundId: ctx.reg1.id, promoCode: 'NGAWUR99' })
    soft('promo unknown', 'quote: discount 0 + promoErrorCode', [r.body.data?.discountAmount, r.body.data?.promoErrorCode], [0, 'PROMO_NOT_FOUND'])
    const c = await createOrder(ctx.a1, ctx.s1, { items: [{ product: ctx.bc.id, quantity: 4 }], turnaroundId: ctx.reg1.id, promoCode: 'NGAWUR99' })
    soft('promo unknown', 'create refused 422', [c.status, c.body.code], [422, 'PROMO_NOT_FOUND'])
    const min = await quote(ctx.a1, ctx.s1, { items: [{ product: ctx.bc.id, quantity: 1 }], turnaroundId: ctx.reg1.id, promoCode: 'hemat10' })
    soft('promo min spend', 'HEMAT10 on 25000 < 30000 → not eligible', [min.body.data?.discountAmount, min.body.data?.promoErrorCode], [0, 'PROMO_NOT_ELIGIBLE'])
  })

  test('3.5 create + cash 100000 → kembalian 23500 (on BE total)', async () => {
    const q = await quote(ctx.a1, ctx.s1, { items: [{ product: ctx.ckl.id, quantity: 5 }, { product: ctx.bc.id, quantity: 2 }], turnaroundId: ctx.reg1.id })
    const total = q.body.data.total
    soft('3.5b', 'quote 5kg + BC×2 = 85000 (no promo)', total, 85000)
    const r = await createOrder(ctx.a1, ctx.s1, {
      items: [{ product: ctx.ckl.id, quantity: 5 }, { product: ctx.bc.id, quantity: 2 }], turnaroundId: ctx.reg1.id,
      expectedTotal: total, paymentAmount: total, paymentMethod: 'CASH', cashAmount: 100000, changeAmount: 100000 - total
    })
    const tx = r.body.data ? await orderTx(r.body.data.id) : []
    soft('3.5b', 'status/paymentStatus/tx amount/change', [r.status, r.body.data?.paymentStatus, Number(tx[0]?.amount), Number(tx[0]?.changeGiven)], [201, 'paid', 85000, 15000])
  })

  test('T5-S4 diskon manual: override promo, cap 20%, alasan wajib', async () => {
    const items = [{ product: ctx.bc.id, quantity: 4 }]
    const noReason = await quote(ctx.a1, ctx.s1, { items, turnaroundId: ctx.reg1.id, manualDiscount: { amount: 5000 } })
    soft('manual', 'no reason → 422', [noReason.status, noReason.body.code], [422, 'MANUAL_DISCOUNT_REASON_REQUIRED'])
    const q = await quote(ctx.a1, ctx.s1, { items, turnaroundId: ctx.kilat1.id, promoCode: 'KILAT5', manualDiscount: { amount: 30000, reason: 'langganan lama' } })
    soft('manual', '30000 capped to 20% of 100000, promo ignored, surcharge on subtotal', [q.body.data?.discountAmount, q.body.data?.surcharge, q.body.data?.total], [20000, 30000, 110000])
    const r = await createOrder(ctx.a1, ctx.s1, { items, turnaroundId: ctx.kilat1.id, expectedTotal: 110000, manualDiscount: { amount: 30000, reason: 'langganan lama' } })
    soft('manual', 'create keeps manual discount', [r.status, Number(r.body.data?.discountAmount), Number(r.body.data?.totalPrice)], [201, 20000, 110000])
  })

  test('expectedTotal mismatch → 409 PRICE_CHANGED', async () => {
    const r = await createOrder(ctx.a1, ctx.s1, { items: [{ product: ctx.bc.id, quantity: 1 }], turnaroundId: ctx.reg1.id, expectedTotal: 24999 })
    soft('PRICE_CHANGED', 'status/code', [r.status, r.body.code], [409, 'PRICE_CHANGED'])
  })

  test('3.6 / T1-S6 DP tunai → pelunasan QRIS', async () => {
    const r = await createOrder(ctx.a1, ctx.s1, {
      items: [{ product: ctx.bc.id, quantity: 2 }], turnaroundId: ctx.kilat1.id, expectedTotal: 65000,
      paymentAmount: 20000, paymentMethod: 'CASH', cashAmount: 20000, changeAmount: 0
    })
    soft('3.6', 'Kilat +30% total / status after DP', [r.status, Number(r.body.data?.totalPrice), r.body.data?.serviceChargeAmount, r.body.data?.paymentStatus], [201, 65000, 15000, 'partially_paid'])
    const id = r.body.data.id
    const pay = await request(app).post(`/order/${id}/payments`).set(ctx.a1)
      .send({ store: ctx.s1.id, paymentMethod: 'QRIS', amount: 45000, referenceNumber: `QR-${RUN}`, idempotencyKey: key('pay') })
    const tx = await orderTx(id)
    soft('3.6', 'after QRIS 45000: paymentStatus / methods / amounts', [pay.status, pay.body.data?.paymentStatus, tx.map((t) => [t.typePayment, Number(t.amount)])], [200, 'paid', [['CASH', 20000], ['QRIS', 45000]]])
    const over = await request(app).post(`/order/${id}/payments`).set(ctx.a1)
      .send({ store: ctx.s1.id, paymentMethod: 'CASH', amount: 1000, cashAmount: 1000, idempotencyKey: key('pay') })
    soft('3.6 overpay', 'pay on fully paid order rejected', over.status >= 400, true)
  })

  test('3.7 batal RECEIVED + refund penuh; refund > paid ditolak', async () => {
    const r = await createOrder(ctx.a1, ctx.s1, { items: [{ product: ctx.bc.id, quantity: 2 }], turnaroundId: ctx.reg1.id, paymentAmount: 50000, paymentMethod: 'CASH', cashAmount: 50000, changeAmount: 0 })
    const id = r.body.data.id
    const tooMuch = await request(app).post(`/laundry/order/${id}/cancel`).set(ctx.a1)
      .send({ store: ctx.s1.id, reason: 'uji refund lebih', refundAmount: 60000, refundMethod: 'CASH', idempotencyKey: key('c') })
    const txAfter = await orderTx(id)
    soft('3.7 refund>paid', 'refund 60000 on paid 50000 → 422 REFUND_EXCEEDS_PAID', [tooMuch.status, tooMuch.body.code], [422, 'REFUND_EXCEEDS_PAID'])
    soft('3.7 refund>paid', 'refund row amount if accepted', txAfter.filter((t) => Number(t.amount) < 0).map((t) => Number(t.amount)), [])
    const r2 = await createOrder(ctx.a1, ctx.s1, { items: [{ product: ctx.bc.id, quantity: 2 }], turnaroundId: ctx.reg1.id, paymentAmount: 50000, paymentMethod: 'CASH', cashAmount: 50000, changeAmount: 0 })
    const k = key('c')
    const c1 = await request(app).post(`/laundry/order/${r2.body.data.id}/cancel`).set(ctx.a1)
      .send({ store: ctx.s1.id, reason: 'pelanggan batal', refundAmount: 50000, refundMethod: 'CASH', idempotencyKey: k })
    const c2 = await request(app).post(`/laundry/order/${r2.body.data.id}/cancel`).set(ctx.a1)
      .send({ store: ctx.s1.id, reason: 'pelanggan batal', refundAmount: 50000, refundMethod: 'CASH', idempotencyKey: k })
    const tx = await orderTx(r2.body.data.id)
    soft('3.7', 'CANCELLED, net 0, one refund row (idempotent)', [c1.status, c1.body.data?.laundryOrder?.processStatus, tx.reduce((s, t) => s + Number(t.amount), 0), tx.length, c2.status], [200, 'CANCELLED', 0, 2, 200])
  })

  test('G6 batal setelah diproses butuh PIN — cancel endpoint & PATCH status', async () => {
    const r = await createOrder(ctx.a1, ctx.s1, { items: [{ product: ctx.bc.id, quantity: 1 }], turnaroundId: ctx.reg1.id })
    const id = r.body.data.id
    await request(app).patch(`/laundry/order/${id}/status`).set(ctx.a1).send({ store: ctx.s1.id, toStatus: 'WASHING' })
    const noPin = await request(app).post(`/laundry/order/${id}/cancel`).set(ctx.a1).send({ store: ctx.s1.id, reason: 'x' })
    const badPin = await request(app).post(`/laundry/order/${id}/cancel`).set(ctx.a1).send({ store: ctx.s1.id, reason: 'x', approverPin: '0000' })
    soft('G6 cancel', 'no PIN / wrong PIN refused', [noPin.status, badPin.status], [403, 403])
    const patch = await request(app).patch(`/laundry/order/${id}/status`).set(ctx.a1).send({ store: ctx.s1.id, toStatus: 'CANCELLED', reason: 'bypass' })
    soft('G6 PATCH', 'PATCH toStatus=CANCELLED refused', [patch.status, patch.body.code], [409, 'USE_CANCEL_ENDPOINT'])
    const ok = await request(app).post(`/laundry/order/${id}/cancel`).set(ctx.a1).send({ store: ctx.s1.id, reason: 'x', approverPin: '1234' })
    const revive = await request(app).patch(`/laundry/order/${id}/status`).set(ctx.a1).send({ store: ctx.s1.id, toStatus: 'WASHING', reason: 'hidupkan lagi' })
    soft('G6 PATCH', 'right PIN cancels; admin cannot revive CANCELLED', [ok.status, revive.status, revive.body.code], [200, 409, 'ORDER_CLOSED'])
  })

  test('3.8 / T1-S8 self-service 2 cuci + 1 kering', async () => {
    const items = [{ product: ctx.selfWash.id, quantity: 2 }, { product: ctx.selfDry.id, quantity: 1 }]
    const under = await createOrder(ctx.a1, ctx.s1, { orderType: 'self', items, pieceCount: 0, paymentAmount: 10000, paymentMethod: 'CASH', cashAmount: 10000 })
    soft('3.8 underpay', 'self-service underpay → 422', under.status, 422)
    const r = await createOrder(ctx.a1, ctx.s1, { orderType: 'self', items, pieceCount: 0, turnaroundId: ctx.kilat1.id, paymentAmount: 24000, paymentMethod: 'CASH', cashAmount: 24000, changeAmount: 0 })
    const d = r.body.data || {}
    soft('3.8', 'total/surcharge/status/process/pieceCount', [r.status, Number(d.totalPrice), d.serviceChargeAmount, d.paymentStatus, d.laundryOrder?.processStatus, d.laundryOrder?.pieceCount], [201, 24000, 0, 'paid', 'PICKED_UP', 0])
  })

  test('T1-S4 CUCI20 kuota 1', async () => {
    const items = [{ product: ctx.bc.id, quantity: 4 }]
    const first = await createOrder(ctx.a1, ctx.s1, { items, turnaroundId: ctx.reg1.id, promoCode: 'CUCI20' })
    soft('T1-S4 #1', 'create with CUCI20: 201, discount 20000', [first.status, Number(first.body.data?.discountAmount)], [201, 20000])
    const again = await quote(ctx.a1, ctx.s1, { items, turnaroundId: ctx.reg1.id, promoCode: 'CUCI20' })
    soft('T1-S4 #2', 'quota exhausted → CUCI20 not applied (4xx or not 20000)', again.status >= 400 || (again.body.data?.discountAmount !== 20000 && !String(again.body.data?.promoCampaignName || '').includes('CUCI20')), true)
  })
})

describe('T2 — kredit, laporan harian', () => {
  test('T2-S1 / 3.11 laporan /laundry/report', async () => {
    // a) kiloan 4.7 kg, kredit, DP 0
    const a = await createOrder(ctx.a2, ctx.s2, { customerId: ctx.credit2.id, items: [{ product: ctx.ckl2.id, quantity: 4.7 }], turnaroundId: ctx.reg2.id })
    // b) satuan BC×2 = 50000, DP 20000 → READY
    const b = await createOrder(ctx.a2, ctx.s2, { items: [{ product: ctx.bc2.id, quantity: 2 }], turnaroundId: ctx.reg2.id, paymentAmount: 20000, paymentMethod: 'CASH', cashAmount: 20000, changeAmount: 0 })
    await request(app).patch(`/laundry/order/${b.body.data.id}/status`).set(ctx.a2).send({ store: ctx.s2.id, toStatus: 'WASHING' })
    await request(app).patch(`/laundry/order/${b.body.data.id}/status`).set(ctx.a2).send({ store: ctx.s2.id, toStatus: 'READY', rackCode: 'A1' })
    // c) self-service 3 × 8000 = 24000 lunas
    const c = await createOrder(ctx.a2, ctx.s2, { orderType: 'self', pieceCount: 0, items: [{ product: ctx.self2.id, quantity: 3 }], paymentAmount: 24000, paymentMethod: 'CASH', cashAmount: 24000, changeAmount: 0 })
    // d) 50000 lunas tunai lalu batal + refund penuh (tidak boleh masuk omzet aktif)
    const d = await createOrder(ctx.a2, ctx.s2, { items: [{ product: ctx.bc2.id, quantity: 2 }], turnaroundId: ctx.reg2.id, paymentAmount: 50000, paymentMethod: 'CASH', cashAmount: 50000, changeAmount: 0 })
    await request(app).post(`/laundry/order/${d.body.data.id}/cancel`).set(ctx.a2).send({ store: ctx.s2.id, reason: 'batal', refundAmount: 50000, refundMethod: 'CASH', idempotencyKey: key('c') })
    soft('T2 setup', 'orders created', [a.status, b.status, c.status, d.status], [201, 201, 201, 201])

    const aTotal = Number(a.body.data.totalPrice)
    soft('T2 a', '4.7 kg billed 5.0 kg → 35000', aTotal, 35000)
    const rep = await request(app).get(`/laundry/report?store=${ctx.s2.id}`).set(ctx.a2)
    const s = rep.body.data?.summary || {}
    soft('3.11 todayOrders', 'cancelled excluded', s.todayOrders, 3)
    soft('3.11 todayKg', 'billQty kiloan 4.7 → 5.0 (round up)', s.todayKg, 5)
    soft('3.11 todayRefunds', 'refund paid out today', s.todayRefunds, 50000)
    soft('3.11 todaySelf', 'count / omzet', [s.todaySelf, s.todaySelfOmzet], [1, 24000])
    soft('3.11 todayPayments', 'net receipts today = 20000 + 24000 (+50000 −50000 refund)', s.todayPayments, 44000)
    soft('3.11 unpaid', 'count / amount (a full + b 30000)', [s.unpaidCount, s.unpaidAmount], [2, aTotal + 30000])
    soft('3.11 ready', 'readyCount / notPickedUp', [s.readyCount, (rep.body.data?.notPickedUp || []).map((o) => o.id)], [1, [b.body.data.id]])
    const today = (rep.body.data?.daily || []).slice(-1)[0] || {}
    soft('3.11 daily[today]', 'omzet = net payments, 7 days', [rep.body.data?.daily?.length, today.omzet, today.orders], [7, 44000, 3])
    const per = Object.fromEntries((rep.body.data?.perService || []).map((p) => [p.serviceId, [p.qty, p.omzet]]))
    soft('3.11 perService', 'BC qty 2 / omzet 50000 (cancelled excluded)', per[ctx.bc2.id], [2, 50000])
    soft('3.11 perService', 'self 3 / 24000', per[ctx.self2.id], [3, 24000])

    // T2-S1 credit pickup with remaining > 0
    await request(app).patch(`/laundry/order/${a.body.data.id}/status`).set(ctx.a2).send({ store: ctx.s2.id, toStatus: 'WASHING' })
    await request(app).patch(`/laundry/order/${a.body.data.id}/status`).set(ctx.a2).send({ store: ctx.s2.id, toStatus: 'READY' })
    const pk = await request(app).post(`/laundry/order/${a.body.data.id}/pickup`).set(ctx.a2).send({ store: ctx.s2.id, pickupPieceCount: 5 })
    const rep2 = await request(app).get(`/laundry/report?store=${ctx.s2.id}`).set(ctx.a2)
    soft('T2-S1', 'credit pickup allowed & still in Belum lunas', [pk.status, (rep2.body.data?.unpaid || []).some((o) => o.id === a.body.data.id)], [200, true])
    // non-credit with outstanding cannot pick up
    const pkB = await request(app).patch(`/laundry/order/${b.body.data.id}/status`).set(ctx.a2).send({ store: ctx.s2.id, toStatus: 'PICKED_UP' })
    soft('T2 outstanding', 'PATCH PICKED_UP refused', [pkB.status, pkB.body.code], [409, 'USE_PICKUP_ENDPOINT'])
    const pkB2 = await request(app).post(`/laundry/order/${b.body.data.id}/pickup`).set(ctx.a2).send({ store: ctx.s2.id, pickupPieceCount: 5 })
    soft('T2 outstanding', '/pickup on non-credit unpaid refused', [pkB2.status, pkB2.body.code], [409, 'OUTSTANDING_PAYMENT'])
  })
})

describe('T3 — isolasi 2 outlet', () => {
  test('T3-S3 outlet B (format jam ringkas): dueAt mengikuti jam buka', async () => {
    const bc = await mkService(ctx.s3b, 'Bed Cover T3B', 25000, { pricingType: 'satuan' })
    const ta = await mkTurnaround(ctx.a3b, ctx.s3b, 'Kilat', 6, 'none', 0, true)
    const { dueAtFrom } = require('../api/service/laundryPricing')
    const before = new Date()
    const r = await quote(ctx.a3b, ctx.s3b, { items: [{ product: bc.id, quantity: 1 }], turnaroundId: ta.id })
    const expected = dueAtFrom(before, 6, [{ day: 'monday', open: '08:00', close: '20:00' }, { day: 'tuesday', open: '08:00', close: '20:00' }, { day: 'wednesday', open: '08:00', close: '20:00' }, { day: 'thursday', open: '08:00', close: '20:00' }, { day: 'friday', open: '08:00', close: '20:00' }, { day: 'saturday', open: '08:00', close: '20:00' }, { day: 'sunday', isOpen: false }], 'Asia/Jakarta')
    soft('T3-S3', 'quote dueAt = opening-hours dueAt (±1 min)', Math.abs(new Date(r.body.data?.dueAt) - expected) < 60000, true)
  })

  test('T3-S1 data & report outlet A tidak terlihat dari B', async () => {
    const a = await createOrder(ctx.a3a, ctx.s3a, { items: [{ product: ctx.bc3a.id, quantity: 1 }] })
    const getFromB = await request(app).get(`/laundry/order/${a.body.data.id}?store=${ctx.s3b.id}`).set(ctx.a3b)
    const repA = await request(app).get(`/laundry/report?store=${ctx.s3a.id}`).set(ctx.a3b)
    const repB = await request(app).get(`/laundry/report?store=${ctx.s3b.id}`).set(ctx.a3b)
    soft('T3-S1', 'B reads A order / A report / B report', [getFromB.status, repA.status >= 400, repB.body.data?.summary?.todayOrders], [404, true, 0])
  })
})

describe('T5 — shift & kas (3.10)', () => {
  test('expected cash 325000, variance −5000', async () => {
    const reg = await openRegister(ctx.a5, ctx.s5, 200000)
    // +tunai 150000 in total = 130000 order + the 20000 order refunded below
    const cashOrder = await createOrder(ctx.a5, ctx.s5, { items: [{ product: ctx.pcs130.id, quantity: 1 }], paymentAmount: 130000, paymentMethod: 'CASH', cashAmount: 150000, changeAmount: 20000 })
    // +QRIS 80000 (not drawer)
    const qr = await createOrder(ctx.a5, ctx.s5, { items: [{ product: ctx.pcs5.id, quantity: 1 }], paymentAmount: 80000, paymentMethod: 'QRIS', referenceNumber: `QR5-${RUN}` })
    // −refund tunai 20000: order 20000 paid cash, cancelled from RECEIVED with full refund
    const rf = await createOrder(ctx.a5, ctx.s5, { items: [{ product: ctx.pcs20.id, quantity: 1 }], paymentAmount: 20000, paymentMethod: 'CASH', cashAmount: 20000, changeAmount: 0 })
    await request(app).post(`/laundry/order/${rf.body.data.id}/cancel`).set(ctx.a5).send({ store: ctx.s5.id, reason: 'refund', refundAmount: 20000, refundMethod: 'CASH', idempotencyKey: key('c') })
    // −expense tunai 30000
    await db.expense.create({ store: ctx.s5.id, expenseNumber: `EXP-${RUN}`, description: 'Gas LPG', amount: 30000, date: new Date(), paymentMethod: 'cash', status: 'approved', isActive: true, isPaid: true })
    // +kas masuk 50000, −kas keluar 25000
    for (const [type, reasonCode, amount] of [['cash_in', 'float_topup', 50000], ['cash_out', 'petty_cash', 25000]]) {
      const mv = await request(app).post(`/cash-register/${reg.id}/movement`).set(ctx.a5).send({ store: ctx.s5.id, type, reasonCode, amount, notes: 'uji', idempotencyKey: key('mv') })
      const row = mv.body.data
      if (row && row.status === 'pending_approval') {
        await request(app).post(`/cash-register/movement/${row.id}/decide`).set(saAuth).send({ store: ctx.s5.id, decision: 'approve', notes: 'ok' })
      }
    }
    soft('3.10 setup', 'orders', [cashOrder.status, qr.status, rf.status], [201, 201, 201])
    const x = await request(app).get(`/cash-register/x-report?store=${ctx.s5.id}`).set(ctx.a5)
    const xd = x.body.data || {}
    const expected = xd.expectedCash ?? xd.summary?.expectedCash ?? xd.cash?.expectedCash
    soft('3.10 X', 'expectedCash', Number(expected), 325000)
    const close = await request(app).put(`/cash-register/close/${reg.id}`).set(ctx.a5).send({ store: ctx.s5.id, closingBalance: 320000, notes: 'kurang 5rb, uang receh hilang' })
    const cd = close.body.data || {}
    soft('3.10 Z', 'close: expectedCash / variance', [close.status, Number(cd.summary?.expectedCash), Number(cd.summary?.variance)], [200, 325000, -5000])
  })
})

describe('T6 — premium', () => {
  test('T6-S1..S5 premium + Ekspres + VIP10 + QRIS + HPP', async () => {
    const items = [{ product: ctx.jas.id, quantity: 1 }, { product: ctx.sepatu.id, quantity: 2 }, { product: ctx.bck.id, quantity: 1 }]
    const q0 = await quote(ctx.a6, ctx.s6, { items, turnaroundId: ctx.ekspres6.id })
    soft('T6-S1/S2', 'subtotal/surcharge/total', [q0.body.data?.subtotal, q0.body.data?.surcharge, q0.body.data?.total], [205000, 41000, 246000])
    soft('T6-S5', 'HPP Jas 9000+1000 = 10000, components', [q0.body.data?.hppTotal, (q0.body.data?.lines?.[0]?.hppComponents || []).map((c) => c.amount)], [10000, [9000, 1000]])
    const q = await quote(ctx.a6, ctx.s6, { items, turnaroundId: ctx.ekspres6.id, promoCode: 'VIP10' })
    soft('T6-S3', 'VIP10 base = subtotal 205000 → 20500 (FE rule), total 225500', [q.body.data?.discountAmount, q.body.data?.total], [20500, 225500])
    const withPromo = await createOrder(ctx.a6, ctx.s6, { items, turnaroundId: ctx.ekspres6.id, promoCode: 'VIP10', expectedTotal: q.body.data.total, paymentAmount: q.body.data.total, paymentMethod: 'QRIS', referenceNumber: `QR6P-${RUN}` })
    soft('T6-S3 create', 'create order with promo code VIP10', [withPromo.status, withPromo.body.message], [201, undefined])
    const r = await createOrder(ctx.a6, ctx.s6, { items, turnaroundId: ctx.ekspres6.id, expectedTotal: 246000, paymentAmount: 246000, paymentMethod: 'QRIS', referenceNumber: `QR6-${RUN}` })
    const x = await request(app).get(`/cash-register/x-report?store=${ctx.s6.id}`).set(ctx.a6)
    const xd = x.body.data || {}
    soft('T6-S4', 'QRIS lunas: paid, drawer unchanged', [r.status, r.body.data?.paymentStatus, Number(xd.expectedCash ?? xd.summary?.expectedCash)], [201, 'paid', 0])
  })
})

test('all golden checks match', () => {
  const failed = results.filter((r) => !r.ok)
  if (failed.length) console.log(failed.map((f) => `FAIL ${f.id} | ${f.label} | expected=${JSON.stringify(f.expected)} actual=${JSON.stringify(f.actual)}`).join('\n'))
  console.log(`${results.length - failed.length}/${results.length} checks PASS`)
  expect(failed).toEqual([])
})
