'use strict'

const { Op } = require('sequelize')
const db = require('../../db/models')
const { createAudit } = require('../../utils/auditLog')
const { createNotification } = require('../../utils/createNotification')
const { shiftEvents } = require('../../utils/shiftEvents')
const { scalarStoreScope } = require('../../utils/tenantScope')

const ShiftSwap = db.shift_swap
const User = db.user
const Shift = db.shift
const Location = db.location
const Attendance = db.attendance

const USER_BASE_ATTRIBUTES = [
  'id',
  'fullName',
  'store',
  'image',
  'roleType',
  'status'
]

const canViewSwapContacts = (req) =>
  ['super_admin', 'admin'].includes(req.user?.roleType)

const buildUserInclude = (req) => {
  const attributes = canViewSwapContacts(req)
    ? [...USER_BASE_ATTRIBUTES, 'email', 'phoneNumber']
    : USER_BASE_ATTRIBUTES

  return [
    {
      model: User,
      as: 'requesterUser',
      attributes,
      include: [
        { model: db.position, as: 'positionData' },
        { model: db.department, as: 'departmentData' },
        { model: Location, as: 'storeData' }
      ]
    },
    {
      model: User,
      as: 'targetUser',
      attributes,
      include: [
        { model: db.position, as: 'positionData' },
        { model: db.department, as: 'departmentData' },
        { model: Location, as: 'storeData' }
      ]
    }
  ]
}
const SHIFT_INCLUDE = [
  { model: Shift, as: 'requesterShift' },
  { model: Shift, as: 'targetShift' }
]

const DECIDER_INCLUDE = [
  {
    model: User,
    as: 'decidedByUser',
    attributes: ['id', 'fullName', 'userName'],
    required: false
  }
]

const isGlobalSuperAdmin = (req) =>
  req.user?.roleType === 'super_admin' && req.user?.store == null

const ownStoreId = (req) => {
  const store = Number(req.user?.store)
  return Number.isInteger(store) && store > 0 ? store : null
}

const resolveStore = (req) => {
  if (isGlobalSuperAdmin(req)) {
    return req.storeId ? Number(req.storeId) : null
  }
  return ownStoreId(req)
}

const swapScope = (req, where = {}) => {
  if (req?.authContext) return scalarStoreScope(req, where)
  if (isGlobalSuperAdmin(req)) return { ...where }
  const store = ownStoreId(req)
  return { ...where, store: store ?? -1 }
}

const getSwapWhere = (req, { includeStatus = true } = {}) => {
  const where = {}
  const store = resolveStore(req)
  if (store) where.store = store

  const { status, mine } = req.query
  const ownOnly = mine || !canViewSwapContacts(req)
  if (ownOnly) {
    where[Op.or] = [{ requesterId: req.user.id }, { targetId: req.user.id }]
  }
  if (includeStatus && status) {
    if (['pending', 'approved', 'rejected', 'cancelled', 'expired'].includes(status)) {
      where.status = status
    }
  }

  // Filter rentang tanggal (createdAt) untuk laporan audit 30 hari terakhir
  const { from, to } = req.query
  if (from || to) {
    where.createdAt = {}
    if (from) where.createdAt[Op.gte] = new Date(from)
    if (to) where.createdAt[Op.lte] = new Date(`${to}T23:59:59.999`)
  }
  return where
}

const normId = (v) => Number(v)

