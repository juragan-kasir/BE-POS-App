'use strict'

const crypto = require('crypto')
const db = require('../../db/models')
const { resolveCounterStore, createOrderItems, sessionCashier, generateOrderNumber, validateCashTender } = require('./order')
const { normalizePaymentMethod, requireTenderReference } = require('../service/canonicalPayment')
const { resolvePaymentMethodName } = require('../service/paymentTypeName')
const { resolveAttributedRegister } = require('../service/settlementAttribution')
const { assertSettlementReferenceUnused } = require('../service/settlementReference')
const { assertFullyPaidForFulfillment } = require('../service/bakeryFulfillment')
// orderFinancials available for future refund/settlement parity; MVP uses simple paid/remaining math.
const { withDeadlockRetry } = require('../../utils/deadlockRetry')

const BakeryOrder = db.bakery_order
const BakeryStatusHistory = db.bakery_status_history
const Order = db.order
const OrderItem = db.order_item
const Product = db.product
const Location = db.location
const Member = db.member

const refuse = (status, code, message) => {
  const err = new Error(message)
  err.statusCode = status
  err.code = code
  throw err
}

const ensureBakeryStore = async (storeId, transaction) => {
  const location = await Location.findByPk(storeId, { transaction })
  if (!location) refuse(404, 'STORE_NOT_FOUND', 'Store not found')
  if (location.businessType !== 'bakery') refuse(400, 'NOT_BAKERY_STORE', 'Store is not a bakery outlet')
  return location
}

const NEXT = {
  PENDING_CONFIRMATION: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['IN_PRODUCTION', 'CANCELLED'],
  IN_PRODUCTION: ['READY', 'CANCELLED'],
  READY: ['PICKED_UP', 'DELIVERED', 'CANCELLED'],
  PICKED_UP: [],
  DELIVERED: [],
  CANCELLED: []
}

const assertTransition = (from, to) => {
  if (!(NEXT[from] || []).includes(to)) refuse(409, 'INVALID_BAKERY_STATUS_TRANSITION', `Cannot transition ${from} -> ${to}`)
}

const writeHistory = (bakeryOrderId, fromStatus, toStatus, actorId, reason, t) =>
  BakeryStatusHistory.create({ bakeryOrderId, fromStatus, toStatus, actorId, reason: reason || null }, { transaction: t })

const getFullBakeryOrder = async (id, store) => {
  const order = await Order.findOne({
    where: { id, ...(store ? { store } : {}) },
    include: [
      { model: OrderItem, as: 'items' },
      {
        model: BakeryOrder,
        as: 'bakeryOrder',
        include: [
          {
            model: BakeryStatusHistory,
            as: 'history',
            separate: true,
            order: [['createdAt', 'ASC']],
            ...(db.user ? { include: [{ model: db.user, as: 'actorData', attributes: ['id', 'fullName'] }] } : {})
          }
        ]
      },
      { model: db.transaction, as: 'transactions' }
    ]
  })
  return order
}

