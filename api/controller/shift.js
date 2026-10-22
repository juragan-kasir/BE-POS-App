const { Op } = require('sequelize')
const db = require('../../db/models')
const Shift = db.shift
const User = db.user
const { DEFAULT_SHIFT_TYPE, SHIFT_TYPES } = require('../../utils/shiftConstants')
const { createAudit } = require('../../utils/auditLog')
const { enrichAuditFields } = require('../../utils/auditFields')
const {
  syncShiftKaryawan,
  clearRemovedMembers,
  validateEmployeeStoreMembership,
  ShiftAssignmentError
} = require('../../utils/shiftChain')
const { scalarStoreScope, isSuperAdmin } = require('../../utils/tenantScope')
const { authorizedStoreIds } = require('../../utils/storeValidation')

const isGlobalSuperAdmin = (req) => isSuperAdmin(req) && req.user?.store == null

const ownStoreId = (req) => {
  const store = Number(req.user?.store)
  return Number.isInteger(store) && store > 0 ? store : null
}

const shiftScope = (req, where = {}) => {
  if (req?.authContext) return scalarStoreScope(req, where)
  if (isGlobalSuperAdmin(req)) return { ...where }
  const store = ownStoreId(req)
  return { ...where, store: store ?? -1 }
}

const serializeShift = (shift) => ({
  id: shift.id,
  store: shift.store,
  nama_shift: shift.name,
  tipe_shift: SHIFT_TYPES.includes(shift.tipe_shift) ? shift.tipe_shift : DEFAULT_SHIFT_TYPE,
  jam_mulai: shift.startTime,
  jam_selesai: shift.endTime,
  tanggal_mulai: shift.tanggal_mulai,
  tanggal_selesai: shift.tanggal_selesai,
  karyawan: shift.karyawan || [],
  status: shift.status,
  createdBy: shift.createdBy,
  modifiedBy: shift.modifiedBy,
  createdByUser: shift.createdByUser || null,
  modifiedByUser: shift.modifiedByUser || null,
  createdAt: shift.createdAt,
  updatedAt: shift.updatedAt
})

const validateTimeRange = (startTime, endTime) => {
  if (!startTime || !endTime) return null
  return startTime > endTime
    ? 'Jam selesai tidak boleh sebelum jam mulai'
    : null
}

const toStoreArray = (raw) => {
  if (Array.isArray(raw)) return raw.map(Number).filter((n) => !isNaN(n))
  if (raw !== undefined && raw !== null && raw !== '') return [Number(raw)]
  return []
}

const validateMembersForStores = async (stores, employeeIds) => {
  const ids = employeeIds || []
  if (ids.length === 0) return { ok: true }

  const targetStores = stores && stores.length > 0 ? stores : [null]
  for (const storeId of targetStores) {
    const check = await validateEmployeeStoreMembership({
      storeId,
      employeeIds: ids
    })
    if (!check.ok) return check
  }
  return { ok: true }
}