const toDateStr = (d) => {
  if (!d) return null
  const dt = new Date(`${String(d).slice(0, 10)}T00:00:00`)
  if (isNaN(dt.getTime())) return null
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(
    dt.getDate()
  ).padStart(2, '0')}`
}

const isOverlap = (aStart, aEnd, bStart, bEnd) => {
  const a1 = toDateStr(aStart)
  const a2 = toDateStr(aEnd) || a1
  const b1 = toDateStr(bStart)
  const b2 = toDateStr(bEnd) || b1
  if (!a1 || !b1) return false
  return a1 <= (b2 || a2) && (a2 || a1) >= b1
}

// Cek apakah seorang karyawan sudah punya shift LAGI (atau absensi) pada
// rentang tanggal yang diminta. excludeShiftIds = shift yang justru sedang
// ditukar (jangan dianggap bentrok).
const findDoubleShift = async ({ userId, tanggal_mulai, tanggal_selesai, excludeShiftIds = [] }) => {
  const id = normId(userId)
  if (isNaN(id)) return null

  const b1 = toDateStr(tanggal_mulai)
  const b2 = toDateStr(tanggal_selesai) || b1
  if (!b1) return null

  const shifts = await Shift.findAll({
    where: { karyawan: { [Op.contains]: [id] } }
  })

  const conflictingShift = shifts.find((s) => {
    if (excludeShiftIds.includes(normId(s.id))) return false
    if (s.status && s.status !== 'active' && s.status !== 'draft') return false
    return isOverlap(s.tanggal_mulai, s.tanggal_selesai, b1, b2)
  })
  if (conflictingShift) {
    return {
      reason: 'shift',
      detail: conflictingShift.name || `Shift #${conflictingShift.id}`
    }
  }

  const dayStart = new Date(`${b1}T00:00:00`)
  const dayEnd = new Date(`${b2}T00:00:00`)
  dayEnd.setDate(dayEnd.getDate() + 1)

  const attendance = await Attendance.findOne({
    where: {
      userId: id,
      absenAt: { [Op.gte]: dayStart, [Op.lt]: dayEnd },
      status: { [Op.ne]: 'cancelled' }
    }
  })
  if (attendance) {
    return { reason: 'attendance', detail: b1 }
  }
  return null
}

// Pindahkan seorang karyawan dari semua shift ke shift tujuan di dalam satu
// transaksi. Dipakai saat approval untuk benar-benar menukar jadwal.
const relocateEmployeeInTx = async (t, userId, toShiftId) => {
  const id = normId(userId)
  if (isNaN(id)) return

  const containing = await Shift.findAll({
    where: { karyawan: { [Op.contains]: [id] } },
    transaction: t,
    lock: t.LOCK.UPDATE
  })
  for (const shift of containing) {
    const karyawan = shift.karyawan || []
    const next = karyawan.filter((k) => normId(k) !== id)
    if (next.length !== karyawan.length) {
      await shift.update({ karyawan: next }, { transaction: t })
    }
  }

  const targetShiftId = normId(toShiftId)
  if (!isNaN(targetShiftId)) {
    const target = await Shift.findByPk(targetShiftId, {
      transaction: t,
      lock: t.LOCK.UPDATE
    })
    if (target) {
      const karyawan = target.karyawan || []
      if (!karyawan.some((k) => normId(k) === id)) {
        await target.update({ karyawan: [...karyawan, id] }, { transaction: t })
      }
    }
  }

  await User.update(
    { shift: isNaN(targetShiftId) ? null : targetShiftId },
    { where: { id }, transaction: t }
  )
}

exports.getShiftSwaps = async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 10))
    const offset = (page - 1) * pageSize

    const where = getSwapWhere(req)

    const [rows, count] = await Promise.all([
      ShiftSwap.findAll({
        where,
        include: [...buildUserInclude(req), ...SHIFT_INCLUDE, ...DECIDER_INCLUDE],
        order: [
          ['status', 'ASC'],
          ['createdAt', 'DESC']
        ],
        limit: pageSize,
        offset
      }),
      ShiftSwap.count({ where })
    ])

    const pendingWhere = { ...where, status: 'pending' }
    const approvedWhere = { ...where, status: 'approved' }
    const rejectedWhere = { ...where, status: 'rejected' }
    const expiredWhere = { ...where, status: 'expired' }

    const [pending, approved, rejectedTotal, expiredTotal, total] = await Promise.all([
      ShiftSwap.count({ where: pendingWhere }),
      ShiftSwap.count({ where: approvedWhere }),
      ShiftSwap.count({ where: rejectedWhere }),
      ShiftSwap.count({ where: expiredWhere }),
      ShiftSwap.count({ where })
    ])

    res.json({
      success: true,
      message: 'Berhasil mengambil data ubah jadwal',
      data: rows,
      pagination: {
        page,
        pageSize,
        totalPage: Math.ceil(count / pageSize),
        total: count
      },
      stats: {
        pending,
        approved,
        rejected: rejectedTotal,
        expired: expiredTotal,
        total
      }
    })
  } catch (error) {
    next(error)
  }
}

