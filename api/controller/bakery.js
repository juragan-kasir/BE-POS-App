'use strict'

const crypto = require('crypto')
const { Op } = require('sequelize')
const { ZodError } = require('zod')
const db = require('../../db/models')
const orderController = require('./order')
const {
  BakeryError,
  tenantSettings,
  publicTenant,
  publicStore,
  resolveBakeryActor,
  resolveBakeryStore
} = require('../service/bakeryContext')
const {
  TenantSettings,
  StoreInput,
  CreateOrderInput,
  UpdateStatusInput,
  AddPaymentInput,
  CancelOrderInput,
  OrdersQuery,
  DateRange,
  DateQuery,
  WaTextQuery
} = require('../validation/bakerySchemas')
const { hasBakeryPermission } = require('../../utils/bakeryCapabilities')
const { getEffectivePriceMap } = require('../../utils/outletPricing')
const { nextDocumentNumber } = require('../../utils/documentNumber')
const { zonedToUtc, localDate, addDays, toIso } = require('../service/salonTime')

// Bakery & catering pre-orders (FE-BAKERY-App, contract /bakery/*). One
// pre-order = one POS `order` (+ order_item, transaction), exactly like a
// laundry order: the DP and every later payment go through the POS payment
// path (collectOrderPaymentInTransaction: drawer attribution, tender
// reference, and — when the order becomes fully paid — stock + sale/COGS
// journals). bakery_order holds the schedule, fulfillment and process status;
// bakery_status_history the trail.

// ---------- http ----------

const fail = (res, status, code, message, details) =>
  res.status(status).json({ code, message, ...(details ? { details } : {}) })

const withStatus = (status, body) => ({ __status: status, body })

const bakeryRoute = ({ perm = null, store = false } = {}, handler) => async (req, res) => {
  try {
    if (!req.user) return fail(res, 401, 'UNAUTHENTICATED', 'Sesi berakhir, silakan masuk lagi')
    const bakery = await resolveBakeryActor(req)
    if (perm && !hasBakeryPermission(req.user, perm)) {
      return fail(res, 403, 'FORBIDDEN', 'Kamu tidak punya akses untuk aksi ini', { required: Array.isArray(perm) ? perm : [perm] })
    }
    const activeStore = store ? resolveBakeryStore(bakery, req.query?.store ?? req.body?.store) : undefined
    const result = await handler({ req, user: req.user, bakery, store: activeStore, body: req.body || {}, query: req.query || {}, params: req.params || {} })
    if (result && result.__status) return res.status(result.__status).json(result.body)
    return res.status(200).json(result ?? { ok: true })
  } catch (err) {
    if (err instanceof BakeryError) return fail(res, err.status, err.code, err.message, err.details)
    if (err instanceof ZodError) {
      return fail(res, 400, 'VALIDATION_FAILED', 'Data tidak valid', {
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
      })
    }
    // Shared POS payment path: { statusCode, code } errors (REGISTER_REQUIRED,
    // REFERENCE_REQUIRED, ALREADY_PAID, INVALID_AMOUNT, …).
    if (err?.statusCode && err?.code && err.statusCode < 500) return fail(res, err.statusCode, err.code, err.message)
    console.error('[bakery]', err)
    return fail(res, 500, 'INTERNAL_ERROR', 'Terjadi kesalahan server')
  }
}

const idParam = (value, message) => {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n <= 0) throw new BakeryError('NOT_FOUND', message, 404)
  return n
}
const notFound = (message) => new BakeryError('NOT_FOUND', message, 404)

const stableHash = (value) => {
  const norm = (v) =>
    Array.isArray(v)
      ? v.map(norm)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]))
        : v
  return crypto.createHash('sha256').update(JSON.stringify(norm(value))).digest('hex')
}

// ---------- status machine ----------

const NEXT_STATUSES = Object.freeze({
  PENDING_CONFIRMATION: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['IN_PRODUCTION', 'CANCELLED'],
  IN_PRODUCTION: ['READY', 'CANCELLED'],
  READY: ['PICKED_UP', 'DELIVERED', 'CANCELLED'],
  PICKED_UP: [],
  DELIVERED: [],
  CANCELLED: []
})
const DONE = ['PICKED_UP', 'DELIVERED']
const invalidTransition = (from, to, message = 'Perubahan status tidak valid') =>
  new BakeryError('INVALID_BAKERY_STATUS_TRANSITION', message, 409, { from, to })

// ---------- context / settings / outlets ----------