const formatOrder = (order) => {
  const o = order.toJSON ? order.toJSON() : order
  const b = o.bakeryOrder || {}
  const methodToFe = (m) => ({ CASH: 'cash', QRIS: 'qris', BANK_TRANSFER: 'transfer', CARD: 'card', E_WALLET: 'other', POINTS: 'other', OTHER: 'other' }[String(m || '').toUpperCase()] || 'other')
  const payments = (o.transactions || []).filter((t) => Number(t.amount || 0) > 0).map((t) => ({
    id: String(t.id),
    amount: Number(t.amount || 0),
    method: methodToFe(t.typePayment),
    note: t.notes || null,
    paidAt: t.createdAt,
    idempotencyKey: t.idempotencyKey || null
  }))
  const paidAmount = payments.reduce((s, p) => s + p.amount, 0)
  const total = Number(o.totalPrice || 0)
  const remainingAmount = Math.max(0, total - paidAmount)
  const paymentStatus = paidAmount <= 0 ? 'unpaid' : remainingAmount <= 0 ? 'paid' : 'partial'
  return {
    id: String(o.id),
    orderNo: o.orderNumber,
    storeId: String(o.store),
    member: o.customerId ? { id: String(o.customerId), name: o.customerName || '', phone: o.customerPhone || null, email: null } : null,
    customerName: o.customerName || '',
    customerPhone: o.customerPhone || null,
    fulfillmentType: b.fulfillmentType || 'pickup',
    scheduledAt: b.scheduledAt,
    deliveryAddress: b.deliveryAddress || null,
    deliveryNote: b.deliveryNote || null,
    customerNote: b.customerNote || null,
    adminNote: b.adminNote || null,
    processStatus: b.processStatus,
    paymentStatus,
    items: (o.items || []).map((it) => ({
      productId: String(it.product),
      productName: it.productName,
      qty: Number(it.quantity || 0),
      unit: it.serviceSnapshot?.unit || 'pcs',
      price: Number(it.price || 0),
      subtotal: Number(it.subtotal || 0),
      note: it.notes || null
    })),
    subtotal: Number(o.subTotal || 0),
    discount: Number(o.discountAmount || 0),
    tax: Number(o.taxAmount || 0),
    total,
    paidAmount,
    remainingAmount,
    payments,
    history: (b.history || []).map((h) => ({
      id: String(h.id),
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      actorName: h.actorData?.fullName || null,
      reason: h.reason || null,
      createdAt: h.createdAt
    })),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt
  }
}

const quoteItems = async (items) => {
  const ids = [...new Set(items.map((i) => Number(i.productId || i.product)).filter(Boolean))]
  const products = await Product.findAll({ where: { id: ids } })
  const byId = new Map(products.map((p) => [p.id, p]))
  const lines = []
  let subtotal = 0
  for (const item of items) {
    const id = Number(item.productId || item.product)
    const product = byId.get(id)
    if (!product) refuse(400, 'PRODUCT_NOT_FOUND', `Product not found: ${id}`)
    const qty = Number(item.quantity ?? item.qty ?? 0)
    if (!(qty > 0)) refuse(400, 'INVALID_QTY', 'Quantity must be > 0')
    const price = Number(product.price || 0)
    if (item.expectedPrice !== undefined && Number(item.expectedPrice) !== price) {
      refuse(409, 'PRICE_CHANGED', 'Price changed')
    }
    const lineSubtotal = Math.round(price * qty)
    subtotal += lineSubtotal
    lines.push({
      product,
      productId: product.id,
      productName: product.nameProduct,
      qty,
      price,
      subtotal: lineSubtotal,
      notes: item.note || item.notes || '',
      unit: product.unit || 'pcs'
    })
  }
  return { lines, subtotal }
}

