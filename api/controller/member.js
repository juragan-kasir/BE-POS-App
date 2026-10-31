const db = require('../../db/models')
const Member = db.member
const { Op } = require('sequelize')
const { createAudit } = require('../../utils/auditLog')
const { enrichAuditFields } = require('../../utils/auditFields')
const {
  canonicalPhone,
  isGuestPhone,
  newGuestPhone,
  parsePhoneInput,
  phoneSearchPrefix
} = require('../../utils/memberIdentity')

// D-05: name/email prechecks evaluate BOTH sides with the unique-index
// expression LOWER(TRIM(...)), so the precheck identity is exactly the DB
// index identity (PostgreSQL TRIM/LOWER semantics, no JS/SQL whitespace
// divergence). The DB index remains the final arbiter; this is UX/error
// messaging only.
const lowerTrim = (value) =>
  db.sequelize.fn('LOWER', db.sequelize.fn('TRIM', value))
const sameIdentity = (column, input) =>
  db.sequelize.where(lowerTrim(db.sequelize.col(column)), lowerTrim(input))

// D-05: DB unique violations (precheck/write race) map to the existing member
// vocabulary by index name. The parsed field path is unusable for expression
// indexes (it yields 'store' or 'lower(TRIM(BOTH FROM email))').
const MEMBER_UNIQUE_MESSAGES = {
  uq_member_store_name_ci: 'Nama member sudah terdaftar',
  uq_member_global_name_ci: 'Nama member sudah terdaftar',
  uq_member_phone_e164: 'Nomor telepon sudah terdaftar',
  uq_member_email_ci: 'Email sudah terdaftar',
  uq_member_store_phone_e164: 'Nomor telepon sudah terdaftar',
  uq_member_global_phone_e164: 'Nomor telepon sudah terdaftar',
  uq_member_store_email_ci: 'Email sudah terdaftar',
  uq_member_global_email_ci: 'Email sudah terdaftar'
}

const INVALID_PHONE_MESSAGE = 'Nomor telepon tidak valid'

// Shared create/update error mapping. Returns the sent response, or null when
// the error is not a known client/uniqueness error.
const respondMemberWriteError = (res, error) => {
  if (error.statusCode) {
    return res.status(error.statusCode).json({
      success: false,
      message: error.message
    })
  }
  if (error.name === 'SequelizeUniqueConstraintError') {
    const constraint = error.parent?.constraint || error.original?.constraint
    const message =
      MEMBER_UNIQUE_MESSAGES[constraint] ||
      `${error.errors?.[0]?.path || 'field'} sudah digunakan`
    return res.status(409).json({ success: false, message })
  }
  return null
}

