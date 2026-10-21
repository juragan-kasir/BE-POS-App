const db = require('../../db/models')
const { Op } = require('sequelize')
const Table = db.table
const Order = db.order
const Reservation = db.reservation
const Location = db.location
const { createAudit, recordAudit } = require('../../utils/auditLog')
const { enrichAuditFields } = require('../../utils/auditFields')
const { scalarStoreScope } = require('../../utils/tenantScope')

exports.getTablesByStore = async (req, res) => {
  const store = req.query.store ||
      (req.user?.roleType !== 'super_admin' ? req.user?.store : null)
  const page = parseInt(req.query.page) || 1
  const limit = parseInt(req.query.limit) || 10
  const search = req.query.search || ''
  const offset = (page - 1) * limit

  try {
    const whereClause = store ? { store } : {}
    if (search) {
      whereClause.name = { [Op.iLike]: `%${search}%` }
    }

    const { count, rows } = await Table.findAndCountAll({
      where: whereClause,
      order: [['updatedAt', 'DESC']],
      limit,
      offset
    })

    await enrichAuditFields(db, rows)

    const [locations, activeReservations] = await Promise.all([
      Location.findAll({ attributes: ['id', 'name'], paranoid: false }),
      Reservation.findAll({
        where: { store, status: ['pending', 'confirmed'] },
        attributes: [
          'id',
          'tableId',
          'customerName',
          'customerPhone',
          'startTime',
          'endTime',
          'reservationDate',
          'status'
        ]
      })
    ])
    const locMap = {}
    for (const l of locations) locMap[l.id] = l.name
    const reservationByTable = {}
    for (const r of activeReservations) {
      if (r.tableId) reservationByTable[r.tableId] = r
    }
    const data = rows.map((t) => {
      const tJson = t.toJSON()
      tJson.store = { id: tJson.store, name: locMap[tJson.store] || 'Unknown' }
      if (reservationByTable[t.id]) {
        tJson.activeReservation = reservationByTable[t.id]
      }
      return tJson
    })

    const [availableCount, occupiedCount, reservedCount] = await Promise.all([
      Table.count({ where: { ...whereClause, status: 'available' } }),
      Table.count({ where: { ...whereClause, status: 'occupied' } }),
      Table.count({ where: { ...whereClause, status: 'reserved' } })
    ])

    const stats = {
      available: availableCount,
      occupied: occupiedCount,
      reserved: reservedCount,
      total: count
    }

    return res.status(200).json({
      message: 'Success',
      data,
      stats,
      pagination: {
        total: count,
        totalPages: Math.ceil(count / limit),
        page,
        limit
      }
    })
  } catch (error) {
    console.error('Error:', error)
    return res.status(500).json({
      error: 'Internal Server Error'
    })
  }
}

