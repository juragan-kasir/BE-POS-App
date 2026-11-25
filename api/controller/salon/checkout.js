'use strict'

const crypto = require('crypto')
const { Op } = require('sequelize')
const db = require('../../../db/models')
const { salonRoute, withStatus } = require('./http')
const { SalonError, tenantSettings, publicStore } = require('../../service/salonContext')
const { QuoteInput, CheckoutInput, RefundInput, OrdersQuery } = require('../../validation/salonSchemas')
const { MoneyError, buildQuote, settlePayments, CANONICAL_METHOD, CONTRACT_METHOD } = require('../../service/salonMoney')
const { requireTenderReference } = require('../../service/canonicalPayment')
const { adjustProductStock } = require('../../service/stockMutationService')
const { enqueueAccountingJob, attemptJob, recordImmediateAttempt } = require('../../service/accountingOutboxService')
const { enqueueOrderAccountingJobs, attemptOrderAccountingEntries } = require('../order')
const { zonedToUtc, localDate, addDays, toIso } = require('../../service/salonTime')
const { nextDailySequence } = require('../../../utils/documentNumber')
const { hasSalonPermission } = require('../../../utils/salonCapabilities')
const { SALON_SERVICE, SALON_RETAIL, idParam, notFound } = require('./shared')
const { DEPOSIT_KEY_PREFIX, requireOpenRegister } = require('./shift')
const { verifyOwnerPin } = require('../../service/salonOwnerPin')

// Salon cashier (SALON-BA BR-SLN-010…015, DR-SLN-06/07): quote, checkout,
// the day's orders and full refund. One salon payment = one POS `order`
// with its `order_item` (staffId), `transaction` rows (split pay, drawer
// attribution), journals and stock history, so FE-POS reports, Z-report and
// the ledger see it. `salon_order` keeps the quote snapshot and the
// idempotency key; `salon_staff_commission` is the immutable commission
// ledger. Money rules live in api/service/salonMoney.js (pure).

const UNIQUE_VIOLATION = '23505'
const pgCode = (err) => err?.parent?.code || err?.original?.code
const pgConstraint = (err) => err?.parent?.constraint || err?.original?.constraint

const moneyError = (err) => {
  if (err instanceof MoneyError) return new SalonError(err.code, err.message, err.status, err.details)
  if (err?.code === 'REFERENCE_REQUIRED') {
    return new SalonError('REFERENCE_REQUIRED', 'Isi nomor referensi untuk pembayaran non-tunai', 422, { field: 'payments' })
  }
  return err
}

const stableHash = (value) => {
  const norm = (v) =>
    Array.isArray(v)
      ? v.map(norm)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]))
        : v
  return crypto.createHash('sha256').update(JSON.stringify(norm(value))).digest('hex')
}

// ---------- quote ----------

const loadAppointment = async (salon, store, rawId, transaction, lock = false) => {
  const row = await db.salon_appointment.findOne({
    where: { id: idParam(rawId, 'Booking tidak ditemukan'), tenantId: salon.tenant.id, store: store.id },
    transaction,
    ...(lock ? { lock: transaction.LOCK.UPDATE } : {})
  })
  if (!row) throw notFound('Booking tidak ditemukan')
  return row
}

/** Active staff profiles of the outlet for the given user ids (404 on an unknown one). */
const outletStaff = async (salon, store, ids, transaction) => {
  const unique = [...new Set(ids.filter((id) => id != null).map(Number))]
  if (!unique.length) return new Map()
  const rows = await db.salon_staff_profile.findAll({
    where: { tenantId: salon.tenant.id, store: store.id, userId: unique },
    attributes: ['userId', 'commissionOverride'],
    transaction
  })
  for (const id of unique) {
    if (!rows.some((r) => r.userId === id)) {
      throw new SalonError('NOT_FOUND', 'Staff tidak ditemukan di outlet ini', 404, { staffId: String(id) })
    }
  }
  return new Map(rows.map((r) => [r.userId, r]))
}

/**
 * Load everything the quote needs and price it. Returns the quote plus the
 * loaded rows checkout writes from.
 */
