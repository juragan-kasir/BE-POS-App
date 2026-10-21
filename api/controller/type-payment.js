const db = require('../../db/models')
const { Op } = require('sequelize')
const ExcelJS = require('exceljs')
const TypePayment = db.type_payment
const { createAudit } = require('../../utils/auditLog')
const { scalarStoreScope } = require('../../utils/tenantScope')
const { authorizedStoreIds } = require('../../utils/storeValidation')

// Resolves the store payload sent by the FE (single id, JSON string array, or 'all')
// into a list of store ids to attach rows to. Empty array means global (store null).
//
// C-1 hardening: the RAW resolveStoreIds is only used as a pure normalizer for the
// super_admin multi-store path. For non-super-admin, callers MUST gate through
// authorizedStoreIds() (which rejects ANY foreign/ambiguous representation) BEFORE
// any write happens. Never trust this raw list for a tenant write.
const resolveStoreIds = (rawStore, userStore) => {
  let s = rawStore
  if (s === undefined || s === null) s = userStore
  if (s === '' || s === 'all') return []
  let arr = s
  if (typeof s === 'string') {
    try {
      arr = JSON.parse(s)
    } catch {
      arr = [s]
    }
  }
  if (!Array.isArray(arr)) arr = [arr]
  const ids = arr
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n > 0)
  return [...new Set(ids)]
}

// Matches store-specific rows plus global (store null) rows for reads.
const buildStoreWhere = (store) => {
  if (!store) return {}
  return { [Op.or]: [{ store }, { store: null }] }
}

