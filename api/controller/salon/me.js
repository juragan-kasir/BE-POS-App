'use strict'

const { Op } = require('sequelize')
const db = require('../../../db/models')
const { salonRoute, withStatus } = require('./http')
const { SalonError, publicStore } = require('../../service/salonContext')
const {
  DateRange,
  DateQuery,
  AttendanceInput,
  ShiftSwapInput,
  ShiftSwapDecisionInput,
  ShiftSwapListQuery
} = require('../../validation/salonSchemas')
const { zonedToUtc, localDate, addDays, toIso } = require('../../service/salonTime')
const { idParam, notFound, hhmm } = require('./shared')
const { loadStaff, profileInclude } = require('./staff')
const { serializeAppointments, appointmentInclude } = require('./appointments')
const { attendanceGuards } = require('../attendance')

// Stylist phone app (/salon/me/*) and shift-swap approval (S2-b, SALON-BA §6,
// DR-SLN-15). Reference: FE-SALON-App src/mocks/handlers.ts.
//
// No new tables:
//   attendance → core `attendance` (type 'check-in' | 'check-out', like the
//                FE-POS clock), same GPS trust rules and store geofence.
//   tukar shift → core `shift_swap` on salon work shifts (`shift` rows). Approval
//                swaps the two employees in shift.karyawan, the salon model
//                (one employee may hold several shifts; user.shift untouched).
//                The daily /internal/shift-swaps/expire job may set a pending
//                swap whose date has passed to 'expired'; the contract has no
//                such status, so it is shown as 'cancelled'.

const MAX_RANGE_DAYS = 62
// Newest swaps first; older ones are history the screens do not page through.
const LIST_LIMIT = 200
const SWAP_ORDER = { pending: 0, approved: 1, rejected: 2, cancelled: 3 }
const CONTRACT_TYPE = { 'check-in': 'check_in', 'check-out': 'check_out' }
const CORE_TYPE = { check_in: 'check-in', check_out: 'check-out' }
const pgCode = (err) => err?.parent?.code || err?.original?.code

const tzOf = (location) => publicStore(location).timezone

/** [start, end) instants of outlet dates from..to. */
const dayBounds = (tz, from, to) => ({
  start: new Date(zonedToUtc(from, '00:00', tz)),
  end: new Date(zonedToUtc(addDays(to, 1), '00:00', tz))
})

const assertRange = ({ from, to }) => {
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > MAX_RANGE_DAYS) {
    throw new SalonError('VALIDATION_FAILED', `Rentang tanggal maksimal ${MAX_RANGE_DAYS} hari`, 400, { field: 'to' })
  }
}

const userNames = async (ids, transaction) => {
  const unique = [...new Set(ids.filter((id) => id != null).map(Number))]
  if (!unique.length) return new Map()
  const rows = await db.user.findAll({
    where: { id: unique },
    attributes: ['id', 'fullName', 'userName'],
    paranoid: false,
    transaction
  })
  return new Map(rows.map((u) => [u.id, u.fullName || u.userName || '']))
}

/**
 * The caller's own staff profile and its outlet. A stylist has one profile per
 * outlet; the one at their home outlet (user.store) wins.
 */
const ownStaff = async (salon, transaction) => {
  const storeIds = salon.stores.map((s) => Number(s.id))
  const profiles = storeIds.length
    ? await db.salon_staff_profile.findAll({
        where: { tenantId: salon.tenant.id, userId: Number(salon.user.id), store: storeIds },
        include: profileInclude,
        order: [['id', 'ASC']],
        transaction
      })
    : []
  const profile = profiles.find((p) => p.store === Number(salon.user.store)) || profiles[0]
  if (!profile) throw new SalonError('NOT_FOUND', 'Akun ini bukan staff layanan', 404)
  const store = salon.stores.find((s) => Number(s.id) === profile.store)
  return { profile, store }
}

// ---------- jadwal & komisi ----------