exports.createShiftSwap = async (req, res, next) => {
  try {
    const {
      store,
      requesterId,
      targetId,
      requesterShiftId,
      targetShiftId,
      tanggal_mulai,
      tanggal_selesai,
      note
    } = req.body

    if (!targetId || !requesterShiftId || !targetShiftId) {
      return res.status(400).json({
        success: false,
        message: 'Target, shift pemohon, dan shift target wajib diisi'
      })
    }

    const finalRequesterId = Number(requesterId) || req.user.id
    const isManager = ['admin', 'super_admin'].includes(req.user?.roleType)
    const isGlobalSuperAdmin =
      req.user?.roleType === 'super_admin' && req.user?.store == null

    if (!isManager && Number(finalRequesterId) !== Number(req.user.id)) {
      return res.status(403).json({
        success: false,
        message: 'Anda hanya dapat mengajukan ubah jadwal untuk diri sendiri'
      })
    }

    if (Number(finalRequesterId) === Number(targetId)) {
      return res.status(400).json({
        success: false,
        message: 'Tidak dapat mengubah jadwal dengan diri sendiri'
      })
    }

    const [requesterUser, targetUser, requesterShift, targetShift] =
      await Promise.all([
        User.findByPk(finalRequesterId),
        User.findByPk(targetId),
        Shift.findByPk(requesterShiftId),
        Shift.findByPk(targetShiftId)
      ])

    if (!requesterUser || requesterUser.userType !== 'user') {
      return res.status(404).json({
        success: false,
        message: 'Karyawan pemohon tidak ditemukan'
      })
    }
    if (!targetUser || targetUser.userType !== 'user') {
      return res.status(404).json({
        success: false,
        message: 'Karyawan target tidak ditemukan'
      })
    }
    if (!requesterShift || !targetShift) {
      return res.status(404).json({
        success: false,
        message: 'Shift tidak ditemukan'
      })
    }
    if (Number(requesterShiftId) === Number(targetShiftId)) {
      return res.status(400).json({
        success: false,
        message: 'Shift pemohon dan shift target harus berbeda'
      })
    }

    const targetStore = Number(targetUser.store)
    if (!Number.isInteger(targetStore) || targetStore <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Karyawan target belum ditetapkan ke toko'
      })
    }

    if (store != null && store !== '' && Number(store) !== targetStore) {
      return res.status(400).json({
        success: false,
        message: 'Toko permintaan tidak sesuai dengan toko karyawan target'
      })
    }

    if (!isGlobalSuperAdmin && Number(req.user?.store) !== targetStore) {
      return res.status(403).json({
        success: false,
        message: 'Anda hanya dapat membuat permintaan ubah jadwal di toko Anda'
      })
    }

    const requesterStore = Number(requesterUser.store)
    if (requesterStore !== targetStore) {
      return res.status(400).json({
        success: false,
        message: 'Ubah jadwal hanya dapat dilakukan dengan karyawan di toko yang sama'
      })
    }

    if (
      Number(requesterShift.store) !== targetStore ||
      Number(targetShift.store) !== targetStore
    ) {
      return res.status(403).json({
        success: false,
        message: 'Shift harus berasal dari toko karyawan yang sama'
      })
    }

    const shiftHasMember = (shift, userId) =>
      (shift.karyawan || []).map(Number).includes(Number(userId))

    if (
      !shiftHasMember(requesterShift, finalRequesterId) ||
      !shiftHasMember(targetShift, targetId)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Karyawan tidak terdaftar pada shift yang ditukar'
      })
    }

    const dup = await ShiftSwap.findOne({
      where: {
        requesterId: finalRequesterId,
        targetId: targetId,
        status: 'pending'
      }
    })
    if (dup) {
      return res.status(400).json({
        success: false,
        message: 'Masih ada permintaan ubah jadwal yang menunggu untuk karyawan yang sama'
      })
    }

    // Double Shift Detection: tolak pengajuan jika target sudah punya shift
    // lain (atau absensi) pada rentang tanggal yang sama. Shift yang sedang
    // ditukar (milik masing-masing) dikecualikan dari pengecekan.
    const swapDates = tanggal_mulai || tanggal_selesai
    if (swapDates) {
      const targetConflict = await findDoubleShift({
        userId: targetId,
        tanggal_mulai: tanggal_mulai || swapDates,
        tanggal_selesai: tanggal_selesai || swapDates,
        excludeShiftIds: [requesterShiftId, targetShiftId]
      })
      if (targetConflict) {
        return res.status(409).json({
          success: false,
          message:
            targetConflict.reason === 'shift'
              ? `${
                  targetUser.fullName || `Karyawan #${targetId}`
                } sudah memiliki shift lain pada tanggal tersebut: ${targetConflict.detail}`
              : `${
                  targetUser.fullName || `Karyawan #${targetId}`
                } sudah memiliki absensi pada tanggal ${targetConflict.detail}`
        })
      }

      const requesterConflict = await findDoubleShift({
        userId: finalRequesterId,
        tanggal_mulai: tanggal_mulai || swapDates,
        tanggal_selesai: tanggal_selesai || swapDates,
        excludeShiftIds: [requesterShiftId, targetShiftId]
      })
      if (requesterConflict) {
        return res.status(409).json({
          success: false,
          message:
            requesterConflict.reason === 'shift'
              ? `${
                  requesterUser?.fullName || `Karyawan #${finalRequesterId}`
                } sudah memiliki shift lain pada tanggal tersebut: ${requesterConflict.detail}`
              : `${
                  requesterUser?.fullName || `Karyawan #${finalRequesterId}`
                } sudah memiliki absensi pada tanggal ${requesterConflict.detail}`
        })
      }
    }

    const swapData = {
      store: targetStore,
      requesterId: finalRequesterId,
      targetId: Number(targetId),
      requesterShiftId: Number(requesterShiftId),
      targetShiftId: Number(targetShiftId),
      tanggal_mulai: tanggal_mulai || null,
      tanggal_selesai: tanggal_selesai || null,
      note: note || null,
      status: 'pending',
      status_history: [
        { status: 'pending', by: req.user.id, at: new Date().toISOString() }
      ],
      expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000)
    }

    const created = await ShiftSwap.create(swapData)

    await createAudit(
      req,
      'create',
      'shift_swap',
      created.id,
      `Permintaan ubah jadwal dibuat: ${requesterUser?.fullName || finalRequesterId} <-> ${targetUser.fullName}`
    )

    await createNotification({
      type: 'shift_swap_requested',
      store: targetStore,
      referenceId: created.id,
      referenceType: 'shift_swap',
      params: [
        requesterUser?.fullName || `Karyawan #${finalRequesterId}`,
        targetUser.fullName || `Karyawan #${targetId}`,
        tanggal_mulai || undefined
      ],
      createdBy: req.user.id
    })

    res.status(201).json({
      success: true,
      message: 'Permintaan ubah jadwal berhasil diajukan',
      data: created
    })
  } catch (error) {
    next(error)
  }
}