exports.getAllTypePaymentByLocationAndActive = async (req, res) => {
  const store = req.query.store ||
      (req.user?.roleType !== 'super_admin' ? req.user?.store : null)
  const { page = 1, limit = 10, search } = req.query

  try {
    const offset = (page - 1) * limit

    const where = buildStoreWhere(store)
    if (search) where.name = { [Op.iLike]: `%${search}%` }

    const { rows: typePayment, count } = await TypePayment.findAndCountAll({
      where,
      limit: parseInt(limit),
      offset: parseInt(offset)
    })

    const [active, draft, inactive] = await Promise.all([
      TypePayment.count({
        where: { ...buildStoreWhere(store), status: 'active' }
      }),
      TypePayment.count({
        where: { ...buildStoreWhere(store), status: 'draft' }
      }),
      TypePayment.count({
        where: { ...buildStoreWhere(store), status: 'inactive' }
      })
    ])

    return res.status(200).json({
      success: true,
      message: 'Success',
      data:
        typePayment?.length > 0
          ? typePayment?.map((items) => {
              return {
                ...items?.dataValues
              }
            })
          : [],
      total: count,
      currentPage: parseInt(page),
      totalPages: Math.ceil(count / limit),
      stats: { total: active + draft + inactive, active, draft, inactive }
    })
  } catch (error) {
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.getAllTypePayment = async (req, res) => {
  const store = req.query.store ||
      (req.user?.roleType !== 'super_admin' ? req.user?.store : null)
  const {
    page = 1,
    pageSize = req.query.limit || 10,
    status,
    search
  } = req.query

  try {
    const offset = (page - 1) * pageSize

    const queryConditions = buildStoreWhere(store)

    if (status && status !== 'all') {
      queryConditions.status = status
    }

    if (search) queryConditions.name = { [Op.iLike]: `%${search}%` }

    const subCategory = await TypePayment.findAll({
      where: queryConditions,
      limit: parseInt(pageSize),
      offset: parseInt(offset),
      order: [['updatedAt', 'DESC']]
    })

    const totalTypePayments = await TypePayment.count({
      where: queryConditions
    })

    return res.status(200).json({
      success: true,
      message: 'Success',
      data:
        subCategory?.length > 0
          ? subCategory?.map((items) => {
              return {
                ...items?.dataValues
              }
            })
          : [],
      pagination: {
        currentPage: parseInt(page),
        pageSize: parseInt(pageSize),
        totalItems: totalTypePayments,
        totalPages: Math.ceil(totalTypePayments / pageSize)
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

exports.getTypePaymentById = async (req, res) => {
  try {
    // IDOR fix: was findByPk(id) with no store filter, reachable by any
    // authenticated role (no requireRole on this route). Mirrors
    // editTypePaymentById's existing correct convention exactly: a
    // type_payment with store: null is a global/system entry visible to
    // everyone (a plain scalarStoreScope would incorrectly hide those from
    // non-super-admin), a type_payment with a real store is only visible
    // to that store's users.
    const isSuperAdmin = req.user?.roleType === 'super_admin'
    const typePayment = await TypePayment.findOne({
      where: isSuperAdmin
        ? { id: req.params.id }
        : {
            id: req.params.id,
            [Op.or]: [{ store: null }, { store: req.user?.store }]
          }
    })

    if (!typePayment) {
      return res.status(404).json({
        success: false,
        message: 'TypePayment not found'
      })
    }

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: typePayment
    })
  } catch (error) {
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.postNewTypePayment = async (req, res) => {
  const { name, type, icon, status, feeType, fee, tenor, sortOrder } = req.body
  let stores
  if (req.user?.roleType === 'super_admin') {
    stores = resolveStoreIds(req.body.store, req.user?.store)
  } else {
    // C-1: single-store tenant — reject ambiguously/foreign store immediately;
    // pin the write to the authorized own store.
    const authz = authorizedStoreIds(req)
    if (!authz.ok) {
      return res.status(403).json({
        success: false,
        message: 'Anda hanya dapat mengakses data di toko Anda'
      })
    }
    stores = authz.stores
  }
  const statusValue =
    status !== undefined
      ? status === true
        ? 'active'
        : status === false
          ? 'inactive'
          : status
      : 'active'
  try {
    const created = []
    const targets = stores.length > 0 ? stores : [null]
    for (const target of targets) {
      const findOneTypePayment = await TypePayment?.findOne({
        where: {
          name,
          ...(target !== null ? { store: target } : { store: null })
        }
      })
      if (findOneTypePayment) continue
      const postData = await TypePayment.create({
        name,
        store: target,
        type: type || 'cash',
        icon: icon || '',
        feeType: feeType || 'fixed',
        fee: fee !== undefined ? fee : 0,
        tenor: tenor !== undefined ? tenor : 0,
        sortOrder: sortOrder !== undefined ? sortOrder : 0,
        status: statusValue
      })
      created.push(postData)
    }

    if (created.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'TypePayment Sudah Terdaftar'
      })
    }

    createAudit(
      req,
      'create',
      'type_payment',
      created[0].id,
      'Created type_payment: ' + (created[0].name || created[0].id)
    )
    return res.status(200).json({
      success: true,
      message: 'Success',
      data: created.length === 1 ? created[0] : created
    })
  } catch (error) {
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.editTypePaymentById = async (req, res) => {
  const body = req.body
  let stores
  if (req.user?.roleType === 'super_admin') {
    stores = resolveStoreIds(body.store, req.user?.store)
  } else {
    // C-1: single-store tenant edits must not expand scope.
    const authz = authorizedStoreIds(req)
    if (!authz.ok) {
      return res.status(403).json({
        success: false,
        message: 'Anda hanya dapat mengakses data di toko Anda'
      })
    }
    stores = authz.stores
  }
  try {
    const existing = await TypePayment.findByPk(req.params.id)
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'TypePayment not found'
      })
    }
    if (existing?.isSystem) {
      return res.status(403).json({
        success: false,
        message: 'Metode pembayaran sistem tidak dapat diedit'
      })
    }
    // C-9: `existing.store &&` short-circuited when the type_payment was
    // global (store: null, non-system) — any tenant admin could edit it.
    // A non-system global type_payment must only be mutated by
    // super_admin, matching the isSystem guard above for the system case.
    if (
      req.user?.roleType !== 'super_admin' &&
      (!existing.store || Number(existing.store) !== Number(req.user?.store))
    ) {
      return res.status(403).json({
        success: false,
        message:
          'Anda tidak memiliki akses untuk mengedit metode pembayaran ini'
      })
    }

    const targetStore =
      stores.length === 1
        ? stores[0]
        : stores.length > 1
          ? existing.store
          : null
    const getDuplicate = await TypePayment.findOne({
      where: {
        name: body.name,
        ...(targetStore !== null ? { store: targetStore } : { store: null })
      }
    })

    if (!getDuplicate || getDuplicate.id === parseInt(req.params.id)) {
      const editTypePayment = await TypePayment?.update(
        {
          name: body.name,
          ...(targetStore !== undefined && { store: targetStore }),
          type: body.type || existing.type,
          icon: body.icon !== undefined ? body.icon : existing.icon,
          feeType: body.feeType !== undefined ? body.feeType : existing.feeType,
          fee: body.fee !== undefined ? body.fee : existing.fee,
          tenor: body.tenor !== undefined ? body.tenor : existing.tenor,
          sortOrder:
            body.sortOrder !== undefined ? body.sortOrder : existing.sortOrder,
          status:
            body.status !== undefined
              ? body.status === true
                ? 'active'
                : body.status === false
                  ? 'inactive'
                  : body.status
              : 'active'
        },
        {
          returning: true,
          where: {
            id: req.params.id
          }
        }
      ).then(([_, data]) => {
        return data
      })
      createAudit(
        req,
        'update',
        'type_payment',
        req.params.id,
        'Updated type_payment: ' + req.params.id
      )

      return res.status(200).json({
        success: true,
        message: 'Sukses Ubah TypePayment',
        data: editTypePayment?.dataValues
      })
    } else {
      return res.status(403).json({
        success: false,
        message: 'TypePayment Sudah Tersedia'
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

exports.downloadTemplate = async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet('Template Type Payment')

    const headers = ['Name', 'Type', 'Description', 'Status']
    worksheet.addRow(headers)

    worksheet.getRow(1).font = { bold: true }
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD3D3D3' }
    }

    worksheet.columns = [
      { width: 25 },
      { width: 18 },
      { width: 30 },
      { width: 12 }
    ]

    for (let row = 2; row <= 12; row++) {
      worksheet.getCell(`B${row}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: ['"Tunai,Non-Tunai,Transfer"']
      }
      worksheet.getCell(`D${row}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: ['"Active,Inactive,Draft"']
      }
    }

    const buffer = await workbook.xlsx.writeBuffer()

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=template-type-payment.xlsx'
    )

    return res.status(200).send(buffer)
  } catch (error) {
    console.error('Error =>', error)
    return res
      .status(500)
      .json({ success: false, message: 'Internal server error' })
  }
}

exports.downloadData = async (req, res) => {
  try {
    const { store } = req.query
    const where = {}
    // C-1: a client `?store=` must never let a store admin export another
    // store's (or every store's) payment types. Pin non-super-admin to own.
    const authz = authorizedStoreIds(req)
    if (req.user?.roleType === 'super_admin') {
      if (store) where.store = Number(store)
    } else if (authz.ok) {
      where.store = authz.stores[0]
    }

    const typePayments = await TypePayment.findAll({
      where,
      order: [['createdAt', 'ASC']]
    })

    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet('Type Payment Data')

    worksheet.addRow(['ID', 'Name', 'Type', 'Status', 'Created At'])

    worksheet.getRow(1).font = { bold: true }
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD3D3D3' }
    }

    typePayments.forEach((tp) =>
      worksheet.addRow([
        tp.id,
        tp.name,
        tp.type,
        tp.status === 'active' ? 'Active' : 'Inactive',
        tp.createdAt ? tp.createdAt.toISOString() : ''
      ])
    )

    worksheet.columns = [
      { width: 10 },
      { width: 25 },
      { width: 18 },
      { width: 10 },
      { width: 20 }
    ]

    const buffer = await workbook.xlsx.writeBuffer()

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=type-payment-data.xlsx'
    )

    return res.status(200).send(buffer)
  } catch (error) {
    console.error('Error =>', error)
    return res
      .status(500)
      .json({ success: false, message: 'Internal server error' })
  }
}

exports.importData = async (req, res) => {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, message: 'No file uploaded' })
    }

    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(req.file.buffer)
    const worksheet = workbook.getWorksheet(1)

    const toCreate = []
    const errors = []

    const typeMap = {
      tunai: 'cash',
      'non-tunai': 'other',
      transfer: 'other',
      cash: 'cash',
      debit: 'debit',
      credit: 'credit',
      'e-wallet': 'e-wallet',
      other: 'other'
    }

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return

      try {
        const [name, type, _description, status] = row.values

        if (!name) {
          errors.push(`Row ${rowNumber}: Name is required`)
          return
        }

        const typeKey = type ? String(type).trim().toLowerCase() : ''
        const finalType = typeMap[typeKey] || 'cash'

        const statusValue = status
          ? String(status).toLowerCase() === 'draft'
            ? 'draft'
            : String(status).toLowerCase() === 'active'
              ? 'active'
              : 'inactive'
          : 'active'

        toCreate.push({
          store: req.user?.store,
          name: String(name).trim(),
          type: finalType,
          status: statusValue,
          createdBy: req.user?.id || null
        })
      } catch (error) {
        errors.push(`Row ${rowNumber}: ${error.message}`)
      }
    })

    if (errors.length > 0) {
      return res
        .status(400)
        .json({ success: false, message: 'Validation errors', errors })
    }

    const created = []
    const skipped = []
    for (const item of toCreate) {
      const existing = await TypePayment.findOne({
        where: { name: item.name }
      })
      if (existing) {
        skipped.push(item.name)
        continue
      }
      const payment = await TypePayment.create(item)
      created.push(payment)
    }

    createAudit(
      req,
      'import',
      'type_payment',
      null,
      `Imported ${created.length} type payments, skipped ${skipped.length}`
    )

    return res.status(201).json({
      success: true,
      message: `Successfully imported ${created.length} from ${toCreate.length} type payments`,
      data: {
        total: toCreate.length,
        created: created.length,
        skipped: skipped.length,
        skippedNames: skipped.length > 0 ? skipped : undefined
      }
    })
  } catch (error) {
    console.error('Error =>', error)
    return res
      .status(500)
      .json({ success: false, message: 'Internal server error' })
  }
}

exports.deleteTypePaymentById = async (req, res) => {
  try {
    const target = await TypePayment.findByPk(req.params.id)
    if (target?.isSystem) {
      return res.status(403).json({
        success: false,
        message: 'Metode pembayaran sistem tidak dapat dihapus'
      })
    }
    // IDOR fix: previously `store = body.store || req.user?.store` let a
    // client override the authorization boundary by sending another
    // store's id in the body — the destroy's WHERE clause would then
    // legitimately match that other store's row. Never trust
    // req.body.store for authorization; scalarStoreScope always derives
    // from req.user.store for non-super-admin regardless of body content.
    const getId = await TypePayment.destroy({
      where: scalarStoreScope(req, { id: req.params.id })
    })
    createAudit(
      req,
      'delete',
      'type_payment',
      req.params.id,
      'Deleted type_payment: ' + req.params.id
    )

    if (getId) {
      return res.status(200).json({
        success: true,
        message: 'Success Hapus TypePayment'
      })
    } else {
      return res.status(403).json({
        success: false,
        message: 'Hapus TypePayment Gagal'
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