exports.getAllMember = async (req, res) => {
  try {
    const {
      nameMember,
      phoneNumber,
      page = 1,
      limit = 10,
      tier,
      status
    } = req.query
    const filters = {}

    let store = req.query.store
    if (req.user?.roleType !== 'super_admin') {
      store = req.user?.store
    }
    if (store) {
      filters.store = store
    }

    if (nameMember) {
      filters.name = {
        [Op.like]: `%${nameMember}%`
      }
    }

    if (phoneNumber) {
      // D-05: member phones are stored as E.164, so national-form input
      // ('0812...') must also match the library-derived canonical prefix
      // ('+62812...'). The raw substring match is preserved as-is.
      const canonicalPrefix = phoneSearchPrefix(phoneNumber)
      filters.phoneNumber = canonicalPrefix
        ? {
            [Op.or]: [
              { [Op.like]: `%${phoneNumber}%` },
              { [Op.like]: `${canonicalPrefix}%` }
            ]
          }
        : { [Op.like]: `%${phoneNumber}%` }
    }

    if (tier != null) {
      filters.tier = tier
    }

    if (status) {
      filters.status = status
    }

    const offset = (page - 1) * limit

    const { count, rows } = await Member.findAndCountAll({
      where: filters,
      offset: parseInt(offset),
      limit: parseInt(limit),
      order: [['createdAt', 'DESC']]
    })
    await enrichAuditFields(db, rows)

    const totalMembers = await Member.count({ where: filters })
    const activeCount = await Member.count({
      where: { ...filters, status: 'active' }
    })
    const draftCount = await Member.count({
      where: { ...filters, status: 'draft' }
    })
    const inactiveCount = await Member.count({
      where: { ...filters, status: 'inactive' }
    })

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: rows,
      pagination: {
        total: count,
        totalPages: Math.ceil(count / limit),
        page: parseInt(page),
        limit: parseInt(limit)
      },
      stats: {
        total: totalMembers,
        active: activeCount,
        draft: draftCount,
        inactive: inactiveCount
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

exports.getMemberById = async (req, res) => {
  try {
    const { id } = req.params
    const { page = 1, limit = 5 } = req.query
    const store =
      req.user?.roleType === 'super_admin'
        ? req.storeId || null
        : req.user?.store || null

    const member = store
      ? await Member.findOne({ where: { id, store } })
      : await Member.findByPk(id)

    if (!member) {
      return res.status(404).json({
        success: false,
        message: 'Member tidak ditemukan'
      })
    }

    const offset = (parseInt(page) - 1) * parseInt(limit)
    const orderWhere = { customerId: id, ...(store ? { store } : {}) }
    const { count, rows: orders } = await db.order.findAndCountAll({
      where: orderWhere,
      include: [
        { model: db.location, as: 'storeData', attributes: ['id', 'name'] }
      ],
      order: [['createdAt', 'DESC']],
      attributes: [
        'id',
        'orderNumber',
        'totalPrice',
        'status',
        'createdAt',
        'store'
      ],
      limit: parseInt(limit),
      offset
    })

    const allOrders = await db.order.findAll({
      where: orderWhere,
      attributes: ['totalPrice']
    })
    const totalSpent = allOrders.reduce(
      (sum, o) => sum + (Number(o.totalPrice) || 0),
      0
    )

    const transactions = orders.map((o) => ({
      id: o.id,
      code: o.orderNumber,
      invoice: o.orderNumber,
      date: o.createdAt,
      store: o.storeData?.name || `Store #${o.store}`,
      storeName: o.storeData?.name || `Store #${o.store}`,
      amount: Number(o.totalPrice) || 0,
      total: Number(o.totalPrice) || 0,
      status: o.status === 'paid' ? 'completed' : o.status
    }))

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: {
        ...member.toJSON(),
        transactions,
        totalSpent,
        transactionPagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / parseInt(limit))
        }
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

exports.addNewMember = async (req, res) => {
  const body = req.body

  try {
    const store =
      req.user?.roleType === 'super_admin'
        ? body.store || null
        : req.user?.store || null

    // D-05: missing/empty/whitespace-only phone -> server-generated guest;
    // a client can never supply a GUEST-* identity on create.
    const phoneInput = parsePhoneInput(body.phoneNumber)
    if (phoneInput.kind === 'guest') {
      return res
        .status(400)
        .json({ success: false, message: INVALID_PHONE_MESSAGE })
    }

    if (body?.nameMember) {
      const nameExists = await Member.findOne({
        where: {
          [Op.and]: [
            sameIdentity('name', body.nameMember),
            store !== null ? { store } : { store: null }
          ]
        },
        raw: true
      })
      if (nameExists) {
        return res
          .status(409)
          .json({ success: false, message: 'Nama member sudah terdaftar' })
      }
    }
    // Phone and email are unique per store bucket, like names (2026-10-31).
    const storeBucket = store !== null ? { store } : { store: null }
    if (phoneInput.kind === 'phone') {
      const phoneExists = await Member.findOne({
        where: { phoneNumber: phoneInput.value, ...storeBucket },
        raw: true
      })
      if (phoneExists) {
        return res
          .status(409)
          .json({ success: false, message: 'Nomor telepon sudah terdaftar' })
      }
    }
    if (body?.email) {
      const emailExists = await Member.findOne({
        where: {
          [Op.and]: [
            sameIdentity('email', body.email),
            { email: { [Op.ne]: null } },
            storeBucket
          ]
        },
        raw: true
      })
      if (emailExists) {
        return res
          .status(409)
          .json({ success: false, message: 'Email sudah terdaftar' })
      }
    }

    // D-05: supplied phones are stored canonical (E.164); a missing phone
    // gets a server-generated guest identifier (exempt from phone
    // uniqueness). Names/emails are stored as-input (expression indexes).
    const phoneNumber =
      phoneInput.kind === 'phone' ? phoneInput.value : newGuestPhone()

    const createdMember = await Member.create({
      store,
      name: body.nameMember,
      phoneNumber,
      email: body.email || null,
      dateOfBirth: body.birthDate,
      gender: body.gender,
      address: body.address,
      tier: body.tier === '' ? null : body.tier,
      status:
        body.status !== undefined
          ? body.status === true
            ? 'active'
            : body.status === false
              ? 'inactive'
              : body.status
          : 'active',
      totalPoints: body.point || 0,
      lifetimePoints: body.point || 0
    })

    if (createdMember.getDataValue) {
      createAudit(
        req,
        'create',
        'member',
        createdMember.id,
        `Created member: ${createdMember.name}`
      )
      return res.status(201).json({
        success: true,
        message: 'Member Berhasil Di Buat',
        data: createdMember
      })
    }
  } catch (error) {
    console.error('Error =>', error)
    if (respondMemberWriteError(res, error)) return
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.editMember = async (req, res) => {
  try {
    const { id } = req.params
    const {
      nameMember,
      phoneNumber,
      email,
      birthDate,
      gender,
      address,
      tier,
      status,
      point
    } = req.body

    const member = await Member.findByPk(id)

    if (!member) {
      return res.status(404).json({
        success: false,
        message: 'Member tidak ditemukan'
      })
    }

    // C-9: `member.store &&` short-circuited when the member was global
    // (store: null — a chain-wide loyalty member, intentionally readable/
    // redeemable at any store during checkout), letting ANY tenant admin
    // edit it. A global member's own ADMIN record (name/phone/tier/points)
    // must only be mutated by super_admin — falsy store is no longer an
    // implicit pass.
    if (
      req.user?.roleType !== 'super_admin' &&
      (!member.store || Number(member.store) !== Number(req.user?.store))
    ) {
      return res.status(403).json({
        success: false,
        message: 'Anda tidak memiliki akses untuk mengedit member ini'
      })
    }

    // D-05: missing/empty/whitespace-only phone leaves the phone unchanged.
    // A GUEST-* value is accepted only as the member's own current value
    // (no-op); a client can never assign an arbitrary guest identity.
    const phoneInput = parsePhoneInput(phoneNumber)
    if (phoneInput.kind === 'guest' && phoneInput.value !== member.phoneNumber) {
      return res
        .status(400)
        .json({ success: false, message: INVALID_PHONE_MESSAGE })
    }

    if (nameMember) {
      const nameExists = await Member.findOne({
        where: {
          [Op.and]: [
            sameIdentity('name', nameMember),
            { id: { [Op.ne]: id } },
            member.store ? { store: member.store } : { store: null }
          ]
        },
        raw: true
      })
      if (nameExists) {
        return res
          .status(409)
          .json({ success: false, message: 'Nama member sudah terdaftar' })
      }
    }
    const memberBucket = member.store ? { store: member.store } : { store: null }
    if (phoneInput.kind === 'phone') {
      const phoneExists = await Member.findOne({
        where: {
          phoneNumber: phoneInput.value,
          id: { [Op.ne]: id },
          ...memberBucket
        },
        raw: true
      })
      if (phoneExists) {
        return res
          .status(409)
          .json({ success: false, message: 'Nomor telepon sudah terdaftar' })
      }
    }
    if (email) {
      const emailExists = await Member.findOne({
        where: {
          [Op.and]: [
            sameIdentity('email', email),
            { id: { [Op.ne]: id } },
            { email: { [Op.ne]: null } },
            memberBucket
          ]
        },
        raw: true
      })
      if (emailExists) {
        return res
          .status(409)
          .json({ success: false, message: 'Email sudah terdaftar' })
      }
    }

    const updateData = {}
    if (nameMember) updateData.name = nameMember
    // D-05: store canonical E.164 (a guest member's own unchanged GUEST-*
    // value is a no-op and is not rewritten).
    if (phoneInput.kind === 'phone') updateData.phoneNumber = phoneInput.value
    if (email !== undefined) updateData.email = email || null
    if (birthDate !== undefined) updateData.dateOfBirth = birthDate
    if (gender !== undefined) updateData.gender = gender
    if (address !== undefined) updateData.address = address
    if (tier !== undefined) updateData.tier = tier === '' ? null : tier
    if (status !== undefined) updateData.status = status
    if (point !== undefined) {
      updateData.totalPoints = point
    }
    updateData.modifiedBy = req.user?.id

    const updatedMember = await member.update(updateData)

    createAudit(
      req,
      'update',
      'member',
      id,
      `Updated member: ${id}`,
      member.dataValues,
      updateData
    )

    return res.status(200).json({
      success: true,
      message: 'Member berhasil diperbarui',
      data: updatedMember
    })
  } catch (error) {
    console.error('Error =>', error)

    // D-05: DB uniqueness violations (race between precheck and update) map
    // to 409 with the existing member vocabulary, matching addNewMember.
    if (respondMemberWriteError(res, error)) return

    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.deleteMember = async (req, res) => {
  try {
    const { id } = req.params

    const member = await Member.findByPk(id)

    if (!member) {
      return res.status(404).json({
        success: false,
        message: 'Member tidak ditemukan'
      })
    }

    // C-9: same falsy-store bypass as editMember — a global member must
    // only be deleted by super_admin, not any tenant admin.
    if (
      req.user?.roleType !== 'super_admin' &&
      (!member.store || Number(member.store) !== Number(req.user?.store))
    ) {
      return res.status(403).json({
        success: false,
        message: 'Anda tidak memiliki akses untuk menghapus member ini'
      })
    }

    await member.destroy()

    createAudit(req, 'delete', 'member', id, `Deleted member: ${member.name}`)

    return res.status(200).json({
      success: true,
      message: 'Member berhasil dihapus'
    })
  } catch (error) {
    console.error('Error =>', error)

    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.editMemberById = async (req, res) => {
  const body = req.body
  const phoneNumber = String(req.params.phoneNumber || '')
  try {
    const store =
      req.user?.roleType === 'super_admin'
        ? req.storeId || null
        : req.user?.store || null

    // D-05: phone identity is canonical E.164. A server-generated GUEST-*
    // value matches exactly; any other unparseable input never matches by
    // phone (the numeric-ID lookup is unchanged); a miss stays 403.
    let phoneLookup = null
    if (isGuestPhone(phoneNumber)) {
      phoneLookup = phoneNumber
    } else {
      try {
        phoneLookup = canonicalPhone(phoneNumber)
      } catch {
        phoneLookup = null
      }
    }
    const lookups = [
      ...(phoneLookup ? [{ phoneNumber: phoneLookup }] : []),
      ...(Number(phoneNumber) > 0 ? [{ id: Number(phoneNumber) }] : [])
    ]
    const matches =
      lookups.length > 0
        ? await Member.findAll({
            where: {
              [Op.or]: lookups,
              ...(store ? { store } : {})
            },
            limit: 2
          })
        : []
    if (matches.length > 1) {
      return res.status(409).json({
        success: false,
        code: 'MEMBER_STORE_REQUIRED',
        message: 'Nomor telepon terdaftar di lebih dari satu toko. Pilih toko terlebih dahulu.'
      })
    }
    const getMember = matches[0] || null

    if (getMember) {
      const addedPoints = Number(body.points) || 0
      const newTotal = (getMember.totalPoints || 0) + addedPoints
      const newLifetime = (getMember.lifetimePoints || 0) + addedPoints

      if (newTotal < 0) {
        return res.status(400).json({
          success: false,
          message: 'Poin tidak cukup untuk diredeem'
        })
      }

      await getMember.update({
        totalPoints: newTotal,
        lifetimePoints: newLifetime
      })

      await db.member_point_history.create({
        member: getMember.id,
        pointsChange: addedPoints,
        pointsBefore: getMember.totalPoints,
        pointsAfter: newTotal,
        notes: 'Manual points adjustment'
      })

      createAudit(
        req,
        'update',
        'member',
        getMember.id,
        `Updated member points: ${getMember.name}`
      )
      return res.status(200).json({
        success: true,
        message: 'Sukses',
        data: getMember
      })
    } else {
      return res.status(403).json({
        success: false,
        message: 'Member Tidak Ditemukan'
      })
    }
  } catch (error) {
    console.error('Error =>', error)

    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}
