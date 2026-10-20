'use strict'

const { Op } = require('sequelize')
const db = require('../../db/models')
const { createAudit } = require('../../utils/auditLog')
const { createNotification } = require('../../utils/createNotification')

const Overtime = db.overtime
const User = db.user
const Shift = db.shift
const Location = db.location
const { postOvertimePayrollJournal } = require('../service/accountingService')

const EMPLOYEE_INCLUDE = [
  {
    model: User,
    as: 'employee',
    attributes: [
      'id',
      'fullName',
      'userName',
      'email',
      'phoneNumber',
      'store',
      'image',
      'roleType',
      'status',
      'monthlySalary',
      'dailySalary',
      'overtimeRate',
      'overtimeFactor'
    ],
    include: [
      { model: db.position, as: 'positionData' },
      { model: db.department, as: 'departmentData' },
      { model: Location, as: 'storeData' }
    ]
  }
]

const DECIDER_INCLUDE = [
  {
    model: User,
    as: 'decidedByUser',
    attributes: ['id', 'fullName', 'userName'],
    required: false
  }
]

const SHIFT_INCLUDE = [
  { model: Shift, as: 'shift', attributes: ['id', 'name', 'startTime', 'endTime'] }
]

const normId = (v) => Number(v)

const toDateStr = (d) => {
  if (!d) return null
  const dt = new Date(`${String(d).slice(0, 10)}T00:00:00`)
  if (isNaN(dt.getTime())) return null
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(
    dt.getDate()
  ).padStart(2, '0')}`
}

// Durasi lembur (jam) dari dua waktu HH:MM, menangani lintas tengah malam.
const hoursBetween = (start, end) => {
  const [ah, am] = String(start || '').split(':').map(Number)
  const [bh, bm] = String(end || '').split(':').map(Number)
  if ([ah, am, bh, bm].some((n) => isNaN(n))) return null
  let minutes = bh * 60 + bm - (ah * 60 + am)
  if (minutes === 0) return null
  if (minutes < 0) minutes += 1440
  return Math.round((minutes / 60) * 100) / 100
}

const isOverlap = (aStart, aEnd, bStart, bEnd) => {
  const a1 = toDateStr(aStart)
  const a2 = toDateStr(aEnd) || a1
  const b1 = toDateStr(bStart)
  const b2 = toDateStr(bEnd) || b1
  if (!a1 || !b1) return false
  return a1 <= (b2 || a2) && (a2 || a1) >= b1
}

// Scoping toko: super_admin bebas memilih, selain itu selalu terpaku ke toko sendiri.
const resolveStoreId = (req, requested) => {
  if (req.user?.roleType === 'super_admin') {
    return Number(requested) || req.storeId || null
  }
  return req.storeId || (req.user?.store ? Number(req.user.store) : null)
}

// Apakah dua rentang jam (HH:MM, dukung lintas tengah malam) saling tumpang tindih.
const timeToMinutes = (t) => {
  const [hh, mm] = String(t || '').split(':').map(Number)
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null
  return hh * 60 + mm
}
const timesOverlap = (aStart, aEnd, bStart, bEnd) => {
  const a1 = timeToMinutes(aStart)
  const a2 = timeToMinutes(aEnd)
  const b1 = timeToMinutes(bStart)
  const b2 = timeToMinutes(bEnd)
  if ([a1, a2, b1, b2].some((v) => v === null)) return false
  const win = (x1, x2) => (x2 > x1 ? [x1, x2] : [x1, x2 + 1440])
  const [wa1, wa2] = win(a1, a2)
  const [wb1, wb2] = win(b1, b2)
  return Math.max(wa1, wb1) < Math.min(wa2, wb2)
}

const getWhere = (req) => {
  const where = {}
  const { store } = req.query
  if (req.user?.roleType === 'super_admin') {
    if (store) where.store = Number(store)
  } else {
    where.store = req.user?.store ? Number(req.user.store) : req.storeId
  }

  const { status, mine, from, to } = req.query
  if (mine) where.employee_id = req.user.id
  if (status && ['pending', 'approved', 'rejected', 'cancelled'].includes(status)) {
    where.status = status
  }
  if (from || to) {
    where.date = {}
    if (from) where.date[Op.gte] = String(from).slice(0, 10)
    if (to) where.date[Op.lte] = String(to).slice(0, 10)
  }
  return where
}

const notify = (type, { store, referenceId }, params, createdBy) =>
  createNotification({
    type,
    store,
    referenceId,
    referenceType: 'overtime',
    params,
    createdBy
  })

exports.getOvertimes = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1
    const pageSize = parseInt(req.query.pageSize) || 10
    const offset = (page - 1) * pageSize
    const where = getWhere(req)

    const [rows, count] = await Promise.all([
      Overtime.findAll({
        where,
        include: [...EMPLOYEE_INCLUDE, ...SHIFT_INCLUDE, ...DECIDER_INCLUDE],
        order: [['date', 'DESC'], ['createdAt', 'DESC']],
        limit: pageSize,
        offset
      }),
      Overtime.count({ where })
    ])

    const stats = await Promise.all(
      ['pending', 'approved', 'rejected', 'cancelled'].map((s) =>
        Overtime.count({ where: { ...where, status: s } })
      )
    )

    res.json({
      success: true,
      message: 'Berhasil mengambil data lembur',
      data: rows,
      pagination: {
        page,
        pageSize,
        totalPage: Math.ceil(count / pageSize),
        total: count
      },
      stats: {
        pending: stats[0],
        approved: stats[1],
        rejected: stats[2],
        cancelled: stats[3]
      }
    })
  } catch (error) {
    next(error)
  }
}

exports.createOvertime = async (req, res, next) => {
  try {
    const {
      store,
      shift_id,
      employee_id,
      date,
      start_time,
      end_time,
      note
    } = req.body

    const finalEmployeeId = Number(employee_id) || req.user.id // nosemgrep: otoritas diverifikasi di baris berikut; Sequelize, bukan NoSQL
    if (Number(finalEmployeeId) !== req.user.id &&
        !['super_admin', 'admin'].includes(req.user.roleType)) {
      return res.status(403).json({
        success: false,
        message: 'Anda hanya dapat mengajukan lembur untuk diri sendiri'
      })
    }

    const [employee, shift] = await Promise.all([
      User.findByPk(finalEmployeeId),
      Shift.findByPk(shift_id)
    ])

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: 'Karyawan tidak ditemukan'
      })
    }
    if (!shift) {
      return res.status(404).json({
        success: false,
        message: 'Shift tidak ditemukan'
      })
    }

    // Aturan bisnis: lembur harus terkait shift yang valid & karyawan terdaftar
    const members = shift.karyawan || []
    if (!members.some((k) => normId(k) === finalEmployeeId)) {
      return res.status(400).json({
        success: false,
        message: 'Karyawan tidak terdaftar pada shift tersebut'
      })
    }

    const storeId = req.user?.roleType === 'super_admin'
      ? Number(store) || employee.store
      : Number(employee.store || req.user.store || req.storeId)

    // Lembur tidak boleh melebihi aturan shift yang sudah ada:
    // rentang tanggal lembur harus masih dalam rentang shift.
    const shiftEnd = toDateStr(shift.tanggal_selesai)
    const shiftStart = toDateStr(shift.tanggal_mulai)
    const otDate = toDateStr(date)
    if (shiftStart && otDate && otDate < shiftStart) {
      return res.status(400).json({
        success: false,
        message: 'Tanggal lembur sebelum tanggal mulai shift'
      })
    }
    if (shiftEnd && otDate && otDate > shiftEnd) {
      return res.status(400).json({
        success: false,
        message: 'Tanggal lembur melewati tanggal selesai shift'
      })
    }

    const duration = hoursBetween(start_time, end_time)
    if (duration === null || duration <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Durasi lembur tidak valid (end_time harus setelah start_time)'
      })
    }

    // Bentrok jadwal: sudah ada lembur aktif (pending/approved) di tanggal sama
    const [dupOt, shiftConflict] = await Promise.all([
      Overtime.findOne({
        where: {
          employee_id: finalEmployeeId,
          date: otDate,
          status: { [Op.in]: ['pending', 'approved'] }
        }
      }),
      Shift.findAll({
        where: { karyawan: { [Op.contains]: [finalEmployeeId] } }
      })
    ])
    if (dupOt) {
      return res.status(409).json({
        success: false,
        message: 'Sudah ada pengajuan lembur pada tanggal tersebut'
      })
    }

    const conflictingShift = shiftConflict.find(
      (s) =>
        normId(s.id) !== normId(shift_id) &&
        isOverlap(s.tanggal_mulai, s.tanggal_selesai, otDate, otDate) &&
        timesOverlap(s.startTime, s.endTime, start_time, end_time)
    )
    if (conflictingShift) {
      return res.status(409).json({
        success: false,
        message: `Bentrok jadwal: pada tanggal tersebut karyawan memiliki shift lain (${
          conflictingShift.name || `#${conflictingShift.id}`
        }) yang waktunya tumpang tindih dengan lembur yang diajukan`
      })
    }

    const created = await Overtime.create({
      store: storeId,
      shift_id: normId(shift_id),
      employee_id: finalEmployeeId,
      date: otDate,
      start_time: String(start_time).slice(0, 5),
      end_time: String(end_time).slice(0, 5),
      duration_hours: duration,
      note: note || null,
      status: 'pending',
      status_history: [
        { status: 'pending', by: req.user.id, at: new Date().toISOString() }
      ],
      accounting_status: 'unposted'
    })

    await createAudit(
      req,
      'create',
      'overtime',
      created.id,
      `Pengajuan lembur dibuat: ${employee.fullName || finalEmployeeId} (${numberToHourLabel(duration)}) pada ${otDate}`
    )

    await notify(
      'overtime_requested',
      { store: storeId, referenceId: created.id },
      [employee.fullName || `Karyawan #${finalEmployeeId}`, otDate, String(duration).replace('.', ',')],
      req.user.id
    )

    res.status(201).json({
      success: true,
      message: 'Pengajuan lembur berhasil dibuat',
      data: created
    })
  } catch (error) {
    next(error)
  }
}