const priceCart = async (salon, store, input, { transaction, lockAppointment = false } = {}) => {
  const appointment = input.appointmentId
    ? await loadAppointment(salon, store, input.appointmentId, transaction, lockAppointment)
    : null
  const items = appointment
    ? await db.salon_appointment_item.findAll({
        where: { appointmentId: appointment.id },
        order: [['startAt', 'ASC'], ['id', 'ASC']],
        transaction
      })
    : []

  const serviceRows = items.length
    ? await db.product.findAll({
        where: { id: [...new Set(items.map((i) => i.productId))], tenantId: salon.tenant.id, tipeProduk: SALON_SERVICE },
        attributes: ['id', 'serviceConfig'],
        paranoid: false,
        transaction
      })
    : []
  const extraIds = input.extras.map((e) => idParam(e.productId, 'Produk tidak ditemukan'))
  const productRows = extraIds.length
    ? await db.product.findAll({
        where: { id: [...new Set(extraIds)], tenantId: salon.tenant.id, tipeProduk: SALON_RETAIL, status: 'active' },
        attributes: ['id', 'nameProduct', 'price', 'serviceConfig'],
        transaction
      })
    : []

  const tipStaff = input.tip.amount > 0 ? input.tip.staffId ?? items[0]?.staffId ?? null : null
  const staff = await outletStaff(
    salon,
    store,
    [...input.extras.map((e) => e.staffId), tipStaff].filter((id) => id != null).map((id) => idParam(id, 'Staff tidak ditemukan')),
    transaction
  )
  // Booked stylists may have left the outlet since; their override still applies.
  const bookedStaff = items.length
    ? await db.salon_staff_profile.findAll({
        where: { tenantId: salon.tenant.id, store: store.id, userId: [...new Set(items.map((i) => i.staffId))] },
        attributes: ['userId', 'commissionOverride'],
        transaction
      })
    : []
  const overrideOf = (staffId) =>
    (staff.get(Number(staffId)) || bookedStaff.find((p) => p.userId === Number(staffId)))?.commissionOverride || null

  const services = items.map((i) => ({
    itemId: i.id,
    productId: i.productId,
    name: i.serviceName,
    staffId: i.staffId,
    price: i.price,
    // DR-SLN-09: staff override > service rule.
    rule: overrideOf(i.staffId) || serviceRows.find((p) => p.id === i.productId)?.serviceConfig?.commission || null
  }))
  const products = input.extras.map((e, idx) => {
    const p = productRows.find((r) => r.id === extraIds[idx])
    if (!p) throw new SalonError('NOT_FOUND', 'Produk tidak ditemukan', 404, { productId: String(e.productId) })
    return {
      idx,
      productId: p.id,
      name: p.nameProduct,
      staffId: e.staffId == null ? null : Number(e.staffId),
      qty: e.qty,
      price: Number(p.price) || 0,
      rule: p.serviceConfig?.commission || null
    }
  })
  const deposit = appointment && appointment.depositStatus === 'held' ? appointment.depositAmount : 0
  let quote
  try {
    quote = buildQuote({
      services,
      products,
      tip: { amount: input.tip.amount, staffId: tipStaff },
      discount: input.discount,
      deposit,
      pointsPer: Number(tenantSettings(salon.tenant).pointsPer) || 10000
    })
  } catch (err) {
    throw moneyError(err)
  }
  return { quote, appointment, items }
}

exports.quote = salonRoute({ perm: 'pos.sell', store: true }, async ({ salon, store, body }) => {
  const input = QuoteInput.parse(body)
  return (await priceCart(salon, store, input)).quote
})

// ---------- serialization ----------

const userNames = async (ids, transaction) => {
  const unique = [...new Set(ids.filter((id) => id != null))]
  if (!unique.length) return new Map()
  const rows = await db.user.findAll({ where: { id: unique }, attributes: ['id', 'fullName', 'userName'], paranoid: false, transaction })
  return new Map(rows.map((u) => [u.id, u.fullName || u.userName || '']))
}

