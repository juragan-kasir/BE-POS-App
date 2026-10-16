const db = require('../../db/models')
const Role = db.role
const User = db.user
const { Op } = db.Sequelize
const { createAudit } = require('../../utils/auditLog')
const { roleAccessMenuSchema } = require('../validation/schemas')

// P0: global authority = super_admin with no store. Store-bound super_admin
// is store-confined, never global (same rule as employee.js P0-2).
const isGlobalSuperAdmin = (req) =>
  req.user?.roleType === 'super_admin' && req.user?.store == null

// D5 (DR-12 §35.4 Q11/Q14/Q15): a tenant_admin with `role.manage` manages
// custom roles of its own tenant's stores. The gate in routes/role.js sets
// req.roleManagerTenant only for that canonical context.
const tenantScope = (req) => req.roleManagerTenant || null

// Until the elevated-confirmation mechanism of DR-12 Q31 exists, a tenant
// admin manages only non-administrative custom roles: no super_admin
// (platform, Q14/Q15) and no admin grants (Q31).
const TENANT_ROLE_TYPES = ['kasir', 'user']

const ROLE_STATUSES = ['active', 'draft', 'inactive']

const normalizeStatus = (status) =>
  status === true ? 'active' : status === false ? 'inactive' : status

// The caller's own store, from the session (never from the request body).
const callerStore = (req) => {
  const store = Number(req.user?.store)
  return Number.isInteger(store) && store > 0 ? store : null
}

// Stores whose roles the caller may see besides the global ones.
const callerRoleStores = (req) => {
  const tenant = tenantScope(req)
  if (tenant) return tenant.storeIds
  const own = callerStore(req)
  return own ? [own] : []
}

const inCallerStores = (req, store) =>
  store != null && callerRoleStores(req).includes(Number(store))

// R-03/R-04/R-05: role visibility comes from the caller's authority.
//   global super_admin  -> every role
//   tenant_admin        -> global roles + its tenant's store roles
//   anyone else         -> global roles + its own store's roles
//   only a super_admin sees super_admin roles
const readableRoleWhere = (req) => {
  if (isGlobalSuperAdmin(req)) return {}
  const stores = callerRoleStores(req)
  const where = {
    [Op.or]: stores.length ? [{ store: null }, { store: stores }] : [{ store: null }]
  }
  if (req.user?.roleType !== 'super_admin' || tenantScope(req)) {
    where.roleType = { [Op.ne]: 'super_admin' }
  }
  return where
}

const canReadRole = (req, role) => {
  if (!role) return false
  if (isGlobalSuperAdmin(req)) return true
  if (
    (req.user?.roleType !== 'super_admin' || tenantScope(req)) &&
    role.roleType === 'super_admin'
  ) {
    return false
  }
  return role.store == null || inCallerStores(req, role.store)
}

// Only a global super_admin changes global roles, other stores' roles and
// built-in (isSystem) roles — D2 (DR-12 Q14: protected built-ins; Q10:
// platform role administration). A store-bound super_admin changes its own
// store's custom roles; a tenant_admin its tenant stores' custom,
// non-administrative roles.
const canMutateRole = (req, role) => {
  if (isGlobalSuperAdmin(req)) return true
  if (role.isSystem || !inCallerStores(req, role.store)) return false
  if (tenantScope(req)) return TENANT_ROLE_TYPES.includes(role.roleType)
  return true
}

// Role types the caller may write.
const roleTypeAllowed = (req, roleType) => {
  if (roleType === 'super_admin') return isGlobalSuperAdmin(req)
  if (tenantScope(req)) return TENANT_ROLE_TYPES.includes(roleType)
  return true
}

const roleTypeDenied = (res, roleType) =>
  res.status(403).json({
    success: false,
    message:
      roleType === 'super_admin'
        ? 'Anda tidak memiliki izin untuk memberikan role Super Admin'
        : 'Anda tidak memiliki izin untuk tipe role ini'
  })

