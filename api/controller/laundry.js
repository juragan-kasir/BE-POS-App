'use strict'

const db = require('../../db/models')
const { resolveCounterStore, loadAndPriceOrderItems, createOrderItems, sessionCashier, generateOrderNumber } = require('./order')
const { normalizeServiceConfig, validateServiceConfig, lineTotal, surchargeFor, addHours, normalizeLaundrySettings } = require('../service/laundryPricing')
const bcrypt = require('bcrypt')
const { normalizePaymentMethod, requireTenderReference } = require('../service/canonicalPayment')
const { resolvePaymentMethodName } = require('../service/paymentTypeName')
const { resolveAttributedRegister } = require('../service/settlementAttribution')
const { validateCashTender } = require('./order')
const { assertSettlementReferenceUnused } = require('../service/settlementReference')
const { computeOrderFinancials, legacyPaymentStatusFor, FINANCIAL_STATES } = require('../service/orderFinancials')
const { withDeadlockRetry } = require('../../utils/deadlockRetry')
const orderController = require('./order')

const LaundryTurnaround = db.laundry_turnaround
const LaundryOrder = db.laundry_order
const LaundryStatusHistory = db.laundry_status_history
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

const ensureLaundryStore = async (storeId, transaction) => {
  const location = await Location.findByPk(storeId, { transaction })
  if (!location) refuse(404, 'STORE_NOT_FOUND', 'Store not found')
  if (location.businessType !== 'laundry') {
    refuse(400, 'NOT_LAUNDRY_STORE', 'Store is not a laundry outlet')
  }
  return location
}

const normalizeBool = (v) => v === true || v === 'true'

const quoteLines = async (items, store) => {
  const ids = [...new Set(items.map((i) => Number(i.product)).filter(Boolean))]
  const products = await Product.findAll({ where: { id: ids } })
  const byId = new Map(products.map((p) => [p.id, p]))
  const lines = []
  let subtotal = 0
  let hppTotal = 0
  let pieceRequired = false
  let requiresIroning = false
  for (const item of items) {
    const product = byId.get(Number(item.product))
    if (!product) refuse(400, 'PRODUCT_NOT_FOUND', `Product not found: ${item.product}`)
    if (product.tipeProduk !== 'laundry_service') {
      refuse(400, 'NOT_LAUNDRY_SERVICE', `Product ${product.nameProduct} is not a laundry service`)
    }
    const config = normalizeServiceConfig(product.serviceConfig)
    const check = validateServiceConfig(config)
    if (!check.ok) refuse(400, 'INVALID_SERVICE_CONFIG', check.message)
    const line = lineTotal({ price: product.price, serviceConfig: config, unit: product.unit, nameProduct: product.nameProduct }, item.quantity)
    const expected = item.expectedPrice
    if (expected !== undefined && Number(expected) !== line.price) {
      const err = new Error('PRICE_CHANGED')
      err.statusCode = 409
      err.code = 'PRICE_CHANGED'
      err.mismatches = [{ productId: product.id, expectedPrice: Number(expected), currentPrice: line.price }]
      throw err
    }
    const snapshot = {
      serviceId: product.id,
      name: product.nameProduct,
      type: config.pricingType,
      unit: product.unit || (config.pricingType === 'kiloan' ? 'kg' : 'pcs'),
      channel: config.channel,
      pricingMode: config.pricingMode,
      actualQty: line.actualQty,
      billQty: line.billQty,
      price: line.price,
      minQty: line.minQty,
      rounding: line.rounding,
      requiresIroning: line.requiresIroning,
      hppUnit: line.hppUnit,
      hppTotal: line.hppTotal,
      hppComponents: line.hppComponents
    }
    lines.push({
      product,
      qty: line.billQty,
      actualQty: line.actualQty,
      price: line.price,
      subtotal: line.subtotal,
      serviceSnapshot: snapshot,
      notes: item.notes || '',
      productName: product.nameProduct,
      productId: product.id
    })
    subtotal += line.subtotal
    hppTotal += line.hppTotal
    if (config.pricingType === 'kiloan') pieceRequired = true
    if (line.requiresIroning) requiresIroning = true
  }
  return { lines, subtotal, hppTotal, pieceRequired, requiresIroning }
}