/** Contract `Order` for salon_order rows. */
const serializeOrders = async (rows, transaction) => {
  if (!rows.length) return []
  const orderIds = rows.map((r) => r.orderId)
  const orders = await db.order.findAll({ where: { id: orderIds }, paranoid: false, transaction })
  const payments = await db.transaction.findAll({
    where: { order: orderIds, amount: { [Op.gt]: 0 } },
    order: [['id', 'ASC']],
    transaction
  })
  const names = await userNames(rows.map((r) => r.refund?.by), transaction)
  return rows.map((r) => {
    const o = orders.find((x) => x.id === r.orderId)
    return {
      id: String(r.id),
      number: o?.orderNumber || '',
      store: String(r.store),
      appointmentId: r.appointmentId == null ? null : String(r.appointmentId),
      memberId: o?.customerId == null ? null : String(o.customerId),
      customerName: o?.customerName || '',
      cashierName: o?.cashierName || '',
      quote: r.quote,
      payments: payments
        .filter((p) => p.order === r.orderId && !String(p.idempotencyKey || '').startsWith(DEPOSIT_KEY_PREFIX))
        .map((p) => ({
          method: CONTRACT_METHOD[p.typePayment] || String(p.typePayment).toLowerCase(),
          amount: Number(p.amount),
          tendered: p.cashReceived == null ? null : Number(p.cashReceived),
          reference: p.referenceNumber || null,
          change: Number(p.changeGiven) || 0
        })),
      status: r.status,
      createdAt: toIso(r.createdAt),
      refund: r.refund
        ? { at: r.refund.at, reason: r.refund.reason, by: names.get(r.refund.by) || '', amount: r.refund.amount }
        : null
    }
  })
}

const publicOrder = async (id, transaction) =>
  (await serializeOrders([await db.salon_order.findByPk(id, { transaction })], transaction))[0]

// ---------- checkout ----------

const invoiceNumber = async (store, transaction) => {
  const { storeId, counterDate, seq } = await nextDailySequence('salon_order', store.id, { transaction })
  return `INV-${storeId}-${counterDate.slice(2).replace(/-/g, '')}-${String(seq).padStart(3, '0')}`
}

const findByKey = (store, idempotencyKey, transaction) =>
  db.salon_order.findOne({ where: { store: store.id, idempotencyKey }, attributes: ['id', 'requestHash'], transaction })

const replayOrMismatch = async (prior, requestHash) => {
  if (prior.requestHash !== requestHash) {
    throw new SalonError('IDEMPOTENCY_MISMATCH', 'Kunci idempotensi dipakai untuk isi berbeda', 409)
  }
  return withStatus(200, await publicOrder(prior.id), { 'Idempotent-Replay': 'true' })
}

/** Outlet stock of each product line, locked (INSUFFICIENT_STOCK when short). */
const assertStock = async (store, quote, transaction) => {
  const need = new Map()
  for (const line of quote.lines.filter((l) => l.kind === 'product')) {
    need.set(Number(line.refId), { name: line.name, qty: (need.get(Number(line.refId))?.qty || 0) + line.qty })
  }
  if (!need.size) return
  const rows = await db.product_store_stock.findAll({
    where: { store: store.id, product: [...need.keys()] },
    order: [['product', 'ASC']],
    transaction,
    lock: transaction.LOCK.UPDATE
  })
  for (const [productId, { name, qty }] of need) {
    const have = Math.trunc(Number(rows.find((r) => Number(r.product) === productId)?.stock) || 0)
    if (have < qty) {
      throw new SalonError('INSUFFICIENT_STOCK', `Stok ${name} tinggal ${have}`, 409, { productId: String(productId), stock: have })
    }
  }
}