exports.updateShiftSwapStatus = async (req, res, next) => {
  const { id } = req.params
  const { status } = req.body

  const t = await db.sequelize.transaction()
  try {
    // Lock baris swap (tanpa include agar FOR UPDATE valid pada inner join)
    // IDOR fix: was findByPk(id) with no store filter — any admin could
    // approve/reject another store's shift swap, actually relocating real
    // employees between shifts. scalarStoreScope adds `store` to the where
    // clause for non-super-admin.
    const swap = await ShiftSwap.findOne({
      where: swapScope(req, { id }),
      transaction: t,
      lock: t.LOCK.UPDATE
    })

    if (!swap) {
      await t.rollback()
      return res.status(404).json({
        success: false,
        message: 'Permintaan ubah jadwal tidak ditemukan'
      })
    }

    if (swap.status !== 'pending') {
      await t.rollback()
      return res.status(400).json({
        success: false,
        message: 'Permintaan ini sudah diputuskan sebelumnya'
      })
    }

    if (!['approved', 'rejected'].includes(status)) {
      await t.rollback()
      return res.status(400).json({
        success: false,
        message: 'Status harus approved atau rejected'
      })
    }

    const statusHistory = Array.isArray(swap.status_history)
      ? swap.status_history
      : []

    if (status === 'approved') {
      // Eksekusi perpindahan jadwal (ACID): pemohon ke shift target, target ke shift pemohon
      await relocateEmployeeInTx(t, swap.requesterId, swap.targetShiftId)
      await relocateEmployeeInTx(t, swap.targetId, swap.requesterShiftId)
    }

    await swap.update(
      {
        status,
        decidedBy: req.user.id,
        decidedAt: new Date(),
        status_history: [
          ...statusHistory,
          { status, by: req.user.id, at: new Date().toISOString() }
        ]
      },
      { transaction: t }
    )

    // Data lengkap untuk respons di-fetch SETELAH update (dalam transaksi yang sama)
    const fullSwap = await ShiftSwap.findByPk(id, {
      transaction: t,
      include: [...buildUserInclude(req), ...SHIFT_INCLUDE, ...DECIDER_INCLUDE]
    })

    await createAudit(
      req,
      'update',
      'shift_swap',
      swap.id,
      `Permintaan ubah jadwal ${status}: ${fullSwap?.requesterUser?.fullName || swap.requesterId} <-> ${fullSwap?.targetUser?.fullName || swap.targetId}`,
      { status: 'pending' },
      { status, decidedBy: req.user.id },
      t
    )

    await t.commit()

    // Event bus: konsumen (mis. payroll) bisa mendengar perpindahan jadwal
    if (status === 'approved') {
      shiftEvents.emit('shift:swapped', {
        swapId: swap.id,
        requesterId: swap.requesterId,
        targetId: swap.targetId,
        requesterShiftId: swap.requesterShiftId,
        targetShiftId: swap.targetShiftId
      })
    }

    // Notifikasi setelah commit (jangan di-inject ke transaksi)
    const requesterName = fullSwap?.requesterUser?.fullName || `Karyawan #${swap.requesterId}`
    const targetName = fullSwap?.targetUser?.fullName || `Karyawan #${swap.targetId}`
    await createNotification({
      type: status === 'approved' ? 'shift_swap_approved' : 'shift_swap_rejected',
      store: swap.store,
      referenceId: swap.id,
      referenceType: 'shift_swap',
      params: [requesterName, targetName],
      createdBy: req.user.id
    })

    res.json({
      success: true,
      message: status === 'approved' ? 'Permintaan disetujui' : 'Permintaan ditolak',
      data: fullSwap
    })
  } catch (error) {
    await t.rollback()
    next(error)
  }
}