const resolveTurnaround = async (store, turnaroundId, transaction) => {
  if (!turnaroundId) {
    const def = await LaundryTurnaround.findOne({ where: { store, isDefault: true, status: 'active' }, transaction })
    if (def) return def
    return LaundryTurnaround.findOne({ where: { store, status: 'active' }, order: [['durationHours', 'ASC']], transaction })
  }
  return LaundryTurnaround.findOne({ where: { id: turnaroundId, store }, transaction })
}

const writeHistory = (laundryOrderId, fromStatus, toStatus, actorId, reason, t) =>
  LaundryStatusHistory.create({ laundryOrderId, fromStatus, toStatus, actorId, reason: reason || null }, { transaction: t })

exports.listTurnarounds = async (req, res) => {
  try {
    const scope = resolveCounterStore(req)
    if (!scope.store) return res.status(scope.status).json(scope.body)
    const rows = await LaundryTurnaround.findAll({ where: { store: scope.store }, order: [['isDefault', 'DESC'], ['durationHours', 'ASC']] })
    return res.json({ success: true, data: rows })
  } catch (e) {
    return res.status(e.statusCode || 500).json({ success: false, message: e.message })
  }
}

exports.createTurnaround = async (req, res) => {
  try {
    const scope = resolveCounterStore(req)
    if (!scope.store) return res.status(scope.status).json(scope.body)
    await ensureLaundryStore(scope.store)
    const body = req.body
    const data = await withDeadlockRetry(() => db.sequelize.transaction(async (t) => {
      if (normalizeBool(body.isDefault)) {
        await LaundryTurnaround.update({ isDefault: false }, { where: { store: scope.store }, transaction: t })
      }
      return LaundryTurnaround.create({
        store: scope.store,
        tenantId: null,
        name: body.name,
        durationHours: Number(body.durationHours) || 72,
        surchargeType: body.surchargeType || 'none',
        surchargeValue: Number(body.surchargeValue) || 0,
        isDefault: normalizeBool(body.isDefault),
        status: body.status || 'active',
        createdBy: req.user?.id
      }, { transaction: t })
    }))
    return res.status(201).json({ success: true, data })
  } catch (e) {
    return res.status(e.statusCode || 500).json({ success: false, message: e.message })
  }
}

exports.updateTurnaround = async (req, res) => {
  try {
    const scope = resolveCounterStore(req)
    if (!scope.store) return res.status(scope.status).json(scope.body)
    await ensureLaundryStore(scope.store)
    const row = await LaundryTurnaround.findOne({ where: { id: req.params.id, store: scope.store } })
    if (!row) return res.status(404).json({ success: false, message: 'Turnaround not found' })
    const body = req.body
    await withDeadlockRetry(() => db.sequelize.transaction(async (t) => {
      if (normalizeBool(body.isDefault)) {
        await LaundryTurnaround.update({ isDefault: false }, { where: { store: scope.store }, transaction: t })
      }
      await row.update({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.durationHours !== undefined ? { durationHours: Number(body.durationHours) || 0 } : {}),
        ...(body.surchargeType !== undefined ? { surchargeType: body.surchargeType } : {}),
        ...(body.surchargeValue !== undefined ? { surchargeValue: Number(body.surchargeValue) || 0 } : {}),
        ...(body.isDefault !== undefined ? { isDefault: normalizeBool(body.isDefault) } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        modifiedBy: req.user?.id
      }, { transaction: t })
    }))
    return res.json({ success: true, data: row })
  } catch (e) {
    return res.status(e.statusCode || 500).json({ success: false, message: e.message })
  }
}

