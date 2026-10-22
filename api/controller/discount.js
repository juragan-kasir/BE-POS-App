const db = require('../../db/models')
const { Op } = require('sequelize')
const Discount = db.discount
const Order = db.order
const ExcelJS = require('exceljs')
const { createAudit } = require('../../utils/auditLog')
const { enrichAuditFields } = require('../../utils/auditFields')
const { scalarStoreScope } = require('../../utils/tenantScope')
const { authorizedWriteStore } = require('../../utils/storeValidation')

const attachStoreData = async (rows) => {
  if (!rows?.length) return rows
  const allStoreIds = [...new Set(rows.map((r) => r.store).filter(Boolean))]
  const locationMap = {}
  if (allStoreIds.length > 0) {
    const Location = db.location
    const locations = await Location.findAll({
      where: { id: allStoreIds },
      attributes: ['id', 'name']
    })
    locations.forEach((l) => {
      locationMap[l.id] = l.name
    })
  }
  return rows.map((r) => ({
    ...r,
    store: r.store ? { id: r.store, name: locationMap[r.store] || null } : []
  }))
}

exports.getAllDiscountByLocationAndActive = async (req, res) => {
  let store = req.query.store
  if (!store && req.user?.roleType !== 'super_admin' && req.user?.store) {
    store = req.user.store
  }
  const { page = 1, size = 10, search } = req.query
  const limit = parseInt(size)
  const offset = (parseInt(page) - 1) * limit

  try {
    await Discount.update(
      { status: 'inactive' },
      {
        where: {
          status: 'active',
          endDate: { [db.Sequelize.Op.lt]: new Date() }
        }
      }
    )

    const whereDiscount = { status: 'active' }
    if (store) {
      whereDiscount[db.Sequelize.Op.or] = [{ store }, { store: null }]
    }
    if (search) whereDiscount.name = { [Op.iLike]: `%${search}%` }

    const { count, rows: subCategory } = await Discount.findAndCountAll({
      where: whereDiscount,
      limit: limit,
      offset: offset
    })

    const data = await attachStoreData(subCategory.map((r) => r.dataValues))

    return res.status(200).json({
      success: true,
      message: 'Success',
      totalItems: count,
      totalPages: Math.ceil(count / limit),
      currentPage: parseInt(page),
      data,
      pagination: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(count / limit)
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

exports.getAllDiscount = async (req, res) => {
  let store = req.query.store
  if (!store && req.user?.roleType !== 'super_admin' && req.user?.store) {
    store = req.user.store
  }
  const { page = 1, size = 10, limit: queryLimit, status, search } = req.query
  const limit = parseInt(queryLimit || size)
  const offset = (parseInt(page) - 1) * limit

  try {
    await Discount.update(
      { status: 'inactive' },
      {
        where: {
          status: 'active',
          endDate: { [db.Sequelize.Op.lt]: new Date() }
        }
      }
    )

    await Discount.update(
      { status: 'active' },
      {
        where: {
          status: 'upcoming',
          startDate: { [db.Sequelize.Op.lte]: new Date() }
        }
      }
    )

    await Discount.update(
      { status: 'upcoming' },
      {
        where: {
          status: 'active',
          startDate: { [db.Sequelize.Op.gt]: new Date() }
        }
      }
    )

    const whereDiscount = {}
    if (store) {
      whereDiscount[db.Sequelize.Op.or] = [{ store }, { store: null }]
    }
    if (status && status !== 'all') whereDiscount.status = status
    if (search) whereDiscount.name = { [Op.iLike]: `%${search}%` }

    const { count, rows } = await Discount.findAndCountAll({
      where: whereDiscount,
      limit,
      offset,
      order: [['updatedAt', 'DESC']]
    })

    await enrichAuditFields(db, rows)

    const storeFilter = store
      ? { [db.Sequelize.Op.or]: [{ store }, { store: null }] }
      : {}
    const now = new Date()
    const sevenDaysLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
    const [activeCount, draftCount, inactiveCount, upcomingCount, expiringCount] = await Promise.all([
      Discount.count({ where: { ...storeFilter, status: 'active' } }),
      Discount.count({ where: { ...storeFilter, status: 'draft' } }),
      Discount.count({ where: { ...storeFilter, status: 'inactive' } }),
      Discount.count({ where: { ...storeFilter, status: 'upcoming' } }),
      Discount.count({
        where: {
          ...storeFilter,
          status: 'active',
          endDate: {
            [db.Sequelize.Op.and]: [
              { [db.Sequelize.Op.ne]: null },
              { [db.Sequelize.Op.gte]: now },
              { [db.Sequelize.Op.lte]: sevenDaysLater }
            ]
          }
        }
      })
    ])

    const data = await attachStoreData(rows.map((i) => i.dataValues))

    return res.status(200).json({
      success: true,
      message: 'Success',
      totalItems: count,
      totalPages: Math.ceil(count / limit),
      currentPage: parseInt(page),
      data,
      stats: {
        total: activeCount + draftCount + inactiveCount + upcomingCount,
        active: activeCount,
        draft: draftCount,
        inactive: inactiveCount,
        upcoming: upcomingCount,
        expiring: expiringCount
      },
      pagination: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(count / limit)
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

// Download Template - Super Admin only
exports.downloadTemplate = async (req, res) => {
  try {
    // Generate template Excel file
    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet('Discount Template')

    // Add headers
    worksheet.addRow([
      'Name',
      'Type (Percentage/Nominal)',
      'Value',
      'Start Date (YYYY-MM-DD)',
      'End Date (YYYY-MM-DD, optional)',
      'Minimum Purchase',
      'Description',
      'Is Active (true/false)'
    ])

    // Style headers
    worksheet.getRow(1).font = { bold: true }
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD3D3D3' }
    }

    // Set column widths
    worksheet.columns = [
      { width: 20 }, // Name
      { width: 20 }, // Type
      { width: 15 }, // Value
      { width: 15 }, // Start Date
      { width: 15 }, // End Date
      { width: 20 }, // Minimum Purchase
      { width: 30 }, // Description
      { width: 15 } // Is Active
    ]

    // Generate buffer
    const buffer = await workbook.xlsx.writeBuffer()

    // Set response headers
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=discount-template.xlsx'
    )

    return res.status(200).send(buffer)
  } catch (error) {
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

// Download Excel Data - Super Admin only
exports.downloadData = async (req, res) => {
  try {
    const { store } = req.query
    const filters = {}
    if (store) {
      filters.store = store
    }

    const discounts = await Discount.findAll({
      where: filters,
      order: [['createdAt', 'ASC']]
    })

    // Generate Excel file
    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet('Discounts Data')

    // Add headers
    worksheet.addRow([
      'ID',
      'Name',
      'Type',
      'Value',
      'Start Date',
      'End Date',
      'Minimum Purchase',
      'Description',
      'Is Active',
      'Created At'
    ])

    // Style headers
    worksheet.getRow(1).font = { bold: true }
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD3D3D3' }
    }

    // Add data rows
    discounts.forEach((discount) => {
      worksheet.addRow([
        discount.id,
        discount.name,
        discount.type,
        discount.value,
        discount.startDate
          ? discount.startDate.toISOString().split('T')[0]
          : '',
        discount.endDate ? discount.endDate.toISOString().split('T')[0] : '',
        discount.minimumOrder,
        discount.description || '',
        discount.status === 'active' ? 'true' : 'false',
        discount.createdAt ? discount.createdAt.toISOString() : ''
      ])
    })

    // Style data rows
    worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      if (rowNumber > 1) {
        // Add borders
        row.eachCell({ includeEmpty: true }, (cell) => {
          cell.border = {
            top: { style: 'thin' },
            left: { style: 'thin' },
            bottom: { style: 'thin' },
            right: { style: 'thin' }
          }
        })
      }
    })

    // Set column widths
    worksheet.columns = [
      { width: 10 }, // ID
      { width: 20 }, // Name
      { width: 15 }, // Type
      { width: 15 }, // Value
      { width: 15 }, // Start Date
      { width: 15 }, // End Date
      { width: 20 }, // Minimum Purchase
      { width: 30 }, // Description
      { width: 10 }, // Is Active
      { width: 20 } // Created At
    ]

    // Generate buffer
    const buffer = await workbook.xlsx.writeBuffer()

    // Set response headers
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=discounts-data.xlsx'
    )

    return res.status(200).send(buffer)
  } catch (error) {
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

// Upload Excel - Super Admin only
exports.importData = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      })
    }

    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(req.file.buffer)
    const worksheet = workbook.getWorksheet(1)

    const discountsToCreate = []
    const errors = []

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return

      try {
        const [
          name,
          type,
          valueStr,
          startDateStr,
          endDateStr,
          minPurchaseStr,
          description,
          isActiveStr
        ] = row.values

        if (!name || !type || !valueStr) {
          errors.push(`Row ${rowNumber}: Missing required fields`)
          return
        }

        const value = parseFloat(valueStr)
        if (isNaN(value) || value < 0) {
          errors.push(`Row ${rowNumber}: Invalid value`)
          return
        }

        const typeNormalized = type.toLowerCase().trim()
        if (!['percentage', 'nominal'].includes(typeNormalized)) {
          errors.push(
            `Row ${rowNumber}: Invalid type. Must be 'percentage' or 'nominal'`
          )
          return
        }

        const startDate = startDateStr ? new Date(startDateStr) : undefined
        const endDate = endDateStr ? new Date(endDateStr) : undefined
        const minimumOrder = parseFloat(minPurchaseStr) || 0
        const isActive =
          isActiveStr?.toLowerCase() === 'true' ||
          isActiveStr === '1' ||
          !!isActiveStr
        const isDraft = isActiveStr?.toLowerCase() === 'draft'

        discountsToCreate.push({
          name: name.trim(),
          type: typeNormalized === 'percentage' ? 'percent' : 'nominal',
          value: value,
          startDate: startDate,
          endDate: endDate,
          minimumOrder: minimumOrder,
          description: description?.trim() || null,
          status: isDraft ? 'draft' : isActive ? 'active' : 'inactive',
          store: req.user?.store,
          createdBy: req.user?.id
        })
      } catch (error) {
        errors.push(`Row ${rowNumber}: ${error.message}`)
      }
    })

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Validation errors occurred',
        errors: errors
      })
    }

    const created = []
    const skipped = []
    for (const item of discountsToCreate) {
      const existing = await Discount.findOne({
        where: {
          name: item.name,
          ...(req.user?.store ? { store: req.user.store } : {})
        }
      })
      if (existing) {
        skipped.push(item.name)
        continue
      }
      const discount = await Discount.create(item)
      created.push(discount)
    }

    createAudit(
      req,
      'import',
      'discount',
      null,
      `Imported ${created.length} discounts, skipped ${skipped.length}`
    )

    return res.status(201).json({
      success: true,
      message: `Successfully imported ${created.length} from ${discountsToCreate.length} discounts`,
      data: {
        total: discountsToCreate.length,
        created: created.length,
        skipped: skipped.length,
        skippedNames: skipped.length > 0 ? skipped : undefined
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

exports.postNewDiscount = async (req, res) => {
  const {
    name,
    type,
    value,
    minimumOrder,
    maximumDiscount,
    startDate,
    endDate,
    status,
    code,
    conditions
  } = req.body
  // Store write target. For non-super-admin the store is always the caller's
  // own (rejects a foreign/ambiguous/array storeId that would otherwise create
  // a discount in another tenant's namespace).
  const storeAuthz = authorizedWriteStore(req)
  if (!storeAuthz.ok) {
    return res.status(403).json({
      success: false,
      message: 'Anda hanya dapat mengakses data di toko Anda'
    })
  }
  const store = storeAuthz.storeId ?? req.user?.store
  const safeStartDate =
    startDate && !isNaN(Date.parse(startDate)) ? startDate : null
  const safeEndDate = endDate && !isNaN(Date.parse(endDate)) ? endDate : null
  try {
    const discountType = type === 'percentage' ? 'percent' : type

    const findOneDiscount = await Discount?.findOne({
      where: {
        name: name,
        ...(store ? { store } : {})
      }
    })

    if (!findOneDiscount) {
      const requestedStatus =
        status !== undefined
          ? status === true || status === 'active'
            ? 'active'
            : status === false || status === 'inactive'
              ? 'inactive'
              : status
          : 'active'

      const finalStatus =
        requestedStatus === 'active' && safeStartDate && new Date(safeStartDate) > new Date()
          ? 'upcoming'
          : requestedStatus

      const postData = await Discount.create({
        name,
        type: discountType || 'percent',
        value: parseInt(value),
        minimumOrder: minimumOrder || 0,
        maximumDiscount: maximumDiscount || 0,
        startDate: safeStartDate,
        endDate: safeEndDate,
        store,
        code: code || null,
        conditions: conditions || null,
        createdBy: req.user?.id,
        status: finalStatus
      })
      createAudit(
        req,
        'create',
        'discount',
        postData.id,
        `Created discount: ${postData.name}`
      )
      return res.status(200).json({
        success: true,
        message: 'Success',
        data: postData
      })
    }
    return res.status(403).json({
      success: false,
      message: 'Discount Sudah Terdaftar'
    })
  } catch (error) {
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.lookupByCode = async (req, res) => {
  const { code } = req.params
  const store = req.query.store ||
      (req.user?.roleType !== 'super_admin' ? req.user?.store : null)

  try {
    if (!code) {
      return res
        .status(400)
        .json({ success: false, message: 'Code is required' })
    }

    const discount = await Discount.findOne({
      where: {
        code: code.trim().toUpperCase(),
        status: 'active',
        ...(store ? { store } : {})
      }
    })

    if (!discount) {
      return res
        .status(404)
        .json({ success: false, message: 'Promo code not found or inactive' })
    }

    // Validate date range
    const now = new Date()
    if (discount.startDate && new Date(discount.startDate) > now) {
      return res
        .status(400)
        .json({ success: false, message: 'Promo has not started yet' })
    }
    if (discount.endDate && new Date(discount.endDate) < now) {
      return res
        .status(400)
        .json({ success: false, message: 'Promo has expired' })
    }

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: {
        valid: true,
        description: discount.name || null,
        type: discount.type || null,
        value: discount.value ?? null,
        minOrder: discount.minimumOrder ?? null
      }
    })
  } catch (error) {
    console.error('Error =>', error)
    return res
      .status(500)
      .json({ success: false, message: 'Internal Server Error' })
  }
}

exports.editDiscountById = async (req, res) => {
  const body = req.body || {}
  // Store write target must be authorized: non-super-admin is pinned to own,
  // so a foreign/array body.store cannot reassign the discount (or its store
  // column) into another tenant's namespace.
  const storeAuthz = authorizedWriteStore(req)
  if (!storeAuthz.ok) {
    return res.status(403).json({
      success: false,
      message: 'Anda hanya dapat mengakses data di toko Anda'
    })
  }
  const store = storeAuthz.storeId ?? req.user?.store

  if (!body.name) {
    return res.status(400).json({
      success: false,
      message: 'Nama diskon wajib diisi'
    })
  }

  const safeStartDate =
    body.startDate && !isNaN(Date.parse(body.startDate)) ? body.startDate : null
  const safeEndDate =
    body.endDate && !isNaN(Date.parse(body.endDate)) ? body.endDate : null
  try {
    const getDuplicate = await Discount.findOne({
      where: {
        name: body.name,
        id: { [Op.ne]: req.params.id },
        ...(store ? { store } : {})
      }
    })

    const bodyStatus =
      body.status !== undefined
        ? body.status === true
          ? 'active'
          : body.status === false
            ? 'inactive'
            : body.status
        : 'active'

    const finalStatus =
      bodyStatus === 'active' && safeStartDate && new Date(safeStartDate) > new Date()
        ? 'upcoming'
        : bodyStatus

    if (
      !getDuplicate?.dataValues ||
      getDuplicate?.dataValues?.status !== bodyStatus
    ) {
      // IDOR fix: `where` previously matched by id alone, so a Store A
      // admin could update any store's discount. scalarStoreScope adds
      // `store: req.user.store` for non-super-admin, so 0 rows are
      // affected (and we 404 below) instead of silently editing another
      // tenant's discount.
      const [affectedCount, affectedRows] = await Discount.update(
        {
          name: body.name,
          type: body.type,
          value: parseInt(body.value),
          minimumOrder: body.minimumOrder,
          maximumDiscount: body.maximumDiscount,
          startDate: safeStartDate,
          endDate: safeEndDate,
          store,
          code: body.code || null,
          conditions: body.conditions || null,
          modifiedBy: req.user?.id,
          status: finalStatus
        },
        {
          returning: true,
          where: scalarStoreScope(req, { id: req.params.id })
        }
      )
      if (affectedCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'Discount tidak ditemukan'
        })
      }
      const editDiscount = affectedRows[0]
      createAudit(
        req,
        'update',
        'discount',
        req.params.id,
        `Updated discount: ${body.name}`
      )
      return res.status(200).json({
        success: true,
        message: 'Sukses Ubah Discount',
        data: editDiscount?.dataValues
      })
    }
    return res.status(403).json({
      success: false,
      message: 'Discount Sudah Tersedia'
    })
  } catch (error) {
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.deleteDiscountById = async (req, res) => {
  try {
    // IDOR fix: was `where: { id }` with no store filter — any admin could
    // delete any store's discount. The existing `if (getId)` affected-row
    // check already does the right thing once the where clause is scoped.
    const getId = await Discount.destroy({
      where: scalarStoreScope(req, { id: req.params.id })
    })

    if (getId) {
      createAudit(
        req,
        'delete',
        'discount',
        req.params.id,
        `Deleted discount: ${req.params.id}`
      )
      return res.status(200).json({
        success: true,
        message: 'Success Hapus Discount'
      })
    }
    return res.status(403).json({
      success: false,
      message: 'Hapus Discount Gagal'
    })
  } catch (error) {
    console.error('ERROR =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.getDiscountById = async (req, res) => {
  try {
    await Discount.update(
      { status: 'inactive' },
      {
        where: {
          status: 'active',
          endDate: { [db.Sequelize.Op.lt]: new Date() }
        }
      }
    )

    // IDOR fix: was findByPk(id) with no store filter — same gap as
    // editDiscountById/deleteDiscountById above, found while fixing those.
    const discount = await Discount.findOne({
      where: scalarStoreScope(req, { id: req.params.id })
    })
    if (!discount) {
      return res
        .status(404)
        .json({ success: false, message: 'Discount not found' })
    }
    // ponytail: hanya order valid yang dihitung — cancelled/void tidak masuk
    const usageCount = await Order.count({
      where: {
        discountId: req.params.id,
        status: { [Op.notIn]: ['cancelled', 'void'] }
      }
    })
    return res.status(200).json({
      success: true,
      message: 'Success',
      data: { ...discount.toJSON(), usageCount }
    })
  } catch (error) {
    console.error('Error =>', error)
    return res
      .status(500)
      .json({ success: false, message: 'Internal Server Error' })
  }
}