exports.createOrder = async (req, res) => {
  try {
    const scope = resolveCounterStore(req)
    if (!scope.store) return res.status(scope.status).json(scope.body)
    await ensureBakeryStore(scope.store)
    const body = req.body
    if (!body.idempotencyKey) refuse(422, 'IDEMPOTENCY_KEY_REQUIRED', 'idempotencyKey is required')

    const existing = await Order.findOne({ where: { store: scope.store, idempotencyKey: body.idempotencyKey } })
    if (existing) {
      const data = await getFullBakeryOrder(existing.id, scope.store)
      return res.status(200).json(formatOrder(data))
    }

    const { lines, subtotal } = await quoteItems(body.items || [])
    const total = subtotal
    if (body.expectedTotal !== undefined && Number(body.expectedTotal) !== total) refuse(409, 'PRICE_CHANGED', 'Total berubah')
    const dpAmount = Math.max(0, Number(body.dpAmount || 0))
    if (dpAmount > total) refuse(422, 'OVERPAYMENT', 'DP exceeds total')

    const customerId = body.customerId || body.memberId || null
    const customer = customerId ? await Member.findByPk(customerId) : null
    const outlet = await Location.findByPk(scope.store)
    const scheduledAt = new Date(body.scheduledAt)
    if (Number.isNaN(scheduledAt.getTime())) refuse(400, 'VALIDATION_FAILED', 'scheduledAt invalid')

    const order = await withDeadlockRetry(() => db.sequelize.transaction(async (t) => {
      const created = await Order.create({
        orderNumber: generateOrderNumber(),
        store: scope.store,
        customerId,
        customerName: body.customerName || customer?.name || null,
        customerPhone: body.customerPhone || customer?.phoneNumber || null,
        ...sessionCashier(req, {}),
        status: dpAmount >= total && total > 0 ? 'paid' : 'pending',
        paymentStatus: dpAmount >= total && total > 0 ? 'paid' : dpAmount > 0 ? 'partially_paid' : 'unpaid',
        subTotal: subtotal,
        totalQuantity: lines.reduce((s, l) => s + l.qty, 0),
        discountType: 'none',
        discountValue: 0,
        discountAmount: 0,
        taxRate: 0,
        taxAmount: 0,
        serviceChargeRate: 0,
        serviceChargeAmount: 0,
        totalPrice: total,
        source: 'pos',
        idempotencyKey: body.idempotencyKey,
        publicToken: crypto.randomBytes(24).toString('hex'),
        notes: body.customerNote || '',
        createdBy: req.user?.id
      }, { transaction: t })

      const itemPayload = lines.map((l) => ({
        product: l.productId,
        productId: l.productId,
        productName: l.productName,
        quantity: l.qty,
        price: l.price,
        subtotal: l.subtotal,
        notes: l.notes,
        options: [],
        modifiers: []
      }))
      const bundleMap = {}
      const productById = new Map(lines.map((l) => [l.product.id, l.product]))
      await createOrderItems(created, itemPayload, bundleMap, productById, 'none', 0, t)

      const bakery = await BakeryOrder.create({
        orderId: created.id,
        store: scope.store,
        tenantId: outlet?.tenantId ?? null,
        processStatus: 'PENDING_CONFIRMATION',
        fulfillmentType: body.fulfillmentType || 'pickup',
        scheduledAt,
        customerNote: body.customerNote || null,
        adminNote: body.adminNote || null,
        deliveryAddress: body.deliveryAddress || null,
        deliveryNote: body.deliveryNote || null,
        createdBy: req.user?.id
      }, { transaction: t })
      await writeHistory(bakery.id, null, 'PENDING_CONFIRMATION', req.user?.id, null, t)

      if (dpAmount > 0) {
        const method = normalizePaymentMethod(body.dpMethod || 'cash')
        if (!method) refuse(422, 'PAYMENT_METHOD_REQUIRED', 'dpMethod is required')
        const tender = validateCashTender({ paymentMethod: method, cashAmount: body.cashAmount, changeAmount: body.changeAmount, amountDue: dpAmount })
        const reference = requireTenderReference(method, body.referenceNumber)
        const register = await resolveAttributedRegister(scope.store, t)
        await assertSettlementReferenceUnused({ store: scope.store, method, reference, transaction: t })
        const paymentMethodName = await resolvePaymentMethodName({ method, store: scope.store, transaction: t })
        await db.transaction.create({
          order: created.id,
          typePayment: method,
          amount: dpAmount,
          cashReceived: tender.cashReceived ?? null,
          changeGiven: tender.changeGiven ?? 0,
          createdBy: req.user?.id,
          cashRegisterId: register.id,
          referenceNumber: reference,
          paymentMethodName,
          idempotencyKey: `${body.idempotencyKey}:dp`,
          notes: body.dpNote || 'DP',
          status: 'completed'
        }, { transaction: t })
        created.cashRegisterId = register.id
        created.paymentMethod = method
        created.paymentMethodName = paymentMethodName
        await created.save({ transaction: t })
      }
      return created
    }))

    const data = await getFullBakeryOrder(order.id, scope.store)
    return res.status(201).json(formatOrder(data))
  } catch (e) {
    return res.status(e.statusCode || 500).json({ success: false, message: e.message, code: e.code })
  }
}