exports.getContext = bakeryRoute({}, async ({ user, bakery }) => ({
  tenant: publicTenant(bakery.tenant),
  user: { id: String(user.id), name: user.fullName || user.userName, email: user.email || null },
  canonicalRole: bakery.canonicalRole,
  permissions: bakery.permissions,
  stores: bakery.stores.map(publicStore),
  onboardingRequired: !bakery.stores.some((s) => s.status !== 'inactive'),
  staffUserId: bakery.canonicalRole === 'staff' ? String(user.id) : null
}))

exports.updateSettings = bakeryRoute({ perm: ['bakery.settings.manage', 'settings.manage'] }, async ({ bakery, body }) => {
  // FE sends the whole TenantSettings (businessType included); only the
  // editable keys are kept.
  const { businessType: _ignored, storeId: _store, store: _s, ...rest } = body || {}
  const input = TenantSettings.parse(rest)
  const tenant = await db.tenant.findByPk(bakery.tenant.id)
  await tenant.update({ bakerySettings: { ...(tenant.bakerySettings || {}), ...input } })
  return publicTenant(tenant)
})

const assertStoreNameFree = async (bakery, name, excludeId, transaction) => {
  const clash = await db.location.findOne({
    where: {
      tenantId: bakery.tenant.id,
      ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}),
      [Op.and]: [db.sequelize.where(db.sequelize.fn('lower', db.sequelize.col('name')), name.trim().toLowerCase())]
    },
    attributes: ['id'],
    transaction
  })
  if (clash) throw new BakeryError('VALIDATION_FAILED', 'Nama outlet sudah dipakai', 409, { field: 'name' })
}

const storeValues = (input) => ({
  name: input.name,
  address: input.address || null,
  detailLocation: input.address || null,
  phoneNumber: input.phone || null,
  timezone: input.timezone,
  status: input.active ? 'active' : 'inactive'
})

exports.createStore = bakeryRoute({ perm: 'outlet.manage' }, async ({ req, bakery, user, body }) => {
  const input = StoreInput.parse(body)
  const location = await db.sequelize.transaction(async (t) => {
    await db.sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `bakery_store:${bakery.tenant.id}` }, transaction: t })
    await assertStoreNameFree(bakery, input.name, null, t)
    const [seq] = await db.sequelize.query("SELECT nextval('location_id_seq') AS id", { transaction: t })
    const id = Number(seq[0].id)
    const created = await db.location.create(
      { id, store: id, tenantId: bakery.tenant.id, businessType: 'bakery', createdBy: user.id, ...storeValues(input) },
      { transaction: t }
    )
    // An owner without a home outlet gets this one, so the outlet-scoped
    // shared flows (cash register) have a store.
    await db.user.update({ store: id }, { where: { id: user.id, store: null }, transaction: t })
    return created
  })
  req.bakery = null
  return withStatus(201, publicStore(location))
})

exports.updateStore = bakeryRoute({ perm: 'outlet.manage' }, async ({ bakery, user, body, params }) => {
  const input = StoreInput.parse(body)
  const id = idParam(params.id, 'Outlet tidak ditemukan')
  const location = await db.sequelize.transaction(async (t) => {
    const row = await db.location.findOne({ where: { id, tenantId: bakery.tenant.id }, transaction: t, lock: t.LOCK.UPDATE })
    if (!row || !bakery.stores.some((s) => Number(s.id) === id)) throw notFound('Outlet tidak ditemukan')
    await assertStoreNameFree(bakery, input.name, id, t)
    await row.update({ ...storeValues(input), modifiedBy: user.id }, { transaction: t })
    return row
  })
  return publicStore(location)
})

// ---------- catalog / members ----------

const publicMember = (m) => (m ? { id: String(m.id), name: m.name, phone: m.phoneNumber || null, email: m.email || null } : null)

exports.listMembers = bakeryRoute({ perm: 'member.read' }, async ({ bakery, query }) => {
  const q = String(query.q || '').trim().slice(0, 60)
  const rows = await db.member.findAll({
    where: {
      tenantId: bakery.tenant.id,
      status: 'active',
      ...(q ? { [Op.or]: [{ name: { [Op.iLike]: `%${q}%` } }, { phoneNumber: { [Op.iLike]: `%${q}%` } }] } : {})
    },
    order: [['name', 'ASC']],
    limit: 50
  })
  return { data: rows.map(publicMember) }
})

/** Active products sold at the outlet (tenant-owned, assigned to the outlet). */
const outletProducts = async (bakery, store, ids, transaction) => {
  const assigned = await db.product_store.findAll({ where: { store: store.id }, attributes: ['product'], transaction })
  const assignedIds = assigned.map((r) => Number(r.product))
  const allowed = ids ? ids.filter((id) => assignedIds.includes(id)) : assignedIds
  if (!allowed.length) return []
  return db.product.findAll({
    where: { id: allowed, tenantId: bakery.tenant.id, status: 'active' },
    order: [['nameProduct', 'ASC']],
    transaction
  })
}