// Resolves the store a role is written with. A store-bound caller is pinned
// to its own store; a tenant_admin must name one of its tenant's stores (a
// tenant-wide role needs a tenant column the role table does not have); a
// global super_admin may name any existing store or null (global).
// Returns { store } or { error: { status, message } }.
const resolveRoleStore = async (req, requested, hasRequested) => {
  const parsed =
    requested === null || requested === undefined || requested === ''
      ? null
      : Number(requested)
  if (parsed !== null && (!Number.isInteger(parsed) || parsed <= 0)) {
    return { error: { status: 400, message: 'Store tidak valid' } }
  }
  if (tenantScope(req)) {
    if (parsed === null) {
      return { error: { status: 400, message: 'Pilih toko untuk role ini' } }
    }
    if (!inCallerStores(req, parsed)) {
      return {
        error: { status: 403, message: 'Anda hanya dapat mengelola role di tenant Anda' }
      }
    }
    return { store: parsed }
  }
  if (!isGlobalSuperAdmin(req)) {
    const own = callerStore(req)
    if (!own) {
      return { error: { status: 403, message: 'Store assignment required' } }
    }
    if (hasRequested && parsed !== own) {
      return {
        error: {
          status: 403,
          message: 'Anda hanya dapat mengelola role di toko Anda'
        }
      }
    }
    return { store: own }
  }
  if (parsed !== null && !(await db.location.findByPk(parsed))) {
    return { error: { status: 400, message: 'Store tidak ditemukan' } }
  }
  return { store: parsed }
}

// Role names are unique within one scope (a store, or global).
const findDuplicateRole = (name, store, exceptId) =>
  Role.findOne({
    where: {
      name,
      store,
      ...(exceptId ? { id: { [Op.ne]: exceptId } } : {})
    }
  })

const pickFields = (row, keys) => {
  const plain = row?.get ? row.get({ plain: true }) : row || {}
  return Object.fromEntries(keys.map((key) => [key, plain[key]]))
}

const notFound = (res) =>
  res.status(404).json({ success: false, message: 'Role Tidak Ditemukan' })

const outOfScope = (res, role) =>
  res.status(403).json({
    success: false,
    message: role?.isSystem
      ? 'Role sistem hanya dapat diubah oleh Super Admin global'
      : 'Anda hanya dapat mengelola role di toko Anda'
  })

exports.getAllRole = async (req, res) => {
  try {
    const getAllRole = await Role.findAll({
      where: { [Op.and]: [{ status: 'active' }, readableRoleWhere(req)] },
      order: [['updatedAt', 'DESC']]
    }).then((res) =>
      res.map((items) => {
        const getData = {
          ...items.dataValues
        }
        return getData
      })
    )

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: getAllRole?.length > 0 ? getAllRole : []
    })
  } catch (error) {
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.getAllRoleInTable = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1)
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100)
    const { status = 'all', search } = req.query
    const offset = (page - 1) * limit
    const scope = readableRoleWhere(req)
    const whereCondition = {}

    if (status === 'active' || status === 'true') {
      whereCondition.status = 'active'
    } else if (status === 'inactive' || status === 'false') {
      whereCondition.status = 'inactive'
    } else if (status === 'draft') {
      whereCondition.status = 'draft'
    }

    if (search) whereCondition.name = { [Op.iLike]: `%${search}%` }

    const { rows: roles, count: totalRoles } = await Role.findAndCountAll({
      where: { [Op.and]: [scope, whereCondition] },
      offset,
      limit,
      order: [['updatedAt', 'DESC']]
    })

    // Users holding each role, within the caller's own stores unless global.
    const userCounts = roles.length
      ? await User.count({
        where: {
          roleId: roles.map((role) => role.id),
          ...(isGlobalSuperAdmin(req) ? {} : { store: callerRoleStores(req) })
        },
        group: ['roleId']
      })
      : []
    const countByRole = new Map(
      userCounts.map((row) => [Number(row.roleId), Number(row.count)])
    )

    const getAllRole = roles.map((items) => {
      return { ...items.dataValues, userCount: countByRole.get(items.id) || 0 }
    })

    const countStatus = (value) =>
      Role.count({ where: { [Op.and]: [scope, { status: value }] } })
    const [activeCount, draftCount, inactiveCount] = await Promise.all([
      countStatus('active'),
      countStatus('draft'),
      countStatus('inactive')
    ])

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: getAllRole.length > 0 ? getAllRole : [],
      pagination: {
        total: totalRoles,
        page,
        limit,
        totalPages: Math.ceil(totalRoles / limit)
      },
      stats: {
        total: activeCount + draftCount + inactiveCount,
        active: activeCount,
        draft: draftCount,
        inactive: inactiveCount
      }
    })
  } catch (error) {
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Internal Server Error'
    })
  }
}