exports.schedule = salonRoute({ perm: 'appointment.read' }, async ({ salon, query }) => {
  const { profile, store } = await ownStaff(salon)
  const tz = tzOf(store)
  const { date = localDate(Date.now(), tz) } = DateQuery.parse({ date: query.date || undefined })
  const { start, end } = dayBounds(tz, date, date)
  const rows = await db.salon_appointment.findAll({
    where: {
      tenantId: salon.tenant.id,
      store: store.id,
      startAt: { [Op.gte]: start, [Op.lt]: end },
      id: {
        [Op.in]: db.sequelize.literal(
          `(SELECT "appointmentId" FROM "salon_appointment_item" WHERE "staffId" = ${Number(profile.userId)} AND "deletedAt" IS NULL)`
        )
      }
    },
    include: appointmentInclude,
    order: [['startAt', 'ASC'], ['id', 'ASC']]
  })
  const [staff] = await loadStaff([profile])
  return { staff, appointments: await serializeAppointments(rows) }
})

const serializeCommission = (c, orderNumbers) => ({
  id: String(c.id),
  orderId: String(c.orderId),
  orderNumber: orderNumbers.get(c.orderId) || '',
  lineKey: c.lineKey,
  staffId: String(c.staffId),
  kind: c.kind,
  name: c.name,
  amount: c.amount,
  status: c.status,
  createdAt: toIso(c.createdAt)
})

/** Own commission ledger rows (earned + reversals) for outlet dates from..to. */
exports.commission = salonRoute({ perm: 'commission.read' }, async ({ salon, query }) => {
  const range = DateRange.parse({ from: query.from, to: query.to })
  assertRange(range)
  // Dates are read in the caller's outlet zone (a stylist works at one outlet).
  const home = salon.stores.find((s) => Number(s.id) === Number(salon.user.store)) || salon.stores[0]
  const { start, end } = dayBounds(home ? tzOf(home) : 'Asia/Jakarta', range.from, range.to)
  const rows = await db.salon_staff_commission.findAll({
    where: {
      tenantId: salon.tenant.id,
      staffId: Number(salon.user.id),
      createdAt: { [Op.gte]: start, [Op.lt]: end }
    },
    order: [['createdAt', 'DESC'], ['id', 'DESC']]
  })
  const orders = rows.length
    ? await db.order.findAll({
        where: { id: [...new Set(rows.map((r) => r.orderId))] },
        attributes: ['id', 'orderNumber'],
        paranoid: false
      })
    : []
  const orderNumbers = new Map(orders.map((o) => [o.id, o.orderNumber]))
  const earned = rows.filter((r) => r.status === 'earned').reduce((s, r) => s + r.amount, 0)
  const reversed = rows.filter((r) => r.status === 'reversed').reduce((s, r) => s + r.amount, 0)
  return { rows: rows.map((r) => serializeCommission(r, orderNumbers)), earned, reversed, net: earned + reversed }
})

// ---------- absensi ----------

const serializeAttendance = (a, tz) => ({
  id: String(a.id),
  store: String(a.store),
  staffId: String(a.userId),
  shiftId: a.shiftId == null ? null : String(a.shiftId),
  date: localDate(new Date(a.absenAt).getTime(), tz),
  type: CONTRACT_TYPE[a.type] || 'check_in',
  at: toIso(a.absenAt),
  latitude: Number(a.latitude),
  longitude: Number(a.longitude),
  accuracy: Number(a.accuracy),
  note: a.note || ''
})

exports.attendance = salonRoute({ perm: 'appointment.read' }, async ({ salon, query }) => {
  const { profile, store } = await ownStaff(salon)
  const tz = tzOf(store)
  const { date = localDate(Date.now(), tz) } = DateQuery.parse({ date: query.date || undefined })
  const { start, end } = dayBounds(tz, date, date)
  const rows = await db.attendance.findAll({
    where: { userId: profile.userId, store: store.id, absenAt: { [Op.gte]: start, [Op.lt]: end } },
    order: [['absenAt', 'ASC'], ['id', 'ASC']]
  })
  return { date, rows: rows.map((r) => serializeAttendance(r, tz)) }
})

const sameClock = (row, input) =>
  row.type === CORE_TYPE[input.type] &&
  String(row.store) === String(input.store) &&
  String(row.shiftId ?? '') === String(input.shiftId ?? '') &&
  Number(row.latitude) === input.latitude &&
  Number(row.longitude) === input.longitude &&
  Number(row.accuracy) === input.accuracy