exports.deleteTurnaround = async (req, res) => {
  try {
    const scope = resolveCounterStore(req)
    if (!scope.store) return res.status(scope.status).json(scope.body)
    const row = await LaundryTurnaround.findOne({ where: { id: req.params.id, store: scope.store } })
    if (!row) return res.status(404).json({ success: false, message: 'Turnaround not found' })
    await row.destroy()
    return res.json({ success: true })
  } catch (e) {
    return res.status(e.statusCode || 500).json({ success: false, message: e.message })
  }
}

exports.quote = async (req, res) => {
  try {
    const scope = resolveCounterStore(req)
    if (!scope.store) return res.status(scope.status).json(scope.body)
    await ensureLaundryStore(scope.store)
    const { lines, subtotal, hppTotal, pieceRequired } = await quoteLines(req.body.items || [], scope.store)
    const turnaround = req.body.orderType === 'self' ? null : await resolveTurnaround(scope.store, req.body.turnaroundId)
    const surcharge = req.body.orderType === 'self' ? 0 : surchargeFor(subtotal, turnaround)
    const total = subtotal + surcharge
    const dueAt = req.body.orderType === 'self' ? new Date() : addHours(new Date(), turnaround?.durationHours || 72)
    return res.json({ success: true, data: { lines: lines.map(l => l.serviceSnapshot), subtotal, surcharge, total, hppTotal, pieceRequired, dueAt, turnaroundId: turnaround?.id || null } })
  } catch (e) {
    if (e.code === 'PRICE_CHANGED') return res.status(409).json({ success: false, code: e.code, mismatches: e.mismatches })
    return res.status(e.statusCode || 500).json({ success: false, message: e.message, code: e.code })
  }
}