const recipesFor = async (store, productIds, transaction) => {
  if (!productIds.length) return new Map()
  const headers = await db.bom_header.findAll({
    where: { productId: productIds, store: store.id, status: 'active' },
    include: [{ model: db.bom_line, as: 'lines', include: [{ model: db.ingredient, as: 'ingredientData', attributes: ['id', 'name', 'unit'] }] }],
    transaction
  })
  return new Map(headers.filter((h) => h.lines?.length).map((h) => [Number(h.productId), h]))
}

exports.listProducts = bakeryRoute({ perm: 'catalog.read', store: true }, async ({ bakery, store }) => {
  const products = await outletProducts(bakery, store, null)
  const prices = await getEffectivePriceMap(products, store.id)
  const recipes = await recipesFor(store, products.map((p) => p.id))
  return {
    data: products.map((p) => ({
      id: String(p.id),
      name: p.nameProduct,
      price: Math.max(0, Math.round(Number(prices.get(String(p.id)) ?? p.price) || 0)),
      unit: p.unit || 'pcs',
      active: p.status === 'active',
      hasRecipe: recipes.has(p.id)
    }))
  }
})

// ---------- serialization ----------

const CONTRACT_METHOD = Object.freeze({ CASH: 'cash', QRIS: 'qris', BANK_TRANSFER: 'transfer', CARD: 'card' })
const PAYMENT_STATUS = Object.freeze({ unpaid: 'unpaid', partial: 'partial', partially_paid: 'partial', paid: 'paid', partially_refunded: 'refunded', refunded: 'refunded' })

/** Contract `BakeryOrder` for bakery_order rows. */
const serializeOrders = async (rows, transaction) => {
  if (!rows.length) return []
  const orderIds = rows.map((r) => r.orderId)
  const orders = await db.order.findAll({ where: { id: orderIds }, paranoid: false, transaction })
  const items = await db.order_item.findAll({ where: { order: orderIds }, order: [['id', 'ASC']], transaction })
  const products = await db.product.findAll({ where: { id: [...new Set(items.map((i) => i.product))] }, attributes: ['id', 'unit'], paranoid: false, transaction })
  const payments = await db.transaction.findAll({ where: { order: orderIds }, order: [['id', 'ASC']], transaction })
  const history = await db.bakery_status_history.findAll({ where: { bakeryOrderId: rows.map((r) => r.id) }, order: [['id', 'ASC']], transaction })
  const members = await db.member.findAll({ where: { id: [...new Set(rows.map((r) => r.memberId).filter(Boolean))] }, paranoid: false, transaction })
  const actorIds = [...new Set(history.map((h) => h.createdBy).filter(Boolean))]
  const actors = actorIds.length ? await db.user.findAll({ where: { id: actorIds }, attributes: ['id', 'fullName', 'userName'], paranoid: false, transaction }) : []
  const actorName = new Map(actors.map((u) => [u.id, u.fullName || u.userName || null]))
  return rows.map((r) => {
    const o = orders.find((x) => x.id === r.orderId)
    const own = payments.filter((p) => p.order === r.orderId)
    const collected = own.filter((p) => Number(p.amount) > 0).reduce((s, p) => s + Number(p.amount), 0)
    const refunded = own.filter((p) => Number(p.amount) < 0).reduce((s, p) => s - Number(p.amount), 0)
    const total = Number(o?.totalPrice) || 0
    const paidAmount = Math.max(0, collected - refunded)
    return {
      id: String(r.id),
      orderNo: o?.orderNumber || '',
      storeId: String(r.store),
      member: publicMember(members.find((m) => m.id === r.memberId)),
      customerName: o?.customerName || '',
      customerPhone: o?.customerPhone || null,
      fulfillmentType: r.fulfillmentType,
      scheduledAt: toIso(r.scheduledAt),
      deliveryAddress: r.deliveryAddress || null,
      deliveryNote: r.deliveryNote || null,
      customerNote: r.customerNote || null,
      adminNote: r.adminNote || null,
      processStatus: r.processStatus,
      paymentStatus: PAYMENT_STATUS[o?.paymentStatus] || (paidAmount >= total && total > 0 ? 'paid' : paidAmount > 0 ? 'partial' : 'unpaid'),
      items: items
        .filter((i) => i.order === r.orderId)
        .map((i) => ({
          productId: String(i.product),
          productName: i.productName || '',
          qty: Number(i.quantity),
          unit: products.find((p) => p.id === i.product)?.unit || 'pcs',
          price: Number(i.price) || 0,
          subtotal: Number(i.totalPrice) || 0,
          note: i.notes || null
        })),
      subtotal: Number(o?.subTotal) || 0,
      discount: Number(o?.discountAmount) || 0,
      tax: Number(o?.taxAmount) || 0,
      total,
      paidAmount,
      remainingAmount: Math.max(0, total - paidAmount),
      payments: own
        .filter((p) => Number(p.amount) > 0)
        .map((p) => ({
          id: String(p.id),
          amount: Number(p.amount),
          method: CONTRACT_METHOD[p.typePayment] || 'other',
          note: p.referenceNumber || p.notes || null,
          paidAt: toIso(p.createdAt),
          idempotencyKey: p.idempotencyKey || null
        })),
      history: history
        .filter((h) => h.bakeryOrderId === r.id)
        .map((h) => ({
          id: String(h.id),
          fromStatus: h.fromStatus || null,
          toStatus: h.toStatus,
          actorName: actorName.get(h.createdBy) || null,
          reason: h.reason || null,
          createdAt: toIso(h.createdAt)
        })),
      createdAt: toIso(r.createdAt),
      updatedAt: toIso(r.updatedAt)
    }
  })
}