exports.clock = salonRoute({ perm: 'appointment.read' }, async ({ salon, body }) => {
  const input = AttendanceInput.parse(body)
  const { profile, store } = await ownStaff(salon)
  if (String(input.store) !== String(store.id)) throw new SalonError('FORBIDDEN', 'Absen hanya untuk outlet kamu', 403)
  const tz = tzOf(store)
  const userId = profile.userId

  const replay = async (transaction) => {
    const prior = await db.attendance.findOne({ where: { userId, idempotencyKey: input.idempotencyKey }, transaction })
    if (!prior) return null
    if (!sameClock(prior, input)) {
      throw new SalonError('IDEMPOTENCY_MISMATCH', 'Kunci idempotensi dipakai untuk isi berbeda', 409)
    }
    return withStatus(200, serializeAttendance(prior, tz), { 'Idempotent-Replay': 'true' })
  }

  const { validateCoordinate, computeStatus, storeDistance, MAX_STORE_DISTANCE_M } = attendanceGuards
  const coordErr = validateCoordinate(input.latitude, input.longitude)
  if (coordErr) throw new SalonError('VALIDATION_FAILED', coordErr, 400, { field: 'latitude' })

  try {
    return await db.sequelize.transaction(async (t) => {
      // One clock at a time per stylist: the duplicate checks below hold.
      await db.sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', {
        replacements: { key: `salon_attendance:${userId}` },
        transaction: t
      })
      const replayed = await replay(t)
      if (replayed) return replayed

      const now = Date.now()
      const date = localDate(now, tz)
      let shiftId = null
      if (input.shiftId) {
        shiftId = idParam(input.shiftId, 'Shift tidak ditemukan')
        const shift = await db.shift.findOne({
          where: { id: shiftId, tenantId: salon.tenant.id, store: store.id, status: 'active' },
          transaction: t
        })
        if (!shift) throw notFound('Shift tidak ditemukan')
        if (!(shift.karyawan || []).map(Number).includes(userId)) {
          throw new SalonError('FORBIDDEN', 'Kamu tidak ditugaskan di shift ini', 403)
        }
        const last = shift.tanggal_selesai ?? shift.tanggal_mulai
        if (date < shift.tanggal_mulai || date > last) {
          throw new SalonError('VALIDATION_FAILED', 'Absen hanya bisa untuk shift hari ini', 400, { field: 'shiftId' })
        }
      }

      const distance = await storeDistance(store.id, input.latitude, input.longitude)
      if (distance != null && distance > MAX_STORE_DISTANCE_M) {
        throw new SalonError('VALIDATION_FAILED', 'Kamu berada di luar radius outlet', 400, {
          field: 'latitude',
          distanceM: Math.round(distance)
        })
      }

      const { start, end } = dayBounds(tz, date, date)
      const today = await db.attendance.findAll({
        where: {
          userId,
          store: store.id,
          shiftId,
          absenAt: { [Op.gte]: start, [Op.lt]: end },
          status: { [Op.ne]: 'cancelled' }
        },
        attributes: ['type'],
        transaction: t
      })
      const has = (type) => today.some((a) => a.type === type)
      if (input.type === 'check_in' && has('check-in')) {
        throw new SalonError('DUPLICATE', 'Kamu sudah absen masuk untuk shift ini', 409)
      }
      if (input.type === 'check_out' && !has('check-in')) {
        throw new SalonError('INVALID_TRANSITION', 'Absen masuk dulu sebelum absen pulang', 409)
      }
      if (input.type === 'check_out' && has('check-out')) {
        throw new SalonError('DUPLICATE', 'Kamu sudah absen pulang untuk shift ini', 409)
      }

      // GPS trust (FE-POS rule): an untrusted fix is still recorded, flagged.
      const trust = computeStatus(input)
      const row = await db.attendance.create(
        {
          userId,
          store: store.id,
          shiftId,
          type: CORE_TYPE[input.type],
          absenAt: new Date(now),
          latitude: input.latitude,
          longitude: input.longitude,
          accuracy: input.accuracy,
          algorithm: 'gps',
          status: trust.status,
          note: input.note || trust.note,
          idempotencyKey: input.idempotencyKey,
          createdBy: userId
        },
        { transaction: t }
      )
      return withStatus(201, serializeAttendance(row, tz))
    })
  } catch (err) {
    // A parallel request with the same key won the unique index: replay it.
    if (pgCode(err) === '23505') {
      const replayed = await replay()
      if (replayed) return replayed
    }
    throw err
  }
})