exports.listOrders = async (req, res) => {
  try {
    const scope = resolveCounterStore(req)
    if (!scope.store) return res.status(scope.status).json(scope.body)
    await ensureBakeryStore(scope.store)
    const { status, q, from, to, page = 1, limit = 50 } = req.query
    const { Op } = require('sequelize')
    const where = { store: scope.store }
    const bakeryWhere = {}
    if (status) bakeryWhere.processStatus = status
    if (from || to) {
      bakeryWhere.scheduledAt = {}
      if (from) bakeryWhere.scheduledAt[Op.gte] = new Date(`${from}T00:00:00.000Z`)
      if (to) bakeryWhere.scheduledAt[Op.lte] = new Date(`${to}T23:59:59.999Z`)
    }
    if (q) {
      where[Op.or] = [
        { orderNumber: { [Op.iLike]: `%${q}%` } },
        { customerName: { [Op.iLike]: `%${q}%` } },
        { customerPhone: { [Op.iLike]: `%${q}%` } }
      ]
    }
    const rows = await Order.findAndCountAll({
      where,
      include: [
        { model: OrderItem, as: 'items' },
        { model: BakeryOrder, as: 'bakeryOrder', required: true, where: bakeryWhere, include: [{ model: BakeryStatusHistory, as: 'history', separate: true, order: [['createdAt', 'ASC']] }] },
        { model: db.transaction, as: 'transactions' }
      ],
      distinct: true,
      order: [[{ model: BakeryOrder, as: 'bakeryOrder' }, 'scheduledAt', 'ASC']],
      limit: parseInt(limit),
      offset: (parseInt(page) - 1) * parseInt(limit)
    })
    return res.json({ data: rows.rows.map(formatOrder) })
  } catch (e) {
    return res.status(e.statusCode || 500).json({ success: false, message: e.message, code: e.code })
  }
}

exports.getOrder = async (req, res) => {
  try {
    const scope = resolveCounterStore(req)
    if (!scope.store) return res.status(scope.status).json(scope.body)
    const data = await getFullBakeryOrder(req.params.id, scope.store)
    if (!data || !data.bakeryOrder) return res.status(404).json({ success: false, message: 'Not found', code: 'NOT_FOUND' })
    return res.json(formatOrder(data))
  } catch (e) {
    return res.status(e.statusCode || 500).json({ success: false, message: e.message, code: e.code })
  }
}

exports.updateStatus = async (req, res) => {
  try {
    const scope = resolveCounterStore(req)
    if (!scope.store) return res.status(scope.status).json(scope.body)
    const body = req.body
    const data = await getFullBakeryOrder(req.params.id, scope.store)
    if (!data || !data.bakeryOrder) return res.status(404).json({ success: false, message: 'Not found', code: 'NOT_FOUND' })
    const bakery = data.bakeryOrder
    if (body.idempotencyKey) {
      const existing = await BakeryStatusHistory.findOne({ where: { bakeryOrderId: bakery.id, reason: `idem:${body.idempotencyKey}` } })
      if (existing) return res.json(formatOrder(data))
    }
    const toStatus = body.toStatus || body.status
    const fromStatus = bakery.processStatus
    assertTransition(fromStatus, toStatus)
    const paid = (data.transactions || []).filter((tx) => Number(tx.amount) > 0).reduce((s, tx) => s + Number(tx.amount || 0), 0)
    assertFullyPaidForFulfillment(toStatus, paid, Number(data.totalPrice || 0))
    const now = new Date()
    const patch = { processStatus: toStatus }
    if (toStatus === 'READY') patch.readyAt = now
    if (toStatus === 'PICKED_UP') patch.pickedUpAt = now
    if (toStatus === 'DELIVERED') patch.deliveredAt = now
    if (toStatus === 'CANCELLED') { patch.cancelledAt = now; patch.cancelledReason = body.reason || null }
    await bakery.update(patch)
    await BakeryStatusHistory.create({
      bakeryOrderId: bakery.id,
      fromStatus,
      toStatus,
      actorId: req.user?.id || null,
      reason: body.idempotencyKey ? `idem:${body.idempotencyKey} ${body.reason || ''}`.trim() : (body.reason || null)
    })
    const updated = await getFullBakeryOrder(req.params.id, scope.store)
    return res.json(formatOrder(updated))
  } catch (e) {
    return res.status(e.statusCode || 500).json({ success: false, message: e.message, code: e.code })
  }
}