exports.createOrder = async (req, res) => {
  try {
    const scope = resolveCounterStore(req)
    if (!scope.store) return res.status(scope.status).json(scope.body)
    await ensureLaundryStore(scope.store)
    const idempotencyKey = req.body.idempotencyKey
    if (!idempotencyKey) refuse(422, 'IDEMPOTENCY_KEY_REQUIRED', 'idempotencyKey is required')
    const existing = await Order.findOne({ where: { store: scope.store, idempotencyKey } })
    if (existing) {
      const data = await getFullLaundryOrder(existing.id, scope.store)
      return res.status(200).json({ success: true, message: 'Duplicate request', data })
    }
    const body = req.body
    const isSelf = body.orderType === 'self'
    const { lines, subtotal, pieceRequired } = await quoteLines(body.items || [], scope.store)
    if (!isSelf && pieceRequired && !(Number(body.pieceCount) > 0)) {
      refuse(400, 'PIECE_COUNT_REQUIRED', 'pieceCount is required for kiloan orders')
    }
    const turnaround = isSelf ? null : await resolveTurnaround(scope.store, body.turnaroundId)
    const surcharge = isSelf ? 0 : surchargeFor(subtotal, turnaround)
    const total = subtotal + surcharge
    const paymentAmount = Math.max(0, Number(body.paymentAmount) || 0)
    if (isSelf && paymentAmount < total) refuse(422, 'SELF_PAYMENT_REQUIRED', 'Self-service requires full payment')
    if (paymentAmount > total) refuse(422, 'OVERPAYMENT', 'Payment amount exceeds total')
    const receivedAt = new Date()
    const dueAt = isSelf ? receivedAt : addHours(receivedAt, turnaround?.durationHours || 72)
    const customer = body.customerId ? await Member.findByPk(body.customerId) : null

    const order = await withDeadlockRetry(() => db.sequelize.transaction(async (t) => {
      const created = await Order.create({
        orderNumber: generateOrderNumber(),
        store: scope.store,
        customerId: body.customerId || null,
        customerName: body.customerName || customer?.name || (isSelf ? 'Pelanggan Self-Service' : null),
        customerPhone: body.customerPhone || customer?.phoneNumber || null,
        ...sessionCashier(req, {}),
        status: paymentAmount >= total && total >= 0 ? 'paid' : 'pending',
        paymentStatus: paymentAmount >= total && total >= 0 ? 'paid' : paymentAmount > 0 ? 'partially_paid' : 'unpaid',
        subTotal: subtotal,
        totalQuantity: lines.reduce((s, l) => s + Number(l.qty || 0), 0),
        discountType: 'none',
        discountValue: 0,
        discountAmount: 0,
        taxRate: 0,
        taxAmount: 0,
        serviceChargeRate: 0,
        serviceChargeAmount: surcharge,
        totalPrice: total,
        paymentMethod: body.paymentMethod || null,
        source: 'pos',
        idempotencyKey,
        publicToken: require('crypto').randomBytes(24).toString('hex'),
        notes: body.note || '',
        createdBy: req.user?.id
      }, { transaction: t })

      const itemPayload = lines.map(l => ({
        product: l.productId,
        productId: l.productId,
        productName: l.productName,
        quantity: l.qty,
        price: l.price,
        subtotal: l.subtotal,
        notes: l.notes,
        options: [],
        modifiers: [],
        serviceSnapshot: l.serviceSnapshot
      }))
      const bundleMap = {}
      const productById = new Map(lines.map(l => [l.product.id, l.product]))
      await createOrderItems(created, itemPayload, bundleMap, productById, 'none', 0, t)

      const laundry = await LaundryOrder.create({
        orderId: created.id,
        store: scope.store,
        tenantId: null,
        processStatus: isSelf ? 'PICKED_UP' : 'RECEIVED',
        turnaroundId: turnaround?.id || null,
        receivedAt,
        dueAt,
        pieceCount: Number(body.pieceCount) || 0,
        conditionTags: body.conditionTags || [],
        conditionNote: body.conditionNote || '',
        pickedUpAt: isSelf ? receivedAt : null,
        pickedUpBy: isSelf ? req.user?.id || null : null,
        createdBy: req.user?.id
      }, { transaction: t })
      await writeHistory(laundry.id, null, laundry.processStatus, req.user?.id, isSelf ? 'Self-service selesai di kasir' : '', t)

      if (paymentAmount > 0) {
        const method = normalizePaymentMethod(body.paymentMethod)
        if (!method) refuse(422, 'PAYMENT_METHOD_REQUIRED', 'paymentMethod is required')
        const tender = validateCashTender({ paymentMethod: method, cashAmount: body.cashAmount, changeAmount: body.changeAmount, amountDue: paymentAmount })
        const reference = requireTenderReference(method, body.referenceNumber)
        const register = await resolveAttributedRegister(scope.store, t)
        await assertSettlementReferenceUnused({ store: scope.store, method, reference, transaction: t })
        const paymentMethodName = await resolvePaymentMethodName({ method, store: scope.store, transaction: t })
        await db.transaction.create({
          order: created.id,
          typePayment: method,
          amount: paymentAmount,
          cashReceived: tender.cashReceived ?? null,
          changeGiven: tender.changeGiven ?? 0,
          createdBy: req.user?.id,
          cashRegisterId: register.id,
          referenceNumber: reference,
          paymentMethodName,
          idempotencyKey: `${idempotencyKey}:dp`
        }, { transaction: t })
        created.cashRegisterId = register.id
        created.paymentMethod = method
        created.paymentMethodName = paymentMethodName
        await created.save({ transaction: t })
      }
      return created
    }))
    const data = await getFullLaundryOrder(order.id, scope.store)
    return res.status(201).json({ success: true, data })
  } catch (e) {
    if (e.code === 'PRICE_CHANGED') return res.status(409).json({ success: false, code: e.code, mismatches: e.mismatches })
    return res.status(e.statusCode || 500).json({ success: false, message: e.message, code: e.code })
  }
}

