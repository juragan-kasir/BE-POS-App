'use strict'

const crypto = require('crypto')
const { Op } = require('sequelize')
const db = require('../../../db/models')
const { salonRoute, withStatus } = require('./http')
const { SalonError, publicStore, DEFAULT_TENANT_SETTINGS } = require('../../service/salonContext')
const {
  SlotQuery,
  DateRange,
  AppointmentInput,
  RescheduleInput,
  TransitionInput,
  WaTextQuery
} = require('../../validation/salonSchemas')
const {
  ScheduleError,
  buildItems,
  withinWindows,
  isStaffFree,
  computeSlots,
  TRANSITION_RULES,
  BLOCKING_STATUSES
} = require('../../service/salonSlots')
const { MIN, zonedToUtc, localDate, addDays, toIso } = require('../../service/salonTime')
const { nextDailySequence } = require('../../../utils/documentNumber')
const { SALON_SERVICE, idParam, notFound, hhmm } = require('./shared')

// Salon schedule: slots, appointments, reschedule, status transitions,
// deposit and the WhatsApp text (SALON-BA BR-SLN-001…009). Rules come from
// api/service/salonSlots.js (pure); this file loads the snapshot, writes in
// one transaction and lets the exclusion constraint settle races.

// A walk-in "now" is not refused for the seconds that pass while typing.
const PAST_TOLERANCE_MS = 5 * MIN
// Longest list range (calendar month view + margin).
const MAX_RANGE_DAYS = 62
const RESCHEDULABLE = ['booked', 'confirmed']

const pgCode = (err) => err?.parent?.code || err?.original?.code
const pgConstraint = (err) => err?.parent?.constraint || err?.original?.constraint
const EXCLUSION_VIOLATION = '23P01'
const UNIQUE_VIOLATION = '23505'

const scheduleError = (err) => {
  if (err instanceof ScheduleError) return new SalonError(err.code, err.message, 409, err.details)
  return err
}

const slotTaken = (details) => new SalonError('SLOT_TAKEN', 'Jadwal staff sudah terisi di jam itu', 409, details)

/** Stable hash of a request payload (key order independent). */
const stableHash = (value) => {
  const norm = (v) =>
    Array.isArray(v)
      ? v.map(norm)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]))
        : v
  return crypto.createHash('sha256').update(JSON.stringify(norm(value))).digest('hex')
}

const storeShape = (location) => {
  const s = publicStore(location)
  return { timezone: s.timezone, openTime: s.openTime, closeTime: s.closeTime }
}

/** [start, end) of outlet dates from..to. */
const dayBounds = (store, from, to) => ({
  start: zonedToUtc(from, '00:00', store.timezone),
  end: zonedToUtc(addDays(to, 1), '00:00', store.timezone)
})

// ---------- snapshot loaders ----------

/** Active salon services by id, in the requested order (404 on an unknown one). */
const loadServices = async (salon, ids, { activeOnly = true, transaction } = {}) => {
  const numeric = ids.map((id) => idParam(id, 'Layanan tidak ditemukan'))
  const rows = await db.product.findAll({
    where: {
      id: [...new Set(numeric)],
      tenantId: salon.tenant.id,
      tipeProduk: SALON_SERVICE,
      ...(activeOnly ? { status: 'active' } : {})
    },
    attributes: ['id', 'nameProduct', 'price', 'serviceConfig'],
    transaction
  })
  return numeric.map((id) => {
    const p = rows.find((r) => r.id === id)
    if (!p) throw new SalonError('NOT_FOUND', 'Layanan tidak ditemukan', 404, { serviceId: String(id) })
    return { id: p.id, name: p.nameProduct, basePrice: Number(p.price) || 0, serviceConfig: p.serviceConfig || {} }
  })
}

/**
 * Active staff of the outlet with skills, availability, leave and booked
 * blocks overlapping [from, to) — the input of salonSlots.
 */