const loadOrder = async (bakery, store, rawId, transaction, lock = false) => {
  const row = await db.bakery_order.findOne({
    where: { id: idParam(rawId, 'Pesanan tidak ditemukan'), tenantId: bakery.tenant.id, store: store.id },
    transaction,
    ...(lock ? { lock: transaction.LOCK.UPDATE } : {})
  })
  if (!row) throw notFound('Pesanan tidak ditemukan')
  return row
}

const publicOrder = async (id, transaction) => (await serializeOrders([await db.bakery_order.findByPk(id, { transaction })], transaction))[0]

// ---------- dates ----------

const tzOf = (store) => store.timezone || 'Asia/Jakarta'
const dayStart = (store, date) => new Date(zonedToUtc(date, '00:00', tzOf(store)))
const today = (store) => localDate(Date.now(), tzOf(store))

// ---------- orders ----------

exports.listOrders = bakeryRoute({ perm: 'bakery.order.read', store: true }, async ({ bakery, store, query }) => {
  const q = OrdersQuery.parse({ from: query.from || undefined, to: query.to || undefined, status: query.status || undefined, q: query.q || undefined })
  const where = { tenantId: bakery.tenant.id, store: store.id }
  if (q.status) where.processStatus = q.status
  if (q.from || q.to) {
    where.scheduledAt = {
      ...(q.from ? { [Op.gte]: dayStart(store, q.from) } : {}),
      ...(q.to ? { [Op.lt]: dayStart(store, addDays(q.to, 1)) } : {})
    }
  }
  if (q.q) {
    where.orderId = {
      [Op.in]: db.sequelize.literal(
        `(SELECT id FROM "order" WHERE store = ${Number(store.id)} AND ("orderNumber" ILIKE ${db.sequelize.escape(`%${q.q}%`)} OR "customerName" ILIKE ${db.sequelize.escape(`%${q.q}%`)}))`
      )
    }
  }
  const rows = await db.bakery_order.findAll({ where, order: [['scheduledAt', 'ASC'], ['id', 'ASC']], limit: 500 })
  return { data: await serializeOrders(rows) }
})

exports.getOrder = bakeryRoute({ perm: 'bakery.order.read', store: true }, async ({ bakery, store, params }) =>
  (await serializeOrders([await loadOrder(bakery, store, params.id)]))[0]
)

const findByKey = (store, idempotencyKey, transaction) =>
  db.bakery_order.findOne({ where: { store: store.id, idempotencyKey }, attributes: ['id', 'requestHash'], transaction })

const replayOrMismatch = async (prior, requestHash) => {
  if (prior.requestHash !== requestHash) {
    throw new BakeryError('IDEMPOTENCY_CONFLICT', 'Kunci idempotensi dipakai untuk isi berbeda', 409)
  }
  return withStatus(200, await publicOrder(prior.id))
}

const UNIQUE_VIOLATION = '23505'

