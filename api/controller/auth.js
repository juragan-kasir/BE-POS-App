const db = require('../../db/models')
const User = db.user
const Location = db.location
const Position = db.position
const generateToken = require('../../utils/jwtConvert')
const { credentialWindow, lifetimeFor } = require('../../utils/jwtConvert')
const {
  createContextSession,
  revokeContextSession,
  revokeAllUserSessions
} = require('../../utils/authorizationContextMiddleware')
const { disconnectSession, disconnectUser } = require('../service/socket')
const bcrypt = require('bcrypt')
const moment = require('moment')
const crypto = require('crypto')
const { Op } = require('sequelize')

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

// P0: global authority = super_admin with no store (platform-level).
// Store-bound super_admin is store-confined, never global (same rule as
// employee.js P0-2 isGlobalSuperAdmin and authContext legacySuperAdminScopeOf).
const isGlobalSuperAdmin = (req) =>
  req.user?.roleType === 'super_admin' && req.user?.store == null

// Store-confined actors (regular admin + store-bound super_admin) are held
// to their own store for change-profile-user.
const isStoreConfinedForProfile = (req) =>
  req.user?.roleType === 'admin' ||
  (req.user?.roleType === 'super_admin' && !isGlobalSuperAdmin(req))

const {
  uploadToCloudinary,
  deleteFromCloudinary
} = require('../../utils/cloudinaryStorage')
const { createAudit, recordAudit, AUDIT_ACTIONS } = require('../../utils/auditLog')
const {
  sendEmail,
  buildResetPasswordEmail
} = require('../../utils/emailService')
const { hashResetToken, resetTokenMatches } = require('../../utils/resetToken')

// Get User By Location
// CRIT-2: ordinary roles (user/admin/kasir) are ALWAYS restricted to their own
// store (`req.storeId`, set by validateStoreAccess from the trusted token).
// Omitting `location` MUST never mean "all stores". Only an explicit
// super_admin global query may select another store, and it must always pass
// an explicit `location` so it cannot accidentally dump the whole user table.
exports.userByLocation = async (req, res) => {
  const { location } = req.query
  const userRole = req.user?.roleType

  let targetStore = null

  if (userRole === 'super_admin' && isGlobalSuperAdmin(req)) {
    if (location === undefined || location === '') {
      return res.status(400).json({
        message: 'Location wajib diisi'
      })
    }
    const parsed = parseInt(location, 10)
    if (!Number.isInteger(parsed)) {
      return res.status(400).json({
        message: 'Location tidak valid'
      })
    }
    targetStore = parsed
  } else {
    // Ordinary tenant users — and store-bound super_admin, which is
    // store-confined (P1-2): always their own store, derived from the JWT
    // store claim only (never req.storeId, which is client-controlled for
    // super_admin callers). An explicit location that differs is rejected.
    const ownStore = req.user?.store
    if (ownStore === null || ownStore === undefined) {
      return res.status(403).json({
        message: 'Akun Anda belum ditetapkan ke toko'
      })
    }
    targetStore = parseInt(ownStore, 10)
    if (Number.isNaN(targetStore)) {
      return res.status(403).json({
        message: 'Akun Anda belum ditetapkan ke toko'
      })
    }
    if (location !== undefined && location !== '') {
      const requested = parseInt(location, 10)
      if (Object.is(requested, NaN) || requested !== targetStore) {
        return res.status(403).json({
          message: 'Anda hanya dapat mengakses user di toko Anda'
        })
      }
    }
  }

  try {
    // Fetch users and location data in parallel
    const [users, locationData] = await Promise.all([
      User.findAll({
        where: { store: targetStore },
        attributes: { exclude: ['password'] } // Exclude password in query
      }),
      Location.findOne({
        where: { id: targetStore }
      })
    ])

    // Check if location exists
    if (!locationData) {
      return res.status(404).json({
        message: 'Location not found',
        data: []
      })
    }

    // Fetch all positions
    const positions = await Position.findAll()
    const positionMap = positions.reduce((acc, pos) => {
      acc[pos.id] = pos.name // Map position id to position name
      return acc
    }, {})

    // Add store name and replace position ID with name in user data
    const usersWithStoreName = users.map((user) => ({
      ...user.dataValues,
      storeName: locationData.name,
      positionName: positionMap[user.position] || '' // Map position ID to name
    }))

    res.status(200).json({
      message: 'Success',
      data: usersWithStoreName
    })
  } catch (error) {
    console.error('Error in userByLocation:', error)
    return res.status(500).json({
      error: 'Internal Server Error'
    })
  } finally {
    console.log('Request handling completed')
  }
}