const loadScheduleStaff = async (salon, store, { from, to, userId = null, excludeAppointmentId = null, transaction }) => {
  const profiles = await db.salon_staff_profile.findAll({
    where: { tenantId: salon.tenant.id, store: store.id, active: true, ...(userId ? { userId } : {}) },
    include: [{ model: db.user, as: 'userData', attributes: ['id', 'fullName', 'userName'] }],
    order: [['userId', 'ASC']],
    transaction
  })
  if (!profiles.length) return []
  const userIds = profiles.map((p) => p.userId)
  const keys = { tenantId: salon.tenant.id, store: store.id, userId: userIds }
  const window = { startAt: { [Op.lt]: new Date(to) }, endAt: { [Op.gt]: new Date(from) } }
  // Sequential: one connection inside a transaction runs one query at a time.
  const skills = await db.salon_staff_skill.findAll({ where: keys, transaction })
  const availability = await db.salon_availability.findAll({ where: keys, transaction })
  const timeOff = await db.salon_time_off.findAll({ where: { ...keys, ...window }, transaction })
  const busy = await db.salon_appointment_item.findAll({
    where: {
      tenantId: salon.tenant.id,
      staffId: userIds,
      status: BLOCKING_STATUSES,
      ...window,
      ...(excludeAppointmentId ? { appointmentId: { [Op.ne]: excludeAppointmentId } } : {})
    },
    attributes: ['staffId', 'startAt', 'endAt'],
    transaction
  })
  return profiles.map((p) => ({
    userId: p.userId,
    name: p.userData?.fullName || p.userData?.userName || '',
    level: p.level,
    skills: skills.filter((s) => s.userId === p.userId),
    availability: availability
      .filter((a) => a.userId === p.userId)
      .map((a) => ({ weekday: a.weekday, startTime: hhmm(a.startTime), endTime: hhmm(a.endTime) })),
    timeOff: timeOff
      .filter((t) => t.userId === p.userId)
      .map((t) => ({ startAt: new Date(t.startAt).getTime(), endAt: new Date(t.endAt).getTime() })),
    busy: busy
      .filter((b) => b.staffId === p.userId)
      .map((b) => ({ startAt: new Date(b.startAt).getTime(), endAt: new Date(b.endAt).getTime() }))
  }))
}

/** Staff snapshot for the outlet day holding `start`. */
const staffForDay = (salon, store, start, opts) => {
  const shape = storeShape(store)
  const date = localDate(start, shape.timezone)
  const { start: from, end: to } = dayBounds(shape, date, date)
  return loadScheduleStaff(salon, store, { from, to, ...opts })
}

const stepMinOf = (salon) => Number(salon.tenant.salonSettings?.slotStepMin) || DEFAULT_TENANT_SETTINGS.slotStepMin

// ---------- serialization ----------

const appointmentInclude = [
  { model: db.salon_appointment_item, as: 'items', separate: true, order: [['startAt', 'ASC'], ['id', 'ASC']] },
  { model: db.salon_appointment_event, as: 'events', separate: true, order: [['id', 'ASC']] }
]

const userNames = async (ids, transaction) => {
  const unique = [...new Set(ids.filter((id) => id != null))]
  if (!unique.length) return new Map()
  const rows = await db.user.findAll({
    where: { id: unique },
    attributes: ['id', 'fullName', 'userName'],
    paranoid: false,
    transaction
  })
  return new Map(rows.map((u) => [u.id, u.fullName || u.userName || '']))
}

const serializeAppointment = (a, names) => ({
  id: String(a.id),
  store: String(a.store),
  number: a.number,
  memberId: a.memberId == null ? null : String(a.memberId),
  customerName: a.customerName,
  customerPhone: a.customerPhone || '',
  status: a.status,
  source: a.source,
  startAt: toIso(a.startAt),
  endAt: toIso(a.endAt),
  depositAmount: a.depositAmount,
  orderId: a.orderId == null ? null : String(a.orderId),
  notes: a.notes || '',
  createdBy: names.get(a.createdBy) || '',
  createdAt: toIso(a.createdAt),
  items: (a.items || []).map((i) => ({
    id: String(i.id),
    productId: String(i.productId),
    serviceName: i.serviceName,
    staffId: String(i.staffId),
    startAt: toIso(i.startAt),
    endAt: toIso(i.endAt),
    price: i.price,
    durationMin: i.durationMin,
    status: i.status
  })),
  history: (a.events || []).map((e) => ({
    status: e.status,
    at: toIso(e.createdAt),
    by: names.get(e.createdBy) || '',
    reason: e.reason ?? null
  }))
})

/** Contract `Appointment` for rows loaded with appointmentInclude. */
const serializeAppointments = async (rows, transaction) => {
  const ids = rows.flatMap((a) => [a.createdBy, ...(a.events || []).map((e) => e.createdBy)])
  const names = await userNames(ids, transaction)
  return rows.map((a) => serializeAppointment(a, names))
}

