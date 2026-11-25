process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const migration = require('../db/migrations/20261125000001-bakery-domain')
const { zonedToUtc, localDate, addDays } = require('../api/service/salonTime')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Bakery pre-orders (/bakery/*, batch B28): context, catalog, create with DP,
// status machine, payments through the POS payment path, cancel, WA text,
// calendar, production plan and dashboard. Shapes follow FE-BAKERY-App
// src/api/contract.ts.

const TZ = 'Asia/Jakarta'
const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
const users = {}
const tokens = {}
const tenants = {}
const stores = {}
const f = {}
const createdUserIds = []
const DAY = addDays(localDate(Date.now(), TZ), 2)
const at = (hhmm, date = DAY) => new Date(zonedToUtc(date, hhmm, TZ)).toISOString()
let seq = 0
const key = () => `bkr-${stamp}-${++seq}`

const nextLocationId = async () => {
  const [rows] = await db.sequelize.query("SELECT nextval('location_id_seq') AS id")
  return Number(rows[0].id)
}
const makeLocation = async (tenantId, name) => {
  const id = await nextLocationId()
  return db.location.create({ id, store: id, name: `${name}_${stamp}`, status: 'active', tenantId, businessType: 'bakery', timezone: TZ })
}
const sign = async (k, user) => {
  tokens[k] = await signSessionToken({ id: user.id, userName: user.userName, roleType: user.roleType, store: user.store }, JWT_SECRET)
}
const makeUser = async (k, roleType, storeId) => {
  users[k] = await db.user.create({
    userName: `bkr_${k}_${stamp}`,
    fullName: `Bakery ${k}`,
    email: `bkr_${k}_${stamp}@test.com`,
    roleType,
    userType: roleType === 'user' ? 'user' : 'admin',
    store: storeId,
    status: 'active'
  })
  createdUserIds.push(users[k].id)
  await sign(k, users[k])
}
const call = (k, method, path, body) => {
  const r = request(app)[method](path).set('Authorization', `Bearer ${tokens[k]}`)
  return body === undefined ? r : r.send(body)
}
const qa = () => `?store=${stores.a.id}`

const orderBody = (extra = {}) => ({
  idempotencyKey: key(),
  memberId: null,
  customerName: 'Bu Sari',
  customerPhone: '081234567890',
  fulfillmentType: 'pickup',
  scheduledAt: at('10:00'),
  customerNote: 'Tulisan: Selamat Ulang Tahun',
  items: [
    { productId: String(f.roti.id), qty: 10 },
    { productId: String(f.kue.id), qty: 2, note: 'coklat' }
  ],
  dpAmount: 0,
  ...extra
})

beforeAll(async () => {
  tenants.bakery = await db.tenant.create({ code: `bkr-${stamp}`, name: 'Roti Sari', businessType: 'bakery' })
  tenants.other = await db.tenant.create({ code: `bkr-o-${stamp}`, name: 'Roti Lain', businessType: 'bakery' })
  tenants.salon = await db.tenant.create({ code: `bkr-s-${stamp}`, name: 'Salon', businessType: 'salon' })
  stores.a = await makeLocation(tenants.bakery.id, 'BKR_A')
  stores.other = await makeLocation(tenants.other.id, 'BKR_O')
  stores.salon = await makeLocation(tenants.salon.id, 'BKR_S')
  await makeUser('owner', 'super_admin', stores.a.id)
  await makeUser('kasir', 'kasir', stores.a.id)
  await makeUser('crew', 'user', stores.a.id)
  await makeUser('otherOwner', 'super_admin', stores.other.id)
  await makeUser('salonOwner', 'super_admin', stores.salon.id)

  f.category = await db.category.create({ name: `Roti ${stamp}`, tenantId: tenants.bakery.id })
  f.roti = await db.product.create({ nameProduct: `Roti Tawar ${stamp}`, category: f.category.id, price: 15000, unit: 'pcs', tenantId: tenants.bakery.id, status: 'active' })
  f.kue = await db.product.create({ nameProduct: `Kue Ulang Tahun ${stamp}`, category: f.category.id, price: 250000, unit: 'loyang', tenantId: tenants.bakery.id, status: 'active' })
  f.hidden = await db.product.create({ nameProduct: `Lain ${stamp}`, category: f.category.id, price: 1000, tenantId: tenants.other.id, status: 'active' })
  for (const p of [f.roti, f.kue]) await db.product_store.create({ product: p.id, store: stores.a.id })
  await db.product_store_stock.create({ product: f.roti.id, store: stores.a.id, stock: 100 })
  await db.product_store_stock.create({ product: f.kue.id, store: stores.a.id, stock: 10 })
  await db.product_store_price.create({ product: f.roti.id, store: stores.a.id, price: 16000 })
  f.tepung = await db.ingredient.create({ name: `Tepung ${stamp}`, unit: 'gram', tenantId: tenants.bakery.id })
  f.telur = await db.ingredient.create({ name: `Telur ${stamp}`, unit: 'butir', tenantId: tenants.bakery.id })
  // One batch makes 2 cakes: 500 g flour + 8 eggs.
  const bom = await db.bom_header.create({ productId: f.kue.id, store: stores.a.id, name: 'Kue', totalQty: 2, status: 'active' })
  await db.bom_line.bulkCreate([
    { bomHeaderId: bom.id, ingredientId: f.tepung.id, qty: 500, unit: 'gram' },
    { bomHeaderId: bom.id, ingredientId: f.telur.id, qty: 8, unit: 'butir' }
  ])
  f.member = await db.member.create({ name: `Sari ${stamp}`, phoneNumber: '081200000001', tenantId: tenants.bakery.id, store: stores.a.id })
})

afterAll(async () => {
  const tenantIds = Object.values(tenants).map((t) => t.id)
  const storeIds = Object.values(stores).map((s) => s.id)
  const productIds = [f.roti?.id, f.kue?.id, f.hidden?.id].filter(Boolean)
  const orderIds = (await db.order.findAll({ where: { store: storeIds }, paranoid: false, attributes: ['id'] })).map((o) => o.id)
  const q = (sql, replacements) => db.sequelize.query(sql, { replacements }).catch((e) => console.error(e.message))
  const del = (model, where) => db[model].destroy({ where, force: true }).catch((e) => console.error(model, e.message))
  await del('bakery_status_history', { tenantId: tenantIds })
  await del('bakery_order', { tenantId: tenantIds })
  if (orderIds.length) {
    await q('DELETE FROM accounting_outbox WHERE "referenceType" = \'order\' AND "referenceId" IN (:ids)', { ids: orderIds })
    await q('DELETE FROM journal_entry_line WHERE "journalEntry" IN (SELECT id FROM journal_entry WHERE store IN (:s))', { s: storeIds })
    await del('journal_entry', { store: storeIds })
    await del('account', { store: storeIds })
    await del('transaction', { order: orderIds })
    await del('order_item', { order: orderIds })
    await del('order_status', { order: orderIds })
    await del('best_selling', { productId: productIds })
    await del('order', { id: orderIds })
  }
  await del('stock_history', { product: productIds })
  await q('DELETE FROM ingredient_store_stock WHERE ingredient IN (:ids)', { ids: [f.tepung?.id, f.telur?.id].filter(Boolean) })
  await q('DELETE FROM stock_history WHERE ingredient IN (:ids)', { ids: [f.tepung?.id, f.telur?.id].filter(Boolean) })
  await del('bom_line', { ingredientId: [f.tepung?.id, f.telur?.id].filter(Boolean) })
  await del('bom_header', { productId: productIds })
  await del('ingredient', { tenantId: tenantIds })
  await del('member', { tenantId: tenantIds })
  await q('DELETE FROM document_counter WHERE store IN (:ids)', { ids: storeIds })
  await del('cashRegister', { store: storeIds })
  await del('product_store_price', { product: productIds })
  await del('product_store_stock', { product: productIds })
  await del('product_store', { product: productIds })
  await del('product', { id: productIds })
  await del('category', { tenantId: tenantIds })
  await del('user', { id: createdUserIds })
  await del('location', { id: storeIds })
  await del('tenant', { id: tenantIds })
  await db.sequelize.close()
})

describe('schema (batch B28)', () => {
  test('tables exist with the status CHECK and the idempotency unique', async () => {
    const [rows] = await db.sequelize.query(
      "SELECT indexname FROM pg_indexes WHERE indexname IN ('uq_bakery_order_store_idempotency','uq_bakery_order_order','uq_bakery_status_history_idempotency') ORDER BY 1"
    )
    expect(rows.map((r) => r.indexname)).toEqual(['uq_bakery_order_order', 'uq_bakery_order_store_idempotency', 'uq_bakery_status_history_idempotency'])
    const [checks] = await db.sequelize.query(
      "SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname IN ('bakery_order_status_check','bakery_status_history_status_check') ORDER BY 1"
    )
    expect(checks.map((c) => c.conname)).toEqual(['bakery_order_status_check', 'bakery_status_history_status_check'])
    expect(checks[0].def).toMatch(/PENDING_CONFIRMATION/)
    expect(checks[0].def).toMatch(/pickup/)
  })

  test('replay of up is a no-op', async () => {
    await migration.up(db.sequelize.getQueryInterface(), db.Sequelize)
  })
})

describe('context, settings and catalog', () => {
  test('context lists the tenant, its outlets and the role permissions', async () => {
    const res = await call('kasir', 'get', '/bakery/context')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      tenant: { id: String(tenants.bakery.id), name: 'Roti Sari', settings: { businessType: 'bakery', leadTimeMinutes: 60 } },
      canonicalRole: 'kasir',
      stores: [{ id: String(stores.a.id), timezone: TZ, active: true }],
      onboardingRequired: false,
      staffUserId: null
    })
    expect(res.body.permissions).toEqual(expect.arrayContaining(['bakery.order.manage', 'pos.sell']))
    expect(res.body.permissions).not.toContain('settings.manage')
  })

  test('a salon tenant is not a bakery', async () => {
    const res = await call('salonOwner', 'get', '/bakery/context')
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('FORBIDDEN')
  })

  test('owner updates settings; a kasir cannot', async () => {
    const denied = await call('kasir', 'patch', '/bakery/settings', { deliveryEnabled: true })
    expect(denied.status).toBe(403)
    const res = await call('owner', 'patch', '/bakery/settings', { businessType: 'bakery', deliveryEnabled: true, leadTimeMinutes: 120 })
    expect(res.status).toBe(200)
    expect(res.body.settings).toMatchObject({ deliveryEnabled: true, leadTimeMinutes: 120, pickupOpen: '08:00' })
  })

  test('products are the outlet ones with the outlet price and the recipe flag', async () => {
    const res = await call('kasir', 'get', `/bakery/products${qa()}`)
    expect(res.status).toBe(200)
    const byId = new Map(res.body.data.map((p) => [p.id, p]))
    expect(byId.get(String(f.roti.id))).toMatchObject({ price: 16000, unit: 'pcs', hasRecipe: false })
    expect(byId.get(String(f.kue.id))).toMatchObject({ price: 250000, unit: 'loyang', hasRecipe: true })
    expect(byId.has(String(f.hidden.id))).toBe(false)
  })

  test('members search inside the tenant', async () => {
    const res = await call('kasir', 'get', `/bakery/members?q=${encodeURIComponent(`Sari ${stamp}`)}`)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([{ id: String(f.member.id), name: `Sari ${stamp}`, phone: '081200000001', email: null }])
  })
})

describe('pre-orders', () => {
  test('a DP needs an open drawer (REGISTER_REQUIRED)', async () => {
    const res = await call('kasir', 'post', `/bakery/orders${qa()}`, orderBody({ dpAmount: 100000, dpMethod: 'cash' }))
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('REGISTER_REQUIRED')
    expect(await db.bakery_order.count({ where: { store: stores.a.id } })).toBe(0)
  })

  test('create prices on the server, takes the DP into the drawer and replays by key', async () => {
    f.register = await db.cashRegister.create({ store: stores.a.id, user: users.kasir.id, status: 'open', openingBalance: 0, openedAt: new Date() })
    f.body = orderBody({ memberId: String(f.member.id), dpAmount: 160000, dpMethod: 'cash' })
    const res = await call('kasir', 'post', `/bakery/orders${qa()}`, f.body)
    expect(res.status).toBe(201)
    f.order = res.body
    expect(res.body).toMatchObject({
      storeId: String(stores.a.id),
      member: { id: String(f.member.id) },
      customerName: 'Bu Sari',
      fulfillmentType: 'pickup',
      processStatus: 'PENDING_CONFIRMATION',
      paymentStatus: 'partial',
      subtotal: 660000,
      total: 660000,
      paidAmount: 160000,
      remainingAmount: 500000
    })
    expect(res.body.items).toEqual([
      expect.objectContaining({ productId: String(f.roti.id), qty: 10, price: 16000, subtotal: 160000, unit: 'pcs' }),
      expect.objectContaining({ productId: String(f.kue.id), qty: 2, price: 250000, subtotal: 500000, note: 'coklat' })
    ])
    expect(res.body.payments).toEqual([expect.objectContaining({ amount: 160000, method: 'cash' })])
    expect(res.body.history.map((h) => h.toStatus)).toEqual(['PENDING_CONFIRMATION'])
    const row = await db.bakery_order.findByPk(Number(res.body.id))
    const order = await db.order.findByPk(row.orderId)
    expect(order).toMatchObject({ status: 'pending', paymentStatus: 'partially_paid', tenantId: tenants.bakery.id })
    const trx = await db.transaction.findAll({ where: { order: order.id } })
    expect(trx.map((t) => [t.typePayment, Number(t.amount), t.cashRegisterId])).toEqual([['CASH', 160000, f.register.id]])

    const replay = await call('kasir', 'post', `/bakery/orders${qa()}`, f.body)
    expect(replay.status).toBe(200)
    expect(replay.body.id).toBe(f.order.id)
    const conflict = await call('kasir', 'post', `/bakery/orders${qa()}`, { ...f.body, customerName: 'Lain' })
    expect(conflict.status).toBe(409)
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT')
  })

  test('invalid input is refused: DP above total, unknown product, delivery without address', async () => {
    const over = await call('kasir', 'post', `/bakery/orders${qa()}`, orderBody({ dpAmount: 999999999, dpMethod: 'cash' }))
    expect(over.status).toBe(400)
    const unknown = await call('kasir', 'post', `/bakery/orders${qa()}`, orderBody({ items: [{ productId: String(f.hidden.id), qty: 1 }] }))
    expect(unknown.status).toBe(404)
    const noAddress = await call('kasir', 'post', `/bakery/orders${qa()}`, orderBody({ fulfillmentType: 'delivery' }))
    expect(noAddress.status).toBe(400)
    expect(noAddress.body.details).toMatchObject({ field: 'deliveryAddress' })
  })

  test('status follows the machine; a retried click is a replay', async () => {
    const path = `/bakery/orders/${f.order.id}/status${qa()}`
    const skip = await call('kasir', 'patch', path, { status: 'READY', idempotencyKey: key() })
    expect(skip.status).toBe(409)
    expect(skip.body.code).toBe('INVALID_BAKERY_STATUS_TRANSITION')
    const k = key()
    const ok = await call('kasir', 'patch', path, { status: 'CONFIRMED', idempotencyKey: k })
    expect(ok.status).toBe(200)
    const again = await call('kasir', 'patch', path, { status: 'CONFIRMED', idempotencyKey: k })
    expect(again.status).toBe(200)
    expect(again.body.history.map((h) => h.toStatus)).toEqual(['PENDING_CONFIRMATION', 'CONFIRMED'])
    for (const status of ['IN_PRODUCTION', 'READY']) {
      expect((await call('kasir', 'patch', path, { status, idempotencyKey: key() })).status).toBe(200)
    }
    const wrongEnd = await call('kasir', 'patch', path, { status: 'DELIVERED', idempotencyKey: key() })
    expect(wrongEnd.status).toBe(409)
    const crew = await call('crew', 'patch', path, { status: 'PICKED_UP', idempotencyKey: key() })
    expect(crew.status).toBe(403)
  })

  test('the production plan scales the recipe by the ordered quantity', async () => {
    const res = await call('crew', 'get', `/bakery/production-plan${qa()}&date=${DAY}`)
    expect(res.status).toBe(200)
    const kue = res.body.items.find((i) => i.productId === String(f.kue.id))
    expect(kue).toMatchObject({ orderedQty: 2, orderCount: 1, hasRecipe: true })
    expect(kue.materials).toEqual([
      { ingredientId: String(f.tepung.id), name: `Tepung ${stamp}`, qty: 500, unit: 'gram' },
      { ingredientId: String(f.telur.id), name: `Telur ${stamp}`, qty: 8, unit: 'butir' }
    ])
    expect(res.body.items.find((i) => i.productId === String(f.roti.id))).toMatchObject({ orderedQty: 10, hasRecipe: false, materials: [] })
  })

  test('the settlement goes through the POS payment path and completes the sale', async () => {
    const path = `/bakery/orders/${f.order.id}/payments${qa()}`
    const over = await call('kasir', 'post', path, { amount: 600000, method: 'cash', idempotencyKey: key() })
    expect(over.status).toBe(422)
    const noRef = await call('kasir', 'post', path, { amount: 500000, method: 'qris', idempotencyKey: key() })
    expect(noRef.status).toBe(422)
    expect(noRef.body.code).toBe('REFERENCE_REQUIRED')
    const k = key()
    const res = await call('kasir', 'post', path, { amount: 500000, method: 'qris', note: 'QR-123456', idempotencyKey: k })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ paymentStatus: 'paid', paidAmount: 660000, remainingAmount: 0 })
    expect(res.body.payments.map((p) => [p.method, p.amount, p.note])).toEqual([['cash', 160000, null], ['qris', 500000, 'QR-123456']])
    const replay = await call('kasir', 'post', path, { amount: 500000, method: 'qris', note: 'QR-123456', idempotencyKey: k })
    expect(replay.status).toBe(200)
    expect(replay.body.payments).toHaveLength(2)

    const row = await db.bakery_order.findByPk(Number(f.order.id))
    const order = await db.order.findByPk(row.orderId)
    expect(order).toMatchObject({ status: 'paid', paymentStatus: 'paid' })
    // Fully paid = recognized sale: finished-good stock and the sale journal.
    const stock = await db.product_store_stock.findOne({ where: { product: f.roti.id, store: stores.a.id } })
    expect(Number(stock.stock)).toBe(90)
    const jobs = await db.accounting_outbox.findAll({ where: { referenceType: 'order', referenceId: order.id }, order: [['id', 'ASC']] })
    expect(jobs.map((j) => [j.jobType, j.status])).toEqual([['order_journal', 'posted'], ['order_cogs_journal', 'posted']])

    const picked = await call('kasir', 'patch', `/bakery/orders/${f.order.id}/status${qa()}`, { status: 'PICKED_UP', idempotencyKey: key() })
    expect(picked.status).toBe(200)
    expect(picked.body.processStatus).toBe('PICKED_UP')
  })

  test('cancel: an unpaid order is cancelled, a kept DP voids it, a finished one is refused', async () => {
    const unpaid = await call('kasir', 'post', `/bakery/orders${qa()}`, orderBody())
    expect(unpaid.status).toBe(201)
    const c1 = await call('kasir', 'post', `/bakery/orders/${unpaid.body.id}/cancel${qa()}`, { reason: 'Batal', idempotencyKey: key() })
    expect(c1.status).toBe(200)
    expect(c1.body.processStatus).toBe('CANCELLED')
    expect((await db.order.findByPk((await db.bakery_order.findByPk(Number(unpaid.body.id))).orderId)).status).toBe('cancelled')
    const pay = await call('kasir', 'post', `/bakery/orders/${unpaid.body.id}/payments${qa()}`, { amount: 1000, method: 'cash', idempotencyKey: key() })
    expect(pay.status).toBe(409)

    const withDp = await call('kasir', 'post', `/bakery/orders${qa()}`, orderBody({ dpAmount: 50000, dpMethod: 'cash' }))
    const c2 = await call('kasir', 'patch', `/bakery/orders/${withDp.body.id}/status${qa()}`, { status: 'CANCELLED', reason: 'Tidak jadi', idempotencyKey: key() })
    expect(c2.status).toBe(200)
    expect((await db.order.findByPk((await db.bakery_order.findByPk(Number(withDp.body.id))).orderId)).status).toBe('void')
    const noReason = await call('kasir', 'patch', `/bakery/orders/${withDp.body.id}/status${qa()}`, { status: 'CANCELLED', idempotencyKey: key() })
    expect(noReason.status).toBe(409)

    const done = await call('kasir', 'post', `/bakery/orders/${f.order.id}/cancel${qa()}`, { reason: 'Telat', idempotencyKey: key() })
    expect(done.status).toBe(409)
  })

  test('list, detail, calendar and dashboard read the outlet calendar', async () => {
    const list = await call('kasir', 'get', `/bakery/orders${qa()}&from=${DAY}&to=${DAY}`)
    expect(list.status).toBe(200)
    expect(list.body.data.length).toBe(3)
    const byStatus = await call('kasir', 'get', `/bakery/orders${qa()}&status=PICKED_UP`)
    expect(byStatus.body.data.map((o) => o.id)).toEqual([f.order.id])
    const search = await call('kasir', 'get', `/bakery/orders${qa()}&q=${encodeURIComponent(f.order.orderNo)}`)
    expect(search.body.data.map((o) => o.id)).toEqual([f.order.id])
    const cal = await call('kasir', 'get', `/bakery/calendar${qa()}&from=${DAY}&to=${addDays(DAY, 6)}`)
    expect(cal.status).toBe(200)
    expect(cal.body.data.find((c) => c.id === f.order.id)).toMatchObject({ itemCount: 12, total: 660000, remainingAmount: 0 })
    const dash = await call('kasir', 'get', `/bakery/dashboard${qa()}&date=${DAY}`)
    expect(dash.status).toBe(200)
    expect(dash.body).toEqual({ date: DAY, totalOrders: 3, dueToday: 1, overdue: 0, unpaidOrDp: 0, readyCount: 0 })
  })

  test('WA text uses the tenant template and a wa.me link', async () => {
    const res = await call('kasir', 'get', `/bakery/orders/${f.order.id}/wa-text${qa()}&template=note`)
    expect(res.status).toBe(200)
    expect(res.body.phone).toBe('6281234567890')
    expect(res.body.text).toContain(f.order.orderNo)
    expect(res.body.text).toContain('Rp660.000')
    expect(res.body.waUrl).toMatch(/^https:\/\/wa\.me\/6281234567890\?text=/)
  })

  test('another tenant cannot reach the outlet or the order', async () => {
    const res = await call('otherOwner', 'get', `/bakery/orders/${f.order.id}${qa()}`)
    expect(res.status).toBe(403)
    const own = await call('otherOwner', 'get', `/bakery/orders/${f.order.id}?store=${stores.other.id}`)
    expect(own.status).toBe(404)
  })
})