exports.createOrder = bakeryRoute({ perm: 'bakery.order.manage', store: true }, async ({ bakery, store, user, body }) => {
  const { store: _store, ...raw } = body
  const input = CreateOrderInput.parse(raw)
  const { idempotencyKey, ...payload } = input
  const requestHash = stableHash(payload)
  const prior = await findByKey(store, idempotencyKey)
  if (prior) return replayOrMismatch(prior, requestHash)

  const settings = tenantSettings(bakery.tenant)
  if (input.fulfillmentType === 'delivery') {
    if (!settings.deliveryEnabled) throw new BakeryError('VALIDATION_FAILED', 'Pengiriman belum diaktifkan di pengaturan', 400, { field: 'fulfillmentType' })
    if (!input.deliveryAddress) throw new BakeryError('VALIDATION_FAILED', 'Alamat pengiriman wajib diisi', 400, { field: 'deliveryAddress' })
  }
  if (input.dpAmount > 0 && !input.dpMethod) throw new BakeryError('VALIDATION_FAILED', 'Pilih metode bayar DP', 400, { field: 'dpMethod' })

  let created
  try {
    created = await db.sequelize.transaction(async (t) => {
      const ids = input.items.map((i) => idParam(i.productId, 'Produk tidak ditemukan'))
      const products = await outletProducts(bakery, store, [...new Set(ids)], t)
      const prices = await getEffectivePriceMap(products, store.id)
      const lines = input.items.map((item, idx) => {
        const product = products.find((p) => p.id === ids[idx])
        if (!product) throw new BakeryError('NOT_FOUND', 'Produk tidak ditemukan di outlet ini', 404, { productId: String(item.productId) })
        const price = Math.max(0, Math.round(Number(prices.get(String(product.id)) ?? product.price) || 0))
        return { product, qty: item.qty, price, subtotal: Math.round(price * item.qty), note: item.note || null }
      })
      const subtotal = lines.reduce((s, l) => s + l.subtotal, 0)
      if (input.dpAmount > subtotal) {
        throw new BakeryError('VALIDATION_FAILED', `DP ${input.dpAmount} melebihi total ${subtotal}`, 400, { field: 'dpAmount' })
      }
      let member = null
      if (input.memberId) {
        member = await db.member.findOne({ where: { id: idParam(input.memberId, 'Pelanggan tidak ditemukan'), tenantId: bakery.tenant.id }, transaction: t })
        if (!member) throw notFound('Pelanggan tidak ditemukan')
      }

      const order = await db.order.create(
        {
          orderNumber: await nextDocumentNumber('order', store.id, { transaction: t }),
          store: store.id,
          customerId: member ? member.id : null,
          customerName: input.customerName,
          customerPhone: input.customerPhone || member?.phoneNumber || null,
          ...orderController.sessionCashier({ user }, {}),
          status: subtotal === 0 ? 'paid' : 'pending',
          paymentStatus: subtotal === 0 ? 'paid' : 'unpaid',
          subTotal: subtotal,
          totalQuantity: lines.reduce((s, l) => s + l.qty, 0),
          discountType: 'none',
          discountValue: 0,
          discountAmount: 0,
          taxRate: 0,
          taxAmount: 0,
          serviceChargeRate: 0,
          serviceChargeAmount: 0,
          totalPrice: subtotal,
          source: 'pos',
          notes: 'Pre-order bakery',
          createdBy: user.id
        },
        { transaction: t }
      )
      await orderController.createOrderItems(
        order,
        lines.map((l) => ({
          product: l.product.id,
          productId: l.product.id,
          productName: l.product.nameProduct,
          quantity: l.qty,
          price: l.price,
          subtotal: l.subtotal,
          notes: l.note,
          options: [],
          modifiers: []
        })),
        {},
        new Map(lines.map((l) => [l.product.id, l.product])),
        'none',
        0,
        t
      )
      const bakeryOrder = await db.bakery_order.create(
        {
          tenantId: bakery.tenant.id,
          store: store.id,
          orderId: order.id,
          memberId: member ? member.id : null,
          fulfillmentType: input.fulfillmentType,
          scheduledAt: new Date(input.scheduledAt),
          deliveryAddress: input.fulfillmentType === 'delivery' ? input.deliveryAddress || null : null,
          deliveryNote: input.deliveryNote || null,
          customerNote: input.customerNote || null,
          adminNote: input.adminNote || null,
          processStatus: 'PENDING_CONFIRMATION',
          idempotencyKey,
          requestHash,
          createdBy: user.id
        },
        { transaction: t }
      )
      await db.bakery_status_history.create(
        { tenantId: bakery.tenant.id, bakeryOrderId: bakeryOrder.id, fromStatus: null, toStatus: 'PENDING_CONFIRMATION', idempotencyKey, createdBy: user.id },
        { transaction: t }
      )
      let accountingJobs = null
      if (input.dpAmount > 0) {
        const result = await orderController.collectOrderPaymentInTransaction(
          order.id,
          store.id,
          {
            paymentMethod: input.dpMethod,
            amount: input.dpAmount,
            cashAmount: input.dpMethod === 'cash' ? input.dpAmount : undefined,
            changeAmount: input.dpMethod === 'cash' ? 0 : undefined,
            referenceNumber: input.dpMethod === 'cash' ? null : input.dpNote || null,
            idempotencyKey: `${idempotencyKey}:dp`
          },
          user,
          t
        )
        accountingJobs = result.accountingJobs
      }
      return { id: bakeryOrder.id, accountingJobs }
    })
  } catch (err) {
    const constraint = err?.parent?.constraint || err?.original?.constraint || ''
    if ((err?.parent?.code || err?.original?.code) === UNIQUE_VIOLATION && /idempotency/.test(constraint)) {
      const winner = await findByKey(store, idempotencyKey)
      if (winner) return replayOrMismatch(winner, requestHash)
    }
    throw err
  }
  if (created.accountingJobs) {
    await orderController.attemptOrderAccountingEntries(created.accountingJobs).catch((err) => console.error('[bakery] journal deferred', err?.message))
  }
  return withStatus(201, await publicOrder(created.id))
})