const todayStr = () => {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

const autoExpireShifts = async () => {
  const today = todayStr()
  const [count] = await Shift.update(
    { status: 'inactive' },
    {
      where: {
        status: 'active',
        tanggal_selesai: { [Op.ne]: null, [Op.lt]: today }
      }
    }
  )
  if (count > 0) {
    console.log(`[shift] ${count} shift expired -> status inactive (${today})`)
  }
  return count
}

exports.getAllShift = async (req, res) => {
  const {
    page: rawPage,
    pageSize: rawPageSize,
    status = 'all',
    search,
    store: queryStore
  } = req.query
  const page = Math.max(1, parseInt(rawPage, 10) || 1)
  const pageSize = Math.min(100, Math.max(1, parseInt(rawPageSize, 10) || 10))

  try {
    await autoExpireShifts()

    const offset = (page - 1) * pageSize

    let statusCondition = {}
    if (status && status !== 'all') {
      statusCondition = { status }
    }

    const where = { ...statusCondition }
    const effectiveStore = isGlobalSuperAdmin(req)
      ? req.storeId || (queryStore ? Number(queryStore) : null)
      : ownStoreId(req)
    if (effectiveStore) where.store = effectiveStore
    else if (!isGlobalSuperAdmin(req)) where.store = -1
    if (search) where.name = { [Op.iLike]: `%${search}%` }

    const shiftCategory = await Shift.findAll({
      where,
      limit: pageSize,
      offset,
      order: [['updatedAt', 'DESC']]
    })

    const totalShifts = await Shift.count({ where })

    const [active, draft, inactive] = await Promise.all([
      Shift.count({ where: { ...where, status: 'active' } }),
      Shift.count({ where: { ...where, status: 'draft' } }),
      Shift.count({ where: { ...where, status: 'inactive' } })
    ])

    await enrichAuditFields(db, shiftCategory)

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: shiftCategory.map(serializeShift),
      pagination: {
        currentPage: page,
        pageSize: pageSize,
        totalItems: totalShifts,
        total: totalShifts,
        totalPages: Math.ceil(totalShifts / pageSize)
      },
      stats: { total: active + draft + inactive, active, draft, inactive }
    })
  } catch (error) {
    if (error instanceof ShiftAssignmentError) {
      return res.status(error.status).json({
        success: false,
        message: error.message
      })
    }
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.getShiftDropdown = async (req, res) => {
  const { status } = req.query

  try {
    await autoExpireShifts()

    const whereCondition = {}
    const scopedStore = isGlobalSuperAdmin(req)
      ? req.storeId
        ? Number(req.storeId)
        : null
      : ownStoreId(req)
    if (scopedStore) whereCondition.store = scopedStore
    else if (!isGlobalSuperAdmin(req)) whereCondition.store = -1
    if (status === 'active') {
      whereCondition.status = 'active'
    } else if (status === 'inactive') {
      whereCondition.status = 'inactive'
    }

    const shifts = await Shift.findAll({
      where: whereCondition,
      attributes: [
        'id',
        'store',
        'name',
        'startTime',
        'endTime',
        'tipe_shift',
        'tanggal_mulai',
        'tanggal_selesai',
        'karyawan',
        'status'
      ]
    })

    const data = shifts.map((shift) => ({
      id: shift.id,
      storeId: shift.store,
      shiftName: shift.name,
      startTime: shift.startTime,
      endTime: shift.endTime,
      karyawan: shift.karyawan || [],
      statusShift: shift.status === 'active' ? 'active' : 'inactive'
    }))

    return res.status(200).json({
      status: 200,
      data
    })
  } catch (error) {
    if (error instanceof ShiftAssignmentError) {
      return res.status(error.status).json({
        success: false,
        message: error.message
      })
    }
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.postNewShift = async (req, res) => {
  try {
    const {
      nama_shift,
      tipe_shift,
      jam_mulai,
      jam_selesai,
      tanggal_mulai,
      tanggal_selesai,
      karyawan,
      status
    } = req.body
    let stores
    if (isGlobalSuperAdmin(req)) {
      const rawStore = req.body.store || req.storeId || req.user?.store
      stores = toStoreArray(rawStore)
    } else if (req.user?.roleType === 'super_admin') {
      const own = ownStoreId(req)
      const rawStore = req.body.store
      if (own == null) {
        return res.status(403).json({
          success: false,
          message: 'Store assignment required'
        })
      }
      if (rawStore != null && rawStore !== '' && Number(rawStore) !== own) {
        return res.status(403).json({
          success: false,
          message: 'Anda hanya dapat mengakses data di toko Anda'
        })
      }
      stores = [own]
    } else {
      // C-3: single-store tenant — reject ambiguous/foreign/null store; pin own.
      const authz = authorizedStoreIds(req)
      if (!authz.ok) {
        return res.status(403).json({
          success: false,
          message: 'Anda hanya dapat mengakses data di toko Anda'
        })
      }
      stores = authz.stores
    }

    const memberCheck = await validateMembersForStores(stores, karyawan)
    if (!memberCheck.ok) {
      return res.status(memberCheck.status).json({
        success: false,
        message: memberCheck.message
      })
    }

    const rangeError = validateTimeRange(jam_mulai, jam_selesai)
    if (rangeError) {
      return res.status(400).json({
        success: false,
        message: rangeError
      })
    }

    if (stores.length === 0) {
      const existing = await Shift.findOne({ where: { name: nama_shift, store: null } })
      if (existing) {
        return res.status(403).json({ success: false, message: 'Shift Sudah Terdaftar' })
      }
const postData = await Shift.create({
         name: nama_shift,
         tipe_shift: SHIFT_TYPES.includes(tipe_shift) ? tipe_shift : DEFAULT_SHIFT_TYPE,
         startTime: jam_mulai,
         endTime: jam_selesai,
         tanggal_mulai,
         tanggal_selesai,
         karyawan: karyawan || [],
         status: status || 'active',
         store: null,
         createdBy: req.user?.id
       })

       createAudit(req, 'create', 'shift', postData.id, `Created shift: ${postData.id}`)

       await enrichAuditFields(db, [postData])

       await syncShiftKaryawan({
         shiftId: postData.id,
         employeeIds: karyawan || []
       })

       return res.status(200).json({
         success: true,
         message: 'Success',
         data: serializeShift(postData)
       })
    }

    if (stores.length === 1) {
      const existing = await Shift.findOne({ where: { name: nama_shift, store: stores[0] } })
      if (existing) {
        return res.status(403).json({ success: false, message: 'Shift Sudah Terdaftar' })
      }
const postData = await Shift.create({
         name: nama_shift,
         tipe_shift: SHIFT_TYPES.includes(tipe_shift) ? tipe_shift : DEFAULT_SHIFT_TYPE,
         startTime: jam_mulai,
         endTime: jam_selesai,
         tanggal_mulai,
         tanggal_selesai,
         karyawan: karyawan || [],
         status: status || 'active',
         store: stores[0],
         createdBy: req.user?.id
       })

       createAudit(req, 'create', 'shift', postData.id, `Created shift: ${postData.id}`)

       await enrichAuditFields(db, [postData])

       await syncShiftKaryawan({
         shiftId: postData.id,
         employeeIds: karyawan || []
       })

       return res.status(200).json({
         success: true,
         message: 'Success',
         data: serializeShift(postData)
       })
    }

    const created = []
    for (const storeId of stores) {
      const existing = await Shift.findOne({ where: { name: nama_shift, store: storeId } })
      if (existing) continue
const postData = await Shift.create({
         name: nama_shift,
         tipe_shift: SHIFT_TYPES.includes(tipe_shift) ? tipe_shift : DEFAULT_SHIFT_TYPE,
         startTime: jam_mulai,
         endTime: jam_selesai,
         tanggal_mulai,
         tanggal_selesai,
         karyawan: karyawan || [],
         status: status || 'active',
         store: storeId,
         createdBy: req.user?.id
       })

       createAudit(req, 'create', 'shift', postData.id, `Created shift: ${postData.id}`)

       await enrichAuditFields(db, [postData])

       await syncShiftKaryawan({
         shiftId: postData.id,
         employeeIds: karyawan || []
       })

       created.push(serializeShift(postData))
    }

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: created.length === 1 ? created[0] : created
    })
  } catch (error) {
    if (error instanceof ShiftAssignmentError) {
      return res.status(error.status).json({
        success: false,
        message: error.message
      })
    }
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.editShiftById = async (req, res) => {
  const {
    id,
    nama_shift,
    store,
    tipe_shift,
    jam_mulai,
    jam_selesai,
    tanggal_mulai,
    tanggal_selesai,
    karyawan,
    status
  } = req.body

  try {
    const rangeError = validateTimeRange(jam_mulai, jam_selesai)
    if (rangeError) {
      return res.status(400).json({
        success: false,
        message: rangeError
      })
    }

    // IDOR fix: was findByPk(id) with no store filter — any admin could
    // edit any store's shift (including reassigning karyawan/employees).
    const existingShift = await Shift.findOne({
      where: shiftScope(req, { id })
    })
    if (!existingShift) {
      return res.status(404).json({
        success: false,
        message: 'Shift Tidak Ditemukan'
      })
    }

    let stores
    if (isGlobalSuperAdmin(req)) {
      stores = toStoreArray(store)
    } else if (req.user?.roleType === 'super_admin') {
      const own = ownStoreId(req)
      if (own == null) {
        return res.status(403).json({
          success: false,
          message: 'Store assignment required'
        })
      }
      if (store != null && store !== '' && Number(store) !== own) {
        return res.status(403).json({
          success: false,
          message: 'Anda hanya dapat mengakses data di toko Anda'
        })
      }
      stores = [own]
    } else {
      // C-3: single-store tenant edit must not expand scope nor null the store.
      const authz = authorizedStoreIds(req)
      if (!authz.ok) {
        return res.status(403).json({
          success: false,
          message: 'Anda hanya dapat mengakses data di toko Anda'
        })
      }
      stores = authz.stores
    }

    const effectiveStores = stores.length > 0 ? stores : [existingShift.store]
    const memberCheck = await validateMembersForStores(
      effectiveStores,
      karyawan ?? existingShift.karyawan
    )
    if (!memberCheck.ok) {
      return res.status(memberCheck.status).json({
        success: false,
        message: memberCheck.message
      })
    }

    const duplicateWhere = { // nosemgrep: Sequelize SQL query, nilai divalidasi zod + koersi — bukan NoSQL injection
      id: { [Op.ne]: id },
      name: nama_shift || existingShift.name
    }
    if (stores.length > 0) {
      duplicateWhere.store = { [Op.in]: stores }
    }
    const getDuplicate = await Shift.findOne({ // nosemgrep: Sequelize SQL query — bukan NoSQL injection
      where: duplicateWhere
    })
    if (getDuplicate) {
      return res.status(403).json({
        success: false,
        message: 'Shift Sudah Tersedia'
      })
    }

    if (stores.length <= 1) {
const editShift = await Shift?.update(
         {
           name: nama_shift,
           store: stores.length === 1 ? stores[0] : existingShift.store,
           tipe_shift: tipe_shift ?? existingShift.tipe_shift,
           startTime: jam_mulai,
           endTime: jam_selesai,
           tanggal_mulai: tanggal_mulai ?? existingShift.tanggal_mulai,
           tanggal_selesai: tanggal_selesai !== undefined ? tanggal_selesai : existingShift.tanggal_selesai,
           karyawan: karyawan ?? existingShift.karyawan,
           status: status ?? existingShift.status,
           modifiedBy: req.user?.id
         },
         {
           returning: true,
           where: shiftScope(req, { id })
         }
       ).then(([_, data]) => data[0])

       createAudit(req, 'update', 'shift', id, `Updated shift: ${id}`)

       await enrichAuditFields(db, [editShift])

       const newKaryawan = karyawan ?? existingShift.karyawan
       await syncShiftKaryawan({ shiftId: id, employeeIds: newKaryawan })
       await clearRemovedMembers({
         shiftId: id,
         oldKaryawan: existingShift.karyawan,
         newKaryawan
       })

       return res.status(200).json({
         success: true,
         message: 'Sukses Ubah Shift',
         data: serializeShift(editShift)
       })
    }

    const baseData = {
      name: nama_shift,
      tipe_shift: tipe_shift ?? existingShift.tipe_shift,
      startTime: jam_mulai,
      endTime: jam_selesai,
      tanggal_mulai: tanggal_mulai ?? existingShift.tanggal_mulai,
      tanggal_selesai: tanggal_selesai !== undefined ? tanggal_selesai : existingShift.tanggal_selesai,
      karyawan: karyawan ?? existingShift.karyawan,
      status: status ?? existingShift.status,
      modifiedBy: req.user?.id
    }

    await Shift.destroy({ where: shiftScope(req, { id }) })

    const created = []
    for (const storeId of stores) {
const postData = await Shift.create({ ...baseData, store: storeId, createdBy: existingShift.createdBy })

       createAudit(req, 'update', 'shift', postData.id, `Updated shift: ${postData.id}`)

       await enrichAuditFields(db, [postData])

       await syncShiftKaryawan({ shiftId: postData.id, employeeIds: karyawan ?? existingShift.karyawan })

       created.push(serializeShift(postData))
    }

    await clearRemovedMembers({
      shiftId: id,
      oldKaryawan: existingShift.karyawan,
      newKaryawan: karyawan ?? existingShift.karyawan
    })

    return res.status(200).json({
      success: true,
      message: 'Sukses Ubah Shift',
      data: created.length === 1 ? created[0] : created
    })
  } catch (error) {
    if (error instanceof ShiftAssignmentError) {
      return res.status(error.status).json({
        success: false,
        message: error.message
      })
    }
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.deleteShiftById = async (req, res) => {
  const { id } = req.params
  try {
    // IDOR fix: the User.update side effect below used to run
    // unconditionally, before any ownership check — nulling out real
    // employees' shift reference for a shift id belonging to ANY store.
    const shift = await Shift.findOne({ where: shiftScope(req, { id }) })
    if (!shift) {
      return res.status(404).json({
        success: false,
        message: 'Shift Tidak Ditemukan'
      })
    }

    await User.update({ shift: null }, { where: { shift: id } })

    const getId = await Shift.destroy({
      where: shiftScope(req, { id })
    })
    if (getId) {
      createAudit(req, 'delete', 'shift', id, `Deleted shift: ${id}`)

      return res.status(200).json({
        success: true,
        message: 'Success Hapus Shift'
      })
    } else {
      return res.status(403).json({
        success: false,
        message: 'Hapus Shift Gagal'
      })
    }
  } catch (error) {
    if (error instanceof ShiftAssignmentError) {
      return res.status(error.status).json({
        success: false,
        message: error.message
      })
    }
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.getShiftById = async (req, res) => {
  const { id } = req.params
  try {
    await autoExpireShifts()

    // IDOR fix: was findByPk(id) with no store filter.
    const shift = await Shift.findOne({ where: shiftScope(req, { id }) })
    if (!shift) {
      return res.status(404).json({
        success: false,
        message: 'Shift Tidak Ditemukan'
      })
    }

    await enrichAuditFields(db, [shift])
    return res.status(200).json({
      success: true,
      message: 'Success',
      data: serializeShift(shift)
    })
  } catch (error) {
    if (error instanceof ShiftAssignmentError) {
      return res.status(error.status).json({
        success: false,
        message: error.message
      })
    }
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}