// Change User Status (activate/deactivate) By Id
exports.changeUserStatusById = async (req, res) => {
  const { id, status } = req.body
  const currentUserRole = req.user?.roleType
  const currentUserStore = req.user?.store

  try {
    if (!id) {
      return res.status(400).json({
        message: 'ID User wajib diisi'
      })
    }
    if (!['active', 'inactive'].includes(status)) {
      return res.status(400).json({
        message: 'Status harus active atau inactive'
      })
    }

    const targetUser = await User.findByPk(id)

    if (!targetUser) {
      return res.status(404).json({
        message: 'User tidak ditemukan'
      })
    }

    // P1-2: only a global super_admin may change status of a super_admin
    // account (global or bound), whichever store it belongs to.
    if (!isGlobalSuperAdmin(req) && targetUser.roleType === 'super_admin') {
      return res.status(403).json({
        message: 'Tidak dapat mengubah Super Admin'
      })
    }

    // P1-2: a store-bound super_admin is confined to its own store like an
    // admin. Global bypasses the store restriction.
    if (
      req.user?.roleType === 'super_admin' &&
      !isGlobalSuperAdmin(req) &&
      targetUser.store !== currentUserStore
    ) {
      return res.status(403).json({
        message: 'Anda hanya dapat mengubah user di toko Anda'
      })
    }

    if (currentUserRole === 'admin') {
      if (targetUser.store !== currentUserStore) {
        return res.status(403).json({
          message: 'Anda hanya dapat mengubah user di toko Anda'
        })
      }
      if (targetUser.roleType === 'super_admin') {
        return res.status(403).json({
          message: 'Tidak dapat mengubah Super Admin'
        })
      }
    }

    // P1-3: canonical account disable/re-enable. `inactive` sets the
    // authoritative disablement timestamp AND keeps the presence status;
    // `active` clears it. Single atomic mutation so the two can never
    // disagree. P1-2 authorization above is unchanged.
    // AUTH-1 P3: disabling also revokes every session of the account in the
    // same transaction (the user-row UPDATE runs first, serializing with the
    // login row lock). Re-enabling touches no session: revoked rows stay
    // revoked, so only a fresh login regains access (DR-03 Q8).
    const updatedUser = await db.sequelize.transaction(async (t) => {
      const updated = await User.update(
        {
          status,
          disabledAt: status === 'inactive' ? new Date() : null
        },
        {
          returning: true,
          where: { id },
          transaction: t
        }
      )
      if (updated[0] > 0 && status === 'inactive') {
        await revokeAllUserSessions(db, targetUser.id, { transaction: t })
      }
      return updated
    })

    if (updatedUser[0] === 0) {
      return res.status(404).json({
        message: 'User not found or no changes made.'
      })
    }

    // AUTH-1 P4: the disable (and its revocation) committed; drop live sockets.
    if (status === 'inactive') disconnectUser(targetUser.id)

    createAudit(req, 'update', 'user', id, `Updated user status: ${id}`)

    // RETURNING yields every column, credentials included; toJSON() strips them.
    const result = updatedUser[1][0]?.toJSON()

    return res.status(200).json({
      message: 'Status user berhasil diubah',
      data: result
    })
  } catch (error) {
    console.error('Error updating user status:', error)
    return res.status(500).json({
      error: 'Internal Server Error'
    })
  }
}