/** Replay of a status request already applied with this key. */
const appliedWithKey = (row, idempotencyKey, transaction) =>
  db.bakery_status_history.findOne({ where: { bakeryOrderId: row.id, idempotencyKey }, attributes: ['id'], transaction })

const cancelInTransaction = async ({ bakery, row, user, reason, idempotencyKey, t }) => {
  if (DONE.includes(row.processStatus)) throw invalidTransition(row.processStatus, 'CANCELLED', 'Pesanan sudah selesai')
  const order = await db.order.findByPk(row.orderId, { transaction: t, lock: t.LOCK.UPDATE })
  // A fully paid pre-order is a recognized sale (stock + journals). Undoing it
  // needs a refund, which this MVP does not offer: refuse instead of leaving
  // the drawer and the ledger out of step.
  if (order.status === 'paid' && Number(order.totalPrice) > 0) {
    throw invalidTransition(row.processStatus, 'CANCELLED', 'Pesanan sudah lunas; batalkan lewat refund di kasir POS')
  }
  const rows = await db.transaction.findAll({ where: { order: order.id }, attributes: ['amount'], transaction: t })
  const collected = rows.reduce((s, r) => s + Number(r.amount), 0)
  // A kept DP stays in the drawer it was paid into; the order leaves the
  // sales lists either way (same convention as laundry: 'void' when money
  // was collected, else 'cancelled').
  await order.update({ status: collected > 0 ? 'void' : 'cancelled', modifiedBy: user.id }, { transaction: t })
  await db.bakery_status_history.create(
    { tenantId: bakery.tenant.id, bakeryOrderId: row.id, fromStatus: row.processStatus, toStatus: 'CANCELLED', reason, idempotencyKey, createdBy: user.id },
    { transaction: t }
  )
  await row.update({ processStatus: 'CANCELLED', modifiedBy: user.id }, { transaction: t })
}

exports.updateStatus = bakeryRoute({ perm: 'bakery.order.manage', store: true }, async ({ bakery, store, user, body, params }) => {
  const { store: _store, ...raw } = body
  const input = UpdateStatusInput.parse(raw)
  const id = await db.sequelize.transaction(async (t) => {
    const row = await loadOrder(bakery, store, params.id, t, true)
    if (await appliedWithKey(row, input.idempotencyKey, t)) return row.id
    const from = row.processStatus
    if (!NEXT_STATUSES[from].includes(input.status)) throw invalidTransition(from, input.status)
    if (input.status === 'CANCELLED') {
      if (!input.reason) throw new BakeryError('VALIDATION_FAILED', 'Alasan pembatalan wajib diisi', 400, { field: 'reason' })
      await cancelInTransaction({ bakery, row, user, reason: input.reason, idempotencyKey: input.idempotencyKey, t })
      return row.id
    }
    if (input.status === 'PICKED_UP' && row.fulfillmentType !== 'pickup') throw invalidTransition(from, input.status, 'Pesanan ini dikirim, bukan diambil')
    if (input.status === 'DELIVERED' && row.fulfillmentType !== 'delivery') throw invalidTransition(from, input.status, 'Pesanan ini diambil, bukan dikirim')
    await db.bakery_status_history.create(
      { tenantId: bakery.tenant.id, bakeryOrderId: row.id, fromStatus: from, toStatus: input.status, reason: input.reason || null, idempotencyKey: input.idempotencyKey, createdBy: user.id },
      { transaction: t }
    )
    await row.update({ processStatus: input.status, modifiedBy: user.id }, { transaction: t })
    return row.id
  })
  return publicOrder(id)
})

