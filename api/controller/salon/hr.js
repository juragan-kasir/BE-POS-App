'use strict'

const { Op } = require('sequelize')
const db = require('../../../db/models')
const { salonRoute, withStatus } = require('./http')
const { SalonError } = require('../../service/salonContext')
const { PositionInput, WorkShiftInput, WorkShiftRange } = require('../../validation/salonSchemas')
const { idParam, notFound, hhmm, iEquals } = require('./shared')

// Salon HR adapters over the shared tables (plan decision 4: no new tables).
//
//   positions   → `position` rows of the tenant (store NULL = tenant-wide).
//   work shifts → `shift` rows of the outlet (tipe_shift harian|mingguan,
//                 tanggal_mulai/selesai, karyawan = user ids). Unlike the
//                 FE-POS flow, a salon employee may hold several shifts, so
//                 user.shift is not synced (utils/shiftChain is the FE-POS
//                 one-shift-per-employee model); overlap of ACTIVE shifts
//                 per employee is refused instead.

// ---------- positions ----------

const serializePosition = (p) => ({
  id: String(p.id),
  name: p.name,
  description: p.description || '',
  active: (p.status || 'active') === 'active'
})

const findPosition = async (salon, id, transaction) => {
  const row = await db.position.findOne({
    where: { id: idParam(id, 'Jabatan tidak ditemukan'), tenantId: salon.tenant.id },
    transaction
  })
  if (!row) throw notFound('Jabatan tidak ditemukan')
  return row
}

const assertPositionNameFree = async (salon, name, excludeId, transaction) => {
  const clash = await db.position.findOne({
    where: {
      tenantId: salon.tenant.id,
      ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}),
      [Op.and]: [iEquals('name', name)]
    },
    attributes: ['id'],
    transaction
  })
  if (clash) throw new SalonError('DUPLICATE', 'Nama jabatan sudah dipakai', 409, { field: 'name' })
}

exports.listPositions = salonRoute({ perm: 'employee.read' }, async ({ salon }) => {
  const rows = await db.position.findAll({ where: { tenantId: salon.tenant.id }, order: [['name', 'ASC']] })
  return { data: rows.map(serializePosition) }
})

exports.createPosition = salonRoute({ perm: 'employee.manage' }, async ({ salon, user, body }) => {
  const input = PositionInput.parse(body)
  const row = await db.sequelize.transaction(async (t) => {
    await assertPositionNameFree(salon, input.name, null, t)
    return db.position.create(
      {
        name: input.name,
        description: input.description,
        status: input.active ? 'active' : 'inactive',
        tenantId: salon.tenant.id,
        store: null,
        createdBy: user.id
      },
      { transaction: t }
    )
  })
  return withStatus(201, serializePosition(row))
})

exports.updatePosition = salonRoute({ perm: 'employee.manage' }, async ({ salon, user, body, params }) => {
  const input = PositionInput.parse(body)
  const row = await db.sequelize.transaction(async (t) => {
    const position = await findPosition(salon, params.id, t)
    await assertPositionNameFree(salon, input.name, position.id, t)
    // Staff show the position by id, so a rename reaches them by itself.
    return position.update(
      {
        name: input.name,
        description: input.description,
        status: input.active ? 'active' : 'inactive',
        modifiedBy: user.id
      },
      { transaction: t }
    )
  })
  return serializePosition(row)
})

exports.deletePosition = salonRoute({ perm: 'employee.manage' }, async ({ salon, params }) => {
  const row = await db.sequelize.transaction(async (t) => {
    const position = await findPosition(salon, params.id, t)
    const used = await db.salon_staff_profile.count({
      where: { tenantId: salon.tenant.id, positionId: position.id },
      transaction: t
    })
    if (used > 0) throw new SalonError('IN_USE', 'Jabatan masih dipakai karyawan', 409, { staff: used })
    await position.destroy({ transaction: t })
    return position
  })
  return serializePosition(row)
})

// ---------- work shifts ----------

const serializeWorkShift = (w) => ({
  id: String(w.id),
  store: String(w.store),
  name: w.name,
  type: w.tipe_shift === 'mingguan' ? 'mingguan' : 'harian',
  startDate: w.tanggal_mulai,
  endDate: w.tipe_shift === 'mingguan' ? w.tanggal_selesai : null,
  startTime: hhmm(w.startTime),
  endTime: hhmm(w.endTime),
  employeeIds: (Array.isArray(w.karyawan) ? w.karyawan : []).map(String),
  status: ['draft', 'active', 'inactive'].includes(w.status) ? w.status : 'inactive'
})

const findWorkShift = async (salon, store, id, transaction) => {
  const row = await db.shift.findOne({
    where: { id: idParam(id, 'Shift tidak ditemukan'), tenantId: salon.tenant.id, store: store.id },
    transaction
  })
  if (!row) throw notFound('Shift tidak ditemukan')
  return row
}