// ---------- tukar shift ----------

const shiftSnapshot = (w) => ({
  id: String(w.id),
  name: w.name,
  type: w.tipe_shift === 'mingguan' ? 'mingguan' : 'harian',
  startDate: w.tanggal_mulai,
  endDate: w.tipe_shift === 'mingguan' ? w.tanggal_selesai : null,
  startTime: hhmm(w.startTime),
  endTime: hhmm(w.endTime)
})

const serializeWorkShift = (w) => ({
  ...shiftSnapshot(w),
  store: String(w.store),
  employeeIds: (Array.isArray(w.karyawan) ? w.karyawan : []).map(String),
  status: ['draft', 'active', 'inactive'].includes(w.status) ? w.status : 'inactive'
})

/** Contract `ShiftSwap`; the shift snapshots taken at request time live in status_history[0]. */
const serializeSwaps = async (rows, transaction) => {
  const names = await userNames(rows.flatMap((r) => [r.requesterId, r.targetId, r.decidedBy]), transaction)
  const snapOf = (r) => (Array.isArray(r.status_history) && r.status_history[0]?.shifts) || null
  // A swap made outside the salon API has no snapshot: show the shifts as they are now.
  const missing = rows.filter((r) => !snapOf(r)).flatMap((r) => [r.requesterShiftId, r.targetShiftId])
  const live = missing.length
    ? new Map((await db.shift.findAll({ where: { id: [...new Set(missing)] }, paranoid: false, transaction })).map((w) => [w.id, shiftSnapshot(w)]))
    : new Map()
  return rows.map((r) => {
    const snap = snapOf(r) || { requester: live.get(r.requesterShiftId), target: live.get(r.targetShiftId) }
    return {
      id: String(r.id),
      store: String(r.store),
      date: r.tanggal_mulai,
      requesterId: String(r.requesterId),
      requesterName: names.get(r.requesterId) || '',
      targetId: String(r.targetId),
      targetName: names.get(r.targetId) || '',
      requesterShiftId: String(r.requesterShiftId),
      targetShiftId: String(r.targetShiftId),
      requesterShift: snap.requester,
      targetShift: snap.target,
      note: r.note || '',
      status: r.status === 'expired' ? 'cancelled' : r.status,
      createdAt: toIso(r.createdAt),
      decidedAt: r.decidedAt ? toIso(r.decidedAt) : null,
      decidedBy: r.decidedBy == null ? null : names.get(r.decidedBy) || ''
    }
  })
}

const sortSwaps = (list) =>
  list.sort((a, b) => SWAP_ORDER[a.status] - SWAP_ORDER[b.status] || Date.parse(b.createdAt) - Date.parse(a.createdAt))

/** Date filter on the swap date; `cancelled` also covers swaps the expiry job closed. */
const swapWhere = ({ status, from, to }) => {
  const where = {}
  if (status) where.status = status === 'cancelled' ? ['cancelled', 'expired'] : status
  if (from || to) where.tanggal_mulai = { ...(from ? { [Op.gte]: from } : {}), ...(to ? { [Op.lte]: to } : {}) }
  return where
}

// Same advisory lock as the work-shift writes in ./hr.js: a swap decision and
// a shift edit at one outlet never interleave.
const lockOutletShifts = (store, transaction) =>
  db.sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', {
    replacements: { key: `salon_work_shift:${store.id}` },
    transaction
  })

const activeStaffIds = async (salon, store, transaction) => {
  const rows = await db.salon_staff_profile.findAll({
    where: { tenantId: salon.tenant.id, store: store.id, active: true },
    attributes: ['userId'],
    transaction
  })
  return new Set(rows.map((r) => r.userId))
}