const loadAppointment = async (salon, store, id, transaction) => {
  const row = await db.salon_appointment.findOne({
    where: { id, tenantId: salon.tenant.id, store: store.id },
    include: appointmentInclude,
    transaction
  })
  if (!row) throw notFound('Booking tidak ditemukan')
  return row
}

const publicAppointment = async (salon, store, id, transaction) =>
  (await serializeAppointments([await loadAppointment(salon, store, id, transaction)], transaction))[0]

/** Locked appointment row (no include: FOR UPDATE cannot lock an outer join). */
const lockAppointment = async (salon, store, rawId, transaction) => {
  const row = await db.salon_appointment.findOne({
    where: { id: idParam(rawId, 'Booking tidak ditemukan'), tenantId: salon.tenant.id, store: store.id },
    transaction,
    lock: transaction.LOCK.UPDATE
  })
  if (!row) throw notFound('Booking tidak ditemukan')
  return row
}

/** A stylist (staff role) sees only bookings they work on. */
const selfStaffId = (salon) => (salon.canonicalRole === 'staff' ? Number(salon.user.id) : null)

// ---------- slots ----------

const splitIds = (raw) =>
  (Array.isArray(raw) ? raw : [raw])
    .filter((v) => v !== undefined && v !== null)
    .flatMap((v) => String(v).split(','))
    .map((v) => v.trim())
    .filter(Boolean)

exports.listSlots = salonRoute({ perm: 'appointment.read', store: true }, async ({ salon, store, query }) => {
  const q = SlotQuery.parse({
    date: query.date,
    serviceIds: splitIds(query.serviceIds),
    staffId: query.staffId ? String(query.staffId) : null
  })
  const shape = storeShape(store)
  const services = await loadServices(salon, q.serviceIds)
  const { start: from, end: to } = dayBounds(shape, q.date, q.date)
  const staff = await loadScheduleStaff(salon, store, { from, to })
  const slots = computeSlots({
    store: shape,
    date: q.date,
    services,
    staff,
    staffId: q.staffId,
    stepMin: stepMinOf(salon),
    now: Date.now()
  })
  return {
    slots: slots.map((s) => ({ startAt: toIso(s.startAt), endAt: toIso(s.endAt), staffId: String(s.staffId) })),
    timezone: shape.timezone
  }
})

// ---------- list / detail ----------

exports.listAppointments = salonRoute({ perm: 'appointment.read', store: true }, async ({ salon, store, query }) => {
  const { from, to } = DateRange.parse({ from: query.from, to: query.to })
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > MAX_RANGE_DAYS) {
    throw new SalonError('VALIDATION_FAILED', `Rentang tanggal maksimal ${MAX_RANGE_DAYS} hari`, 400, { field: 'to' })
  }
  const bounds = dayBounds(storeShape(store), from, to)
  const self = selfStaffId(salon)
  const where = {
    tenantId: salon.tenant.id,
    store: store.id,
    startAt: { [Op.gte]: new Date(bounds.start), [Op.lt]: new Date(bounds.end) }
  }
  if (self) {
    where.id = {
      [Op.in]: db.sequelize.literal(
        `(SELECT "appointmentId" FROM "salon_appointment_item" WHERE "staffId" = ${self} AND "deletedAt" IS NULL)`
      )
    }
  }
  const rows = await db.salon_appointment.findAll({
    where,
    include: appointmentInclude,
    order: [['startAt', 'ASC'], ['id', 'ASC']]
  })
  return { data: await serializeAppointments(rows) }
})

exports.getAppointment = salonRoute({ perm: 'appointment.read', store: true }, async ({ salon, store, params }) => {
  const row = await loadAppointment(salon, store, idParam(params.id, 'Booking tidak ditemukan'))
  const self = selfStaffId(salon)
  if (self && !row.items.some((i) => i.staffId === self)) throw notFound('Booking tidak ditemukan')
  return (await serializeAppointments([row]))[0]
})

// ---------- create ----------

const replayOrMismatch = async (salon, store, prior, requestHash) => {
  if (prior.requestHash !== requestHash) {
    throw new SalonError('IDEMPOTENCY_MISMATCH', 'Kunci idempotensi dipakai untuk isi berbeda', 409)
  }
  return withStatus(200, await publicAppointment(salon, store, prior.id), { 'Idempotent-Replay': 'true' })
}

