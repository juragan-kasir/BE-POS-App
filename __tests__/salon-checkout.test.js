process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const bcrypt = require('bcrypt')
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { zonedToUtc, localDate, addDays } = require('../api/service/salonTime')
const { allocate, commissionsFor, buildQuote, settlePayments, expectedCash } = require('../api/service/salonMoney')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Salon S2-a: shift (= POS cash register), quote, checkout, the day's orders
// and full refund. Shapes follow FE-SALON-App src/api/contract.ts; rules
// SALON-BA BR-SLN-009…016, DR-SLN-06/07.

const TZ = 'Asia/Jakarta'
const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
const users = {}
const tokens = {}
const tenants = {}
const stores = {}
const createdUserIds = []
const at = (hhmm) => new Date(zonedToUtc(addDays(localDate(Date.now(), TZ), 2), hhmm, TZ)).toISOString()

const nextLocationId = async () => {
  const [rows] = await db.sequelize.query("SELECT nextval('location_id_seq') AS id")
  return Number(rows[0].id)
}
const makeLocation = async (tenantId, name) =>
  db.location.create({
    id: await nextLocationId(),
    name: `${name}_${stamp}`,
    phoneNumber: '0215550000',
    status: 'active',
    tenantId,
    businessType: 'salon',
    timezone: TZ,
    salonSettings: { openTime: '09:00', closeTime: '21:00' }
  })
const sign = async (key, user) => {
  tokens[key] = await signSessionToken(
    { id: user.id, userName: user.userName, roleType: user.roleType, store: user.store },
    JWT_SECRET
  )
}
const makeUser = async (key, roleType, storeId) => {
  users[key] = await db.user.create({
    userName: `sco_${key}_${stamp}`,
    fullName: `Salon ${key}`,
    email: `sco_${key}_${stamp}@test.com`,
    roleType,
    userType: roleType === 'user' ? 'user' : 'admin',
    store: storeId,
    status: 'active'
  })
  createdUserIds.push(users[key].id)
  await sign(key, users[key])
}
const call = (key, method, path, body) => {
  const r = request(app)[method](path).set('Authorization', `Bearer ${tokens[key]}`)
  return body === undefined ? r : r.send(body)
}
const qa = () => `?store=${stores.a.id}`

const f = {}
let keySeq = 0
const key = () => `sco-${stamp}-${++keySeq}`

const completedBooking = async ({ depositAmount = 0, depositMethod = null, memberId = null } = {}) => {
  const res = await call('admin', 'post', `/salon/appointments${qa()}`, {
    serviceIds: [f.cut.id],
    staffId: f.senior.userId,
    startAt: at("11:00"),
    memberId,
    customerName: 'Rina',
    customerPhone: '081234567890',
    source: 'phone',
    depositAmount,
    depositMethod,
    notes: '',
    idempotencyKey: key()
  })
  expect(res.status).toBe(201)
  for (const step of ['check-in', 'start', 'complete']) {
    const r = await call('admin', 'post', `/salon/appointments/${res.body.id}/${step}${qa()}`, { reason: null })
    expect(r.status).toBe(200)
  }
  return res.body
}

const cart = (appointmentId, extra = {}) => ({
  appointmentId,
  extras: [{ productId: f.shampoo.id, qty: 2, staffId: f.senior.userId }],
  tip: { amount: 10000, staffId: null },
  discount: { type: 'percent', value: 10 },
  ...extra
})