exports.mySwaps = salonRoute({ perm: 'appointment.read' }, async ({ salon, query }) => {
  const { profile, store } = await ownStaff(salon)
  const filter = ShiftSwapListQuery.parse({ from: query.from || undefined, to: query.to || undefined })
  const rows = await db.shift_swap.findAll({
    where: {
      ...swapWhere(filter),
      store: store.id,
      [Op.or]: [{ requesterId: profile.userId }, { targetId: profile.userId }]
    },
    order: [['id', 'DESC']],
    limit: LIST_LIMIT
  })
  return { data: sortSwaps(await serializeSwaps(rows)) }
})

exports.swapCandidates = salonRoute({ perm: 'appointment.read' }, async ({ salon, query }) => {
  const { store } = await ownStaff(salon)
  const tz = tzOf(store)
  const from = query.from || localDate(Date.now(), tz)
  const range = DateRange.parse({ from, to: query.to || addDays(from, 7) })
  assertRange(range)
  const shifts = await db.shift.findAll({
    where: {
      tenantId: salon.tenant.id,
      store: store.id,
      status: 'active',
      tanggal_mulai: { [Op.lte]: range.to },
      [Op.and]: [
        db.sequelize.where(
          db.sequelize.fn('COALESCE', db.sequelize.col('tanggal_selesai'), db.sequelize.col('tanggal_mulai')),
          { [Op.gte]: range.from }
        )
      ]
    },
    order: [['tanggal_mulai', 'ASC'], ['startTime', 'ASC'], ['id', 'ASC']]
  })
  const staff = await db.salon_staff_profile.findAll({
    where: { tenantId: salon.tenant.id, store: store.id, active: true },
    include: profileInclude,
    order: [['id', 'ASC']]
  })
  return {
    shifts: shifts.map(serializeWorkShift),
    staff: staff.map((p) => ({
      id: String(p.userId),
      name: p.userData?.fullName || p.userData?.userName || '',
      position: p.positionData?.name || '',
      colorTag: p.colorTag
    }))
  }
})

const sameSwap = (row, input) =>
  String(row.requesterShiftId) === String(input.requesterShiftId) &&
  String(row.targetShiftId) === String(input.targetShiftId) &&
  String(row.targetId) === String(input.targetId) &&
  row.tanggal_mulai === input.date &&
  (row.note || '') === input.note