exports.cancelOrder = bakeryRoute({ perm: 'bakery.order.manage', store: true }, async ({ bakery, store, user, body, params }) => {
  const { store: _store, ...raw } = body
  const input = CancelOrderInput.parse(raw)
  const id = await db.sequelize.transaction(async (t) => {
    const row = await loadOrder(bakery, store, params.id, t, true)
    if (row.processStatus === 'CANCELLED' || (await appliedWithKey(row, input.idempotencyKey, t))) return row.id
    await cancelInTransaction({ bakery, row, user, reason: input.reason, idempotencyKey: input.idempotencyKey, t })
    return row.id
  })
  return publicOrder(id)
})

exports.addPayment = bakeryRoute({ perm: ['bakery.order.manage', 'pos.sell'], store: true }, async ({ bakery, store, user, body, params }) => {
  const { store: _store, ...raw } = body
  const input = AddPaymentInput.parse(raw)
  const done = await db.sequelize.transaction(async (t) => {
    const row = await loadOrder(bakery, store, params.id, t, true)
    if (row.processStatus === 'CANCELLED') {
      const replay = await db.transaction.findOne({ where: { order: row.orderId, idempotencyKey: input.idempotencyKey }, attributes: ['id'], transaction: t })
      if (!replay) throw invalidTransition('CANCELLED', 'CANCELLED', 'Pesanan sudah dibatalkan')
      return { id: row.id, accountingJobs: null }
    }
    const result = await orderController.collectOrderPaymentInTransaction(
      row.orderId,
      store.id,
      {
        paymentMethod: input.method,
        amount: input.amount,
        cashAmount: input.method === 'cash' ? input.amount : undefined,
        changeAmount: input.method === 'cash' ? 0 : undefined,
        referenceNumber: input.method === 'cash' ? null : input.note || null,
        idempotencyKey: input.idempotencyKey
      },
      user,
      t
    )
    await row.update({ modifiedBy: user.id }, { transaction: t })
    return { id: row.id, accountingJobs: result.accountingJobs || null }
  })
  if (done.accountingJobs) {
    await orderController.attemptOrderAccountingEntries(done.accountingJobs).catch((err) => console.error('[bakery] journal deferred', err?.message))
  }
  return publicOrder(done.id)
})

// ---------- WhatsApp text ----------

const rupiah = (n) => `Rp${Number(n || 0).toLocaleString('id-ID')}`
const waPhone = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '')
  if (!digits) return null
  return digits.startsWith('0') ? `62${digits.slice(1)}` : digits
}

