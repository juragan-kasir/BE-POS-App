const db = require('../../db/models')
const { Op } = db.Sequelize
const Position = db.position
const User = db.user
const { createAudit } = require('../../utils/auditLog')
const { enrichAuditFields } = require('../../utils/auditFields')
const { scalarStoreScope } = require('../../utils/tenantScope')

const positionInclude = [
  {
    model: db.department,
    as: 'departmentData',
    attributes: ['id', 'name']
  }
]

exports.getAllPosition = async (req, res) => {
  try {
    const getAllPosition = await Position.findAll({
      where: { status: 'active' },
      include: positionInclude,
      order: [['updatedAt', 'DESC']]
    }).then((records) =>
      records.map((items) => {
        const getData = { ...items.dataValues }
        return getData
      })
    )

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: getAllPosition?.length > 0 ? getAllPosition : []
    })
  } catch (error) {
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.getAllPositionInTable = async (req, res) => {
  try {
    const { page = 1, limit = 10, status = 'all', search = '' } = req.query
    const offset = (page - 1) * limit

    let whereCondition = {}
    if (status && status !== 'all') {
      whereCondition = { status }
    }

    if (search) {
      whereCondition = {
        ...whereCondition,
        [Op.or]: [
          { name: { [Op.iLike]: `%${search}%` } },
          { description: { [Op.iLike]: `%${search}%` } },
          { '$departmentData.name$': { [Op.iLike]: `%${search}%` } }
        ]
      }
    }

    const { rows: getAllPosition, count: totalItems } =
      await Position.findAndCountAll({
        where: whereCondition,
        include: positionInclude,
        offset: parseInt(offset),
        limit: parseInt(limit),
        order: [['updatedAt', 'DESC']]
      })
    await enrichAuditFields(db, getAllPosition)

    const totalPages = Math.ceil(totalItems / limit)

    const [activeCount, inactiveCount, draftCount, totalPositions] =
      await Promise.all([
        Position.count({ where: { status: 'active' } }),
        Position.count({ where: { status: 'inactive' } }),
        Position.count({ where: { status: 'draft' } }),
        Position.count()
      ])

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: getAllPosition?.length > 0 ? getAllPosition : [],
      total: totalItems,
      pagination: {
        totalItems,
        total: totalItems,
        totalPages,
        currentPage: parseInt(page),
        limit: parseInt(limit)
      },
      stats: {
        total: totalPositions,
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

exports.getPositionById = async (req, res) => {
  try {
    const { id } = req.params

    // IDOR fix: was unscoped, and this route has no requireRole gate at
    // all, so any authenticated role could read another store's position.
    const position = await Position.findOne({
      where: scalarStoreScope(req, { id }),
      include: positionInclude
    })

    if (!position) {
      return res.status(404).json({
        success: false,
        message: 'Posisi tidak ditemukan'
      })
    }

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: position
    })
  } catch (error) {
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.getPositionByDepartment = async (req, res) => {
  try {
    const { departmentId } = req.params

    if (!departmentId) {
      return res.status(400).json({
        success: false,
        message: 'Department ID wajib diisi'
      })
    }

    const positions = await Position.findAll({
      where: { departmentId },
      include: positionInclude,
      order: [['name', 'ASC']]
    }).then((records) =>
      records.map((items) => {
        const getData = { ...items.dataValues }
        return getData
      })
    )

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: positions
    })
  } catch (error) {
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.addNewPosition = async (req, res) => {
  const body = req.body

  try {
    const findOnePosition = await Position?.findOne({
      where: { name: body?.name }
    })

    if (!findOnePosition?.getDataValue) {
      const creadtedPosition = await Position.create({
        name: body.name,
        departmentId: body.departmentId,
        description: body.description,
        status:
          body.status !== undefined
            ? body.status === true
              ? 'active'
              : body.status === false
                ? 'inactive'
                : body.status
            : 'active',
        store: body.store || req.user?.store
      })
      createAudit(
        req,
        'create',
        'position',
        creadtedPosition.id,
        `Created position: ${creadtedPosition.name || creadtedPosition.id}`
      )

      if (creadtedPosition.getDataValue) {
        return res.status(200).json({
          success: true,
          message: 'Position Berhasil Di Buat',
          // The client opens the new record from its success notice.
          data: creadtedPosition
        })
      }
    }
    return res.status(403).json({
      success: false,
      message: 'Position Sudah Terdaftar'
    })
  } catch (error) {
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.editPositionById = async (req, res) => {
  const body = req.body
  const id = req.params.id || body.id

  try {
    // IDOR fix: was Position.update({where:{id}}) with no store filter —
    // any admin could edit any store's position. Confirm ownership first.
    const existingPosition = await Position.findOne({
      where: scalarStoreScope(req, { id })
    })
    if (!existingPosition) {
      return res.status(404).json({
        success: false,
        message: 'Posisi tidak ditemukan'
      })
    }

    const getDuplicate = await Position.findOne({
      where: {
        name: body.name,
        id: { [Op.ne]: id }
      }
    })

    if (!getDuplicate?.dataValues) {
      const [, rows] = await Position.update(
        {
          name: body.name,
          departmentId: body.departmentId,
          description: body.description,
          status:
            body.status !== undefined
              ? body.status === true
                ? 'active'
                : body.status === false
                  ? 'inactive'
                  : body.status
              : 'active',
          store: body.store || req.user?.store
        },
        {
          returning: true,
          where: scalarStoreScope(req, { id })
        }
      )
      const editPosition = rows[0]
      createAudit(
        req,
        'update',
        'position',
        id,
        `Updated position: ${editPosition.name || id}`
      )

      return res.status(200).json({
        success: true,
        message: 'Sukses Ubah Position',
        data: editPosition?.dataValues
      })
    }
    return res.status(403).json({
      success: false,
      message: 'Position Sudah Tersedia'
    })
  } catch (error) {
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.deletePositionById = async (req, res) => {
  try {
    const positionId = req.params.id || req.body.id

    // IDOR fix: this used to run the User.update side effect below
    // unconditionally, before any ownership check — nulling out real
    // employees' position reference for a position id belonging to ANY
    // store, not just the caller's. Confirm ownership first.
    const position = await Position.findOne({
      where: scalarStoreScope(req, { id: positionId })
    })
    if (!position) {
      return res.status(404).json({
        success: false,
        message: 'Position Tidak Ditemukan'
      })
    }

    // Set position reference to null for users that reference this position
    await User.update({ position: null }, { where: { position: positionId } })

    const getId = await Position.destroy({
      where: scalarStoreScope(req, { id: positionId })
    })
    createAudit(
      req,
      'delete',
      'position',
      positionId,
      `Deleted position: ${positionId}`
    )

    if (getId) {
      return res.status(200).json({
        success: true,
        message: 'Success Hapus Position'
      })
    }
    return res.status(404).json({
      success: false,
      message: 'Position Tidak Ditemukan'
    })
  } catch (error) {
    console.error('ERROR =>', error)
    return res.status(500).json({
      success: false,
      message: error.message || 'Terjadi Kesalahan Internal Server'
    })
  }
}
const buildPositionTemplateWorksheet = (
  workbook,
  sheetName,
  positions,
  departments
) => {
  const worksheet = workbook.addWorksheet(sheetName)

  const HEADERS = [
    { key: 'no', header: 'No.', width: 8 },
    { key: 'name', header: 'Nama Jabatan (Wajib)', width: 30 },
    { key: 'department', header: 'Departemen', width: 30 },
    { key: 'description', header: 'Deskripsi Jabatan', width: 35 },
    { key: 'status', header: 'Status (Aktif/Nonaktif)', width: 25 }
  ]

  worksheet.columns = HEADERS.map((h) => ({
    header: h.header,
    key: h.key,
    width: h.width
  }))

  const headerRow = worksheet.getRow(1)
  headerRow.font = { bold: true, color: { argb: 'FFFFFF' } }
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: '4472C4' }
  }
  headerRow.alignment = { horizontal: 'center' }
  headerRow.height = 25

  const departmentDropdownList = departments
    .map((d) => `${d.id}.${d.name}`)
    .join(',')

  const maxRows = Math.max(
    positions.length + 2,
    positions.length + 1,
    departments.length + 2
  )
  for (let row = 2; row <= maxRows; row++) {
    const idx = row - 2
    const item = positions[idx]

    worksheet.getCell(`A${row}`).value = idx + 1
    worksheet.getCell(`A${row}`).protection = { locked: true }

    if (item) {
      worksheet.getCell(`B${row}`).value = item.name
      worksheet.getCell(`C${row}`).value = item.departmentData
        ? `${item.departmentData.id}.${item.departmentData.name}`
        : ''
      worksheet.getCell(`D${row}`).value = item.description || ''
      worksheet.getCell(`E${row}`).value =
        item.status === 'active' ? 'Aktif' : 'Nonaktif'
    }

    worksheet.getCell(`B${row}`).protection = { locked: false }
    worksheet.getCell(`C${row}`).protection = { locked: false }
    worksheet.getCell(`D${row}`).protection = { locked: false }
    worksheet.getCell(`E${row}`).protection = { locked: false }

    worksheet.getCell(`C${row}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formula1: [`"${departmentDropdownList}"`],
      showDropDown: true
    }
    worksheet.getCell(`E${row}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formula1: ['"Aktif,Nonaktif,Draft"'],
      showDropDown: true
    }
  }

  worksheet.protect('', {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatCells: false,
    formatColumns: false,
    formatRows: false,
    insertColumns: false,
    insertRows: false,
    insertHyperlinks: false,
    deleteColumns: false,
    deleteRows: false,
    sort: false,
    autoFilter: false,
    pivotTables: false
  })
}

const buildPositionExportWorksheet = (workbook, sheetName, positions) => {
  const worksheet = workbook.addWorksheet(sheetName)

  const HEADERS = [
    { key: 'no', header: 'No.', width: 8 },
    { key: 'id', header: 'ID', width: 15 },
    { key: 'name', header: 'Nama Jabatan', width: 30 },
    { key: 'department', header: 'Departemen', width: 30 },
    { key: 'description', header: 'Deskripsi Jabatan', width: 35 },
    { key: 'status', header: 'Status (Aktif/Nonaktif)', width: 25 }
  ]

  worksheet.columns = HEADERS.map((h) => ({
    header: h.header,
    key: h.key,
    width: h.width
  }))

  const headerRow = worksheet.getRow(1)
  headerRow.font = { bold: true, color: { argb: 'FFFFFF' } }
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: '4472C4' }
  }
  headerRow.alignment = { horizontal: 'center' }
  headerRow.height = 25

  positions.forEach((pos, index) => {
    const rowNum = index + 2
    worksheet.getCell(`A${rowNum}`).value = index + 1
    worksheet.getCell(`B${rowNum}`).value = pos.id
    worksheet.getCell(`C${rowNum}`).value = pos.name
    worksheet.getCell(`D${rowNum}`).value = pos.departmentData
      ? `${pos.departmentData.id}.${pos.departmentData.name}`
      : ''
    worksheet.getCell(`E${rowNum}`).value = pos.description || ''
    worksheet.getCell(`F${rowNum}`).value =
      pos.status === 'active' ? 'Aktif' : 'Nonaktif'
  })

  worksheet.protect('', {
    selectLockedCells: true,
    selectUnlockedCells: true
  })
}

// Download position Excel template
exports.downloadTemplate = async (req, res) => {
  try {
    const excelJS = require('exceljs')

    const departments = await db.department.findAll({
      where: { status: 'active' },
      attributes: ['id', 'name']
    })

    const positions = await Position.findAll({
      include: [
        {
          model: db.department,
          as: 'departmentData',
          attributes: ['id', 'name']
        }
      ],
      order: [['createdAt', 'ASC']]
    })

    const workbook = new excelJS.Workbook()
    buildPositionTemplateWorksheet(workbook, 'Jabatan', positions, departments)

    const data = await workbook.xlsx.writeBuffer()
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=template-jabatan.xlsx'
    )
    res.send(data)
  } catch (error) {
    console.error('Error downloading template =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

// Download position data as Excel
exports.downloadData = async (req, res) => {
  try {
    const excelJS = require('exceljs')

    const { status = 'all' } = req.query

    let whereCondition = {}
    if (status && status !== 'all') {
      whereCondition = { status }
    }

    const positions = await Position.findAll({
      where: whereCondition,
      include: [
        {
          model: db.department,
          as: 'departmentData',
          attributes: ['id', 'name']
        }
      ],
      order: [['createdAt', 'ASC']]
    })

    const workbook = new excelJS.Workbook()
    buildPositionExportWorksheet(workbook, 'Jabatan', positions)

    const data = await workbook.xlsx.writeBuffer()
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=jabatan-data.xlsx'
    )
    res.send(data)
  } catch (error) {
    console.error('Error downloading data =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

// Upload position Excel
exports.uploadExcel = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Tidak ada file yang diupload'
      })
    }

    const excelJS = require('exceljs')

    const workbook = new excelJS.Workbook()
    await workbook.xlsx.load(req.file.buffer)

    const worksheet = workbook.getWorksheet('Jabatan')
    if (!worksheet) {
      return res.status(400).json({
        success: false,
        message: 'Sheet "Jabatan" tidak ditemukan'
      })
    }

    // Validate headers
    const headers = []
    worksheet.getRow(1).eachCell((cell) => {
      headers.push(cell.value ? cell.value.toString().trim() : '')
    })

    const EXPECTED_HEADERS = [
      'No.',
      'Nama Jabatan (Wajib)',
      'Departemen',
      'Deskripsi Jabatan',
      'Status (Aktif/Nonaktif)'
    ]

    const isValid = EXPECTED_HEADERS.every((expected, index) => {
      return headers[index] === expected
    })

    if (!isValid) {
      return res.status(400).json({
        success: false,
        message:
          'Header template tidak valid. Pastikan menggunakan template yang benar'
      })
    }

    // Get departments for mapping
    const departments = await db.department.findAll({
      attributes: ['id', 'name']
    })
    const departmentMap = {}
    departments.forEach((d) => {
      departmentMap[d.name.toLowerCase().trim()] = d.id
    })
    departments.forEach((d) => {
      departmentMap[`${d.id}.${d.name}`.toLowerCase().trim()] = d.id
    })
    departments.forEach((d) => {
      departmentMap[d.id.toString()] = d.id
    })

    // Process rows
    const positionsToCreate = []
    const errors = []

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber >= 2) {
        const rowData = row.values

        if (!rowData[2]) {
          return
        }

        const name = rowData[2] ? String(rowData[2]).trim() : null
        const departmentInput = rowData[3] ? String(rowData[3]).trim() : null
        const description = rowData[4] ? String(rowData[4]).trim() : null
        const statusInput = rowData[5] ? String(rowData[5]).trim() : null

        if (!name) {
          errors.push(`Baris ${rowNumber}: Nama jabatan wajib diisi`)
          return
        }

        let departmentId = null
        if (departmentInput) {
          const lowerDept = departmentInput.toLowerCase().trim()
          if (departmentMap[lowerDept]) {
            departmentId = departmentMap[lowerDept]
          } else {
            errors.push(
              `Baris ${rowNumber}: Departemen "${departmentInput}" tidak ditemukan`
            )
            return
          }
        } else {
          errors.push(`Baris ${rowNumber}: Departemen wajib diisi`)
          return
        }

        let status = null
        if (statusInput) {
          const lowerStatus = statusInput.toLowerCase().trim()
          if (lowerStatus === 'draft') {
            status = 'draft'
          } else if (
            lowerStatus === 'aktif' ||
            lowerStatus === 'active' ||
            lowerStatus === 'true'
          ) {
            status = 'active'
          } else if (
            lowerStatus === 'nonaktif' ||
            lowerStatus === 'non-active' ||
            lowerStatus === 'nonactive' ||
            lowerStatus === 'false'
          ) {
            status = 'inactive'
          } else {
            errors.push(
              `Baris ${rowNumber}: Status "${statusInput}" tidak valid. Gunakan Aktif/Nonaktif/Draft`
            )
            return
          }
        } else {
          status = 'active'
        }

        positionsToCreate.push({
          name,
          departmentId,
          description: description || null,
          status
        })
      }
    })

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Terdapat kesalahan pada data',
        errors
      })
    }

    // Check for duplicate names in upload
    const uploadNames = positionsToCreate.map((p) =>
      p.name.toLowerCase().trim()
    )
    const duplicateNames = uploadNames.filter(
      (name, index, arr) => arr.indexOf(name) !== index
    )

    if (duplicateNames.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Jabatan berikut duplikat dalam file upload: ${[...new Set(duplicateNames)].join(', ')}`
      })
    }

    // Process creations
    const createdPositions = []
    for (const posData of positionsToCreate) {
      try {
        const existing = await Position.findOne({
          where: { name: posData.name }
        })
        if (!existing) {
          const pos = await Position.create(posData)
          createAudit(
            req,
            'create',
            'position',
            pos.id,
            'Created position: ' + (pos.name || pos.id)
          )
          createdPositions.push(pos)
        }
      } catch (error) {
        console.error('Error creating position =>', error)
      }
    }

    return res.status(200).json({
      success: true,
      message: `Berhasil memproses ${createdPositions.length} dari ${positionsToCreate.length} jabatan`,
      data: {
        total: positionsToCreate.length,
        created: createdPositions.length,
        skipped: positionsToCreate.length - createdPositions.length
      }
    })
  } catch (error) {
    console.error('Error processing upload =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}