beforeAll(async () => {
  tenants.salon = await db.tenant.create({ code: `sco-${stamp}`, name: 'Salon Kasir', businessType: 'salon' })
  tenants.other = await db.tenant.create({ code: `sco-o-${stamp}`, name: 'Salon Lain', businessType: 'salon' })
  stores.a = await makeLocation(tenants.salon.id, 'SCO_A')
  stores.other = await makeLocation(tenants.other.id, 'SCO_O')
  await makeUser('owner', 'super_admin', stores.a.id)
  await makeUser('admin', 'admin', stores.a.id)
  await makeUser('kasir', 'kasir', stores.a.id)
  await makeUser('otherOwner', 'super_admin', stores.other.id)

  const svc = await call('owner', 'post', '/salon/services', {
    name: `Potong ${stamp}`,
    category: 'Rambut',
    basePrice: 50000,
    serviceConfig: { durationMin: 45, bufferMin: 15, levelPrices: { junior: 50000, senior: 65000, master: 80000 }, commission: { type: 'percent', value: 40 } },
    active: true
  })
  expect(svc.status).toBe(201)
  f.cut = svc.body
  const prd = await call('owner', 'post', `/salon/products${qa()}`, {
    name: `Shampoo ${stamp}`,
    price: 30000,
    stock: 5,
    commission: { type: 'percent', value: 10 },
    active: true
  })
  expect(prd.status).toBe(201)
  f.shampoo = prd.body

  const created = await call('owner', 'post', `/salon/staff${qa()}`, {
    name: 'Stylist Senior',
    username: `sco_sr_${stamp}`.toLowerCase().slice(0, 30),
    position: 'Stylist',
    positionId: null,
    level: 'senior',
    colorTag: '#10b981',
    acceptsOnline: true,
    active: true,
    commissionOverride: null
  })
  expect(created.status).toBe(201)
  const id = created.body.userId
  await call('owner', 'put', `/salon/staff/${id}/skills${qa()}`, [{ productId: f.cut.id, durationOverride: null, priceOverride: null }])
  const avail = await call('owner', 'put', `/salon/staff/${id}/availability${qa()}`,
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: '09:00', endTime: '21:00' })))
  expect(avail.status).toBe(200)
  f.senior = avail.body

  const member = await call('admin', 'post', `/salon/customers${qa()}`, { name: 'Rina Member', phone: `0812${String(Date.now()).slice(-8)}`, notes: '' })
  expect(member.status).toBe(201)
  f.member = member.body
})

afterAll(async () => {
  const tenantIds = Object.values(tenants).map((t) => t.id)
  const storeIds = (await db.location.findAll({ where: { tenantId: tenantIds }, paranoid: false, attributes: ['id'] })).map((l) => l.id)
  const productIds = (await db.product.findAll({ where: { tenantId: tenantIds }, paranoid: false, attributes: ['id'] })).map((p) => p.id)
  const staffUserIds = (await db.salon_staff_profile.findAll({ where: { tenantId: tenantIds }, paranoid: false, attributes: ['userId'] })).map((p) => p.userId)
  const orderIds = (await db.order.findAll({ where: { store: storeIds }, paranoid: false, attributes: ['id'] })).map((o) => o.id)
  const q = (sql, replacements) => db.sequelize.query(sql, { replacements }).catch((e) => console.error(e.message))
  const del = (model, where) => db[model].destroy({ where, force: true }).catch((e) => console.error(model, e.message))
  if (orderIds.length) {
    // The commission ledger refuses DELETE by trigger; lift it for cleanup only.
    await q('ALTER TABLE salon_staff_commission DISABLE TRIGGER USER')
    await q('DELETE FROM salon_staff_commission WHERE "orderId" IN (:ids)', { ids: orderIds })
    await q('ALTER TABLE salon_staff_commission ENABLE TRIGGER USER')
    await del('salon_order', { orderId: orderIds })
    await q('DELETE FROM accounting_outbox WHERE "referenceType" = \'order\' AND "referenceId" IN (:ids)', { ids: orderIds })
    await q('DELETE FROM journal_entry_line WHERE "journalEntry" IN (SELECT id FROM journal_entry WHERE store IN (:s))', { s: storeIds })
    await del('journal_entry', { store: storeIds })
    await del('account', { store: storeIds })
    await del('transaction', { order: orderIds })
    await del('order_item', { order: orderIds })
    await del('order_status', { order: orderIds })
    await del('order', { id: orderIds })
  }
  await del('stock_history', { product: productIds })
  await del('salon_appointment_event', { tenantId: tenantIds })
  await del('salon_appointment_item', { tenantId: tenantIds })
  await del('salon_appointment', { tenantId: tenantIds })
  await del('member', { tenantId: tenantIds })
  await del('salon_availability', { tenantId: tenantIds })
  await del('salon_staff_skill', { tenantId: tenantIds })
  await del('salon_staff_profile', { tenantId: tenantIds })
  await q('DELETE FROM document_counter WHERE store IN (:ids)', { ids: storeIds })
  await del('cashRegister', { store: storeIds })
  await del('product_store_stock', { product: productIds })
  await del('product_store', { product: productIds })
  await del('product', { id: productIds })
  await del('category', { tenantId: tenantIds })
  await del('user', { id: [...createdUserIds, ...staffUserIds] })
  await del('position', { tenantId: tenantIds })
  await del('location', { id: storeIds })
  await del('tenant', { id: tenantIds })
  await db.sequelize.close()
})