exports.requestSwap = salonRoute({ perm: 'appointment.read' }, async ({ salon, body }) => {
  const input = ShiftSwapInput.parse(body)
  const { profile, store } = await ownStaff(salon)
  const me = profile.userId

  const replay = async (transaction) => {
    const prior = await db.shift_swap.findOne({ where: { requesterId: me, idempotencyKey: input.idempotencyKey }, transaction })
    if (!prior) return null
    if (!sameSwap(prior, input)) throw new SalonError('IDEMPOTENCY_MISMATCH', 'Kunci idempotensi dipakai untuk isi berbeda', 409)
    return withStatus(200, (await serializeSwaps([prior], transaction))[0], { 'Idempotent-Replay': 'true' })
  }

  try {
    return await db.sequelize.transaction(async (t) => {
      await lockOutletShifts(store, t)
      const replayed = await replay(t)
      if (replayed) return replayed

      const targetId = idParam(input.targetId, 'Rekan kerja tidak ditemukan di outlet ini')
      if (targetId === me) throw new SalonError('VALIDATION_FAILED', 'Pilih rekan kerja lain', 400, { field: 'targetId' })
      if (!(await activeStaffIds(salon, store, t)).has(targetId)) throw notFound('Rekan kerja tidak ditemukan di outlet ini')

      const findShift = (id) =>
        db.shift.findOne({
          where: { id: idParam(id, 'Shift tidak ditemukan'), tenantId: salon.tenant.id, store: store.id, status: 'active' },
          transaction: t
        })
      const mine = await findShift(input.requesterShiftId)
      const theirs = await findShift(input.targetShiftId)
      const on = (w, userId) => (w.karyawan || []).map(Number).includes(userId)
      if (!mine || !on(mine, me)) throw new SalonError('FORBIDDEN', 'Shift kamu tidak ditemukan', 403)
      if (!theirs || !on(theirs, targetId)) throw notFound('Shift rekan tidak ditemukan')
      if (mine.id === theirs.id) throw new SalonError('VALIDATION_FAILED', 'Pilih shift yang berbeda', 400, { field: 'targetShiftId' })
      if ([mine, theirs].some((w) => w.tipe_shift !== 'harian' || w.tanggal_selesai)) {
        throw new SalonError('VALIDATION_FAILED', 'Tukar shift hanya untuk shift harian', 400)
      }
      if (mine.tanggal_mulai !== input.date || theirs.tanggal_mulai !== input.date) {
        throw new SalonError('VALIDATION_FAILED', 'Kedua shift harus di tanggal yang sama', 400, { field: 'date' })
      }
      if (input.date < localDate(Date.now(), tzOf(store))) {
        throw new SalonError('VALIDATION_FAILED', 'Shift yang sudah lewat tidak bisa ditukar', 400, { field: 'date' })
      }
      if (on(theirs, me) || on(mine, targetId)) throw new SalonError('DUPLICATE', 'Kalian sudah berada di shift yang sama', 409)
      const pending = await db.shift_swap.count({
        where: {
          store: store.id,
          status: 'pending',
          [Op.or]: [
            { requesterShiftId: [mine.id, theirs.id] },
            { targetShiftId: [mine.id, theirs.id] }
          ]
        },
        transaction: t
      })
      if (pending) throw new SalonError('DUPLICATE', 'Salah satu shift masih punya pengajuan tukar yang menunggu', 409)

      const row = await db.shift_swap.create(
        {
          store: store.id,
          requesterId: me,
          targetId,
          requesterShiftId: mine.id,
          targetShiftId: theirs.id,
          tanggal_mulai: input.date,
          tanggal_selesai: input.date,
          note: input.note,
          status: 'pending',
          idempotencyKey: input.idempotencyKey,
          status_history: [
            {
              status: 'pending',
              by: me,
              at: new Date().toISOString(),
              shifts: { requester: shiftSnapshot(mine), target: shiftSnapshot(theirs) }
            }
          ],
          createdBy: me
        },
        { transaction: t }
      )
      return withStatus(201, (await serializeSwaps([row], t))[0])
    })
  } catch (err) {
    if (pgCode(err) === '23505') {
      const replayed = await replay()
      if (replayed) return replayed
    }
    throw err
  }
})

const decide = async (row, status, userId, transaction) =>
  row.update(
    {
      status,
      decidedBy: userId,
      decidedAt: new Date(),
      modifiedBy: userId,
      status_history: [
        ...(Array.isArray(row.status_history) ? row.status_history : []),
        { status, by: userId, at: new Date().toISOString() }
      ]
    },
    { transaction }
  )

exports.cancelSwap = salonRoute({ perm: 'appointment.read' }, async ({ salon, params }) => {
  const { profile, store } = await ownStaff(salon)
  const id = idParam(params.id, 'Pengajuan tukar shift tidak ditemukan')
  return db.sequelize.transaction(async (t) => {
    const row = await db.shift_swap.findOne({
      where: { id, store: store.id, [Op.or]: [{ requesterId: profile.userId }, { targetId: profile.userId }] },
      transaction: t,
      lock: t.LOCK.UPDATE
    })
    if (!row) throw notFound('Pengajuan tukar shift tidak ditemukan')
    if (row.requesterId !== profile.userId) throw new SalonError('FORBIDDEN', 'Hanya pengaju yang bisa membatalkan', 403)
    if (row.status !== 'pending') throw new SalonError('INVALID_TRANSITION', 'Pengajuan ini sudah diproses', 409)
    await decide(row, 'cancelled', profile.userId, t)
    return (await serializeSwaps([row], t))[0]
  })
})

// ---------- persetujuan (owner / admin) ----------