// Change User Role By Id & Location
exports.changeUserByIdAndLocation = async (req, res) => {
  const { store, id, userType, position, roleId, roleType } = req.body
  const currentUserRole = req.user?.roleType
  const currentUserStore = req.user?.store

  try {
    const targetUser = await User.findByPk(id)

    if (!targetUser) {
      return res.status(404).json({
        message: 'User tidak ditemukan'
      })
    }

    // P0: only a global super_admin may touch an existing super_admin
    // account through this endpoint, whichever field is changed.
    if (!isGlobalSuperAdmin(req) && targetUser.roleType === 'super_admin') {
      return res.status(403).json({
        message: 'Tidak dapat mengubah Super Admin'
      })
    }

    // Validation: store-confined actors (admin + store-bound super_admin)
    // can only manage users in their own store and cannot move them.
    if (isStoreConfinedForProfile(req)) {
      if (targetUser.store !== currentUserStore) {
        return res.status(403).json({
          message: 'Anda hanya dapat mengubah user di toko Anda'
        })
      }
      // Admin can't move a user to a different store
      if (store !== undefined && parseInt(store) !== currentUserStore) {
        return res.status(403).json({
          message: 'Anda hanya dapat menetapkan user ke toko Anda sendiri'
        })
      }
    } else if (currentUserRole === 'admin') {
      if (targetUser.store !== currentUserStore) {
        return res.status(403).json({
          message: 'Anda hanya dapat mengubah user di toko Anda'
        })
      }
      // Admin can't move a user to a different store
      if (store !== undefined && parseInt(store) !== currentUserStore) {
        return res.status(403).json({
          message: 'Anda hanya dapat menetapkan user ke toko Anda sendiri'
        })
      }
    }

    // Update the userType, position, store, roleId and roleType
    const updateData = { userType, position, store }

    if (roleId || roleType) {
      // P0: only a global super_admin may grant the super_admin role,
      // via either roleType or roleId representation.
      if (!isGlobalSuperAdmin(req) && roleType === 'super_admin') {
        return res.status(403).json({
          message: 'Anda tidak memiliki izin untuk memberikan role Super Admin'
        })
      }
      if (roleId) {
        const role = await db.role.findByPk(roleId)
        // P0: unknown roleId is 400 with no mutation (never silent fallback).
        if (!role) {
          return res.status(400).json({
            message: 'Role tidak ditemukan'
          })
        }
        // R-11: an inactive or draft role cannot be newly granted.
        if (role.status !== 'active' && Number(roleId) !== Number(targetUser.roleId)) {
          return res.status(400).json({
            message: 'Role tidak aktif dan tidak dapat diberikan'
          })
        }
        if (
          !isGlobalSuperAdmin(req) &&
          role.roleType === 'super_admin'
        ) {
          return res.status(403).json({
            message:
              'Anda tidak memiliki izin untuk memberikan role Super Admin'
          })
        }
        // Legacy compatibility: non-global non-admin callers were already
        // blocked above for super_admin targets/grants; preserve the
        // original admin-only grant check for other privileged grants.
        if (currentUserRole !== 'super_admin' && role.roleType === 'super_admin') {
          return res.status(403).json({
            message:
              'Anda tidak memiliki izin untuk memberikan role Super Admin'
          })
        }
        updateData.roleId = roleId
        updateData.roleType = role.roleType
      } else if (roleType) {
        updateData.roleType = roleType
        // Clear roleId if changing to custom or different type
        updateData.roleId = null
      }
    }

    const [affectedRows, updatedUsers] = await User.update(updateData, {
      returning: true,
      where: { id }
    })

    if (affectedRows === 0) {
      return res.status(404).json({
        message: 'User not found or no changes made.'
      })
    }

    // RETURNING yields every column, credentials included; toJSON() strips them.
    const result = updatedUsers[0]?.toJSON()
    createAudit(req, 'update', 'user', id, `Updated user role: ${id}`)

    return res.status(200).json({
      message: 'User role updated successfully',
      data: result
    })
  } catch (error) {
    console.error('Error updating user role:', error)
    return res.status(500).json({
      error: 'Internal Server Error'
    })
  }
}