const findByKey = (store, idempotencyKey, transaction) =>
  db.salon_appointment.findOne({
    where: { store: store.id, idempotencyKey },
    attributes: ['id', 'requestHash'],
    paranoid: false,
    transaction
  })

/** Open cash register of the outlet (cash deposit lands in its drawer, BR-SLN-009). */
const openRegister = async (store, transaction) => {
  const register = await db.cashRegister.findOne({
    where: { store: store.id, status: 'open' },
    order: [['id', 'DESC']],
    transaction,
    lock: transaction.LOCK.SHARE
  })
  if (!register) throw new SalonError('SHIFT_CLOSED', 'Buka shift kasir dulu untuk menerima deposit tunai', 409)
  return register
}

const bookingNumber = async (store, start, transaction) => {
  const { counterDate, seq } = await nextDailySequence('salon_booking', store.id, { transaction, now: new Date(start) })
  return `BK-${counterDate.slice(2).replace(/-/g, '')}-${String(seq).padStart(3, '0')}`
}

const createItems = (salon, store, appointmentId, items, status, transaction) =>
  db.salon_appointment_item.bulkCreate(
    items.map((i) => ({
      tenantId: salon.tenant.id,
      store: store.id,
      appointmentId,
      productId: i.productId,
      serviceName: i.serviceName,
      staffId: i.staffId,
      startAt: new Date(i.startAt),
      endAt: new Date(i.endAt),
      price: i.price,
      durationMin: i.durationMin,
      bufferMin: i.bufferMin,
      status
    })),
    { transaction }
  )

const addEvent = (salon, appointmentId, status, reason, userId, transaction) =>
  db.salon_appointment_event.create(
    { tenantId: salon.tenant.id, appointmentId, status, reason: reason || null, createdBy: userId },
    { transaction }
  )

exports.createAppointment = salonRoute({ perm: 'appointment.manage', store: true }, async ({ salon, store, user, body }) => {
  const input = AppointmentInput.parse(body)
  const { idempotencyKey, ...payload } = input
  const requestHash = stableHash(payload)

  // BR-SLN-006: same key + same body → replay; same key + other body → 409.
  const prior = await findByKey(store, idempotencyKey)
  if (prior) return replayOrMismatch(salon, store, prior, requestHash)

  if (input.depositAmount > 0 && !input.depositMethod) {
    throw new SalonError('VALIDATION_FAILED', 'Pilih metode bayar deposit', 400, { field: 'depositMethod' })
  }
  const start = Date.parse(input.startAt)
  const now = Date.now()
  if (start < now - PAST_TOLERANCE_MS) throw new SalonError('SLOT_IN_PAST', 'Waktu sudah lewat', 409)

  let createdId
  try {
    createdId = await db.sequelize.transaction(async (t) => {
      const services = await loadServices(salon, input.serviceIds, { transaction: t })
      if (input.memberId) {
        const member = await db.member.findOne({
          where: { id: idParam(input.memberId, 'Pelanggan tidak ditemukan'), tenantId: salon.tenant.id },
          attributes: ['id'],
          transaction: t
        })
        if (!member) throw notFound('Pelanggan tidak ditemukan')
      }

      const shape = storeShape(store)
      const staffList = await staffForDay(salon, store, start, { transaction: t })
      let staff
      if (input.staffId) {
        staff = staffList.find((s) => String(s.userId) === input.staffId)
        if (!staff) throw notFound('Staff tidak ditemukan di outlet ini')
      } else {
        // "Siapa saja": the slot engine's pick for exactly this start (BR-SLN-004).
        const slot = computeSlots({
          store: shape,
          date: localDate(start, shape.timezone),
          services,
          staff: staffList,
          stepMin: stepMinOf(salon),
          now: now - PAST_TOLERANCE_MS
        }).find((s) => s.startAt === start)
        staff = slot && staffList.find((s) => s.userId === slot.staffId)
        if (!staff) throw new SalonError('SLOT_TAKEN', 'Tidak ada staff yang bebas di jam itu', 409)
      }

      let items
      try {
        items = buildItems(staff, services, start)
      } catch (err) {
        throw scheduleError(err)
      }
      const end = items[items.length - 1].endAt
      if (!withinWindows(staff, shape, start, end)) {
        throw new SalonError('OUTSIDE_AVAILABILITY', `${staff.name} tidak bekerja di jam itu`, 409, {
          staffId: String(staff.userId)
        })
      }
      if (!isStaffFree(staff, start, end)) throw slotTaken({ staffId: String(staff.userId) })

      const register =
        input.depositAmount > 0 && input.depositMethod === 'cash' ? await openRegister(store, t) : null
      const appointment = await db.salon_appointment.create(
        {
          tenantId: salon.tenant.id,
          store: store.id,
          number: await bookingNumber(store, start, t),
          memberId: input.memberId ? Number(input.memberId) : null,
          customerName: input.customerName,
          customerPhone: input.customerPhone,
          status: 'booked',
          source: input.source,
          startAt: new Date(start),
          endAt: new Date(end),
          depositAmount: input.depositAmount,
          depositMethod: input.depositAmount > 0 ? input.depositMethod : null,
          depositCashRegisterId: register ? register.id : null,
          depositStatus: input.depositAmount > 0 ? 'held' : 'none',
          notes: input.notes,
          idempotencyKey,
          requestHash,
          createdBy: user.id
        },
        { transaction: t }
      )
      await createItems(salon, store, appointment.id, items, 'booked', t)
      await addEvent(salon, appointment.id, 'booked', null, user.id, t)
      return appointment.id
    })
  } catch (err) {
    // The database settles the races the snapshot cannot see.
    if (pgCode(err) === EXCLUSION_VIOLATION) throw slotTaken()
    if (pgCode(err) === UNIQUE_VIOLATION && /idempotency/.test(pgConstraint(err) || '')) {
      const winner = await findByKey(store, idempotencyKey)
      if (winner) return replayOrMismatch(salon, store, winner, requestHash)
    }
    throw err
  }
  return withStatus(201, await publicAppointment(salon, store, createdId))
})

