'use strict'

const db = require('../../../db/models')
const { salonRoute, withStatus } = require('./http')
const { SalonError } = require('../../service/salonContext')
const { QueueInput, QueueCallInput } = require('../../validation/salonSchemas')
const { staffServicePlan, totalSpanMin, buildItems, isStaffFree } = require('../../service/salonSlots')
const { MIN, localDate, overlaps, toIso } = require('../../service/salonTime')
const { SALON_SERVICE, idParam, notFound } = require('./shared')
const { bookingKit } = require('./appointments')

const {
  loadServices,
  loadScheduleStaff,
  storeShape,
  dayBounds,
  bookingNumber,
  createItems,
  addEvent,
  scheduleError,
  slotTaken,
  stableHash,
  EXCLUSION_VIOLATION,
  UNIQUE_VIOLATION,
  pgCode
} = bookingKit

// Salon walk-in queue (S2-b, SALON-BA §5). Reference: FE-SALON-App
// src/mocks/engine/queue.ts.
//
//   POST /salon/queue          → a numbered ticket of today (A001…) for an outlet.
//   GET  /salon/queue          → today's board: tickets in number order, each
//                                waiting ticket's estimated start (greedy, in
//                                number order, on the fastest free skilled staff)
//                                and when each staff is next free.
//   POST /salon/queue/:id/call → the ticket becomes a walk-in appointment that
//                                starts now (in_service) with the chosen staff.
//   POST /salon/queue/:id/skip → the guest left.
//
// Table and model come with B26 (no migration here). A called ticket is
// 'serving' until its appointment ends (completed, paid, cancelled, no-show);
// the board then shows it 'done' (read from the appointment, not stored).

const APPOINTMENT_DONE = ['completed', 'paid', 'cancelled', 'no_show']
const FREE_PROBE_MIN = 15

/** Earliest instant ≥ `from` when `busy` leaves `span` minutes free. */
const earliestFree = (busy, from, span) => {
  let t = from
  for (const b of [...busy].sort((x, y) => x.startAt - y.startAt)) {
    if (overlaps(t, t + span * MIN, b.startAt, b.endAt)) t = Math.max(t, b.endAt)
  }
  return t
}

const blocksOf = (staff) => [...staff.busy, ...staff.timeOff]

/**
 * Today's board of the outlet. `estimates` (ticket id → { at, staffId }) is
 * also returned for the call handler.
 */
const loadBoard = async (salon, store, transaction) => {
  const now = Date.now()
  const shape = storeShape(store)
  const businessDate = localDate(now, shape.timezone)
  const { start: dayStart, end: dayEnd } = dayBounds(shape, businessDate, businessDate)
  const tickets = await db.salon_queue_ticket.findAll({
    where: { tenantId: salon.tenant.id, store: store.id, businessDate },
    order: [['seq', 'ASC']],
    transaction
  })
  const appointmentIds = tickets.map((t) => t.appointmentId).filter((id) => id != null)
  const appointments = appointmentIds.length
    ? await db.salon_appointment.findAll({
        where: { id: appointmentIds },
        attributes: ['id', 'status', 'startAt'],
        transaction
      })
    : []
  const byId = new Map(appointments.map((a) => [a.id, a]))
  const staffList = await loadScheduleStaff(salon, store, { from: dayStart, to: dayEnd, transaction })

  const waiting = tickets.filter((t) => t.status === 'waiting')
  const serviceIds = [...new Set(tickets.flatMap((t) => t.serviceIds.map(Number)))]
  // Services as they are now (also inactive ones: the guest is already in line);
  // the ticket's service names come from here too. A service gone from the
  // catalog leaves its ticket without an estimate.
  const services = serviceIds.length
    ? (await db.product.findAll({
        where: { id: serviceIds, tenantId: salon.tenant.id, tipeProduk: SALON_SERVICE },
        attributes: ['id', 'nameProduct', 'price', 'serviceConfig'],
        transaction
      })).map((p) => ({ id: p.id, name: p.nameProduct, basePrice: Number(p.price) || 0, serviceConfig: p.serviceConfig || {} }))
    : []
  const busy = new Map(staffList.map((s) => [s.userId, blocksOf(s)]))
  const estimates = new Map()
  for (const ticket of waiting) {
    const wanted = ticket.serviceIds.map((id) => services.find((s) => s.id === Number(id)))
    let best = null
    for (const s of staffList) {
      if (ticket.preferredStaffId && s.userId !== ticket.preferredStaffId) continue
      if (!wanted.every((svc) => svc && staffServicePlan(s, svc))) continue
      const span = totalSpanMin(s, wanted)
      const at = earliestFree(busy.get(s.userId), now, span)
      if (!best || at < best.at) best = { at, staffId: s.userId, span }
    }
    if (best) {
      busy.get(best.staffId).push({ startAt: best.at, endAt: best.at + best.span * MIN })
      estimates.set(ticket.id, { at: best.at, staffId: best.staffId })
    } else {
      estimates.set(ticket.id, { at: now, staffId: null })
    }
  }

  const statusOf = (t) => {
    if (t.status !== 'serving') return t.status
    const apt = byId.get(t.appointmentId)
    return !apt || APPOINTMENT_DONE.includes(apt.status) ? 'done' : 'serving'
  }
  const startOf = (t) => {
    const est = estimates.get(t.id)
    if (est) return est.at
    const apt = byId.get(t.appointmentId)
    return apt ? new Date(apt.startAt).getTime() : new Date(t.createdAt).getTime()
  }
  return {
    estimates,
    staffList,
    board: {
      businessDate,
      tickets: tickets.map((t) => ({
        id: String(t.id),
        store: String(t.store),
        businessDate: t.businessDate,
        seq: t.seq,
        label: t.label,
        appointmentId: t.appointmentId == null ? null : String(t.appointmentId),
        serviceIds: t.serviceIds.map(String),
        status: statusOf(t),
        customerName: t.customerName,
        serviceNames: t.serviceIds.map((id) => services.find((x) => x.id === Number(id))?.name || ''),
        preferredStaffId: t.preferredStaffId == null ? null : String(t.preferredStaffId),
        staffId: t.staffId == null ? null : String(t.staffId),
        estimatedStartAt: toIso(startOf(t)),
        createdAt: toIso(t.createdAt)
      })),
      staffFreeAt: staffList.map((s) => ({
        staffId: String(s.userId),
        freeAt: toIso(earliestFree(blocksOf(s), now, FREE_PROBE_MIN))
      }))
    }
  }
}