exports.checkout = salonRoute({ perm: 'pos.sell', store: true }, async ({ salon, store, user, body }) => {
  const input = CheckoutInput.parse(body)
  const { idempotencyKey, ...payload } = input
  const requestHash = stableHash(payload)

  const prior = await findByKey(store, idempotencyKey)
  if (prior) return replayOrMismatch(prior, requestHash)

  let created
  try {
    created = await db.sequelize.transaction(async (t) => {
      const register = await requireOpenRegister(store, t)
      const { quote, appointment } = await priceCart(salon, store, input, { transaction: t, lockAppointment: true })
      if (appointment) {
        if (appointment.status === 'paid' || appointment.orderId) {
          throw new SalonError('ALREADY_PAID', 'Booking ini sudah dibayar', 409)
        }
        if (appointment.status !== 'completed') {
          throw new SalonError('NOT_COMPLETED', 'Selesaikan layanan dulu sebelum bayar', 409, { status: appointment.status })
        }
      }
      if (!quote.lines.length) throw new SalonError('VALIDATION_FAILED', 'Keranjang kosong', 400, { field: 'extras' })
      await assertStock(store, quote, t)
      let payments
      try {
        payments = settlePayments(input.payments, quote.due).map((p) => ({
          ...p,
          typePayment: CANONICAL_METHOD[p.method],
          reference: requireTenderReference(CANONICAL_METHOD[p.method], p.reference)
        }))
      } catch (err) {
        throw moneyError(err)
      }

      const memberRaw = appointment?.memberId ?? input.memberId
      let member = null
      if (memberRaw != null) {
        member = await db.member.findOne({
          where: { id: idParam(memberRaw, 'Pelanggan tidak ditemukan'), tenantId: salon.tenant.id },
          transaction: t,
          lock: t.LOCK.UPDATE
        })
        if (!member) throw notFound('Pelanggan tidak ditemukan')
      }

      const orderNumber = await invoiceNumber(store, t)
      const cashierName = user.fullName || user.userName || ''
      const order = await db.order.create(
        {
          orderNumber,
          store: store.id,
          customerId: member ? member.id : null,
          customerName: appointment?.customerName || input.customerName || member?.name || 'Pelanggan umum',
          customerPhone: appointment?.customerPhone || null,
          cashierId: user.id,
          cashierName,
          status: 'paid',
          subTotal: quote.subtotal,
          discountType: input.discount.type === 'percent' ? 'percent' : input.discount.type === 'amount' ? 'nominal' : 'none',
          discountValue: input.discount.type === 'none' ? 0 : Math.round(input.discount.value),
          discountAmount: quote.discountTotal,
          // The tip rides on the service-charge leg so the order journal
          // balances (credited to 4100, outside sales revenue).
          serviceChargeAmount: quote.tipTotal,
          totalPrice: quote.total,
          totalQuantity: quote.lines.filter((l) => l.kind !== 'tip').reduce((s, l) => s + l.qty, 0),
          paymentMethod: payments.length === 1 ? payments[0].typePayment : payments.length ? 'SPLIT' : 'DEPOSIT',
          paymentStatus: 'paid',
          source: 'pos',
          notes: appointment ? `Salon ${appointment.number}` : 'Salon',
          cashRegisterId: register.id,
          createdBy: user.id
        },
        { transaction: t }
      )

      const itemIdByKey = new Map()
      for (const line of quote.lines.filter((l) => l.kind !== 'tip')) {
        const row = await db.order_item.create(
          {
            order: order.id,
            product: Number(line.refId),
            productName: line.name,
            quantity: line.qty,
            price: line.unitPrice,
            discountType: line.discount > 0 ? 'nominal' : 'none',
            discountValue: line.discount,
            discountAmount: line.discount,
            totalPrice: line.net,
            status: 'served',
            staffId: line.staffId == null ? null : Number(line.staffId),
            serviceSnapshot: line.kind === 'service' ? { lineKey: line.key, commission: line.commission } : null,
            createdBy: user.id
          },
          { transaction: t }
        )
        itemIdByKey.set(line.key, row.id)
      }

      // The deposit taken at booking settles its share of the order; its row
      // stays attributed to the drawer it was paid into.
      if (quote.depositPaid > 0) {
        await db.transaction.create(
          {
            order: order.id,
            typePayment: CANONICAL_METHOD[appointment.depositMethod] || 'CASH',
            amount: quote.depositPaid,
            cashReceived: appointment.depositMethod === 'cash' ? quote.depositPaid : null,
            changeGiven: 0,
            referenceNumber: appointment.depositReference || null,
            cashRegisterId: appointment.depositCashRegisterId || null,
            idempotencyKey: `${DEPOSIT_KEY_PREFIX}${appointment.id}`,
            notes: `Deposit booking ${appointment.number}`,
            createdBy: user.id
          },
          { transaction: t }
        )
      }
      for (const [i, p] of payments.entries()) {
        await db.transaction.create(
          {
            order: order.id,
            typePayment: p.typePayment,
            amount: p.amount,
            cashReceived: p.method === 'cash' ? p.tendered : null,
            changeGiven: p.change,
            referenceNumber: p.reference,
            cashRegisterId: register.id,
            idempotencyKey: `salon:${idempotencyKey}:${i}`,
            createdBy: user.id
          },
          { transaction: t }
        )
      }

      const salonOrder = await db.salon_order.create(
        {
          tenantId: salon.tenant.id,
          store: store.id,
          orderId: order.id,
          appointmentId: appointment ? appointment.id : null,
          quote,
          depositApplied: quote.depositPaid,
          tipTotal: quote.tipTotal,
          status: 'paid',
          idempotencyKey,
          requestHash,
          createdBy: user.id
        },
        { transaction: t }
      )

      // DR-SLN-07: commission rows are written once the order is settled.
      const commissions = quote.lines.filter((l) => l.staffId != null && l.commission > 0)
      if (commissions.length) {
        await db.salon_staff_commission.bulkCreate(
          commissions.map((l) => ({
            tenantId: salon.tenant.id,
            store: store.id,
            orderId: order.id,
            orderItemId: itemIdByKey.get(l.key) || null,
            lineKey: l.key,
            staffId: Number(l.staffId),
            kind: l.kind,
            name: l.name,
            amount: l.commission,
            status: 'earned',
            createdBy: user.id
          })),
          { transaction: t }
        )
      }

      // BR-SLN-014: retail stock leaves the outlet at payment.
      for (const line of quote.lines.filter((l) => l.kind === 'product')) {
        await adjustProductStock({
          productId: Number(line.refId),
          store: store.id,
          deltaQty: -line.qty,
          referenceType: 'sale',
          referenceId: order.id,
          notes: `Penjualan salon ${orderNumber}`,
          createdBy: user.id,
          transaction: t
        })
      }

      if (appointment) {
        await appointment.update(
          {
            status: 'paid',
            orderId: order.id,
            depositStatus: quote.depositPaid > 0 ? 'applied' : appointment.depositStatus,
            modifiedBy: user.id
          },
          { transaction: t }
        )
        await db.salon_appointment_item.update({ status: 'paid' }, { where: { appointmentId: appointment.id }, transaction: t })
        await db.salon_appointment_event.create(
          { tenantId: salon.tenant.id, appointmentId: appointment.id, status: 'paid', reason: orderNumber, createdBy: user.id },
          { transaction: t }
        )
      }
      if (member && quote.pointsEarned > 0) {
        await member.update(
          {
            totalPoints: (member.totalPoints || 0) + quote.pointsEarned,
            lifetimePoints: (member.lifetimePoints || 0) + quote.pointsEarned,
            modifiedBy: user.id
          },
          { transaction: t }
        )
      }

      const jobs = await enqueueOrderAccountingJobs(
        order,
        store.id,
        orderNumber,
        {
          subTotal: quote.subtotal,
          discountAmount: quote.discountTotal,
          taxAmount: 0,
          serviceChargeAmount: quote.tipTotal,
          totalPrice: quote.total
        },
        order.paymentMethod,
        user.id,
        t
      )
      return { id: salonOrder.id, jobs }
    })
  } catch (err) {
    if (pgCode(err) === UNIQUE_VIOLATION && /idempotency/.test(pgConstraint(err) || '')) {
      const winner = await findByKey(store, idempotencyKey)
      if (winner) return replayOrMismatch(winner, requestHash)
    }
    throw err
  }
  // After commit: a posting failure leaves the outbox job for the scheduler.
  await attemptOrderAccountingEntries(created.jobs).catch((err) => console.error('[salon] journal deferred', err?.message))
  return withStatus(201, await publicOrder(created.id))
})