// ---------- reschedule ----------

exports.rescheduleAppointment = salonRoute({ perm: 'appointment.manage', store: true }, async ({ salon, store, user, body, params }) => {
  const input = RescheduleInput.parse(body)
  const start = Date.parse(input.startAt)
  try {
    const id = await db.sequelize.transaction(async (t) => {
      const apt = await lockAppointment(salon, store, params.id, t)
      // BR-SLN-007: only a booking the guest has not come in for yet moves.
      if (!RESCHEDULABLE.includes(apt.status)) {
        throw new SalonError('INVALID_TRANSITION', 'Hanya booking yang belum datang yang bisa dipindah', 409, {
          from: apt.status
        })
      }
      if (start < Date.now() - PAST_TOLERANCE_MS) throw new SalonError('SLOT_IN_PAST', 'Waktu sudah lewat', 409)
      const staffList = await staffForDay(salon, store, start, {
        userId: idParam(input.staffId, 'Staff tidak ditemukan'),
        excludeAppointmentId: apt.id,
        transaction: t
      })
      const staff = staffList[0]
      if (!staff) throw notFound('Staff tidak ditemukan di outlet ini')
      const current = await db.salon_appointment_item.findAll({
        where: { appointmentId: apt.id },
        order: [['startAt', 'ASC'], ['id', 'ASC']],
        transaction: t
      })
      // A service switched off since booking still moves with its booking.
      const services = await loadServices(
        salon,
        current.map((i) => i.productId),
        { activeOnly: false, transaction: t }
      )
      let items
      try {
        items = buildItems(staff, services, start)
      } catch (err) {
        throw scheduleError(err)
      }
      const end = items[items.length - 1].endAt
      if (!withinWindows(staff, storeShape(store), start, end)) {
        throw new SalonError('OUTSIDE_AVAILABILITY', `${staff.name} tidak bekerja di jam itu`, 409, {
          staffId: String(staff.userId)
        })
      }
      if (!isStaffFree(staff, start, end)) throw slotTaken({ staffId: String(staff.userId) })

      // Old blocks leave the constraint first (soft delete), so a move that
      // overlaps the booking's own old time is not seen as a clash.
      await db.salon_appointment_item.destroy({ where: { appointmentId: apt.id }, transaction: t })
      // BR-SLN-005: prices are re-locked for the (possibly new) staff.
      await createItems(salon, store, apt.id, items, apt.status, t)
      await apt.update({ startAt: new Date(start), endAt: new Date(end), modifiedBy: user.id }, { transaction: t })
      await addEvent(salon, apt.id, apt.status, `Dipindah ke ${staff.name}`, user.id, t)
      return apt.id
    })
    return publicAppointment(salon, store, id)
  } catch (err) {
    if (pgCode(err) === EXCLUSION_VIOLATION) throw slotTaken()
    throw err
  }
})