exports.board = salonRoute({ perm: 'appointment.read', store: true }, async ({ salon, store }) =>
  (await loadBoard(salon, store)).board
)

// ---------- enqueue ----------

const findByKey = (store, idempotencyKey, transaction) =>
  db.salon_queue_ticket.findOne({
    where: { store: store.id, idempotencyKey },
    attributes: ['id', 'requestHash'],
    transaction
  })

const replayOrMismatch = async (salon, store, prior, requestHash) => {
  if (prior.requestHash !== requestHash) {
    throw new SalonError('IDEMPOTENCY_MISMATCH', 'Kunci idempotensi dipakai untuk isi berbeda', 409)
  }
  return withStatus(200, (await loadBoard(salon, store)).board, { 'Idempotent-Replay': 'true' })
}

exports.enqueue = salonRoute({ perm: 'appointment.manage', store: true }, async ({ salon, store, user, body }) => {
  const input = QueueInput.parse(body)
  const { idempotencyKey, ...payload } = input
  const requestHash = stableHash(payload)
  const prior = await findByKey(store, idempotencyKey)
  if (prior) return replayOrMismatch(salon, store, prior, requestHash)

  try {
    await db.sequelize.transaction(async (t) => {
      const services = await loadServices(salon, input.serviceIds, { transaction: t })
      if (input.memberId) {
        const member = await db.member.findOne({
          where: { id: idParam(input.memberId, 'Pelanggan tidak ditemukan'), tenantId: salon.tenant.id },
          attributes: ['id'],
          transaction: t
        })
        if (!member) throw notFound('Pelanggan tidak ditemukan')
      }
      const now = Date.now()
      const shape = storeShape(store)
      const businessDate = localDate(now, shape.timezone)
      const { start, end } = dayBounds(shape, businessDate, businessDate)
      const staffList = await loadScheduleStaff(salon, store, { from: start, to: end, transaction: t })
      const preferred = input.preferredStaffId ? idParam(input.preferredStaffId, 'Staff tidak ditemukan di outlet ini') : null
      if (preferred && !staffList.some((s) => s.userId === preferred)) throw notFound('Staff tidak ditemukan di outlet ini')
      const able = staffList.some(
        (s) => (!preferred || s.userId === preferred) && services.every((svc) => staffServicePlan(s, svc))
      )
      if (!able) throw new SalonError('STAFF_NOT_SKILLED', 'Belum ada staff yang bisa mengerjakan layanan ini', 409)

      // One number per outlet per day: serialize the outlet's enqueues of the day.
      await db.sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', {
        replacements: { key: `salon_queue:${store.id}:${businessDate}` },
        transaction: t
      })
      const last = await db.salon_queue_ticket.max('seq', { where: { store: store.id, businessDate }, transaction: t })
      const seq = (Number(last) || 0) + 1
      await db.salon_queue_ticket.create(
        {
          tenantId: salon.tenant.id,
          store: store.id,
          businessDate,
          seq,
          label: `A${String(seq).padStart(3, '0')}`,
          serviceIds: services.map((s) => s.id),
          status: 'waiting',
          customerName: input.customerName,
          customerPhone: input.customerPhone,
          memberId: input.memberId ? Number(input.memberId) : null,
          preferredStaffId: preferred,
          idempotencyKey,
          requestHash,
          createdBy: user.id
        },
        { transaction: t }
      )
    })
  } catch (err) {
    if (pgCode(err) === UNIQUE_VIOLATION) {
      const winner = await findByKey(store, idempotencyKey)
      if (winner) return replayOrMismatch(salon, store, winner, requestHash)
    }
    throw err
  }
  return withStatus(201, (await loadBoard(salon, store)).board)
})