describe('money rules (pure)', () => {
  test('allocate always adds up to the total', () => {
    expect(allocate(12500, [65000, 60000])).toEqual([6500, 6000])
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33])
    expect(allocate(0, [5, 5])).toEqual([0, 0])
  })

  test('commission rounding rest lands on the last line with a rule', () => {
    const rule = { type: 'percent', value: 33.5 }
    const rows = commissionsFor([{ net: 1001, qty: 1, rule }, { net: 999, qty: 1, rule: null }, { net: 1003, qty: 1, rule }])
    expect(rows.reduce((a, b) => a + b, 0)).toBe(Math.round((1001 + 1003) * 0.335))
    expect(rows[1]).toBe(0)
  })

  test('quote: discount split, tip undiscounted and pointless, deposit off the due', () => {
    const quote = buildQuote({
      services: [{ itemId: 1, productId: 10, name: 'Potong', staffId: 7, price: 65000, rule: { type: 'percent', value: 40 } }],
      products: [{ idx: 0, productId: 20, name: 'Shampoo', staffId: null, qty: 2, price: 30000, rule: { type: 'percent', value: 10 } }],
      tip: { amount: 10000, staffId: 7 },
      discount: { type: 'percent', value: 10 },
      deposit: 20000,
      pointsPer: 10000
    })
    expect(quote).toMatchObject({ subtotal: 125000, discountTotal: 12500, tipTotal: 10000, total: 122500, depositPaid: 20000, due: 102500, pointsEarned: 11 })
    // No selling staff on the product: no product commission (BR-SLN-014).
    expect(quote.lines.map((l) => [l.kind, l.net, l.commission])).toEqual([['service', 58500, 23400], ['product', 54000, 0], ['tip', 10000, 10000]])
  })

  test('payments must match the due exactly, one cash row, change computed', () => {
    expect(() => settlePayments([{ method: 'cash', amount: 100, tendered: null, reference: null }], 101)).toThrow(/tidak sama/)
    expect(() => settlePayments([{ method: 'cash', amount: 50, tendered: null, reference: null }, { method: 'cash', amount: 50, tendered: null, reference: null }], 100)).toThrow(/satu baris/)
    expect(() => settlePayments([{ method: 'cash', amount: 100, tendered: 90, reference: null }], 100)).toThrow(/kurang/)
    expect(settlePayments([{ method: 'cash', amount: 100, tendered: 150, reference: null }], 100)[0].change).toBe(50)
    expect(expectedCash({ openingCash: 100, cashSales: 50, depositCash: 20, refunds: 30 })).toBe(140)
  })
})