const numberToHourLabel = (n) => {
  const v = Number(n) || 0
  return `${v.toLocaleString('id-ID')} jam`
}

exports.updateOvertimeStatus = async (req, res, next) => {
  const { id } = req.params
  const { status, note } = req.body
  const t = await db.sequelize.transaction()
  try {
    const ot = await Overtime.findByPk(id, {
      transaction: t,
      lock: t.LOCK.UPDATE
    })
    if (!ot) {
      await t.rollback()
      return res.status(404).json({
        success: false,
        message: 'Pengajuan lembur tidak ditemukan'
      })
    }
    if (ot.status !== 'pending') {
      await t.rollback()
      return res.status(400).json({
        success: false,
        message: 'Pengajuan ini sudah diputuskan sebelumnya'
      })
    }
    // Scoping toko: admin hanya dapat memutuskan untuk tokonya sendiri.
    const scopeStore = resolveStoreId(req, ot.store)
    if (scopeStore && Number(ot.store) !== Number(scopeStore)) {
      await t.rollback()
      return res.status(403).json({
        success: false,
        message: 'Anda hanya dapat menyetujui lembur di toko Anda'
      })
    }
    // Aturan bisnis: data yang sudah di-post tidak boleh diubah
    if (ot.accounting_status === 'posted') {
      await t.rollback()
      return res.status(400).json({
        success: false,
        message: 'Lembur sudah diposting ke akuntansi dan tidak dapat diubah'
      })
    }

    const history = Array.isArray(ot.status_history) ? ot.status_history : []
    await ot.update(
      {
        status,
        decidedBy: req.user.id,
        decidedAt: new Date(),
        status_history: [
          ...history,
          { status, by: req.user.id, at: new Date().toISOString(), note: note || null }
        ]
      },
      { transaction: t }
    )

    const employee = await User.findByPk(ot.employee_id, { transaction: t })

    await createAudit(
      req,
      'update',
      'overtime',
      ot.id,
      `Pengajuan lembur ${status} (${ot.date}): ${employee?.fullName || ot.employee_id}${note ? ` — ${note}` : ''}`,
      { status: 'pending' },
      { status, decidedBy: req.user.id, note: note || null },
      t
    )

    await t.commit()

    await notify(
      status === 'approved' ? 'overtime_approved' : 'overtime_rejected',
      { store: ot.store, referenceId: ot.id },
      [employee?.fullName || `Karyawan #${ot.employee_id}`, ot.date, note || undefined],
      req.user.id
    )

    res.json({
      success: true,
      message: status === 'approved' ? 'Pengajuan lembur disetujui' : 'Pengajuan lembur ditolak',
      data: ot
    })
  } catch (error) {
    await t.rollback()
    next(error)
  }
}