// Get All List User
exports.getAllUser = async (req, res) => {
  try {
    const currentUserRole = req.user?.roleType
    const currentUserStore = req.user?.store

    const whereCondition = {}

    // Admin can only see users in their store
    if (currentUserRole === 'admin') {
      whereCondition.store = currentUserStore
      whereCondition.roleType = { [Op.ne]: 'super_admin' }
    }

    // P1-2 (locked): a store-bound super_admin gets the same own-store
    // audience as an admin (super_admin rows hidden). Global keeps the
    // existing unrestricted audience. DB-level filtering, never JS filtering.
    if (
      currentUserRole === 'super_admin' &&
      !isGlobalSuperAdmin(req)
    ) {
      whereCondition.store = currentUserStore
      whereCondition.roleType = { [Op.ne]: 'super_admin' }
    }

    // Summary cards (AdminList): the whole visible audience, independent of
    // the search box. Buckets mirror the list's status badge: a disabled
    // account (disabledAt) is never counted as active or pending;
    // `inactive` covers every account that is neither, disabled included.
    const [counts] = await User.findAll({
      where: whereCondition,
      attributes: [
        [db.sequelize.literal('COUNT(*)'), 'total'],
        [db.sequelize.literal(`COUNT(*) FILTER (WHERE "disabledAt" IS NULL AND "status" = 'active')`), 'active'],
        [db.sequelize.literal(`COUNT(*) FILTER (WHERE "disabledAt" IS NULL AND "status" IN ('pending', 'draft'))`), 'pending'],
        [db.sequelize.literal(`COUNT(*) FILTER (WHERE "disabledAt" IS NOT NULL)`), 'disabled']
      ],
      raw: true
    })
    const stats = {
      total: Number(counts?.total || 0),
      active: Number(counts?.active || 0),
      pending: Number(counts?.pending || 0),
      disabled: Number(counts?.disabled || 0)
    }
    stats.inactive = stats.total - stats.active - stats.pending

    const search = String(req.query.search || '').trim()
    const listWhere = search
      ? {
          ...whereCondition,
          [Op.or]: ['userName', 'fullName', 'email'].map((field) => ({
            [field]: { [Op.iLike]: `%${search}%` }
          }))
        }
      : whereCondition

    // Paged only when the caller asks for a page; without page/limit the
    // full list is returned exactly as before.
    const paged = req.query.page !== undefined || req.query.limit !== undefined
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100)
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1)

    const { rows, count } = await User.findAndCountAll({
      where: listWhere,
      order: [['id', 'ASC']],
      ...(paged ? { limit, offset: (page - 1) * limit } : {})
    })
    const getAllUser = rows.map((items) => {
      const getData = {
        ...items.dataValues
      }
      delete getData.password
      return getData
    })

    res.status(200).json({
      message: 'Success',
      data: getAllUser,
      total: count,
      pagination: {
        page: paged ? page : 1,
        limit: paged ? limit : count,
        total: count,
        totalPages: paged ? Math.max(Math.ceil(count / limit), 1) : 1
      },
      stats
    })
  } catch {
    return res.status(500).json({
      error: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.login = async (req, res) => {
  const { userName, password, rememberMe } = req.body

  if (!userName || !password) {
    return res
      .status(400)
      .json({ message: 'Username dan Password harus diisi' })
  }

  try {
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userName)

    // Cari user berdasarkan email atau username
    // (the password hash is excluded by default; verification reads it explicitly)
    const findUser = await User.scope('withCredentials').findOne({
      where: isEmail
        ? { email: userName.toLowerCase() }
        : { userName: userName.toLowerCase() },
      paranoid: false // opsional untuk test
    })

    if (!findUser) {
      // DR-24 C-24a / DR-20: every authentication attempt is audited; an
      // attempt against an unknown identity is attributed to the submitted
      // name with a safe reason code (no credential material).
      await recordAudit({
        actor: { id: null, name: userName },
        req,
        action: AUDIT_ACTIONS.LOGIN,
        entity: 'AUTH',
        result: 'DENIED',
        reason: 'USER_NOT_FOUND',
        source: 'password'
      })
      return res.status(401).json({
        message: 'User Name / Email Tidak Ditemukan'
      })
    }

    // F5: a soft-deleted account can never authenticate — login must not
    // reactivate it (fail closed; the query above uses paranoid:false).
    if (findUser.deletedAt != null) {
      await recordAudit({
        actor: { id: findUser.id, name: findUser.userName },
        req,
        action: AUDIT_ACTIONS.LOGIN,
        entity: 'AUTH',
        entityId: findUser.id,
        result: 'DENIED',
        reason: 'ACCOUNT_DELETED',
        source: 'password'
      })
      return res.status(401).json({
        message: 'User Name / Email Tidak Ditemukan'
      })
    }

    if (findUser.status === 'draft') {
      await recordAudit({
        actor: { id: findUser.id, name: findUser.userName },
        req,
        action: AUDIT_ACTIONS.LOGIN,
        entity: 'AUTH',
        entityId: findUser.id,
        result: 'DENIED',
        reason: 'ACCOUNT_DRAFT',
        source: 'password'
      })
      return res.status(401).json({
        message: 'User Name / Email Tidak Ditemukan'
      })
    }

    // P1-3: a disabled account can never authenticate. Presence `status`
    // alone (e.g. `inactive` from legacy logout) never disables: only the
    // separate `disabledAt` state denies. Placed before password
    // verification like the soft-delete gate above, so denied logins mint
    // no token/session and never reach the presence reactivation below.
    if (findUser.disabledAt != null) {
      await recordAudit({
        actor: { id: findUser.id, name: findUser.userName },
        req,
        action: AUDIT_ACTIONS.LOGIN,
        entity: 'AUTH',
        entityId: findUser.id,
        result: 'DENIED',
        reason: 'ACCOUNT_DISABLED',
        source: 'password'
      })
      return res.status(401).json({
        message: 'User Name / Email Tidak Ditemukan'
      })
    }

    // Cocokkan password
    const isPasswordValid = await bcrypt.compare(password, findUser.password)
    if (!isPasswordValid) {
      await recordAudit({
        actor: { id: findUser.id, name: findUser.userName },
        req,
        action: AUDIT_ACTIONS.LOGIN,
        entity: 'AUTH',
        entityId: findUser.id,
        result: 'FAILURE',
        reason: 'INVALID_PASSWORD',
        source: 'password'
      })
      return res.status(401).json({
        message: 'Password Salah'
      })
    }

    // AUTH-1 P1: every login credential is bound to an authorization session
    // created in one transaction with a locked re-check of the account. The
    // password was verified outside the transaction (bcrypt is slow), so the
    // row is re-read under lock: an account disabled/removed, or a password
    // changed, since that verification gets no session and no token. Any
    // failure (including session creation) rolls back and reaches the
    // catch below — login fails closed, never with a sessionless JWT.
    const verifiedHash = findUser.password
    const credential = credentialWindow(
      Date.now(),
      lifetimeFor(rememberMe === true)
    )
    const outcome = await db.sequelize.transaction(async (t) => {
      const current = await User.scope('withCredentials').findOne({
        where: { id: findUser.id },
        paranoid: false,
        transaction: t,
        lock: t.LOCK.UPDATE
      })
      if (
        !current ||
        current.deletedAt != null ||
        current.disabledAt != null ||
        current.status === 'draft'
      ) {
        return { denied: 'User Name / Email Tidak Ditemukan' }
      }
      if (current.password !== verifiedHash) {
        return { denied: 'Password Salah' }
      }

      // Update status active
      await User.update({ status: 'active' }, { where: { id: findUser.id }, transaction: t })

      const session = await createContextSession(db, {
        userId: findUser.id,
        expiresAt: new Date(credential.exp * 1000),
        transaction: t
      })
      return { sessionId: session.sessionId, account: current }
    })

    if (outcome.denied) {
      // The locked re-check can deny after the password already verified
      // (account disabled/removed or password changed mid-flight). The
      // denial is audited with the same safe reason vocabulary.
      const passwordRejected = outcome.denied === 'Password Salah'
      await recordAudit({
        actor: { id: findUser.id, name: findUser.userName },
        req,
        action: AUDIT_ACTIONS.LOGIN,
        entity: 'AUTH',
        entityId: findUser.id,
        result: passwordRejected ? 'FAILURE' : 'DENIED',
        reason: passwordRejected ? 'INVALID_PASSWORD' : 'ACCOUNT_UNAVAILABLE',
        source: 'password'
      })
      return res.status(401).json({ message: outcome.denied })
    }

    // Signed only after the session committed; exp equals the session's
    // expiresAt. P6: the payload carries only the canonical identity/session
    // identifiers; iat/exp come from the credential window. Authority always
    // comes from the DB session + account row, never JWT claims.
    const { account } = outcome
    const getToken = generateToken(
      {
        id: account.id,
        sessionId: outcome.sessionId
      },
      credential
    )

    // Ambil role dan accessMenu
    let roleData = null
    let accessMenu = findUser.accessMenu

    if (findUser.roleId) {
      roleData = await db.role.findByPk(findUser.roleId)
      if (roleData && (!accessMenu || !accessMenu.length)) {
        accessMenu = roleData.accessMenu
      }
    }

    // A super_admin normally sees every menu (it also inherits the Super
    // Admin role's full list). A super_admin account that carries its OWN
    // accessMenu is menu-scoped: the client shows only those menus. UX only —
    // server-side authority of a super_admin is unchanged.
    const accessMenuScoped =
      findUser.roleType === 'super_admin' && parseAccessMenu(findUser.accessMenu).length > 0

    // D8: never disclose the credential verifier. Strip the bcrypt hash
    // from the user object before embedding it in either login response
    // below (same boundary already applied to register/get-all-user).
    const safeUser = findUser.toJSON()
    delete safeUser.password

    // DR-24 C-24a / DR-20: the successful authentication is audited once the
    // session is committed, before any response branch. The row carries the
    // identity, scope and outcome only — never the password or the session
    // id / JWT (both stay out of every audit payload).
    await recordAudit({
      actor: { id: findUser.id, name: findUser.userName },
      req,
      action: AUDIT_ACTIONS.LOGIN,
      entity: 'AUTH',
      entityId: findUser.id,
      storeId: account.store,
      result: 'SUCCESS',
      source: 'password',
      metadata: {
        roleType: findUser.roleType || 'user',
        userType: findUser.userType
      }
    })

    // Jika userType bukan admin/user
    if (!['admin', 'user'].includes(findUser.userType)) {
      return res.status(200).json({
        message: 'Success Login',
        token: getToken,
        user: {
          ...safeUser,
          roleType: findUser.roleType || 'user',
          roleName: roleData?.name || 'Staff/Karyawan',
          accessMenu: parseAccessMenu(accessMenu),
          accessMenuScoped
        }
      })
    }

    // Ambil data tambahan
    const location = await Location.findOne({ where: { id: findUser.store } })
    const position = await Position.findOne({
      where: { id: findUser.position }
    })

    return res.status(200).json({
      message: 'Success Login',
      token: getToken,
      user: {
        ...safeUser,
        roleType: findUser.roleType || 'user',
        roleName: roleData?.name || 'Staff/Karyawan',
        accessMenu: parseAccessMenu(accessMenu),
        accessMenuScoped,
        storeName: location?.name ?? '',
        positionName: position?.name ?? ''
      }
    })
  } catch (error) {
    console.error('ERROR LOGIN =>', error)
    return res.status(500).json({
      message: 'Terjadi Kesalahan Internal Server'
    })
  } finally {
    console.log('resEND')
  }
}

// Register (public, unauthenticated)
// CRIT-1: caller-controlled `store`/`userType`/`shift`/`position`/`accessMenu`
// are stripped by registerSchema. This endpoint ALWAYS creates an unassigned
// (store: null), non-privileged (roleType 'user', userType 'user') account and
// does NOT issue a JWT — a store is assigned later by an authorized admin via
// /auth/change-profile-user, after which normal login applies.
exports.registerNewUser = async (req, res) => {
  const body = req.body

  try {
    // Password and confirmPassword have already been validated by the schema,
    // but keep the check as a defense in depth.
    if (body?.password !== body?.confirmPassword) {
      return res.status(400).json({
        message: 'Password dan Konfirmasi Password Tidak Cocok'
      })
    }

    // Check if the user (either by email or userName) already exists
    const findUser = await User.findOne({
      where: {
        [Op.or]: [{ userName: body?.userName }, { email: body?.email }]
      }
    })

    if (!findUser) {
      const employeeID = String(Math.floor(100000 + Math.random() * 900000))

      // Get default role (Staff/Karyawan) - roleType 'user'
      const defaultRole = await db.role.findOne({
        where: { roleType: 'user' }
      })

      // Create new user in the database (password auto-hashed by model hook).
      // Public registration is always unassigned + non-privileged: ignoring
      // anything the caller says about store/role (CRIT-1).
      const createUser = await User.create({
        roleType: 'user', // Default role is user (never caller-controlled)
        roleId: defaultRole?.id || null, // Assign default role ID
        userType: 'user', // Default userType is user (never caller-controlled)
        userName: body?.userName,
        password: body?.password,
        email: body?.email,
        address: body.address,
        employeeID: employeeID, // Assign generated Employee ID
        fullName: body?.fullName || '',
        phoneNumber: body?.phoneNumber || '',
        gender: body?.gender || '',
        dateOfBirth: body?.dateOfBirth || null,
        placeOfBirth: body?.placeOfBirth || '',
        store: null, // Unassigned — admin must assign a store via change-profile-user
        shift: null, // Not caller-controlled (CRIT-1)
        position: null, // Not caller-controlled (CRIT-1)
        accessMenu: null,
        status: 'active',
        modifiedAt: moment().format('YYYY-MM-DD HH:mm:ss')
      })
      createAudit(
        req,
        'create',
        'user',
        createUser.id,
        `Created user: ${createUser.userName || createUser.id}`
      )

      const result = createUser.toJSON()
      delete result.password // Remove the password before sending it back

      // Deliberately NO token here: public registration must not mint an
      // authenticated session (CRIT-1). The account can only be used after an
      // admin assigns its store; normal login then issues the token.
      return res.status(200).json({
        message: 'Success Menyimpan User',
        data: result
      })
    } else {
      return res.status(401).json({
        message: 'Email / Username Sudah Terdaftar'
      })
    }
  } catch (error) {
    console.log('ERROR REGISTER =>', error)

    return res.status(500).json({
      message: 'Terjadi Kesalahan Internal Server',
      error: error.message
    })
  }
}

// Edit User
exports.editUser = async (req, res) => {
  try {
    const { body } = req
    const imageFile = req.file

    if (!body?.email) {
      return res.status(400).json({ message: 'Email wajib diisi' })
    }

    const existingUser = await User.findOne({
      where: { email: body.email }
    })

    if (!existingUser) {
      return res.status(404).json({ message: 'User not found' })
    }

    // Security: users may only edit their own profile
    if (existingUser.id !== req.user?.id) {
      return res.status(403).json({
        message: 'Anda hanya dapat mengubah profil Anda sendiri'
      })
    }

    let image = existingUser.image

    if (imageFile) {
      const uploadedImage = await uploadToCloudinary(
        imageFile.path,
        'pos-app-users'
      )

      if (existingUser.image) {
        await deleteFromCloudinary(existingUser.image)
      }
      image = uploadedImage
    }

    const updatedUser = await existingUser.update({
      userName: body.userName,
      fullName: body.fullName || existingUser.fullName,
      address: body.address,
      gender: body.gender,
      phoneNumber: body.phoneNumber,
      dateOfBirth: body.dateOfBirth ? body.dateOfBirth : null,
      placeOfBirth: body.placeOfBirth || existingUser.placeOfBirth,
      image: image,
      deletedAt: null
    })
    createAudit(
      req,
      'update',
      'user',
      updatedUser.id,
      `Updated user: ${updatedUser.id}`
    )

    // AUTH-1 P1: a profile edit mints no credential — only login does. The
    // caller keeps its existing session token.
    const locationByIdUserLogin = await Location.findOne({
      where: {
        id: updatedUser.dataValues.store
      }
    })

    const positionByIdUserLogin = await Position.findOne({
      where: {
        id: updatedUser.dataValues.position
      }
    })

    return res.status(200).json({
      message: 'Success Login',
      user: {
        ...updatedUser?.dataValues,
        storeName: locationByIdUserLogin?.dataValues?.name ?? '',
        positionName: positionByIdUserLogin?.dataValues?.name ?? ''
      }
    })
  } catch (error) {
    console.error('ERROR:', error)
    return res.status(500).json({ message: 'Internal server error' })
  }
}

const RESET_TOKEN_TTL_MINUTES = 15

const getFrontendUrl = () => process.env.FRONTEND_URL || 'http://localhost:5173'

// Request Password Reset (step 1): generate a one-time token and email it.
// Always returns the same response whether or not the email exists so the
// endpoint does not leak which accounts are registered.
exports.requestResetPassword = async (req, res) => {
  const body = req?.body
  const email = String(body?.email || '')
    .trim()
    .toLowerCase()
    .slice(0, 254)

  if (!email) {
    return res.status(400).json({ error: 'Email wajib diisi' })
  }

  try {
    const existingUser = await User.findOne({ where: { email } }) // codacy-ignore-line

    if (existingUser) {
      const token = crypto.randomBytes(32).toString('hex')
      const expiresAt = new Date(
        Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000
      )

      // Only the digest is stored; the plaintext token exists solely in the email.
      existingUser.resetToken = hashResetToken(token)
      existingUser.resetTokenExpires = expiresAt
      await existingUser.save()

      const resetUrl = `${getFrontendUrl()}/reset-password?token=${token}&email=${encodeURIComponent(email)}`
      const mail = buildResetPasswordEmail({
        name: existingUser.fullName,
        resetUrl,
        expiresInMinutes: RESET_TOKEN_TTL_MINUTES
      })

      try {
        await sendEmail({ to: email, ...mail })
      } catch (emailError) {
        console.error(
          'Reset password email failed to send:',
          emailError.message
        )
        if (process.env.NODE_ENV !== 'production') {
          console.log(`[DEV] Reset password link for ${email}: ${resetUrl}`)
        }
      }

      createAudit(
        req,
        'request-reset',
        'user',
        existingUser.id,
        `Requested password reset for user ${existingUser.id}`
      )
    }

    return res.status(200).json({
      message:
        'Jika email terdaftar, tautan atur ulang kata sandi telah dikirim. Cek kotak masuk Anda.'
    })
  } catch (error) {
    console.error('ERROR requestResetPassword:', error)
    return res.status(500).json({ error: 'Terjadi Kesalahan Internal Server' })
  }
}

// Reset Password (step 2): requires the one-time token emailed in step 1.
exports.resetPassword = async (req, res) => {
  const body = req?.body

  if (
    !body?.email ||
    !body?.token ||
    !body?.newPassword ||
    !body?.confirmPassword
  ) {
    return res.status(400).json({
      error: 'Email, token, New Password, dan Confirm Password harus diisi'
    })
  }

  if (body.newPassword !== body.confirmPassword) {
    return res.status(400).json({
      error: 'New Password dan Confirm Password tidak cocok'
    })
  }

  if (body.newPassword.length < 6) {
    return res.status(400).json({
      error: 'Password minimal 6 karakter'
    })
  }

  try {
    const email = String(body.email).trim().toLowerCase()
    const existingUser = await User.scope('withCredentials').findOne({ where: { email } })

    if (
      !existingUser ||
      !resetTokenMatches(existingUser.resetToken, body.token) ||
      !existingUser.resetTokenExpires ||
      new Date(existingUser.resetTokenExpires).getTime() < Date.now()
    ) {
      return res.status(400).json({
        error:
          'Tautan atur ulang kata sandi tidak valid atau sudah kedaluwarsa. Silakan minta ulang.'
      })
    }

    existingUser.password = body.newPassword
    existingUser.resetToken = null
    existingUser.resetTokenExpires = null
    // AUTH-1 P3: a credential change invalidates every existing session in
    // the same transaction; the password UPDATE runs first, so a racing
    // login either sees the new hash under its row lock (P1) or has its
    // session revoked here.
    await db.sequelize.transaction(async (t) => {
      await existingUser.save({ transaction: t })
      await revokeAllUserSessions(db, existingUser.id, { transaction: t })
    })
    // AUTH-1 P4: committed; drop the account's live sockets.
    disconnectUser(existingUser.id)

    createAudit(
      req,
      'reset-password',
      'user',
      existingUser.id,
      `Password reset for user ${existingUser.id}`
    )

    return res.status(200).json({
      message: 'Password berhasil direset. Silakan login dengan password baru.'
    })
  } catch (error) {
    console.log('ERROR =>', error)
    return res.status(500).json({
      error: 'Terjadi Kesalahan Internal Server'
    })
  }
}

// Generate Employee ID
exports.generateEmployeeId = async (req, res) => {
  try {
    const employeeId = String(Math.floor(100000 + Math.random() * 900000))

    return res.status(200).json({
      success: true,
      data: { employeeId }
    })
  } catch (error) {
    console.error('Error generate employee ID:', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

// User Logout
// AUTH-1 P3: revokes the authenticated session loaded by canonical
// `authorization` (req.authSession). There is no sessionless path: a token
// that is not bound to a live session never reaches this handler.
exports.logout = async (req, res) => {
  try {
    const session = req.authSession

    if (!session || !req.user) {
      return res.status(401).json({
        message: 'Unauthorized'
      })
    }

    await revokeContextSession(db, session.sessionId, req.user.id)
    // AUTH-1 P4: the revocation is committed; drop this session's live sockets.
    disconnectSession(session.sessionId)

    // DR-24 C-24a / DR-20: the revocation is audited after it committed;
    // the session id itself never enters the row.
    await recordAudit({
      actor: { id: req.user.id },
      req,
      action: AUDIT_ACTIONS.LOGOUT,
      entity: 'AUTH',
      entityId: req.user.id,
      result: 'SUCCESS',
      source: 'session'
    })

    res.clearCookie('token')

    return res.status(200).json({
      message: 'User Berhasil Logout'
    })
  } catch (error) {
    console.log('ERROR LOGOUT =>', error)
    return res.status(500).json({
      error: 'Terjadi Kesalahan Internal Server'
    })
  }
}