describe('shift, checkout and refund', () => {
  test('no shift yet: current is null and checkout refuses SHIFT_CLOSED', async () => {
    const current = await call('kasir', 'get', `/salon/shift/current${qa()}`)
    expect(current.status).toBe(200)
    expect(current.body).toEqual({ shift: null })
    const res = await call('kasir', 'post', `/salon/checkout${qa()}`, {
      ...cart(null, { tip: { amount: 0, staffId: null }, discount: { type: 'none' } }),
      payments: [{ method: 'cash', amount: 60000, tendered: null, reference: null }],
      customerName: 'Umum',
      memberId: null,
      idempotencyKey: key()
    })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('SHIFT_CLOSED')
  })

  test('kasir opens the outlet shift once', async () => {
    const res = await call('kasir', 'post', `/salon/shift/open${qa()}`, { openingCash: 100000 })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ store: String(stores.a.id), openingCash: 100000, status: 'open', cashSales: 0, closedAt: null })
    f.shiftId = res.body.id
    const again = await call('admin', 'post', `/salon/shift/open${qa()}`, { openingCash: 0 })
    expect(again.status).toBe(409)
    expect(again.body.code).toBe('SHIFT_ALREADY_OPEN')
  })

  test('a booking that is not completed cannot be paid', async () => {
    const res = await call('admin', 'post', `/salon/appointments${qa()}`, {
      serviceIds: [f.cut.id], staffId: f.senior.userId, startAt: at('19:00'), memberId: null, customerName: 'Budi',
      customerPhone: '', source: 'walk_in', depositAmount: 0, depositMethod: null, notes: '', idempotencyKey: key()
    })
    expect(res.status).toBe(201)
    const pay = await call('kasir', 'post', `/salon/checkout${qa()}`, {
      ...cart(res.body.id, { extras: [], tip: { amount: 0, staffId: null }, discount: { type: 'none' } }),
      payments: [{ method: 'cash', amount: 65000, tendered: null, reference: null }],
      customerName: '', memberId: null, idempotencyKey: key()
    })
    expect(pay.status).toBe(409)
    expect(pay.body.code).toBe('NOT_COMPLETED')
  })

  test('quote prices the booking with deposit, retail extra, tip and discount on the server', async () => {
    f.booking = await completedBooking({ depositAmount: 20000, depositMethod: 'cash', memberId: f.member.id })
    const res = await call('kasir', 'post', `/salon/checkout/quote${qa()}`, cart(f.booking.id))
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ subtotal: 125000, discountTotal: 12500, tipTotal: 10000, total: 122500, depositPaid: 20000, due: 102500, pointsEarned: 11 })
    expect(res.body.lines.map((l) => [l.kind, l.staffId, l.net, l.commission])).toEqual([
      ['service', f.senior.userId, 58500, 23400],
      ['product', f.senior.userId, 54000, 5400],
      ['tip', f.senior.userId, 10000, 10000]
    ])
  })

  test('payment mismatch, a missing non-cash reference and short stock are refused', async () => {
    const base = { ...cart(f.booking.id), customerName: '', memberId: null }
    const short = await call('kasir', 'post', `/salon/checkout${qa()}`, {
      ...base, payments: [{ method: 'cash', amount: 100000, tendered: null, reference: null }], idempotencyKey: key()
    })
    expect(short.status).toBe(409)
    expect(short.body.code).toBe('PAYMENT_MISMATCH')
    const noRef = await call('kasir', 'post', `/salon/checkout${qa()}`, {
      ...base, payments: [{ method: 'qris', amount: 102500, tendered: null, reference: null }], idempotencyKey: key()
    })
    expect(noRef.status).toBe(422)
    expect(noRef.body.code).toBe('REFERENCE_REQUIRED')
    const stock = await call('kasir', 'post', `/salon/checkout${qa()}`, {
      ...base,
      extras: [{ productId: f.shampoo.id, qty: 9, staffId: null }],
      payments: [{ method: 'cash', amount: 999999, tendered: null, reference: null }],
      idempotencyKey: key()
    })
    expect(stock.status).toBe(409)
    expect(stock.body.code).toBe('INSUFFICIENT_STOCK')
  })

  test('checkout writes one POS order, its ledger, commissions, stock and points', async () => {
    f.payKey = key()
    f.payBody = {
      ...cart(f.booking.id),
      payments: [
        { method: 'cash', amount: 52500, tendered: 60000, reference: null },
        { method: 'qris', amount: 50000, tendered: null, reference: 'QR-778899' }
      ],
      customerName: '',
      memberId: null,
      idempotencyKey: f.payKey
    }
    const res = await call('kasir', 'post', `/salon/checkout${qa()}`, f.payBody)
    expect(res.status).toBe(201)
    f.order = res.body
    expect(res.body).toMatchObject({
      store: String(stores.a.id),
      appointmentId: f.booking.id,
      memberId: f.member.id,
      customerName: 'Rina',
      cashierName: 'Salon kasir',
      status: 'paid',
      refund: null
    })
    expect(res.body.number).toMatch(new RegExp(`^INV-${stores.a.id}-\\d{6}-\\d{3}$`))
    expect(res.body.quote.total).toBe(122500)
    expect(res.body.payments).toEqual([
      { method: 'cash', amount: 52500, tendered: 60000, reference: null, change: 7500 },
      { method: 'qris', amount: 50000, tendered: null, reference: 'QR-778899', change: 0 }
    ])

    const so = await db.salon_order.findByPk(Number(res.body.id))
    const order = await db.order.findByPk(so.orderId)
    expect(order).toMatchObject({ status: 'paid', paymentStatus: 'paid', tenantId: tenants.salon.id, customerId: Number(f.member.id) })
    expect(Number(order.totalPrice)).toBe(122500)
    const trx = await db.transaction.findAll({ where: { order: order.id }, order: [['id', 'ASC']] })
    // Σ payment rows (deposit + till) = order total (BR-SLN-018).
    expect(trx.reduce((s, t) => s + Number(t.amount), 0)).toBe(122500)
    expect(trx.map((t) => t.typePayment)).toEqual(['CASH', 'CASH', 'QRIS'])
    expect(trx.every((t) => t.tenantId === tenants.salon.id)).toBe(true)
    const items = await db.order_item.findAll({ where: { order: order.id }, order: [['id', 'ASC']] })
    expect(items.map((i) => [i.productName.split(' ')[0], i.staffId, Number(i.totalPrice)])).toEqual([
      ['Potong', Number(f.senior.userId), 58500],
      ['Shampoo', Number(f.senior.userId), 54000]
    ])
    const commissions = await db.salon_staff_commission.findAll({ where: { orderId: order.id }, order: [['id', 'ASC']] })
    expect(commissions.map((c) => [c.kind, c.amount, c.status])).toEqual([['service', 23400, 'earned'], ['product', 5400, 'earned'], ['tip', 10000, 'earned']])
    const stock = await db.product_store_stock.findOne({ where: { product: Number(f.shampoo.id), store: stores.a.id } })
    expect(Number(stock.stock)).toBe(3)
    const appointment = await db.salon_appointment.findByPk(Number(f.booking.id))
    expect(appointment).toMatchObject({ status: 'paid', orderId: order.id, depositStatus: 'applied' })
    const member = await db.member.findByPk(Number(f.member.id))
    expect(member.totalPoints).toBe(11)
    // The sale journal is posted right after commit and balances (tip on the
    // service-charge leg).
    const jobs = await db.accounting_outbox.findAll({ where: { referenceType: 'order', referenceId: order.id }, order: [['id', 'ASC']] })
    expect(jobs.map((j) => [j.jobType, j.status])).toEqual([['order_journal', 'posted'], ['order_cogs_journal', 'posted']])
    const journal = await db.journal_entry.findOne({ where: { referenceId: order.id, store: stores.a.id } })
    expect(Number(journal.totalDebit)).toBe(122500)
    expect(Number(journal.totalCredit)).toBe(122500)
  })

  test('same key + same body replays; same key + other body is refused; a paid booking stays paid', async () => {
    const replay = await call('kasir', 'post', `/salon/checkout${qa()}`, f.payBody)
    expect(replay.status).toBe(200)
    expect(replay.headers['idempotent-replay']).toBe('true')
    expect(replay.body.id).toBe(f.order.id)
    const mismatch = await call('kasir', 'post', `/salon/checkout${qa()}`, { ...f.payBody, customerName: 'Lain' })
    expect(mismatch.status).toBe(409)
    expect(mismatch.body.code).toBe('IDEMPOTENCY_MISMATCH')
    const twice = await call('kasir', 'post', `/salon/checkout${qa()}`, { ...f.payBody, idempotencyKey: key() })
    expect(twice.status).toBe(409)
    expect(twice.body.code).toBe('ALREADY_PAID')
  })

  test('the shift reads its figures from the ledger', async () => {
    const res = await call('kasir', 'get', `/salon/shift/current${qa()}`)
    expect(res.body.shift).toMatchObject({ id: f.shiftId, cashSales: 52500, nonCashSales: 50000, depositCash: 20000, refunds: 0, orderCount: 1 })
  })

  test("today's orders list the sale; another tenant cannot reach the outlet", async () => {
    const res = await call('kasir', 'get', `/salon/orders${qa()}`)
    expect(res.status).toBe(200)
    expect(res.body.data.map((o) => o.id)).toContain(f.order.id)
    const other = await call('otherOwner', 'get', `/salon/orders${qa()}`)
    expect(other.status).toBe(403)
    const refund = await call('otherOwner', 'post', `/salon/orders/${f.order.id}/refund?store=${stores.other.id}`, { reason: 'bukan punya saya', ownerPin: null })
    expect(refund.status).toBe(404)
  })

  test('a kasir refunds only with the owner PIN of the outlet', async () => {
    const body = { reason: 'Pelanggan komplain', ownerPin: '1234' }
    const notSet = await call('kasir', 'post', `/salon/orders/${f.order.id}/refund${qa()}`, body)
    expect(notSet.status).toBe(422)
    expect(notSet.body.code).toBe('OWNER_PIN_NOT_SET')
    const raw = (await db.location.findByPk(stores.a.id)).getDataValue('salonSettings')
    await db.location.update({ salonSettings: { ...raw, ownerPinHash: await bcrypt.hash('1234', 4) } }, { where: { id: stores.a.id } })
    const wrong = await call('kasir', 'post', `/salon/orders/${f.order.id}/refund${qa()}`, { ...body, ownerPin: '9999' })
    expect(wrong.status).toBe(403)
    expect(wrong.body.code).toBe('OWNER_PIN_INVALID')

    const res = await call('kasir', 'post', `/salon/orders/${f.order.id}/refund${qa()}`, body)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('refunded')
    expect(res.body.refund).toMatchObject({ reason: 'Pelanggan komplain', by: 'Salon kasir', amount: 102500 })

    const so = await db.salon_order.findByPk(Number(f.order.id))
    const order = await db.order.findByPk(so.orderId)
    expect(order).toMatchObject({ status: 'void', paymentStatus: 'refunded' })
    const commissions = await db.salon_staff_commission.findAll({ where: { orderId: order.id } })
    expect(commissions).toHaveLength(6)
    expect(commissions.reduce((s, c) => s + c.amount, 0)).toBe(0)
    const stock = await db.product_store_stock.findOne({ where: { product: Number(f.shampoo.id), store: stores.a.id } })
    expect(Number(stock.stock)).toBe(5)
    expect((await db.member.findByPk(Number(f.member.id))).totalPoints).toBe(0)
    const reversal = await db.accounting_outbox.findOne({ where: { referenceType: 'order', referenceId: order.id, jobType: 'reverse_order_journals' } })
    expect(reversal.status).toBe('posted')

    const again = await call('owner', 'post', `/salon/orders/${f.order.id}/refund${qa()}`, { reason: 'Pelanggan komplain', ownerPin: null })
    expect(again.status).toBe(409)
  })

  test('close = blind count against modal + tunai + deposit tunai − refund tunai', async () => {
    const res = await call('kasir', 'post', `/salon/shift/close${qa()}`, { countedCash: 119000 })
    expect(res.status).toBe(200)
    // 100000 + 52500 + 20000 − 52500
    expect(res.body).toMatchObject({ status: 'closed', expectedCash: 120000, countedCash: 119000, variance: -1000, refunds: 52500 })
    const list = await call('admin', 'get', `/salon/shifts${qa()}`)
    expect(list.status).toBe(200)
    expect(list.body.data[0]).toMatchObject({ id: f.shiftId, status: 'closed' })
    const closed = await call('kasir', 'post', `/salon/shift/close${qa()}`, { countedCash: 0 })
    expect(closed.body.code).toBe('SHIFT_CLOSED')
  })

  test('a stylist cannot sell or see the till', async () => {
    const stylist = await db.user.findByPk(Number(f.senior.userId))
    await sign('stylist', stylist)
    const res = await call('stylist', 'post', `/salon/checkout/quote${qa()}`, cart(null))
    expect(res.status).toBe(403)
    const shifts = await call('stylist', 'get', `/salon/shift/current${qa()}`)
    expect(shifts.status).toBe(403)
  })
})
