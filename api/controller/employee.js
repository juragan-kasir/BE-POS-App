const crypto = require('crypto')
const db = require('../../db/models')
const User = db.user
const Location = db.location
const Position = db.position
const Department = db.department
const { Op } = require('sequelize')
const {
  uploadToCloudinaryWithDedup,
  deleteFromCloudinary
} = require('../../utils/cloudinaryStorage')
const { createNotification } = require('../../utils/createNotification')
const { createAudit } = require('../../utils/auditLog')
const { enrichAuditFields } = require('../../utils/auditFields')
const { syncEmployeeShift } = require('../../utils/shiftChain')
const { scalarStoreScope } = require('../../utils/tenantScope')
const { authorizedWriteStore } = require('../../utils/storeValidation')
const { revokeAllUserSessions } = require('../../utils/authorizationContextMiddleware')
const { disconnectUser } = require('../service/socket')

const dateOrNull = (value, fallback) =>
  value === undefined ? fallback : value ? value : null

const parseAccessMenu = (menu) => {
  if (Array.isArray(menu)) return menu
  if (typeof menu === 'string') {
    try {
      return JSON.parse(menu)
    } catch {
      return []
    }
  }
  return []
}

// P0-2: only a global super_admin (no store claim, the rule already used by
// backup.js requireGlobalSuperAdmin and authContext legacySuperAdminScopeOf)
// administers employees across stores or hands out the super_admin role.
// Everyone else, a store-bound super_admin included, is held to its own store.
const isGlobalSuperAdmin = (req) =>
  req.user?.roleType === 'super_admin' && req.user?.store == null

const ownStoreOf = (req) => {
  const store = Number(req.user?.store)
  return Number.isInteger(store) && store > 0 ? store : null
}

// authorizedWriteStore and scalarStoreScope treat every super_admin as global.
// Evaluate a store-bound super_admin with the single-store rule instead.
const asStoreConfined = (req) =>
  req.user?.roleType === 'super_admin' && !isGlobalSuperAdmin(req)
    ? { user: { ...req.user, roleType: 'admin' }, body: req.body, query: req.query }
    : req

// The destination store of an employee write comes from here, never straight
// from body.store. It runs in the controller, after multer and validate(), so
// it also covers multipart and `data`-wrapped bodies: the route-level
// validateStoreAccess runs before both and never sees their store.
const employeeWriteStore = (req) => {
  if (isGlobalSuperAdmin(req)) return authorizedWriteStore(req)
  if (ownStoreOf(req) == null) return { ok: false }
  return authorizedWriteStore(asStoreConfined(req))
}

const STORE_DENIED = 'Anda hanya dapat menetapkan karyawan ke toko Anda sendiri'

// P1: store-confined employee reads use the same global/bound distinction as
// P0-2 writes. A location filter is never authority: omitted/null/'' means
// the actor's own store; an explicit value must equal it, otherwise 403
// before any employee row is queried. Arrays/multi-values and malformed
// values fail closed.
const LIST_DENIED = 'Anda hanya dapat mengakses data di toko Anda'

const normalizeLocationFilter = (value) => {
  if (value === undefined || value === null || value === '') return { absent: true }
  if (Array.isArray(value)) return { ok: false }
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isInteger(n) || n <= 0) return { ok: false }
  return { ok: true, storeId: n }
}

// Same grant rule as auth.js change-profile-user, applied to the RESOLVED
// role: only a global super_admin may assign a super_admin role. An unknown
// roleId is rejected instead of silently falling back to another role.
// R-11: an inactive or draft role cannot be newly granted; a user who
// already holds it keeps it (`currentRoleId`), so re-saving them still works.
const resolveGrantableRole = async (req, roleId, currentRoleId = null) => {
  const role = await db.role.findByPk(roleId)
  if (!role) return { status: 400, message: 'Role tidak ditemukan' }
  if (role.status !== 'active' && Number(roleId) !== Number(currentRoleId)) {
    return { status: 400, message: 'Role tidak aktif dan tidak dapat diberikan' }
  }
  if (role.roleType === 'super_admin' && !isGlobalSuperAdmin(req)) {
    return {
      status: 403,
      message: 'Anda tidak memiliki izin untuk memberikan role Super Admin'
    }
  }
  return { role }
}