exports.cancelShiftSwap = async (req, res, next) => {
  const { id } = req.params
  const t = await db.sequelize.transaction()
  try {
    // IDOR fix: was findByPk(id) with no store filter — the isAdmin
    // bypass below let any admin cancel any store's swap regardless. Now
    // a cross-store admin never finds the row in the first place; the
    // isAdmin bypass still applies (unchanged) once ownership is confirmed
    // — i.e. any admin of the OWNING store, not just the two employees
    // involved, can still cancel it.
    const swap = await ShiftSwap.findOne({
      where: swapScope(req, { id }),
      transaction: t,
      lock: t.LOCK.UPDATE
    })

    if (!swap) {
      await t.rollback()
      return res.status(404).json({
        success: false,
        message: 'Permintaan ubah jadwal tidak ditemukan'
      })
    }

    if (swap.status !== 'pending') {
      await t.rollback()
      return res.status(400).json({
        success: false,
        message: 'Permintaan ini sudah diputuskan sebelumnya'
      })
    }

    const isAdmin =
      req.user.roleType === 'super_admin' || req.user.roleType === 'admin'
    const involved =
      String(req.user.id) === String(swap.requesterId) ||
      String(req.user.id) === String(swap.targetId)
    if (!isAdmin && !involved) {
      await t.rollback()
      return res.status(403).json({
        success: false,
        message: 'Anda tidak berhak membatalkan permintaan ini'
      })
    }

    const statusHistory = Array.isArray(swap.status_history)
      ? swap.status_history
      : []

    await swap.update(
      {
        status: 'cancelled',
        decidedBy: req.user.id,
        decidedAt: new Date(),
        status_history: [
          ...statusHistory,
          { status: 'cancelled', by: req.user.id, at: new Date().toISOString() }
        ]
      },
      { transaction: t }
    )

    const fullSwap = await ShiftSwap.findByPk(id, {
      transaction: t,
      include: [...buildUserInclude(req), ...SHIFT_INCLUDE, ...DECIDER_INCLUDE]
    })

    await createAudit(
      req,
      'update',
      'shift_swap',
      swap.id,
      `Permintaan ubah jadwal dibatalkan: ${fullSwap?.requesterUser?.fullName || swap.requesterId} <-> ${fullSwap?.targetUser?.fullName || swap.targetId}`,
      { status: 'pending' },
      { status: 'cancelled', decidedBy: req.user.id },
      t
    )

    await t.commit()

    // Notifikasi setelah commit (jangan di-inject ke transaksi)
    const requesterName = fullSwap?.requesterUser?.fullName || `Karyawan #${swap.requesterId}`
    const targetName = fullSwap?.targetUser?.fullName || `Karyawan #${swap.targetId}`
    await createNotification({
      type: 'shift_swap_cancelled',
      store: swap.store,
      referenceId: swap.id,
      referenceType: 'shift_swap',
      params: [requesterName, targetName],
      createdBy: req.user.id
    })

    res.json({
      success: true,
      message: 'Permintaan dibatalkan',
      data: fullSwap
    })
  } catch (error) {
    await t.rollback()
    next(error)
  }
}