exports.addNewRole = async (req, res) => {
  const body = req.body

  try {
    // P0: creating a super_admin role requires global super_admin; a
    // tenant_admin writes only TENANT_ROLE_TYPES. Authorization happens
    // before any lookup or write.
    const requestedType = body?.roleType || 'user'
    if (!roleTypeAllowed(req, requestedType)) return roleTypeDenied(res, requestedType)

    const status = body.status !== undefined ? normalizeStatus(body.status) : 'active'
    if (!ROLE_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: 'Status role tidak valid' })
    }

    // R-05: the store comes from the caller's authority, not the body.
    const scope = await resolveRoleStore(req, body.store, body.store !== undefined)
    if (scope.error) {
      return res
        .status(scope.error.status)
        .json({ success: false, message: scope.error.message })
    }

    if (await findDuplicateRole(body.name, scope.store)) {
      return res.status(409).json({
        success: false,
        message: 'Role Sudah Terdaftar'
      })
    }

    // R-08: the role and its audit record commit together; createdBy is the
    // session user, never a client-supplied id.
    const createdRole = await db.sequelize.transaction(async (transaction) => {
      const role = await Role.create(
        {
          name: body.name,
          description: body.description,
          roleType: body.roleType || 'user',
          store: scope.store,
          status,
          accessMenu: body.accessMenu || [],
          createdBy: req.user?.id ?? null
        },
        { transaction }
      )
      await createAudit(
        req,
        'create',
        'role',
        role.id,
        `Created role: ${role.id}`,
        null,
        pickFields(role, ['name', 'roleType', 'store', 'status', 'accessMenu']),
        transaction
      )
      return role
    })

    return res.status(200).json({
      success: true,
      message: 'Role Berhasil Di Buat',
      data: { id: createdRole.id }
    })
  } catch (error) {
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.editRoleById = async (req, res) => {
  const body = req.body || {}

  try {
    const target = await Role.findByPk(req.params.id)
    if (!canReadRole(req, target)) return notFound(res)
    if (!canMutateRole(req, target)) return outOfScope(res, target)

    // P0: editing a role into super_admin requires global super_admin.
    // Covers both explicit roleType change and preservation of an existing
    // super_admin role through an edit. Authorization before mutation.
    const resultingRoleType = body.roleType || target.roleType || 'user'
    if (!roleTypeAllowed(req, resultingRoleType)) {
      return roleTypeDenied(res, resultingRoleType)
    }

    // D2 (DR-12 Q14): a built-in role keeps its type and scope; only its
    // name, status and menus may be changed (by the global super_admin).
    if (
      target.isSystem &&
      ((body.roleType !== undefined && body.roleType !== target.roleType) ||
        (body.store !== undefined &&
          (body.store === null || body.store === '' ? null : Number(body.store)) !==
            (target.store == null ? null : Number(target.store))))
    ) {
      return res.status(403).json({
        success: false,
        message: 'Tipe dan cakupan role sistem tidak dapat diubah'
      })
    }

    // R-02: only the fields the request sends change. An omitted roleType,
    // store, status or accessMenu keeps its stored value.
    const changes = {}
    // `description` is accepted by the schema but the role table has no such
    // column, so only stored attributes are considered.
    for (const key of ['name', 'description', 'roleType', 'accessMenu']) {
      if (body[key] !== undefined && Role.rawAttributes[key]) {
        changes[key] = body[key]
      }
    }
    if (body.status !== undefined) {
      changes.status = normalizeStatus(body.status)
      if (!ROLE_STATUSES.includes(changes.status)) {
        return res.status(400).json({ success: false, message: 'Status role tidak valid' })
      }
    }
    if (body.store !== undefined) {
      const scope = await resolveRoleStore(req, body.store, true)
      if (scope.error) {
        return res
          .status(scope.error.status)
          .json({ success: false, message: scope.error.message })
      }
      changes.store = scope.store
    }

    const nextName = changes.name ?? target.name
    const nextStore = changes.store !== undefined ? changes.store : target.store
    if (
      (changes.name !== undefined || changes.store !== undefined) &&
      (await findDuplicateRole(nextName, nextStore, target.id))
    ) {
      return res.status(409).json({
        success: false,
        message: 'Role Sudah Tersedia'
      })
    }

    changes.modifiedBy = req.user?.id ?? null
    const changedKeys = Object.keys(changes)
    const oldValues = pickFields(target, changedKeys)

    await db.sequelize.transaction(async (transaction) => {
      await target.update(changes, { transaction })
      await createAudit(
        req,
        'update',
        'role',
        target.id,
        `Updated role: ${target.id}`,
        oldValues,
        pickFields(target, changedKeys),
        transaction
      )
    })

    return res.status(200).json({
      success: true,
      message: 'Sukses Ubah Role',
      data: target.get({ plain: true })
    })
  } catch (error) {
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.deleteRoleById = async (req, res) => {
  try {
    const role = await Role.findByPk(req.params.id)
    if (!canReadRole(req, role)) return notFound(res)
    if (role.isSystem) {
      return res.status(403).json({
        success: false,
        message: 'Role system tidak dapat dihapus'
      })
    }
    if (!canMutateRole(req, role)) return outOfScope(res, role)

    // D4 (DR-12 §35.4 Q5/Q6: a membership is anchored on its role): a role
    // that users still hold is not deleted — they would be left without a
    // role. The row lock serializes against a concurrent assignment
    // (updateUserRole locks the role FOR SHARE).
    const inUse = await db.sequelize.transaction(async (transaction) => {
      await Role.findByPk(role.id, { transaction, lock: transaction.LOCK.UPDATE })
      const holders = await User.count({ where: { roleId: role.id }, transaction })
      if (holders > 0) return holders
      await role.destroy({ transaction })
      await createAudit(
        req,
        'delete',
        'role',
        role.id,
        `Deleted role: ${role.id}`,
        pickFields(role, ['name', 'roleType', 'store', 'status', 'accessMenu']),
        null,
        transaction
      )
      return 0
    })

    if (inUse > 0) {
      return res.status(409).json({
        success: false,
        code: 'ROLE_IN_USE',
        message: `Role masih dipakai ${inUse} pengguna. Pindahkan pengguna ke role lain sebelum menghapus.`,
        data: { userCount: inUse }
      })
    }

    return res.status(200).json({
      success: true,
      message: 'Success Hapus Role'
    })
  } catch (error) {
    console.error('ERROR =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.getRoleById = async (req, res) => {
  const { id } = req.params

  try {
    const role = await Role.findByPk(id)

    if (!canReadRole(req, role)) return notFound(res)

    // Users holding the role, within the caller's own stores unless global.
    const userCount = await User.count({
      where: {
        roleId: role.id,
        ...(isGlobalSuperAdmin(req) ? {} : { store: callerRoleStores(req) })
      }
    })

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: { ...role.get({ plain: true }), userCount }
    })
  } catch (error) {
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.updateUserRole = async (req, res) => {
  const { userId, roleId, accessMenu } = req.body
  const currentUserRole = req.user?.roleType

  try {
    const user = await db.user.findByPk(userId)

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User Tidak Ditemukan'
      })
    }

    const role = await Role.findByPk(roleId)

    if (!role) {
      return res.status(400).json({
        success: false,
        message: 'Role tidak ditemukan'
      })
    }

    // P0: only a global super_admin may touch an existing super_admin
    // account or grant a super_admin role, in any store.
    if (!isGlobalSuperAdmin(req) && user.roleType === 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'Tidak dapat mengubah Super Admin'
      })
    }
    if (!isGlobalSuperAdmin(req) && role.roleType === 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'Anda tidak memiliki izin untuk memberikan role Super Admin'
      })
    }

    if (user.roleType === 'super_admin' && role.roleType !== 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'Tidak dapat downgrade Super Admin'
      })
    }

    // D5 (DR-12 Q15/Q18): a tenant_admin assigns, inside its tenant's
    // stores, only roles it may manage, to users without an administrative
    // role; a store role only to a user of that store.
    if (tenantScope(req)) {
      const allowed =
        inCallerStores(req, user.store) &&
        TENANT_ROLE_TYPES.includes(user.roleType) &&
        TENANT_ROLE_TYPES.includes(role.roleType) &&
        (role.store == null || Number(role.store) === Number(user.store))
      if (!allowed) {
        return res.status(403).json({
          success: false,
          message: 'Anda hanya dapat mengelola role non-admin di tenant Anda'
        })
      }
    } else {
      if (
        currentUserRole === 'admin' &&
        (user.roleType === 'super_admin' || role.roleType === 'super_admin')
      ) {
        return res.status(403).json({
          success: false,
          message: 'Anda tidak memiliki akses untuk mengubah role Super Admin'
        })
      }

      if (currentUserRole === 'admin' && role.roleType === 'super_admin') {
        return res.status(403).json({
          success: false,
          message: 'Tidak dapat memberikan role Super Admin'
        })
      }

      if (currentUserRole === 'admin') {
        if (user.store !== req.user.store) {
          return res.status(403).json({
            success: false,
            message: 'Anda hanya dapat mengelola user di toko Anda'
          })
        }
      }

      // P0: store-bound super_admin is store-confined like admin.
      if (
        req.user?.roleType === 'super_admin' &&
        !isGlobalSuperAdmin(req) &&
        user.store !== req.user.store
      ) {
        return res.status(403).json({
          success: false,
          message: 'Anda hanya dapat mengelola user di toko Anda'
        })
      }

      // R-05: a store-bound caller assigns only global roles or its own
      // store's roles.
      if (
        !isGlobalSuperAdmin(req) &&
        role.store != null &&
        Number(role.store) !== callerStore(req)
      ) {
        return res.status(403).json({
          success: false,
          message: 'Role tidak tersedia untuk toko Anda'
        })
      }
    }

    // R-11: an inactive or draft role cannot be newly granted; re-applying
    // the role a user already holds stays possible.
    if (role.status !== 'active' && Number(role.id) !== Number(user.roleId)) {
      return res.status(400).json({
        success: false,
        code: 'ROLE_INACTIVE',
        message: 'Role tidak aktif dan tidak dapat diberikan'
      })
    }

    if (accessMenu !== undefined && accessMenu !== null) {
      const parsedMenu = roleAccessMenuSchema.safeParse(accessMenu)
      if (!parsedMenu.success) {
        return res.status(400).json({ success: false, message: 'accessMenu tidak valid' })
      }
    }

    // R-08: a role grant and its audit record commit together.
    const grantKeys = ['roleType', 'roleId', 'accessMenu']
    const oldValues = pickFields(user, grantKeys)
    await db.sequelize.transaction(async (transaction) => {
      // Pairs with the delete lock (D4): the role cannot be deleted while
      // it is being granted.
      const locked = await Role.findByPk(role.id, {
        transaction,
        lock: transaction.LOCK.SHARE
      })
      if (!locked) throw Object.assign(new Error('ROLE_GONE'), { code: 'ROLE_GONE' })
      await user.update(
        {
          roleType: role.roleType,
          roleId: roleId,
          accessMenu: accessMenu || role.accessMenu
        },
        { transaction }
      )
      await createAudit(
        req,
        'update',
        'role',
        roleId,
        `Updated user role: ${userId}`,
        oldValues,
        pickFields(user, grantKeys),
        transaction
      )
    })

    return res.status(200).json({
      success: true,
      message: 'Success Ubah Role User',
      data: {
        id: user.id,
        userName: user.userName,
        roleType: user.roleType,
        roleId: user.roleId,
        accessMenu: user.accessMenu
      }
    })
  } catch (error) {
    if (error?.code === 'ROLE_GONE') {
      return res.status(400).json({ success: false, message: 'Role tidak ditemukan' })
    }
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

// P0-1: the caller's authority decides the scope; `roleType` is only a
// filter inside it. Route gate: requireRole('super_admin', 'admin') +
// validateStoreAccess.
//   global super_admin (no store)   -> every store
//   store-bound super_admin         -> its own store only (same rule as
//                                      backup.js effectiveBackupStore)
//   admin                           -> its own store, never super_admin rows
exports.getUsersByRole = async (req, res) => {
  const { roleType } = req.query
  const currentUserRole = req.user?.roleType
  const currentUserStore = req.user?.store

  const roleTypes = User.rawAttributes.roleType.values
  const hasFilter = roleType !== undefined && roleType !== ''
  if (hasFilter && !roleTypes.includes(roleType)) {
    return res.status(400).json({
      success: false,
      message: 'roleType tidak valid'
    })
  }

  try {
    const whereCondition = {}

    if (hasFilter) {
      whereCondition.roleType = roleType
    }

    const isGlobalSuperAdmin =
      currentUserRole === 'super_admin' && currentUserStore == null
    if (!isGlobalSuperAdmin) {
      const ownStore = Number(currentUserStore)
      if (!Number.isInteger(ownStore) || ownStore <= 0) {
        return res.status(403).json({
          success: false,
          message: 'Store assignment required'
        })
      }
      whereCondition.store = ownStore
    }

    if (currentUserRole === 'admin') {
      whereCondition.roleType = hasFilter
        ? { [Op.and]: [{ [Op.eq]: roleType }, { [Op.ne]: 'super_admin' }] }
        : { [Op.ne]: 'super_admin' }
    }

    const users = await db.user.findAll({
      where: whereCondition,
      attributes: { exclude: ['password'] },
      include: [
        {
          model: Role,
          as: 'role',
          attributes: ['id', 'name', 'roleType', 'accessMenu']
        }
      ]
    })

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: users
    })
  } catch (error) {
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.updateRoleAccessMenu = async (req, res) => {
  const { roleId, accessMenu } = req.body

  if (!roleAccessMenuSchema.safeParse(accessMenu).success) {
    return res.status(400).json({
      success: false,
      message: 'accessMenu tidak valid'
    })
  }

  try {
    const role = await Role.findByPk(roleId)

    if (!canReadRole(req, role)) return notFound(res)
    if (!canMutateRole(req, role)) return outOfScope(res, role)

    const oldValues = pickFields(role, ['accessMenu'])
    await db.sequelize.transaction(async (transaction) => {
      await role.update(
        { accessMenu, modifiedBy: req.user?.id ?? null },
        { transaction }
      )
      await createAudit(
        req,
        'update',
        'role',
        role.id,
        `Updated role access menu: ${role.id}`,
        oldValues,
        { accessMenu },
        transaction
      )
    })

    return res.status(200).json({
      success: true,
      message: 'Success Update Akses Menu',
      data: {
        id: role.id,
        name: role.name,
        roleType: role.roleType,
        accessMenu: role.accessMenu
      }
    })
  } catch (error) {
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}