exports.listSwaps = salonRoute({ perm: 'shift.manage', store: true }, async ({ store, query }) => {
  const filter = ShiftSwapListQuery.parse({ status: query.status || undefined })
  const rows = await db.shift_swap.findAll({
    where: { ...swapWhere(filter), store: store.id },
    order: [['id', 'DESC']],
    limit: LIST_LIMIT
  })
  return { data: sortSwaps(await serializeSwaps(rows)) }
})

/** An active shift of `userId` at the outlet overlapping `shift` (date and time), other than `exclude`. */
const clashFor = async (salon, store, userId, shift, exclude, transaction) => {
  const end = shift.tanggal_selesai ?? shift.tanggal_mulai
  const rows = await db.shift.findAll({
    where: {
      tenantId: salon.tenant.id,
      store: store.id,
      status: 'active',
      id: { [Op.notIn]: exclude },
      tanggal_mulai: { [Op.lte]: end },
      startTime: { [Op.lt]: shift.endTime },
      endTime: { [Op.gt]: shift.startTime }
    },
    transaction
  })
  return rows.find((w) => (w.tanggal_selesai ?? w.tanggal_mulai) >= shift.tanggal_mulai && (w.karyawan || []).map(Number).includes(userId))
}

exports.decideSwap = salonRoute({ perm: 'shift.manage', store: true }, async ({ salon, store, user, body, params }) => {
  const { decision } = ShiftSwapDecisionInput.parse(body)
  const id = idParam(params.id, 'Pengajuan tukar shift tidak ditemukan')
  return db.sequelize.transaction(async (t) => {
    await lockOutletShifts(store, t)
    const row = await db.shift_swap.findOne({ where: { id, store: store.id }, transaction: t, lock: t.LOCK.UPDATE })
    if (!row) throw notFound('Pengajuan tukar shift tidak ditemukan')
    if (row.status !== 'pending') throw new SalonError('INVALID_TRANSITION', 'Pengajuan ini sudah diproses', 409)
    if (decision === 'rejected') {
      await decide(row, 'rejected', user.id, t)
      return (await serializeSwaps([row], t))[0]
    }

    const load = (shiftId) =>
      db.shift.findOne({ where: { id: shiftId, tenantId: salon.tenant.id, store: store.id }, transaction: t, lock: t.LOCK.UPDATE })
    const mine = await load(row.requesterShiftId)
    const theirs = await load(row.targetShiftId)
    const on = (w, userId) => (w.karyawan || []).map(Number).includes(userId)
    if (!mine || !theirs || mine.status !== 'active' || theirs.status !== 'active') {
      throw new SalonError('INVALID_TRANSITION', 'Shift sudah berubah, pengajuan tidak bisa disetujui', 409)
    }
    if (!on(mine, row.requesterId) || !on(theirs, row.targetId)) {
      throw new SalonError('INVALID_TRANSITION', 'Karyawan sudah tidak berada di shift tersebut', 409)
    }
    if (on(theirs, row.requesterId) || on(mine, row.targetId)) {
      throw new SalonError('INVALID_TRANSITION', 'Karyawan sudah berada di shift tujuan', 409)
    }
    const exclude = [mine.id, theirs.id]
    const clash =
      (await clashFor(salon, store, row.targetId, mine, exclude, t)) ||
      (await clashFor(salon, store, row.requesterId, theirs, exclude, t))
    if (clash) {
      const who = on(clash, row.targetId) ? row.targetId : row.requesterId
      const names = await userNames([who], t)
      throw new SalonError('SLOT_TAKEN', `${names.get(who) || 'Karyawan'} punya shift lain di jam yang sama`, 409, {
        shiftId: String(clash.id)
      })
    }

    const swapOut = (w, out, inId) => [...(w.karyawan || []).map(Number).filter((u) => u !== out), inId]
    await theirs.update({ karyawan: swapOut(theirs, row.targetId, row.requesterId), modifiedBy: user.id }, { transaction: t })
    await mine.update({ karyawan: swapOut(mine, row.requesterId, row.targetId), modifiedBy: user.id }, { transaction: t })
    await decide(row, 'approved', user.id, t)
    return (await serializeSwaps([row], t))[0]
  })
})