exports.addPayment = async (req, res) => {
  try {
    const scope = resolveCounterStore(req)
    if (!scope.store) return res.status(scope.status).json(scope.body)
    const body = req.body
    const data = await getFullBakeryOrder(req.params.id, scope.store)
    if (!data || !data.bakeryOrder) return res.status(404).json({ success: false, message: 'Not found', code: 'NOT_FOUND' })
    const existingTx = await db.transaction.findOne({ where: { order: data.id, idempotencyKey: body.idempotencyKey } })
    if (existingTx) return res.json(formatOrder(await getFullBakeryOrder(req.params.id, scope.store)))
    const paid = (data.transactions || []).filter((tx) => Number(tx.amount) > 0).reduce((s, tx) => s + Number(tx.amount || 0), 0)
    const outstanding = Math.max(0, Number(data.totalPrice || 0) - paid)
    const amount = Math.min(Number(body.amount || 0), outstanding)
    if (amount <= 0) refuse(422, 'NO_OUTSTANDING', 'No outstanding amount')
    const method = normalizePaymentMethod(body.method)
    if (!method) refuse(422, 'PAYMENT_METHOD_REQUIRED', 'method is required')
    await withDeadlockRetry(() => db.sequelize.transaction(async (t) => {
      const tender = validateCashTender({ paymentMethod: method, cashAmount: body.cashAmount, changeAmount: body.changeAmount, amountDue: amount })
      const reference = requireTenderReference(method, body.referenceNumber)
      const register = await resolveAttributedRegister(scope.store, t)
      await assertSettlementReferenceUnused({ store: scope.store, method, reference, transaction: t })
      const paymentMethodName = await resolvePaymentMethodName({ method, store: scope.store, transaction: t })
      await db.transaction.create({
        order: data.id,
        typePayment: method,
        amount,
        cashReceived: tender.cashReceived ?? null,
        changeGiven: tender.changeGiven ?? 0,
        createdBy: req.user?.id,
        cashRegisterId: register.id,
        referenceNumber: reference,
        paymentMethodName,
        idempotencyKey: body.idempotencyKey,
        notes: body.note || 'Pelunasan'
      }, { transaction: t })
      const newPaid = paid + amount
      const newState = newPaid >= Number(data.totalPrice || 0) ? 'paid' : 'partially_paid'
      await Order.update({ paymentStatus: newState, cashRegisterId: register.id, paymentMethod: method, paymentMethodName }, { where: { id: data.id }, transaction: t })
    }))
    return res.json(formatOrder(await getFullBakeryOrder(req.params.id, scope.store)))
  } catch (e) {
    return res.status(e.statusCode || 500).json({ success: false, message: e.message, code: e.code })
  }
}

exports.cancelOrder = async (req, res) => {
  try {
    const scope = resolveCounterStore(req)
    if (!scope.store) return res.status(scope.status).json(scope.body)
    const body = req.body
    const data = await getFullBakeryOrder(req.params.id, scope.store)
    if (!data || !data.bakeryOrder) return res.status(404).json({ success: false, message: 'Not found', code: 'NOT_FOUND' })
    const bakery = data.bakeryOrder
    if (bakery.processStatus === 'CANCELLED') return res.json(formatOrder(data))
    const fromStatus = bakery.processStatus
    assertTransition(fromStatus, 'CANCELLED')
    const now = new Date()
    await bakery.update({ processStatus: 'CANCELLED', cancelledAt: now, cancelledReason: body.reason || null })
    await writeHistory(bakery.id, fromStatus, 'CANCELLED', req.user?.id, body.reason || null, null)
    return res.json(formatOrder(await getFullBakeryOrder(req.params.id, scope.store)))
  } catch (e) {
    return res.status(e.statusCode || 500).json({ success: false, message: e.message, code: e.code })
  }
}