exports.cancelOvertime = async (req, res, next) => {
  const { id } = req.params
  const t = await db.sequelize.transaction()
  try {
    const ot = await Overtime.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE })
    if (!ot) {
      await t.rollback()
      return res.status(404).json({ success: false, message: 'Pengajuan lembur tidak ditemukan' })
    }
    if (ot.status !== 'pending') {
      await t.rollback()
      return res.status(400).json({ success: false, message: 'Pengajuan ini sudah diputuskan sebelumnya' })
    }
    const isAdmin = ['super_admin', 'admin'].includes(req.user.roleType)
    if (!isAdmin && String(ot.employee_id) !== String(req.user.id)) {
      await t.rollback()
      return res.status(403).json({ success: false, message: 'Anda tidak berhak membatalkan pengajuan ini' })
    }
    const scopeStore = resolveStoreId(req, ot.store)
    if (scopeStore && Number(ot.store) !== Number(scopeStore)) {
      await t.rollback()
      return res.status(403).json({ success: false, message: 'Anda hanya dapat membatalkan lembur di toko Anda' })
    }

    const history = Array.isArray(ot.status_history) ? ot.status_history : []
    await ot.update(
      {
        status: 'cancelled',
        decidedBy: req.user.id,
        decidedAt: new Date(),
        status_history: [
          ...history,
          { status: 'cancelled', by: req.user.id, at: new Date().toISOString() }
        ]
      },
      { transaction: t }
    )

    await createAudit(
      req,
      'update',
      'overtime',
      ot.id,
      `Pengajuan lembur dibatalkan (${ot.date})`,
      { status: 'pending' },
      { status: 'cancelled', decidedBy: req.user.id },
      t
    )

    await t.commit()
    res.json({ success: true, message: 'Pengajuan dibatalkan', data: ot })
  } catch (error) {
    await t.rollback()
    next(error)
  }
}