const getFullLaundryOrder = async (id, store) => {
  const order = await Order.findOne({
    where: { id, ...(store ? { store } : {}) },
    include: [
      { model: OrderItem, as: 'items' },
      { model: LaundryOrder, as: 'laundryOrder', include: [{ model: LaundryStatusHistory, as: 'history', separate: true, order: [['createdAt', 'ASC']] }, { model: LaundryTurnaround, as: 'turnaround' }] }
    ]
  })
  return order
}

exports.listOrders = async (req, res) => {
  try {
    const scope = resolveCounterStore(req)
    if (!scope.store) return res.status(scope.status).json(scope.body)
    const { processStatus, q, page = 1, limit = 50 } = req.query
    const where = { store: scope.store }
    const laundryWhere = {}
    if (processStatus) laundryWhere.processStatus = processStatus
    if (q) {
      const { Op } = require('sequelize')
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
        { model: LaundryOrder, as: 'laundryOrder', required: true, where: laundryWhere, include: [{ model: LaundryTurnaround, as: 'turnaround' }] }
      ],
      distinct: true,
      order: [['createdAt', 'DESC']],
      limit: parseInt(limit),
      offset: (parseInt(page) - 1) * parseInt(limit)
    })
    return res.json({ success: true, data: rows.rows, pagination: { total: rows.count, page: parseInt(page), limit: parseInt(limit), totalPages: Math.ceil(rows.count / parseInt(limit)) } })
  } catch (e) {
    return res.status(e.statusCode || 500).json({ success: false, message: e.message })
  }
}

exports.getOrder = async (req, res) => {
  try {
    const scope = resolveCounterStore(req)
    if (!scope.store) return res.status(scope.status).json(scope.body)
    const data = await getFullLaundryOrder(req.params.id, scope.store)
    if (!data || !data.laundryOrder) return res.status(404).json({ success: false, message: 'Order not found' })
    return res.json({ success: true, data })
  } catch (e) {
    return res.status(e.statusCode || 500).json({ success: false, message: e.message })
  }
}

const ALLOWED = {
  RECEIVED: ['WASHING', 'CANCELLED'],
  WASHING: ['IRONING', 'READY', 'CANCELLED'],
  IRONING: ['READY', 'CANCELLED'],
  READY: ['PICKED_UP', 'CANCELLED'],
  PICKED_UP: [],
  CANCELLED: []
}

exports.updateStatus = async (req, res) => {
  try {
    const scope = resolveCounterStore(req)
    if (!scope.store) return res.status(scope.status).json(scope.body)
    const { toStatus, reason } = req.body
    const data = await withDeadlockRetry(() => db.sequelize.transaction(async (t) => {
      const order = await Order.findOne({ where: { id: req.params.id, store: scope.store }, transaction: t, lock: t.LOCK.UPDATE })
      if (!order) refuse(404, 'NOT_FOUND', 'Order not found')
      const laundry = await LaundryOrder.findOne({ where: { orderId: order.id, store: scope.store }, transaction: t, lock: t.LOCK.UPDATE })
      if (!laundry) refuse(404, 'NOT_FOUND', 'Order not found')
      const from = laundry.processStatus
      const allowed = ALLOWED[from] || []
      const isAdmin = ['admin', 'super_admin'].includes(req.user?.roleType)
      if (!allowed.includes(toStatus) && !(isAdmin && reason)) {
        refuse(403, 'INVALID_TRANSITION', `Cannot move ${from} to ${toStatus}`)
      }
      const patch = { processStatus: toStatus, modifiedBy: req.user?.id }
      if (toStatus === 'READY') patch.readyAt = new Date()
      if (toStatus === 'CANCELLED') patch.cancelledReason = reason || ''
      if (toStatus === 'PICKED_UP') patch.pickedUpAt = new Date()
      await laundry.update(patch, { transaction: t })
      await writeHistory(laundry.id, from, toStatus, req.user?.id, reason, t)
      return laundry
    }))
    return res.json({ success: true, data })
  } catch (e) {
    return res.status(e.statusCode || 500).json({ success: false, message: e.message, code: e.code })
  }
}