exports.waText = async (req, res) => {
  try {
    const scope = resolveCounterStore(req)
    if (!scope.store) return res.status(scope.status).json(scope.body)
    const data = await getFullBakeryOrder(req.params.id, scope.store)
    if (!data || !data.bakeryOrder) return res.status(404).json({ success: false, message: 'Not found', code: 'NOT_FOUND' })
    const o = formatOrder(data)
    const template = ['note', 'ready', 'reminder'].includes(req.query.template) ? req.query.template : 'note'
    const schedule = new Date(o.scheduledAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
    const map = {
      note: `Halo ${o.customerName}, pesanan ${o.orderNo} total Rp ${o.total.toLocaleString('id-ID')}, DP Rp ${o.paidAmount.toLocaleString('id-ID')}, sisa Rp ${o.remainingAmount.toLocaleString('id-ID')}. Jadwal ${schedule}.`,
      ready: `Halo ${o.customerName}, pesanan ${o.orderNo} sudah siap.`,
      reminder: `Halo ${o.customerName}, mengingatkan pesanan ${o.orderNo} dijadwalkan ${schedule}.`
    }
    const text = map[template]
    const phone = o.customerPhone ? o.customerPhone.replace(/\D/g, '').replace(/^0/, '62') : null
    return res.json({ template, text, phone, waUrl: phone ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}` : null })
  } catch (e) {
    return res.status(e.statusCode || 500).json({ success: false, message: e.message, code: e.code })
  }
}

exports.calendar = async (req, res) => {
  try {
    const scope = resolveCounterStore(req)
    if (!scope.store) return res.status(scope.status).json(scope.body)
    await ensureBakeryStore(scope.store)
    const { from, to } = req.query
    const { Op } = require('sequelize')
    const bakeryWhere = {}
    if (from || to) {
      bakeryWhere.scheduledAt = {}
      if (from) bakeryWhere.scheduledAt[Op.gte] = new Date(`${from}T00:00:00.000Z`)
      if (to) bakeryWhere.scheduledAt[Op.lte] = new Date(`${to}T23:59:59.999Z`)
    }
    const rows = await Order.findAll({
      where: { store: scope.store },
      include: [
        { model: OrderItem, as: 'items' },
        { model: BakeryOrder, as: 'bakeryOrder', required: true, where: bakeryWhere },
        { model: db.transaction, as: 'transactions' }
      ],
      order: [[{ model: BakeryOrder, as: 'bakeryOrder' }, 'scheduledAt', 'ASC']]
    })
    const data = rows.map(formatOrder).map((o) => ({
      id: o.id,
      orderNo: o.orderNo,
      customerName: o.customerName,
      fulfillmentType: o.fulfillmentType,
      scheduledAt: o.scheduledAt,
      processStatus: o.processStatus,
      paymentStatus: o.paymentStatus,
      total: o.total,
      remainingAmount: o.remainingAmount,
      itemCount: o.items.reduce((a, b) => a + Number(b.qty || 0), 0)
    }))
    return res.json({ data })
  } catch (e) {
    return res.status(e.statusCode || 500).json({ success: false, message: e.message, code: e.code })
  }
}

exports.dashboard = async (req, res) => {
  try {
    const scope = resolveCounterStore(req)
    if (!scope.store) return res.status(scope.status).json(scope.body)
    await ensureBakeryStore(scope.store)
    const date = req.query.date || new Date().toISOString().slice(0, 10)
    const rows = await Order.findAll({
      where: { store: scope.store },
      include: [
        { model: BakeryOrder, as: 'bakeryOrder', required: true },
        { model: db.transaction, as: 'transactions' }
      ]
    })
    const orders = rows.map(formatOrder)
    const dueToday = orders.filter((o) => o.processStatus !== 'CANCELLED' && String(o.scheduledAt).slice(0, 10) === date).length
    const overdue = orders.filter((o) => !['CANCELLED', 'PICKED_UP', 'DELIVERED'].includes(o.processStatus) && String(o.scheduledAt).slice(0, 10) < date).length
    const unpaidOrDp = orders.filter((o) => o.processStatus !== 'CANCELLED' && o.paymentStatus !== 'paid').length
    const readyCount = orders.filter((o) => o.processStatus === 'READY').length
    return res.json({ date, totalOrders: orders.length, dueToday, overdue, unpaidOrDp, readyCount })
  } catch (e) {
    return res.status(e.statusCode || 500).json({ success: false, message: e.message, code: e.code })
  }
}

exports.productionPlan = async (req, res) => {
  try {
    const scope = resolveCounterStore(req)
    if (!scope.store) return res.status(scope.status).json(scope.body)
    await ensureBakeryStore(scope.store)
    const date = req.query.date || new Date().toISOString().slice(0, 10)
    const { Op } = require('sequelize')
    const rows = await Order.findAll({
      where: { store: scope.store },
      include: [
        { model: OrderItem, as: 'items' },
        {
          model: BakeryOrder,
          as: 'bakeryOrder',
          required: true,
          where: {
            scheduledAt: { [Op.gte]: new Date(`${date}T00:00:00.000Z`), [Op.lte]: new Date(`${date}T23:59:59.999Z`) },
            processStatus: { [Op.ne]: 'CANCELLED' }
          }
        }
      ]
    })
    const map = new Map()
    for (const order of rows) {
      for (const it of order.items || []) {
        const key = String(it.product)
        const existing = map.get(key)
        const qty = Number(it.quantity || 0)
        if (existing) { existing.orderedQty += qty; existing.orderCount += 1 }
        else map.set(key, { productId: key, productName: it.productName, unit: 'pcs', orderedQty: qty, orderCount: 1, hasRecipe: false, materials: [] })
      }
    }
    const ids = [...map.keys()].map(Number).filter(Boolean)
    if (ids.length && db.bom_header) {
      const headers = await db.bom_header.findAll({
        where: { productId: ids, status: 'active' },
        include: db.bom_line ? [{ model: db.bom_line, as: 'lines', include: db.ingredient ? [{ model: db.ingredient, as: 'ingredientData', attributes: ['id', 'name', 'unit'] }] : [] }] : []
      }).catch(() => [])
      for (const h of headers) {
        const item = map.get(String(h.productId))
        if (!item) continue
        item.hasRecipe = true
        const lines = h.lines || []
        item.materials = lines.map((ln) => ({
          ingredientId: ln.ingredientId ? String(ln.ingredientId) : null,
          name: ln.ingredientData?.name || 'Bahan',
          qty: Number(ln.qty || 0) * item.orderedQty,
          unit: ln.unit || ln.ingredientData?.unit || ''
        }))
      }
    }
    return res.json({ date, storeId: String(scope.store), items: [...map.values()], generatedAt: new Date().toISOString() })
  } catch (e) {
    return res.status(e.statusCode || 500).json({ success: false, message: e.message, code: e.code })
  }
}

const defaultBakerySettings = () => ({
  businessType: 'bakery',
  leadTimeMinutes: 60,
  pickupOpen: '08:00',
  pickupClose: '17:00',
  deliveryEnabled: false,
  waNoteTemplate: 'Halo {customer}, pesanan {orderNo} total {total}, DP {dp}, sisa {remaining}. Ambil {schedule}.',
  waReadyTemplate: 'Halo {customer}, pesanan {orderNo} sudah siap diambil.',
  waReminderTemplate: 'Halo {customer}, mengingatkan pesanan {orderNo} dijadwalkan {schedule}.'
})

exports.getSettings = async (req, res) => {
  try {
    const scope = resolveCounterStore(req)
    if (!scope.store) return res.status(scope.status).json(scope.body)
    const loc = await ensureBakeryStore(scope.store)
    return res.json({ ...defaultBakerySettings(), ...(loc.bakerySettings || {}), businessType: 'bakery' })
  } catch (e) {
    return res.status(e.statusCode || 500).json({ success: false, message: e.message, code: e.code })
  }
}

exports.updateSettings = async (req, res) => {
  try {
    const scope = resolveCounterStore(req)
    if (!scope.store) return res.status(scope.status).json(scope.body)
    const loc = await ensureBakeryStore(scope.store)
    const next = { ...defaultBakerySettings(), ...(loc.bakerySettings || {}), ...req.body, businessType: 'bakery' }
    await loc.update({ bakerySettings: next })
    return res.json({ id: String(loc.tenantId || loc.id), name: loc.name, settings: next })
  } catch (e) {
    return res.status(e.statusCode || 500).json({ success: false, message: e.message, code: e.code })
  }
}

const fmtStore = (l) => ({ id: String(l.id), name: l.name, timezone: l.timezone || 'Asia/Jakarta', address: l.address || null, phone: l.phoneNumber || null, active: l.status !== 'inactive' })

exports.listStores = async (req, res) => {
  try {
    const where = { businessType: 'bakery' }
    if (req.user?.roleType !== 'super_admin' && req.user?.store) where.id = req.user.store
    if (req.user?.tenantId) where.tenantId = req.user.tenantId
    const rows = await Location.findAll({ where, order: [['id', 'ASC']] })
    return res.json({ data: rows.map(fmtStore) })
  } catch (e) {
    return res.status(e.statusCode || 500).json({ success: false, message: e.message, code: e.code })
  }
}

exports.createStore = async (req, res) => {
  try {
    const body = req.body
    const loc = await Location.create({
      name: body.name,
      timezone: body.timezone || 'Asia/Jakarta',
      address: body.address || null,
      phoneNumber: body.phone || null,
      status: body.active === false ? 'inactive' : 'active',
      businessType: 'bakery',
      tenantId: req.user?.tenantId ?? null,
      bakerySettings: defaultBakerySettings()
    })
    return res.status(201).json(fmtStore(loc))
  } catch (e) {
    return res.status(e.statusCode || 500).json({ success: false, message: e.message, code: e.code })
  }
}

exports.updateStore = async (req, res) => {
  try {
    const loc = await Location.findByPk(req.params.id)
    if (!loc || loc.businessType !== 'bakery') return res.status(404).json({ success: false, message: 'Not found', code: 'NOT_FOUND' })
    if (req.user?.roleType !== 'super_admin' && String(req.user?.store) !== String(loc.id) && req.user?.tenantId !== loc.tenantId) {
      return res.status(403).json({ success: false, message: 'Forbidden', code: 'FORBIDDEN' })
    }
    const body = req.body
    await loc.update({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      ...(body.address !== undefined ? { address: body.address } : {}),
      ...(body.phone !== undefined ? { phoneNumber: body.phone } : {}),
      ...(body.active !== undefined ? { status: body.active ? 'active' : 'inactive' } : {})
    })
    return res.json(fmtStore(loc))
  } catch (e) {
    return res.status(e.statusCode || 500).json({ success: false, message: e.message, code: e.code })
  }
}

exports.listMembers = async (req, res) => {
  try {
    const scope = resolveCounterStore(req)
    if (!scope.store) return res.status(scope.status).json(scope.body)
    const { Op } = require('sequelize')
    const q = String(req.query.q || '').trim()
    const where = { store: scope.store }
    if (q) where[Op.or] = [{ name: { [Op.iLike]: `%${q}%` } }, { phoneNumber: { [Op.iLike]: `%${q}%` } }]
    const rows = await Member.findAll({ where, order: [['name', 'ASC']], limit: 50 })
    return res.json({ data: rows.map((m) => ({ id: String(m.id), name: m.name, phone: m.phoneNumber || null, email: m.email || null })) })
  } catch (e) {
    return res.status(e.statusCode || 500).json({ success: false, message: e.message, code: e.code })
  }
}

exports.listProducts = async (req, res) => {
  try {
    const scope = resolveCounterStore(req)
    if (!scope.store) return res.status(scope.status).json(scope.body)
    const { Op } = require('sequelize')
    const where = { status: 'active' }
    if (db.product_store) {
      const links = await db.product_store.findAll({ where: { store: scope.store }, attributes: ['product'], raw: true }).catch(() => [])
      const ids = links.map((l) => l.product).filter(Boolean)
      if (ids.length) where.id = { [Op.in]: ids }
      else if (Product.rawAttributes.store) where.store = scope.store
      else where.id = -1
    } else if (Product.rawAttributes.store) {
      where.store = scope.store
    }
    const rows = await Product.findAll({ where, order: [['nameProduct', 'ASC']], limit: 200 })
    const ids = rows.map((p) => p.id)
    let recipeSet = new Set()
    if (ids.length && db.bom_header) {
      const boms = await db.bom_header.findAll({ where: { productId: ids, status: 'active' }, attributes: ['productId'] }).catch(() => [])
      recipeSet = new Set(boms.map((b) => String(b.productId)))
    }
    return res.json({ data: rows.map((p) => ({ id: String(p.id), name: p.nameProduct, price: Number(p.price || 0), unit: p.unit || 'pcs', active: p.isAvailable !== false, hasRecipe: recipeSet.has(String(p.id)) })) })
  } catch (e) {
    return res.status(e.statusCode || 500).json({ success: false, message: e.message, code: e.code })
  }
}
