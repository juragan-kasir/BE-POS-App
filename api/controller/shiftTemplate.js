const db = require('../../db/models')
const { Op } = db.Sequelize
const ShiftTemplate = db.shift_template
const { createAudit } = require('../../utils/auditLog')
const { enrichAuditFields } = require('../../utils/auditFields')
const { scalarStoreScope, isSuperAdmin } = require('../../utils/tenantScope')

const ownStoreId = (req) => {
  const store = Number(req.user?.store)
  return Number.isInteger(store) && store > 0 ? store : null
}

const isGlobalSuperAdmin = (req) => isSuperAdmin(req) && ownStoreId(req) == null

const templateReadScope = (req, storeQuery) => {
  if (isGlobalSuperAdmin(req)) {
    if (storeQuery) {
      return { [Op.or]: [{ store: null }, { store: Number(storeQuery) }] }
    }
    return {}
  }
  const own = ownStoreId(req)
  if (!own) return { store: null }
  return { [Op.or]: [{ store: null }, { store: own }] }
}

const templateWriteStore = (req) => {
  if (isGlobalSuperAdmin(req)) return null
  return ownStoreId(req)
}

exports.getAllShiftTemplate = async (req, res) => {
  try {
    const { store } = req.query
    const where = { status: 'active', ...templateReadScope(req, store) }

    const templates = await ShiftTemplate.findAll({
      where,
      order: [['name', 'ASC']]
    }).then((res) =>
      res.map((items) => {
        const getData = { ...items.dataValues }
        return getData
      })
    )

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: templates?.length > 0 ? templates : []
    })
  } catch (error) {
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.getAllShiftTemplateInTable = async (req, res) => {
  try {
    const { page = 1, limit = 10, status = 'all', search } = req.query
    const offset = (page - 1) * limit

    const scope = templateReadScope(req, req.query.store)
    let whereCondition = { ...scope }
    if (status && status !== 'all') {
      whereCondition.status = status
    }

    if (search) {
      whereCondition.name = { [Op.iLike]: `%${search}%` }
    }

    const { rows: templates, count: totalItems } =
      await ShiftTemplate.findAndCountAll({
        where: whereCondition,
        offset: parseInt(offset),
        limit: parseInt(limit),
        order: [['updatedAt', 'DESC']]
      })
    await enrichAuditFields(db, templates)

    const totalPages = Math.ceil(totalItems / limit)

    const total = await ShiftTemplate.count({ where: scope })
    const totalActive = await ShiftTemplate.count({ where: { ...scope, status: 'active' } })
    const totalInactive = await ShiftTemplate.count({ where: { ...scope, status: 'inactive' } })
    const totalDraft = await ShiftTemplate.count({ where: { ...scope, status: 'draft' } })

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: templates?.length > 0 ? templates : [],
      pagination: {
        totalItems,
        total: totalItems,
        totalPages,
        currentPage: parseInt(page),
        limit: parseInt(limit)
      },
      stats: {
        total,
        totalActive,
        totalInactive,
        totalDraft
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

exports.getShiftTemplateById = async (req, res) => {
  try {
    const { id } = req.params

    const template = await ShiftTemplate.findOne({
      where: { id, ...templateReadScope(req) }
    })

    if (!template) {
      return res.status(404).json({
        success: false,
        message: 'Template shift tidak ditemukan'
      })
    }

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: {
        ...template.dataValues,
        createdByUser: template.dataValues?.createdByUser || null,
        modifiedByUser: template.dataValues?.modifiedByUser || null
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

exports.addNewShiftTemplate = async (req, res) => {
  const body = req.body

  try {
    const isGlobal = isGlobalSuperAdmin(req)
    const own = ownStoreId(req)
    const requestedStore =
      body.store === undefined || body.store === null || body.store === ''
        ? null
        : Number(body.store)

    if (!isGlobal && own == null) {
      return res.status(403).json({
        success: false,
        message: 'Store assignment required'
      })
    }
    if (!isGlobal && requestedStore != null && requestedStore !== own) {
      return res.status(403).json({
        success: false,
        message: 'Tidak dapat membuat template shift untuk toko lain'
      })
    }

    const store = isGlobal ? requestedStore : own

    const existing = await ShiftTemplate.findOne({
      where: {
        name: body.name,
        store
      }
    })

    if (existing) {
      return res.status(403).json({
        success: false,
        message: 'Template shift dengan nama tersebut sudah ada'
      })
    }

    const template = await ShiftTemplate.create({
      store,
      name: body.name,
      startTime: body.startTime,
      endTime: body.endTime,
      description: body.description || null,
      status:
        body.status !== undefined
          ? body.status === true
            ? 'active'
            : body.status === false
              ? 'inactive'
              : body.status
          : 'active'
    })

    createAudit(
      req,
      'create',
      'shift_template',
      template.id,
      `Created shift template: ${template.name || template.id}`
    )

    return res.status(200).json({
      success: true,
      message: 'Template shift berhasil dibuat',
      data: template
    })
  } catch (error) {
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.editShiftTemplateById = async (req, res) => {
  const body = req.body
  const id = req.params.id || body.id

  try {
    const isGlobal = isGlobalSuperAdmin(req)
    const requestedStore =
      body.store === undefined || body.store === null || body.store === ''
        ? null
        : Number(body.store)
    const getDuplicate = await ShiftTemplate.findOne({
      where: {
        name: body.name,
        store: isGlobal ? requestedStore : templateWriteStore(req),
        id: { [Op.ne]: id }
      }
    })

    if (getDuplicate) {
      return res.status(403).json({
        success: false,
        message: 'Template shift dengan nama tersebut sudah ada'
      })
    }

    // IDOR fix: findByPk(id) + update({where:{id}}) below were both
    // unscoped — any admin could edit any store's shift template.
    const template = await ShiftTemplate.findOne({
      where: scalarStoreScope(req, { id })
    })
    if (!template) {
      return res.status(404).json({
        success: false,
        message: 'Template shift tidak ditemukan'
      })
    }
    if (!isGlobal && requestedStore != null && requestedStore !== ownStoreId(req)) {
      return res.status(403).json({
        success: false,
        message: 'Tidak dapat memindahkan template shift ke toko lain'
      })
    }

    const [, editRows] = await ShiftTemplate.update(
      {
        store: isGlobal
          ? body.store !== undefined
            ? requestedStore
            : template.store
          : template.store,
        name: body.name,
        startTime: body.startTime,
        endTime: body.endTime,
        description: body.description !== undefined ? body.description : template.description,
        status:
          body.status !== undefined
            ? body.status === true
              ? 'active'
              : body.status === false
                ? 'inactive'
                : body.status
            : template.status
      },
      {
        returning: true,
        where: scalarStoreScope(req, { id })
      }
    )

    const editTemplate = editRows[0]
    createAudit(
      req,
      'update',
      'shift_template',
      id,
      `Updated shift template: ${editTemplate.name || id}`
    )

    return res.status(200).json({
      success: true,
      message: 'Template shift berhasil diperbarui',
      data: editTemplate?.dataValues
    })
  } catch (error) {
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.deleteShiftTemplateById = async (req, res) => {
  const id = req.params.id

  try {
    // Same IDOR fix as editShiftTemplateById.
    const template = await ShiftTemplate.findOne({
      where: scalarStoreScope(req, { id })
    })
    if (!template) {
      return res.status(404).json({
        success: false,
        message: 'Template shift tidak ditemukan'
      })
    }

    await ShiftTemplate.destroy({ where: scalarStoreScope(req, { id }) })
    createAudit(
      req,
      'delete',
      'shift_template',
      id,
      `Deleted shift template: ${id}`
    )

    return res.status(200).json({
      success: true,
      message: 'Template shift berhasil dihapus'
    })
  } catch (error) {
    console.error('ERROR =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}