// Closing payroll: agregasi lembur `approved` dalam satu bulan per karyawan,
// kalikan jam × rate overtime, buat jurnal (6100/2200), lalu flag `posted`.
// Dedup per (store, periode) lewat accountingService mencegah double posting.
exports.postOvertimePayroll = async (req, res, next) => {
  const { month } = req.body
  const [year, mon] = String(month || '').split('-').map(Number)
  if (!year || !mon || mon < 1 || mon > 12) {
    return res.status(400).json({
      success: false,
      message: 'Bulan tidak valid (format YYYY-MM)'
    })
  }
  const store = resolveStoreId(req, req.body.store)

  const t = await db.sequelize.transaction()
  try {
    const approved = await Overtime.findAll({
      where: {
        store: store || undefined,
        status: 'approved',
        accounting_status: { [Op.ne]: 'posted' },
        date: { [Op.gte]: `${year}-${String(mon).padStart(2, '0')}-01` }
      },
      transaction: t,
      lock: t.LOCK.UPDATE
    })

    const rows = approved.filter(
      (o) => String(o.date).startsWith(`${year}-${String(mon).padStart(2, '0')}`)
    )
    if (rows.length === 0) {
      await t.rollback()
      return res.status(200).json({
        success: true,
        message: 'Tidak ada lembur disetujui pada periode tersebut',
        data: { posted: 0, totalAmount: 0 }
      })
    }

    const employees = await User.findAll({
      where: { id: { [Op.in]: [...new Set(rows.map((r) => r.employee_id))] } },
      transaction: t
    })
    const empMap = new Map(employees.map((e) => [e.id, e]))

    const lines = rows.map((r) => {
      const emp = empMap.get(r.employee_id) || {}
      const rate =
        Number(emp.overtimeRate) ||
        (emp.dailySalary ? Number(emp.dailySalary) / 8 : 0)
      const hours = Number(r.duration_hours) || 0
      const amount = Math.round(hours * rate * 100) / 100
      return {
        employeeId: r.employee_id,
        employeeName: emp.fullName,
        hours,
        amount
      }
    })

    const storeList = [...new Set(rows.map((r) => r.store))]

    // Pertama buat jurnal (dedup by sourceType+referenceId di dalam transaksi)
    let entry = null
    let lastErr = null
    for (const s of storeList) {
      const storeLines = lines.filter(
        (l) => rows.find((r) => r.employee_id === l.employeeId)?.store === s
      )
      try {
        const created = await postOvertimePayrollJournal({
          store: s,
          period: String(month),
          lines: storeLines,
          date: new Date(`${year}-${String(mon).padStart(2, '0')}-01`),
          createdBy: req.user.id,
          transaction: t
        })
        if (created) entry = created
      } catch (err) {
        lastErr = err
        console.error('postOvertimePayrollJournal error:', err.message)
      }
    }
    if (!entry && lastErr) {
      throw lastErr
    }

    for (const r of rows) {
      await r.update(
        {
          accounting_status: 'posted',
          postedAt: new Date(),
          journalId: entry?.id || r.journalId || null
        },
        { transaction: t }
      )
    }

    const totalAmount = Math.round(
      lines.reduce((s, l) => s + l.amount, 0) * 100
    ) / 100

    await createAudit(
      req,
      'update',
      'overtime',
      rows.map((r) => r.id).join(','),
      `Posting lembur periode ${month}: ${rows.length} pengajuan, total ${totalAmount.toLocaleString('id-ID')}`
    )

    await t.commit()

    res.json({
      success: true,
      message: `Berhasil memposting ${rows.length} lembur ke akuntansi`,
      data: {
        posted: rows.length,
        totalAmount,
        journalId: entry?.id || null,
        entryNumber: entry?.entryNumber || null
      }
    })
  } catch (error) {
    await t.rollback()
    next(error)
  }
}

module.exports = {
  getOvertimes: exports.getOvertimes,
  createOvertime: exports.createOvertime,
  updateOvertimeStatus: exports.updateOvertimeStatus,
  cancelOvertime: exports.cancelOvertime,
  postOvertimePayroll: exports.postOvertimePayroll
}