/** Every employee must be a salon staff member of this outlet. */
const assertShiftEmployees = async (salon, store, employeeIds, transaction) => {
  const ids = [...new Set(employeeIds.map((id) => idParam(id, 'Karyawan tidak ada di outlet ini')))]
  if (!ids.length) return ids
  const rows = await db.salon_staff_profile.findAll({
    where: { tenantId: salon.tenant.id, store: store.id, userId: ids },
    attributes: ['userId'],
    transaction
  })
  const known = new Set(rows.map((r) => r.userId))
  const missing = ids.find((id) => !known.has(id))
  if (missing) throw new SalonError('NOT_FOUND', 'Karyawan tidak ada di outlet ini', 404, { userId: String(missing) })
  return ids
}

/** An employee may not hold two ACTIVE shifts overlapping in date and time. */
const assertNoShiftConflict = async (salon, store, input, employeeIds, excludeId, transaction) => {
  if (input.status !== 'active' || !employeeIds.length) return
  const start = input.startDate
  const end = input.endDate ?? input.startDate
  const candidates = await db.shift.findAll({
    where: {
      tenantId: salon.tenant.id,
      store: store.id,
      status: 'active',
      ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}),
      tanggal_mulai: { [Op.lte]: end },
      startTime: { [Op.lt]: input.endTime },
      endTime: { [Op.gt]: input.startTime }
    },
    transaction
  })
  for (const userId of employeeIds) {
    const clash = candidates.find((w) => {
      const wEnd = w.tanggal_selesai ?? w.tanggal_mulai
      return wEnd >= start && (w.karyawan || []).map(Number).includes(userId)
    })
    if (clash) {
      const staff = await db.user.findByPk(userId, { attributes: ['fullName', 'userName'], transaction })
      throw new SalonError(
        'SLOT_TAKEN',
        `${staff?.fullName || staff?.userName || 'Karyawan'} sudah punya shift aktif di tanggal & jam itu`,
        409,
        { userId: String(userId), shiftId: String(clash.id) }
      )
    }
  }
}

// Serialize writes per outlet so two requests cannot both pass the overlap check.
const lockOutletShifts = (store, transaction) =>
  db.sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', {
    replacements: { key: `salon_work_shift:${store.id}` },
    transaction
  })

const shiftValues = (input, employeeIds) => ({
  name: input.name,
  tipe_shift: input.type,
  tanggal_mulai: input.startDate,
  tanggal_selesai: input.type === 'mingguan' ? input.endDate : null,
  startTime: input.startTime,
  endTime: input.endTime,
  karyawan: employeeIds,
  status: input.status
})

exports.listWorkShifts = salonRoute({ perm: ['employee.read', 'appointment.read'], store: true }, async ({ salon, store, user, query }) => {
  const range = WorkShiftRange.parse({ from: query.from || undefined, to: query.to || undefined })
  const where = { tenantId: salon.tenant.id, store: store.id }
  const and = []
  if (range.to) where.tanggal_mulai = { [Op.lte]: range.to }
  if (range.from) {
    and.push(db.sequelize.where(db.sequelize.fn('COALESCE', db.sequelize.col('tanggal_selesai'), db.sequelize.col('tanggal_mulai')), { [Op.gte]: range.from }))
  }
  // A stylist sees only the shifts they are on (DR-SLN-15).
  if (salon.canonicalRole === 'staff') {
    and.push(db.sequelize.literal(`"karyawan" @> '${JSON.stringify([Number(user.id)])}'::jsonb`))
  }
  if (and.length) where[Op.and] = and
  const rows = await db.shift.findAll({
    where,
    order: [['tanggal_mulai', 'ASC'], ['startTime', 'ASC'], ['id', 'ASC']]
  })
  return { data: rows.map(serializeWorkShift) }
})

exports.createWorkShift = salonRoute({ perm: 'shift.manage', store: true }, async ({ salon, store, user, body }) => {
  const input = WorkShiftInput.parse(body)
  const row = await db.sequelize.transaction(async (t) => {
    await lockOutletShifts(store, t)
    const employeeIds = await assertShiftEmployees(salon, store, input.employeeIds, t)
    await assertNoShiftConflict(salon, store, input, employeeIds, null, t)
    return db.shift.create(
      { ...shiftValues(input, employeeIds), store: store.id, createdBy: user.id },
      { transaction: t }
    )
  })
  return withStatus(201, serializeWorkShift(row))
})

exports.updateWorkShift = salonRoute({ perm: 'shift.manage', store: true }, async ({ salon, store, user, body, params }) => {
  const input = WorkShiftInput.parse(body)
  const row = await db.sequelize.transaction(async (t) => {
    await lockOutletShifts(store, t)
    const shift = await findWorkShift(salon, store, params.id, t)
    const employeeIds = await assertShiftEmployees(salon, store, input.employeeIds, t)
    await assertNoShiftConflict(salon, store, input, employeeIds, shift.id, t)
    return shift.update({ ...shiftValues(input, employeeIds), modifiedBy: user.id }, { transaction: t })
  })
  return serializeWorkShift(row)
})

exports.deleteWorkShift = salonRoute({ perm: 'shift.manage', store: true }, async ({ salon, store, params }) => {
  const row = await db.sequelize.transaction(async (t) => {
    const shift = await findWorkShift(salon, store, params.id, t)
    await shift.destroy({ transaction: t })
    return shift
  })
  return serializeWorkShift(row)
})