exports.addEmployee = async (req, res) => {
  const body = req.body
  const imageFile = req.files?.['image']?.[0]
  const documentFiles = req.files?.['documents'] || []

  try {
    if (body?.status !== 'draft' && (!body?.password || !body?.userName)) {
      return res.status(400).json({
        success: false,
        message: 'User Name dan Password wajib diisi'
      })
    }

    // P0-2: authorize the destination store and the role before any lookup,
    // upload or write.
    const destination = employeeWriteStore(req)
    if (!destination.ok) {
      return res.status(403).json({ success: false, message: STORE_DENIED })
    }

    let role = null
    if (body?.roleId) {
      const grant = await resolveGrantableRole(req, body.roleId)
      if (!grant.role) {
        return res
          .status(grant.status)
          .json({ success: false, message: grant.message })
      }
      role = grant.role
    } else {
      role = await db.role.findOne({ where: { roleType: 'user' } })
    }

    const userName = body?.userName || null
    const password = body?.password || null

    const existingUser = await User.findOne({
      paranoid: false,
      where: {
        [Op.or]: [
          ...(body?.userName ? [{ userName: body.userName }] : []),
          ...(body?.email ? [{ email: body.email }] : [])
        ]
      }
    })

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: 'Username atau Email sudah terdaftar'
      })
    }

    if (body?.email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      if (!emailRegex.test(body.email)) {
        return res.status(400).json({
          success: false,
          message: 'Format email tidak valid'
        })
      }
    }

    const employeeID = body?.employeeID || body?.employeeId
    if (employeeID) {
      const existingEmployeeID = await User.findOne({
        where: { employeeID }
      })
      if (existingEmployeeID) {
        return res.status(409).json({
          success: false,
          message: 'Employee ID sudah digunakan'
        })
      }
    }

    if (body?.phoneNumber) {
      const existingPhone = await User.findOne({
        where: { phoneNumber: body.phoneNumber }
      })
      if (existingPhone) {
        return res.status(409).json({
          success: false,
          message: 'Nomor telepon sudah digunakan'
        })
      }
    }

    let imageUrl = null
    if (imageFile) {
      const { url } = await uploadToCloudinaryWithDedup(
        imageFile.path,
        'pos-app-users'
      )
      const duplicate = await User.findOne({
        where: { image: url }
      })
      if (duplicate) {
        return res.status(409).json({
          success: false,
          message: 'Gambar sudah digunakan oleh karyawan lain'
        })
      }
      imageUrl = url
    }

    let documentUrls = []
    if (documentFiles.length > 0) {
      for (const doc of documentFiles) {
        const { url } = await uploadToCloudinaryWithDedup(
          doc.path,
          'pos-app-documents'
        )
        documentUrls.push(url)
      }
    }

    const employeeId =
      body?.employeeID ||
      body?.employeeId ||
      String(crypto.randomInt(100000, 999999))

    const isDraft = (body?.status || 'active') === 'draft'
    const draftSuffix = isDraft ? `draft-${employeeId}` : null

    const createUser = await User.create({
      image: imageUrl,
      roleType: role?.roleType || 'user',
      roleId: role?.id || null,
      userType: 'user',
      fullName: body?.fullName || draftSuffix || '',
      userName: userName || draftSuffix || '',
      password: password || (isDraft ? 'Draft!12345' : ''),
      email: body?.email || (isDraft ? `${draftSuffix}@placeholder.local` : ''),
      address: body?.address || '',
      gender: body?.gender || '',
      phoneNumber: body?.phoneNumber || '',
      employeeID: employeeId,
      department: body?.department || '',
      departmentId: body?.departmentId || null,
      employmentType: body?.employmentType || '',
      startDate: body?.startDate || null,
      dateOfBirth: body?.dateOfBirth || null,
      placeOfBirth: body?.placeOfBirth || '',
      status: isDraft ? 'draft' : body?.status || 'active',
      store: destination.storeId || null,
      shift: body?.shift ? Number(body.shift) : null,
      position: body?.position || null,
      accessMenu: body?.accessMenu ? parseAccessMenu(body.accessMenu) : null,
      contractDuration: body?.contractDuration || null,
      endDate: body?.endDate || null,
      monthlySalary: body?.monthlySalary || null,
      dailySalary: body?.dailySalary || null,
      documents: documentUrls.length > 0 ? JSON.stringify(documentUrls) : null,
      createdBy: req.user?.id || null
    })

    if (body?.shift) {
      await syncEmployeeShift({
        userId: createUser.id,
        newShiftId: Number(body.shift)
      })
    }

    createAudit(
      req,
      'create',
      'employee',
      createUser.id,
      `Created employee: ${createUser.id}`
    )

    const result = createUser.toJSON()
    delete result.password

    createNotification({
      type: 'employee_created',
      store: createUser.store,
      referenceId: createUser.id,
      referenceType: 'employee',
      params: [req.body.fullName],
      createdBy: req.user?.fullName || 'System'
    }).catch(console.error)

    return res.status(200).json({
      success: true,
      message: 'Karyawan berhasil ditambahkan',
      data: result
    })
  } catch (error) {
    console.error('Error add employee:', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.getAllEmployee = async (req, res) => {
  try {
    const {
      page: rawPage = 1,
      limit: rawLimit = 10,
      search,
      status,
      location
    } = req.query
    const page = Math.max(1, parseInt(rawPage) || 1)
    const limit = Math.max(1, Math.min(100, parseInt(rawLimit) || 10))
    const offset = (page - 1) * limit

    const whereCondition = { userType: 'user' }

    if (status) {
      whereCondition.status = status
    }

    if (search) {
      whereCondition[Op.or] = [
        { fullName: { [Op.iLike]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } },
        { userName: { [Op.iLike]: `%${search}%` } }
      ]
    }

    // P1: list confinement. Global super_admin keeps unrestricted behavior
    // (explicit location honored as a filter). Confined actors (admin +
    // store-bound super_admin, plus any other non-global role reaching this
    // route) are scoped to their own store; location can only select the own
    // store, never expand beyond it. validateStoreAccess does not inspect
    // query.location, so the check lives here before any employee query.
    if (isGlobalSuperAdmin(req)) {
      if (location) {
        whereCondition.store = location
      }
    } else {
      const ownStore = ownStoreOf(req)
      if (ownStore == null) {
        return res.status(403).json({ success: false, message: LIST_DENIED })
      }
      const normalized = normalizeLocationFilter(location)
      if (normalized.absent) {
        whereCondition.store = ownStore
      } else if (!normalized.ok || normalized.storeId !== ownStore) {
        return res.status(403).json({ success: false, message: LIST_DENIED })
      } else {
        whereCondition.store = ownStore
      }
    }

    const [employees, total, activeCount, inactiveCount, draftCount] =
      await Promise.all([
        User.findAll({
          where: whereCondition,
          attributes: { exclude: ['password'] },
          include: [
            { model: Location, as: 'storeData', attributes: ['id', 'name'] },
            { model: Position, as: 'positionData', attributes: ['id', 'name'] },
            {
              model: Department,
              as: 'departmentData',
              attributes: ['id', 'name']
            }
          ],
          limit,
          offset,
          order: [['updatedAt', 'DESC']]
        }),
        User.count({ where: whereCondition }),
        User.count({ where: { ...whereCondition, status: 'active' } }),
        User.count({ where: { ...whereCondition, status: 'inactive' } }),
        User.count({ where: { ...whereCondition, status: 'draft' } }),
        User.findAll({
          where: { ...whereCondition, store: { [Op.ne]: null } },
          attributes: ['store'],
          group: ['store']
        })
      ])

    const totalPages = Math.ceil(total / limit)

    await enrichAuditFields(db, employees)

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: employees,
      total,
      pagination: {
        total,
        totalPages,
        page,
        limit
      },
      stats: {
        total,
        active: activeCount,
        draft: draftCount,
        inactive: inactiveCount
      }
    })
  } catch (error) {
    console.error('Error get all employee:', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.getEmployeeById = async (req, res) => {
  const { id } = req.params

  try {
    // P1: confine single-resource reads to the authorized store. A bound
    // super_admin is evaluated with the single-store rule so it cannot read
    // another store's employee; misses stay indistinguishable (404).
    const employee = await User.findOne({
      where: scalarStoreScope(asStoreConfined(req), { id }),
      attributes: { exclude: ['password'] },
      include: [
        { model: Location, as: 'storeData', attributes: ['id', 'name'] },
        { model: Position, as: 'positionData', attributes: ['id', 'name'] },
        { model: Department, as: 'departmentData', attributes: ['id', 'name'] }
      ]
    })

    if (!employee || employee.userType !== 'user') {
      return res.status(404).json({
        success: false,
        message: 'Karyawan tidak ditemukan'
      })
    }

    await enrichAuditFields(db, [employee])

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: employee
    })
  } catch (error) {
    console.error('Error get employee by id:', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.getEmployeeByEmployeeID = async (req, res) => {
  const { employeeID } = req.params

  try {
    // P1: employeeID lookup carries the same store scope as the numeric-ID
    // lookup; without it any actor could pull another store's PII by
    // guessing a globally-unique employeeID.
    const employee = await User.findOne({
      where: scalarStoreScope(asStoreConfined(req), { employeeID }),
      attributes: { exclude: ['password'] },
      include: [
        { model: Location, as: 'storeData', attributes: ['id', 'name'] },
        { model: Position, as: 'positionData', attributes: ['id', 'name'] },
        { model: Department, as: 'departmentData', attributes: ['id', 'name'] }
      ]
    })

    if (!employee || employee.userType !== 'user') {
      return res.status(404).json({
        success: false,
        message: 'Karyawan tidak ditemukan'
      })
    }

    await enrichAuditFields(db, [employee])

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: employee
    })
  } catch (error) {
    console.error('Error get employee by employeeID:', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.updateEmployee = async (req, res) => {
  const body = req.body
  const imageFile = req.files?.['image']?.[0]
  const documentFiles = req.files?.['documents'] || []

  try {
    const employeeId = req.body.id || req.query.id || req.params.id
    // IDOR fix: was findByPk(employeeId) with no store filter, allowing a
    // Store A admin to edit another store's staff record (id taken from
    // req.body, not the URL, but the same bug either way).
    const employee = await User.findOne({
      where: scalarStoreScope(asStoreConfined(req), { id: employeeId })
    })

    if (!employee || employee.userType !== 'user') {
      return res.status(404).json({
        success: false,
        message: 'Karyawan tidak ditemukan'
      })
    }

    // P0-2: a super_admin account is managed only by a global super_admin
    // (auth.js change-profile-user precedent), whichever field is changed.
    if (!isGlobalSuperAdmin(req) && employee.roleType === 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'Tidak dapat mengubah Super Admin'
      })
    }

    const destination = employeeWriteStore(req)
    if (!destination.ok) {
      return res.status(403).json({ success: false, message: STORE_DENIED })
    }

    let grantedRole = null
    if (body?.roleId) {
      const grant = await resolveGrantableRole(req, body.roleId, employee.roleId)
      if (!grant.role) {
        return res
          .status(grant.status)
          .json({ success: false, message: grant.message })
      }
      grantedRole = grant.role
    }

    if (body?.userName && body.userName !== employee.userName) {
      const existing = await User.findOne({
        where: { userName: body.userName, id: { [Op.ne]: employeeId } }
      })
      if (existing) {
        return res.status(409).json({
          success: false,
          message: 'Username sudah digunakan'
        })
      }
    }

    if (body?.email && body.email !== employee.email) {
      const existing = await User.findOne({
        where: { email: body.email, id: { [Op.ne]: employeeId } }
      })
      if (existing) {
        return res.status(409).json({
          success: false,
          message: 'Email sudah digunakan'
        })
      }
    }

    if (body?.employeeID && body.employeeID !== employee.employeeID) {
      const existing = await User.findOne({
        where: { employeeID: body.employeeID, id: { [Op.ne]: employeeId } }
      })
      if (existing) {
        return res.status(409).json({
          success: false,
          message: 'Employee ID sudah digunakan'
        })
      }
    }

    const updateEmployeeID =
      body?.employeeID || body?.employeeId || employee.employeeID

    if (body?.phoneNumber && body.phoneNumber !== employee.phoneNumber) {
      const existing = await User.findOne({
        where: { phoneNumber: body.phoneNumber, id: { [Op.ne]: employeeId } }
      })
      if (existing) {
        return res.status(409).json({
          success: false,
          message: 'Nomor telepon sudah digunakan'
        })
      }
    }

    let imageUrl = employee.image
    if (imageFile) {
      const { url } = await uploadToCloudinaryWithDedup(
        imageFile.path,
        'pos-app-users'
      )
      const duplicate = await User.findOne({
        where: { image: url, id: { [Op.ne]: employeeId } }
      })
      if (duplicate) {
        return res.status(409).json({
          success: false,
          message: 'Gambar sudah digunakan oleh karyawan lain'
        })
      }
      if (employee.image && employee.image !== url) {
        await deleteFromCloudinary(employee.image)
      }
      imageUrl = url
    }

    let documentUrls = employee.documents ? JSON.parse(employee.documents) : []

    const deletedDocuments = body?.deletedDocuments
      ? typeof body.deletedDocuments === 'string'
        ? JSON.parse(body.deletedDocuments)
        : body.deletedDocuments
      : []

    if (deletedDocuments.length > 0) {
      for (const docUrl of deletedDocuments) {
        await deleteFromCloudinary(docUrl)
      }
      documentUrls = documentUrls.filter(
        (url) => !deletedDocuments.includes(url)
      )
    }

    if (documentFiles.length > 0) {
      for (const doc of documentFiles) {
        const { url } = await uploadToCloudinaryWithDedup(
          doc.path,
          'pos-app-documents'
        )
        documentUrls.push(url)
      }
    }

    const updateData = {
      image: imageUrl,
      fullName: body?.fullName ?? employee.fullName,
      userName: body?.userName ?? employee.userName,
      email: body?.email ?? employee.email,
      address: body?.address ?? employee.address,
      gender: body?.gender ?? employee.gender,
      phoneNumber: body?.phoneNumber ?? employee.phoneNumber,
      employeeID: updateEmployeeID ?? employee.employeeID,
      department: body?.department ?? employee.department,
      departmentId: body?.departmentId ?? employee.departmentId,
      employmentType: body?.employmentType ?? employee.employmentType,
      startDate: dateOrNull(body?.startDate, employee.startDate),
      dateOfBirth: dateOrNull(body?.dateOfBirth, employee.dateOfBirth),
      placeOfBirth: body?.placeOfBirth ?? employee.placeOfBirth,
      status:
        body?.status ||
        (body?.isActive !== undefined
          ? body.isActive
            ? 'active'
            : 'inactive'
          : employee.status),
      store: destination.storeId ?? employee.store,
      shift: body?.shift !== undefined
        ? body?.shift
          ? Number(body.shift)
          : null
        : employee.shift,
      position: body?.position ?? employee.position,
      accessMenu: body?.accessMenu
        ? parseAccessMenu(body.accessMenu)
        : employee.accessMenu,
      roleId: body?.roleId ?? employee.roleId,
      contractDuration: body?.contractDuration ?? employee.contractDuration,
      endDate: dateOrNull(body?.endDate, employee.endDate),
      monthlySalary: body?.monthlySalary ?? employee.monthlySalary,
      dailySalary: body?.dailySalary ?? employee.dailySalary,
      documents:
        deletedDocuments.length > 0 || documentFiles.length > 0
          ? JSON.stringify(documentUrls)
          : employee.documents,
      modifiedBy: req.user?.id || null
    }

    if (body?.password) {
      updateData.password = body.password
    }

    if (grantedRole) {
      updateData.roleType = grantedRole.roleType
    }

    // AUTH-1 P3: a password change revokes every session of the target
    // employee (never the acting admin's) atomically with the new hash.
    await db.sequelize.transaction(async (t) => {
      await employee.update(updateData, { transaction: t })
      if (updateData.password) {
        await revokeAllUserSessions(db, employee.id, { transaction: t })
      }
    })
    // AUTH-1 P4: committed; drop the employee's live sockets.
    if (updateData.password) disconnectUser(employee.id)

    if (body?.shift !== undefined) {
      await syncEmployeeShift({
        userId: employeeId,
        newShiftId: body?.shift ? Number(body.shift) : null
      })
    }

    createAudit(
      req,
      'update',
      'employee',
      employeeId,
      `Updated employee: ${employeeId}`
    )

    const result = employee.toJSON()
    delete result.password

    createNotification({
      type: 'employee_updated',
      store: employee.store,
      referenceId: employee.id,
      referenceType: 'employee',
      params: [req.body.fullName || employee.fullName],
      createdBy: req.user?.fullName || 'System'
    }).catch(console.error)

    return res.status(200).json({
      success: true,
      message: 'Karyawan berhasil diupdate',
      data: result
    })
  } catch (error) {
    console.error('Error update employee:', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.deleteEmployee = async (req, res) => {
  const { id } = req.params

  try {
    // P1: the same confined scope guards lookup and destroy so an actor
    // that cannot read a target can never delete it. Side-effects stay
    // after the scoped lookup (fail-closed ordering preserved).
    const employee = await User.findOne({
      where: scalarStoreScope(asStoreConfined(req), { id })
    })

    if (!employee || employee.userType !== 'user') {
      return res.status(404).json({
        success: false,
        message: 'Karyawan tidak ditemukan'
      })
    }

    if (employee.image) {
      await deleteFromCloudinary(employee.image)
    }

    await syncEmployeeShift({ userId: id, newShiftId: null })

    // AUTH-1 P3: soft-delete and session revocation commit together, so a
    // removed account keeps no usable session (and a later restore cannot
    // revive one — revoked rows stay revoked).
    const destroyedCount = await db.sequelize.transaction(async (t) => {
      const count = await User.destroy({
        where: scalarStoreScope(asStoreConfined(req), { id }),
        transaction: t
      })
      if (count > 0) {
        await revokeAllUserSessions(db, employee.id, { transaction: t })
      }
      return count
    })
    if (destroyedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Karyawan tidak ditemukan'
      })
    }
    // AUTH-1 P4: the soft-delete committed; drop the employee's live sockets.
    disconnectUser(employee.id)

    createAudit(req, 'delete', 'employee', id, `Deleted employee: ${id}`)

    createNotification({
      type: 'employee_deleted',
      store: employee.store,
      referenceId: employee.id,
      referenceType: 'employee',
      params: [employee.fullName || 'Unknown'],
      createdBy: req.user?.fullName || 'System'
    }).catch(console.error)

    return res.status(200).json({
      success: true,
      message: 'Karyawan berhasil dihapus'
    })
  } catch (error) {
    console.error('Error delete employee:', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}