exports.waText = bakeryRoute({ perm: 'bakery.order.read', store: true }, async ({ bakery, store, query, params }) => {
  const { template } = WaTextQuery.parse({ template: query.template || undefined })
  const order = (await serializeOrders([await loadOrder(bakery, store, params.id)]))[0]
  const settings = tenantSettings(bakery.tenant)
  const source = { note: settings.waNoteTemplate, ready: settings.waReadyTemplate, reminder: settings.waReminderTemplate }[template]
  const schedule = new Intl.DateTimeFormat('id-ID', {
    timeZone: tzOf(store),
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(order.scheduledAt))
  const vars = {
    customer: order.customerName,
    orderNo: order.orderNo,
    total: rupiah(order.total),
    dp: rupiah(order.paidAmount),
    remaining: rupiah(order.remainingAmount),
    schedule
  }
  const text = String(source).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '')
  const phone = waPhone(order.customerPhone)
  return { template, text, phone, waUrl: phone ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}` : null }
})

// ---------- calendar / production / dashboard ----------

exports.calendar = bakeryRoute({ perm: 'bakery.order.read', store: true }, async ({ bakery, store, query }) => {
  const { from, to } = DateRange.parse({ from: query.from, to: query.to })
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 62) {
    throw new BakeryError('VALIDATION_FAILED', 'Rentang tanggal maksimal 62 hari', 400, { field: 'to' })
  }
  const rows = await db.bakery_order.findAll({
    where: { tenantId: bakery.tenant.id, store: store.id, scheduledAt: { [Op.gte]: dayStart(store, from), [Op.lt]: dayStart(store, addDays(to, 1)) } },
    order: [['scheduledAt', 'ASC'], ['id', 'ASC']]
  })
  const orders = await serializeOrders(rows)
  return {
    data: orders.map((o) => ({
      id: o.id,
      orderNo: o.orderNo,
      customerName: o.customerName,
      fulfillmentType: o.fulfillmentType,
      scheduledAt: o.scheduledAt,
      processStatus: o.processStatus,
      paymentStatus: o.paymentStatus,
      total: o.total,
      remainingAmount: o.remainingAmount,
      itemCount: Math.round(o.items.reduce((s, i) => s + i.qty, 0))
    }))
  }
})

const round3 = (n) => Math.round(n * 1000) / 1000

exports.productionPlan = bakeryRoute({ perm: 'bakery.production.read', store: true }, async ({ bakery, store, query }) => {
  const { date = today(store) } = DateQuery.parse({ date: query.date || undefined })
  const rows = await db.bakery_order.findAll({
    where: {
      tenantId: bakery.tenant.id,
      store: store.id,
      processStatus: { [Op.ne]: 'CANCELLED' },
      scheduledAt: { [Op.gte]: dayStart(store, date), [Op.lt]: dayStart(store, addDays(date, 1)) }
    },
    attributes: ['id', 'orderId']
  })
  const items = rows.length ? await db.order_item.findAll({ where: { order: rows.map((r) => r.orderId) }, order: [['id', 'ASC']] }) : []
  const products = items.length
    ? await db.product.findAll({ where: { id: [...new Set(items.map((i) => i.product))] }, attributes: ['id', 'unit', 'nameProduct'], paranoid: false })
    : []
  const recipes = await recipesFor(store, products.map((p) => p.id))
  const byProduct = new Map()
  for (const item of items) {
    const key = Number(item.product)
    const entry = byProduct.get(key) || { qty: 0, orders: new Set(), name: item.productName }
    entry.qty += Number(item.quantity) || 0
    entry.orders.add(item.order)
    byProduct.set(key, entry)
  }
  const plan = [...byProduct.entries()].map(([productId, entry]) => {
    const product = products.find((p) => p.id === productId)
    const recipe = recipes.get(productId)
    // BOM quantities are per batch of totalQty portions (itemCostService
    // recipeYield): material = line qty × ordered / yield.
    const yieldQty = Number.isInteger(Number(recipe?.totalQty)) && Number(recipe?.totalQty) > 1 ? Number(recipe.totalQty) : 1
    return {
      productId: String(productId),
      productName: entry.name || product?.nameProduct || '',
      unit: product?.unit || 'pcs',
      orderedQty: round3(entry.qty),
      orderCount: entry.orders.size,
      hasRecipe: Boolean(recipe),
      materials: (recipe?.lines || []).map((l) => ({
        ingredientId: l.ingredientId == null ? null : String(l.ingredientId),
        name: l.ingredientData?.name || '',
        qty: round3((Number(l.qty) || 0) * entry.qty / yieldQty),
        unit: l.unit || l.ingredientData?.unit || ''
      }))
    }
  })
  plan.sort((a, b) => a.productName.localeCompare(b.productName))
  return { date, storeId: String(store.id), items: plan, generatedAt: new Date().toISOString() }
})

exports.dashboard = bakeryRoute({ perm: 'bakery.order.read', store: true }, async ({ bakery, store, query }) => {
  const { date = today(store) } = DateQuery.parse({ date: query.date || undefined })
  const start = dayStart(store, date)
  const end = dayStart(store, addDays(date, 1))
  const [row] = await db.sequelize.query(
    `SELECT
        COUNT(*) FILTER (WHERE b."scheduledAt" >= :start AND b."scheduledAt" < :end)::int AS "totalOrders",
        COUNT(*) FILTER (WHERE b."scheduledAt" >= :start AND b."scheduledAt" < :end AND b."processStatus" <> 'CANCELLED')::int AS "dueToday",
        COUNT(*) FILTER (WHERE b."scheduledAt" < :start AND b."processStatus" NOT IN ('CANCELLED','PICKED_UP','DELIVERED'))::int AS overdue,
        COUNT(*) FILTER (WHERE b."processStatus" <> 'CANCELLED' AND o."paymentStatus" IS DISTINCT FROM 'paid')::int AS "unpaidOrDp",
        COUNT(*) FILTER (WHERE b."processStatus" = 'READY')::int AS "readyCount"
       FROM bakery_order b JOIN "order" o ON o.id = b."orderId"
      WHERE b."tenantId" = :tenant AND b.store = :store`,
    { replacements: { start, end, tenant: bakery.tenant.id, store: store.id }, type: db.sequelize.QueryTypes.SELECT }
  )
  return { date, ...row }
})