exports.pickup = async (req, res) => {
  try {
    const scope = resolveCounterStore(req)
    if (!scope.store) return res.status(scope.status).json(scope.body)
    const result = await withDeadlockRetry(() => db.sequelize.transaction(async (t) => {
      const order = await Order.findOne({ where: { id: req.params.id, store: scope.store }, transaction: t, lock: t.LOCK.UPDATE })
      if (!order) refuse(404, 'NOT_FOUND', 'Order not found')
      const laundry = await LaundryOrder.findOne({ where: { orderId: order.id, store: scope.store }, transaction: t, lock: t.LOCK.UPDATE })
      if (!laundry) refuse(404, 'NOT_FOUND', 'Order not found')
      const fin = await computeOrderFinancials(order, t)
      const member = order.customerId ? await Member.findByPk(order.customerId, { transaction: t }) : null
      if (fin.O > 0 && !member?.isCredit) refuse(409, 'OUTSTANDING_PAYMENT', 'Outstanding payment must be settled before pickup')
      const from = laundry.processStatus
      await laundry.update({
        processStatus: 'PICKED_UP',
        pickedUpAt: new Date(),
        pickedUpBy: req.user?.id,
        pickupPieceCount: Number(req.body.pickupPieceCount) || 0,
        pickupNote: req.body.pickupNote || '',
        modifiedBy: req.user?.id
      }, { transaction: t })
      await writeHistory(laundry.id, from, 'PICKED_UP', req.user?.id, req.body.pickupNote, t)
      return laundry
    }))
    return res.json({ success: true, data: result })
  } catch (e) {
    return res.status(e.statusCode || 500).json({ success: false, message: e.message, code: e.code })
  }
}

exports.waText = async (req, res) => {
  try {
    const scope = resolveCounterStore(req)
    if (!scope.store) return res.status(scope.status).json(scope.body)
    const order = await getFullLaundryOrder(req.params.id, scope.store)
    if (!order || !order.laundryOrder) return res.status(404).json({ success: false, message: 'Order not found' })
    const store = await Location.findByPk(scope.store)
    const laundry = order.laundryOrder
    const type = req.query.type || 'receipt'
    const phone = String(order.customerPhone || '').replace(/[^0-9]/g, '')
    const waPhone = phone.startsWith('0') ? '62' + phone.slice(1) : phone
    let text = ''
    if (type === 'ready') {
      text = `Halo ${order.customerName || ''}, cucian ${order.orderNumber} sudah siap diambil di ${store?.name || ''}. Sisa pembayaran Rp${(await computeOrderFinancials(order)).O}.`
      if (!laundry.readyNotifiedAt) await laundry.update({ readyNotifiedAt: new Date() })
    } else if (type === 'reminder') {
      text = `Halo ${order.customerName || ''}, cucian ${order.orderNumber} sudah siap sejak ${laundry.readyAt || ''} dan belum diambil.`
      if (!laundry.readyNotifiedAt) await laundry.update({ readyNotifiedAt: new Date() })
    } else {
      text = `Halo ${order.customerName || ''}, cucian Anda sudah kami terima. No. order ${order.orderNumber}, ${laundry.pieceCount || 0} potong, selesai ${laundry.dueAt || ''}. Total Rp${order.totalPrice}. Terima kasih!`
    }
    const waUrl = waPhone ? `https://wa.me/${waPhone}?text=${encodeURIComponent(text)}` : null
    return res.json({ success: true, data: { text, waUrl } })
  } catch (e) {
    return res.status(e.statusCode || 500).json({ success: false, message: e.message })
  }
}