// ---------- transitions ----------

const transitionHandler = (transition) =>
  salonRoute({ perm: 'appointment.manage', store: true }, async ({ salon, store, user, body, params }) => {
    const { reason } = TransitionInput.parse(body && Object.keys(body).length ? body : { reason: null })
    const rule = TRANSITION_RULES[transition]
    const id = await db.sequelize.transaction(async (t) => {
      const apt = await lockAppointment(salon, store, params.id, t)
      if (!rule.from.includes(apt.status)) {
        throw new SalonError('INVALID_TRANSITION', `Tidak bisa ${transition} dari status ${apt.status}`, 409, {
          from: apt.status,
          transition
        })
      }
      const why = reason ? reason.trim() : ''
      if (rule.reason && !why) {
        throw new SalonError('VALIDATION_FAILED', 'Alasan wajib diisi', 400, { field: 'reason' })
      }
      const items = await db.salon_appointment_item.findAll({
        where: { appointmentId: apt.id },
        attributes: ['id', 'staffId'],
        transaction: t
      })
      if (transition === 'start') {
        // A stylist works on one guest at a time.
        const busy = await db.salon_appointment_item.findOne({
          where: {
            tenantId: salon.tenant.id,
            staffId: [...new Set(items.map((i) => i.staffId))],
            status: 'in_service',
            appointmentId: { [Op.ne]: apt.id }
          },
          attributes: ['id'],
          transaction: t
        })
        if (busy) throw new SalonError('SLOT_TAKEN', 'Staff masih melayani pelanggan lain', 409)
      }
      const changes = { status: rule.to, modifiedBy: user.id }
      // BR-SLN-009: a no-show or cancellation forfeits a held deposit.
      if ((rule.to === 'no_show' || rule.to === 'cancelled') && apt.depositStatus === 'held') {
        changes.depositStatus = 'forfeited'
      }
      await db.salon_appointment_item.update(
        { status: rule.to },
        { where: { appointmentId: apt.id }, transaction: t }
      )
      await apt.update(changes, { transaction: t })
      await addEvent(salon, apt.id, rule.to, why || null, user.id, t)
      return apt.id
    })
    return publicAppointment(salon, store, id)
  })

exports.transitions = Object.fromEntries(Object.keys(TRANSITION_RULES).map((t) => [t, transitionHandler(t)]))

// ---------- WhatsApp text ----------

exports.waText = salonRoute({ perm: 'appointment.read', store: true }, async ({ salon, store, query, params }) => {
  const { kind } = WaTextQuery.parse({ kind: query.kind || undefined })
  const row = await loadAppointment(salon, store, idParam(params.id, 'Booking tidak ditemukan'))
  const shop = publicStore(store)
  const names = await userNames(row.items.map((i) => i.staffId))
  const staffNames = [...new Set(row.items.map((i) => names.get(i.staffId) || ''))].filter(Boolean).join(', ')
  const when = new Intl.DateTimeFormat('id-ID', {
    timeZone: shop.timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(row.startAt))
  const lines =
    kind === 'thanks'
      ? [
          `Halo ${row.customerName}, terima kasih sudah datang ke ${shop.name}! 🙏`,
          'Sampai ketemu lagi. Booking berikutnya cukup balas pesan ini.'
        ]
      : [
          `Halo ${row.customerName}, ini pengingat booking kamu di *${shop.name}*:`,
          `📅 ${when}`,
          `✂️ ${row.items.map((i) => i.serviceName).join(' + ')}`,
          staffNames ? `👤 ${staffNames}` : '',
          row.depositAmount ? `Deposit diterima: Rp${row.depositAmount.toLocaleString('id-ID')}` : '',
          `No. booking: ${row.number}`,
          '',
          `Balas *YA* untuk konfirmasi${shop.phone ? ` atau hubungi ${shop.phone}` : ''} bila ingin ganti jadwal. — ${salon.tenant.name}`
        ]
  return {
    phone: row.customerPhone || '',
    text: lines.filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== '')).join('\n')
  }
})

module.exports.serializeAppointments = serializeAppointments
module.exports.appointmentInclude = appointmentInclude

// Booking building blocks reused by the walk-in queue (./queue.js), so a called
// ticket becomes an appointment by the same rules and numbering.
module.exports.bookingKit = {
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
}