// ---------- orders of a day ----------

exports.listOrders = salonRoute({ perm: ['pos.sell', 'report.read'], store: true }, async ({ store, query }) => {
  const { timezone } = publicStore(store)
  const { date = localDate(Date.now(), timezone) } = OrdersQuery.parse({ date: query.date || undefined })
  const rows = await db.salon_order.findAll({
    where: {
      store: store.id,
      createdAt: {
        [Op.gte]: new Date(zonedToUtc(date, '00:00', timezone)),
        [Op.lt]: new Date(zonedToUtc(addDays(date, 1), '00:00', timezone))
      }
    },
    order: [['createdAt', 'DESC'], ['id', 'DESC']]
  })
  return { data: await serializeOrders(rows) }
})

// ---------- refund ----------

/** BR-SLN-015: `pos.refund`, or the owner PIN of the outlet for a kasir. */
const assertRefundAllowed = async (user, store, ownerPin) => {
  if (hasSalonPermission(user, 'pos.refund')) return
  await verifyOwnerPin(store.id, ownerPin)
}

exports.refund = salonRoute({ perm: 'pos.sell', store: true }, async ({ salon, store, user, body, params }) => {
  const input = RefundInput.parse(body)
  const id = idParam(params.id, 'Order tidak ditemukan')
  await assertRefundAllowed(user, store, input.ownerPin)

  const done = await db.sequelize.transaction(async (t) => {
    const salonOrder = await db.salon_order.findOne({
      where: { id, tenantId: salon.tenant.id, store: store.id },
      transaction: t,
      lock: t.LOCK.UPDATE
    })
    if (!salonOrder) throw notFound('Order tidak ditemukan')
    if (salonOrder.status === 'refunded') throw new SalonError('ALREADY_PAID', 'Order sudah direfund', 409)
    const register = await requireOpenRegister(store, t, 'Buka shift kasir dulu untuk refund')
    const order = await db.order.findByPk(salonOrder.orderId, { transaction: t, lock: t.LOCK.UPDATE })

    // DR-SLN-13 full refund of what was paid at the till; a deposit stays
    // with its booking (BR-SLN-009).
    const paid = await db.transaction.findAll({
      where: { order: order.id, amount: { [Op.gt]: 0 } },
      order: [['id', 'ASC']],
      transaction: t
    })
    const refundable = paid.filter((p) => !String(p.idempotencyKey || '').startsWith(DEPOSIT_KEY_PREFIX))
    let amount = 0
    for (const p of refundable) {
      const value = Number(p.amount)
      amount += value
      await db.transaction.create(
        {
          order: order.id,
          typePayment: p.typePayment,
          amount: -value,
          cashReceived: null,
          changeGiven: 0,
          referenceNumber: p.referenceNumber,
          cashRegisterId: register.id,
          idempotencyKey: `salon-refund:${salonOrder.id}:${p.id}`,
          notes: `Refund salon: ${input.reason}`,
          createdBy: user.id
        },
        { transaction: t }
      )
    }

    // Immutable commission ledger: a reversal is a new negative row.
    const earned = await db.salon_staff_commission.findAll({
      where: { orderId: order.id, status: 'earned' },
      order: [['id', 'ASC']],
      transaction: t
    })
    if (earned.length) {
      await db.salon_staff_commission.bulkCreate(
        earned.map((c) => ({
          tenantId: c.tenantId,
          store: c.store,
          orderId: c.orderId,
          orderItemId: c.orderItemId,
          lineKey: c.lineKey,
          staffId: c.staffId,
          kind: c.kind,
          name: c.name,
          amount: -c.amount,
          status: 'reversed',
          reversesId: c.id,
          createdBy: user.id
        })),
        { transaction: t }
      )
    }

    for (const line of (salonOrder.quote?.lines || []).filter((l) => l.kind === 'product')) {
      await adjustProductStock({
        productId: Number(line.refId),
        store: store.id,
        deltaQty: line.qty,
        referenceType: 'sale_reversal',
        referenceId: order.id,
        notes: `Refund salon ${order.orderNumber}`,
        createdBy: user.id,
        transaction: t
      })
    }

    const points = Number(salonOrder.quote?.pointsEarned) || 0
    if (order.customerId && points > 0) {
      const member = await db.member.findByPk(order.customerId, { transaction: t, lock: t.LOCK.UPDATE })
      if (member) {
        await member.update(
          {
            totalPoints: Math.max(0, (member.totalPoints || 0) - points),
            lifetimePoints: Math.max(0, (member.lifetimePoints || 0) - points),
            modifiedBy: user.id
          },
          { transaction: t }
        )
      }
    }

    await order.update({ status: 'void', paymentStatus: 'refunded', modifiedBy: user.id }, { transaction: t })
    await salonOrder.update(
      { status: 'refunded', refund: { at: new Date().toISOString(), reason: input.reason, by: user.id, amount } },
      { transaction: t }
    )
    const job = await enqueueAccountingJob({
      jobType: 'reverse_order_journals',
      store: store.id,
      referenceType: 'order',
      referenceId: order.id,
      payload: {
        store: store.id,
        orderId: order.id,
        orderNumber: order.orderNumber,
        date: new Date().toISOString(),
        createdBy: user.id
      },
      transaction: t
    })
    return { id: salonOrder.id, job }
  })
  try {
    await recordImmediateAttempt(done.job, await attemptJob(done.job))
  } catch (err) {
    console.error('[salon] journal reversal deferred', err?.message)
  }
  return publicOrder(done.id)
})