exports.cancelOrder = async (req, res) => {
  try {
    const scope = resolveCounterStore(req)
    if (!scope.store) return res.status(scope.status).json(scope.body)
    const { reason, refundAmount = 0, refundMethod, referenceNumber, approverPin, idempotencyKey } = req.body
    const result = await withDeadlockRetry(() => db.sequelize.transaction(async (t) => {
      const order = await Order.findOne({ where: { id: req.params.id, store: scope.store }, transaction: t, lock: t.LOCK.UPDATE })
      if (!order) refuse(404, 'NOT_FOUND', 'Order not found')
      const laundry = await LaundryOrder.findOne({ where: { orderId: order.id, store: scope.store }, transaction: t, lock: t.LOCK.UPDATE })
      if (!laundry) refuse(404, 'NOT_FOUND', 'Order not found')
      if (laundry.processStatus === 'CANCELLED') {
        return order
      }
      if (!ALLOWED[laundry.processStatus]?.includes('CANCELLED')) {
        refuse(403, 'INVALID_TRANSITION', `Cannot cancel from ${laundry.processStatus}`)
      }

      const fin = await computeOrderFinancials(order, t)
      const paidTotal = Math.max(0, Number(order.totalPrice || 0) - Number(fin.O || 0))
      const refund = Math.min(Math.max(0, Number(refundAmount) || 0), paidTotal)
      const needsApproval = !['RECEIVED'].includes(laundry.processStatus)
      if (needsApproval) {
        const outlet = await Location.findByPk(scope.store, { transaction: t })
        const hash = outlet?.laundrySettings?.ownerPinHash
        if (!hash) refuse(422, 'OWNER_PIN_NOT_SET', 'Owner PIN is not configured for this outlet')
        const ok = await bcrypt.compare(String(approverPin || ''), hash)
        if (!ok) refuse(403, 'INVALID_OWNER_PIN', 'Invalid owner PIN')
      }

      if (idempotencyKey) {
        const idem = await db.transaction.findOne({ where: { order: order.id, idempotencyKey }, transaction: t })
        if (idem) return order
      }

      if (refund > 0) {
        const method = normalizePaymentMethod(refundMethod)
        if (!method) refuse(422, 'PAYMENT_METHOD_REQUIRED', 'refundMethod is required')
        const ref = requireTenderReference(method, referenceNumber)
        let cashRegisterId = null
        if (method === 'CASH') {
          const reg = await resolveAttributedRegister(scope.store, t)
          cashRegisterId = reg.id
        } else {
          const opportunistic = await db.cashRegister.findOne({ where: { store: scope.store, status: 'open' }, lock: t.LOCK.SHARE, transaction: t })
          if (opportunistic) cashRegisterId = opportunistic.id
        }
        await assertSettlementReferenceUnused({ store: scope.store, method, reference: ref, transaction: t })
        const paymentMethodName = await resolvePaymentMethodName({ method, store: scope.store, transaction: t })
        await db.transaction.create({
          order: order.id,
          typePayment: method,
          amount: -Math.abs(refund),
          cashReceived: null,
          changeGiven: 0,
          createdBy: req.user?.id,
          cashRegisterId,
          referenceNumber: ref,
          paymentMethodName,
          idempotencyKey: idempotencyKey || null,
          notes: `Refund pembatalan laundry: ${reason}`
        }, { transaction: t })
      }

      const from = laundry.processStatus
      await laundry.update({
        processStatus: 'CANCELLED',
        cancelledReason: String(reason || ''),
        modifiedBy: req.user?.id
      }, { transaction: t })
      await writeHistory(laundry.id, from, 'CANCELLED', req.user?.id, reason, t)
      const after = await computeOrderFinancials(order, t)
      await order.update({ paymentStatus: legacyPaymentStatusFor(after.state) }, { transaction: t })
      return order
    }))
    const data = await getFullLaundryOrder(result.id, scope.store)
    return res.json({ success: true, data })
  } catch (e) {
    return res.status(e.statusCode || 500).json({ success: false, message: e.message, code: e.code })
  }
}