// ---------- call / skip ----------

const lockTicket = async (salon, store, rawId, transaction) => {
  const ticket = await db.salon_queue_ticket.findOne({
    where: { id: idParam(rawId, 'Tiket tidak ditemukan'), tenantId: salon.tenant.id, store: store.id },
    transaction,
    lock: transaction.LOCK.UPDATE
  })
  if (!ticket) throw notFound('Tiket tidak ditemukan')
  return ticket
}

exports.call = salonRoute({ perm: 'appointment.manage', store: true }, async ({ salon, store, user, body, params }) => {
  const input = QueueCallInput.parse(body || {})
  try {
    await db.sequelize.transaction(async (t) => {
      const ticket = await lockTicket(salon, store, params.id, t)
      if (ticket.status !== 'waiting') throw new SalonError('INVALID_TRANSITION', 'Tiket ini sudah dipanggil/dilewati', 409)

      const { estimates, staffList } = await loadBoard(salon, store, t)
      const chosenId = input.staffId
        ? idParam(input.staffId, 'Staff tidak ditemukan di outlet ini')
        : ticket.preferredStaffId || estimates.get(ticket.id)?.staffId || null
      if (!chosenId) throw new SalonError('SLOT_TAKEN', 'Belum ada staff yang bebas', 409)
      const staff = staffList.find((s) => s.userId === chosenId)
      if (!staff) throw notFound('Staff tidak ditemukan di outlet ini')

      // A walk-in starts now even outside the stylist's set hours, but never
      // on top of another guest (the exclusion constraint has the last word).
      const services = await loadServices(salon, ticket.serviceIds.map(String), { activeOnly: false, transaction: t })
      const now = Date.now()
      let items
      try {
        items = buildItems(staff, services, now)
      } catch (err) {
        throw scheduleError(err)
      }
      const end = items[items.length - 1].endAt
      if (!isStaffFree(staff, now, end)) {
        throw new SalonError('SLOT_TAKEN', `${staff.name} masih ada pelanggan di jam ini`, 409, { staffId: String(staff.userId) })
      }

      const appointment = await db.salon_appointment.create(
        {
          tenantId: salon.tenant.id,
          store: store.id,
          number: await bookingNumber(store, now, t),
          memberId: ticket.memberId,
          customerName: ticket.customerName,
          customerPhone: ticket.customerPhone || '',
          status: 'in_service',
          source: 'walk_in',
          startAt: new Date(now),
          endAt: new Date(end),
          depositAmount: 0,
          depositMethod: null,
          depositCashRegisterId: null,
          depositStatus: 'none',
          notes: `Antrian ${ticket.label}`,
          idempotencyKey: `queue-call-${ticket.id}`,
          requestHash: stableHash({ queueTicketId: ticket.id }),
          createdBy: user.id
        },
        { transaction: t }
      )
      await createItems(salon, store, appointment.id, items, 'in_service', t)
      await addEvent(salon, appointment.id, 'checked_in', `Antrian ${ticket.label}`, user.id, t)
      await addEvent(salon, appointment.id, 'in_service', null, user.id, t)
      await ticket.update(
        { status: 'serving', staffId: staff.userId, appointmentId: appointment.id },
        { transaction: t }
      )
    })
  } catch (err) {
    if (pgCode(err) === EXCLUSION_VIOLATION) throw slotTaken()
    throw err
  }
  return (await loadBoard(salon, store)).board
})

exports.skip = salonRoute({ perm: 'appointment.manage', store: true }, async ({ salon, store, params }) => {
  await db.sequelize.transaction(async (t) => {
    const ticket = await lockTicket(salon, store, params.id, t)
    if (ticket.status !== 'waiting') throw new SalonError('INVALID_TRANSITION', 'Tiket ini tidak sedang menunggu', 409)
    await ticket.update({ status: 'skipped' }, { transaction: t })
  })
  return (await loadBoard(salon, store)).board
})