exports.getTableWithActiveOrders = async (req, res) => {
  const store = req.query.store ||
      (req.user?.roleType !== 'super_admin' ? req.user?.store : null)

  try {
    const locations = await Location.findAll({ attributes: ['id', 'name'] })
    const locMap = {}
    for (const l of locations) locMap[l.id] = l.name

    // hasOrderColumn guard for redeemedPoints (added in 20260917) — same as order.js getOrderAttributes
    let orderInclude = {
      model: Order,
      as: 'orders',
      where: {
        status: ['pending', 'confirmed', 'preparing', 'ready', 'served']
      },
      required: false
    }
    try {
      const [col] = await db.sequelize.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'order' AND column_name = 'redeemedPoints' LIMIT 1`,
        { type: db.sequelize.QueryTypes.SELECT }
      )
      if (!col) {
        orderInclude.attributes = { exclude: ['redeemedPoints'] }
      }
    } catch {}
    const tables = await Table.findAll({
      where: store ? { store } : {},
      include: [orderInclude],
      order: [['createdAt', 'DESC']]
    })

    const data = tables.map((t) => {
      const j = t.toJSON()
      j.store = { id: j.store, name: locMap[j.store] || 'Unknown' }
      return j
    })

    return res.status(200).json({
      message: 'Success',
      data
    })
  } catch (error) {
    console.error('Error:', error)
    return res.status(500).json({
      error: 'Internal Server Error'
    })
  }
}

exports.getTableAvailability = async (req, res) => {
  const store = req.query.store ||
      (req.user?.roleType !== 'super_admin' ? req.user?.store : null)

  try {
    const replacements = {}
    let conditions = '1=1'
    if (store) {
      conditions += ` AND "store" = :store`
      replacements.store = store
    }

    const [tables, summary] = await Promise.all([
      Table.findAll({
        where: store ? { store } : {},
        attributes: ['id', 'name', 'status', 'capacity']
      }),
      db.sequelize
        .query(
          `SELECT COUNT(*) FILTER (WHERE "status" = 'available') as available,
                COUNT(*) FILTER (WHERE "status" = 'occupied') as occupied,
                COUNT(*) FILTER (WHERE "status" = 'reserved') as reserved,
                COUNT(*) FILTER (WHERE "status" = 'maintenance') as maintenance,
                COUNT(*) as total
         FROM "table" WHERE ${conditions}`,
          { replacements, type: db.sequelize.QueryTypes.SELECT }
        )
        .then((r) => r[0])
    ])

    return res.status(200).json({
      message: 'Success',
      data: {
        summary: {
          available: Number(summary.available || 0),
          occupied: Number(summary.occupied || 0),
          reserved: Number(summary.reserved || 0),
          maintenance: Number(summary.maintenance || 0),
          total: Number(summary.total || 0)
        },
        tables
      }
    })
  } catch (error) {
    console.error('Error:', error)
    return res.status(500).json({
      error: 'Internal Server Error'
    })
  }
}

exports.createTable = async (req, res) => {
  const store = req.body.store || req.user?.store
  const { name, capacity, area, tableType } = req.body

  try {
    const existingTable = await Table.findOne({
      where: { ...(store ? { store } : {}), name }
    })

    if (existingTable) {
      return res.status(400).json({
        message: 'Table number already exists in this store'
      })
    }

    const table = await Table.create({
      store,
      name,
      capacity: capacity || 4,
      area: area || 'indoor',
      tableType: tableType || 'regular',
      status: 'available'
    })

    createAudit(req, 'create', 'table', table.id, `Created table: ${table.id}`)

    return res.status(201).json({
      message: 'Success creating table',
      data: table
    })
  } catch (error) {
    console.error('Error:', error)
    return res.status(500).json({
      error: 'Internal Server Error'
    })
  }
}

exports.updateTable = async (req, res) => {
  const id = req.params.id || req.body.id
  const { name, capacity, status, area, tableType } = req.body

  try {
    // IDOR fix: `store = req.body.store || req.user?.store` trusted the
    // client-supplied body value directly. validateStoreAccess resolves
    // requestedStore as query.store *or* body.store (query wins), so an
    // attacker who puts their own store in the query string while a
    // different store's id sits in the body reaches the controller with
    // that attacker-chosen `store` never actually checked against
    // req.user.store. scalarStoreScope always derives from req.user.store
    // for non-super-admin regardless of body/query content.
    const table = await Table.findOne({
      where: scalarStoreScope(req, { id })
    })

    if (!table) {
      return res.status(404).json({
        message: 'Table not found'
      })
    }

    await table.update({
      name,
      capacity,
      status,
      area: area !== undefined ? area : table.area,
      tableType: tableType !== undefined ? tableType : table.tableType
    })

    createAudit(req, 'update', 'table', id, `Updated table: ${id}`)

    return res.status(200).json({
      message: 'Success updating table',
      data: table
    })
  } catch (error) {
    console.error('Error:', error)
    return res.status(500).json({
      error: 'Internal Server Error'
    })
  }
}

exports.deleteTable = async (req, res) => {
  const { id } = req.params

  try {
    const activeOrder = await Order.findOne({
      where: {
        tableId: id,
        status: ['pending', 'confirmed', 'preparing', 'ready', 'served']
      }
    })

    if (activeOrder) {
      return res.status(400).json({
        message: 'Cannot delete table with active orders'
      })
    }

    // Same IDOR fix as updateTable — was trusting req.query.store directly.
    const deleted = await Table.destroy({
      where: scalarStoreScope(req, { id })
    })

    if (!deleted) {
      return res.status(404).json({
        message: 'Table not found'
      })
    }

    createAudit(req, 'delete', 'table', id, `Deleted table: ${id}`)

    return res.status(200).json({
      message: 'Success deleting table'
    })
  } catch (error) {
    console.error('Error:', error)
    return res.status(500).json({
      error: 'Internal Server Error'
    })
  }
}

exports.updateTableStatus = async (req, res) => {
  const id = req.params.id || req.body.id
  const { status, reason } = req.body

  try {
    // Same IDOR fix as updateTable. The route itself is admin-only (DR-24
    // C-16 / D-03) — POS order flows claim and release tables inside their
    // own transactions; this endpoint is the manual override.
    const table = await Table.findOne({
      where: scalarStoreScope(req, { id })
    })

    if (!table) {
      return res.status(404).json({
        message: 'Table not found'
      })
    }

    // DR-24 C-16 (D-03): releasing a table is an elevated action — the
    // reason is mandatory and persisted on the audit row. Non-release
    // transitions (e.g. maintenance) do not require one.
    let releaseReason = null
    if (status === 'available') {
      releaseReason = typeof reason === 'string' ? reason.trim() : ''
      if (!releaseReason) {
        return res.status(400).json({
          code: 'RELEASE_REASON_REQUIRED',
          message: 'A reason is required to release a table'
        })
      }
    }

    const previousStatus = table.status
    await table.update({ status })

    if (status === 'available') {
      const activeReservations = await Reservation.findAll({
        where: { tableId: id, status: ['pending', 'confirmed'] }
      })
      for (const r of activeReservations) {
        await r.update({ status: 'completed', modifiedBy: req.user?.id })
      }
    }

    await recordAudit({
      req,
      action: 'update',
      entity: 'table',
      entityId: id,
      description: releaseReason
        ? `Released table ${id}: ${releaseReason}`
        : `Updated table status: ${id}`,
      reason: releaseReason,
      previousState: { status: previousStatus },
      newState: { status },
      metadata: { channel: 'table-management' }
    })

    return res.status(200).json({
      message: 'Success updating table status',
      data: table
    })
  } catch (error) {
    console.error('Error:', error)
    return res.status(500).json({
      error: 'Internal Server Error'
    })
  }
}
