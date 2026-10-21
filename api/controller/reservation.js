const db = require('../../db/models')
const { Op } = require('sequelize')
const Reservation = db.reservation
const Table = db.table
const Location = db.location
const { createAudit } = require('../../utils/auditLog')
const { enrichAuditFields } = require('../../utils/auditFields')
const { scalarStoreScope } = require('../../utils/tenantScope')

exports.getAll = async (req, res) => {
  const store = req.query.store ||
      (req.user?.roleType !== 'super_admin' ? req.user?.store : null)
  const { page = 1, size = 10, date, status, search } = req.query
  const limit = parseInt(size)
  const offset = (parseInt(page) - 1) * limit

  try {
    const where = {}
    if (store) where.store = store
    if (date) where.reservationDate = date
    if (status && status !== 'all') where.status = status
    if (search) {
      where[Op.or] = [
        { customerName: { [Op.iLike]: `%${search}%` } },
        { customerPhone: { [Op.iLike]: `%${search}%` } }
      ]
    }

    const { count, rows } = await Reservation.findAndCountAll({
      where,
      limit,
      offset,
      order: [['updatedAt', 'DESC']]
    })
    await enrichAuditFields(db, rows)

    const statsWhere = store ? { store } : {}
    const stats = {}
    for (const status of [
      'pending',
      'confirmed',
      'cancelled',
      'completed',
      'no_show'
    ]) {
      stats[status] = await Reservation.count({
        where: { ...statsWhere, status }
      })
    }

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: rows.map((r) => r.dataValues),
      pagination: {
        total: count,
        totalPages: Math.ceil(count / limit),
        page: parseInt(page),
        limit: parseInt(limit)
      },
      stats: { total: count, ...stats }
    })
  } catch (error) {
    console.error('Error:', error)
    return res
      .status(500)
      .json({ success: false, message: 'Internal Server Error' })
  }
}

exports.getById = async (req, res) => {
  const { id } = req.params
  const store = req.query.store ||
      (req.user?.roleType !== 'super_admin' ? req.user?.store : null)

  try {
    const reservation = await Reservation.findOne({
      where: { id, ...(store ? { store } : {}) }
    })
    if (!reservation) {
      return res
        .status(404)
        .json({ success: false, message: 'Reservation not found' })
    }

    const result = reservation.toJSON()
    if (result.store) {
      const loc = await Location.findByPk(result.store, {
        attributes: ['id', 'name']
      })
      if (loc) result.storeInfo = loc.toJSON()
    }
    if (result.tableId) {
      const tbl = await Table.findByPk(result.tableId, {
        attributes: ['id', 'name']
      })
      if (tbl) result.tableInfo = tbl.toJSON()
    }

    return res.status(200).json({ success: true, data: result })
  } catch (error) {
    console.error('Error:', error)
    return res
      .status(500)
      .json({ success: false, message: 'Internal Server Error' })
  }
}

exports.create = async (req, res) => {
  const store = req.body.store || req.user?.store
  const {
    customerName,
    customerPhone,
    customerEmail,
    guestCount,
    reservationDate,
    startTime,
    endTime,
    notes,
    tableId
  } = req.body

  try {
    if (!customerName || !reservationDate || !startTime) {
      return res.status(400).json({
        success: false,
        message: 'customerName, reservationDate, and startTime are required'
      })
    }

    if (tableId) {
      const table = await Table.findOne({ where: { id: tableId, store } })
      if (!table) {
        return res
          .status(400)
          .json({ success: false, message: 'Table not found' })
      }
    }

    const reservation = await Reservation.create({
      store,
      tableId: tableId || null,
      customerName,
      customerPhone,
      customerEmail,
      guestCount: guestCount || 1,
      reservationDate,
      startTime,
      endTime: endTime || null,
      notes,
      status: 'pending',
      createdBy: req.user?.id
    })

    createAudit(
      req,
      'create',
      'reservation',
      reservation.id,
      `Created reservation for ${customerName}`
    )

    return res.status(201).json({
      success: true,
      message: 'Reservation created',
      data: reservation
    })
  } catch (error) {
    console.error('Error:', error)
    return res
      .status(500)
      .json({ success: false, message: 'Internal Server Error' })
  }
}

exports.update = async (req, res) => {
  const { id } = req.params
  // IDOR fix: req.body.store was trusted directly as the authorization
  // boundary. validateStoreAccess reads req.query.store *or* body.store
  // (query wins) to decide whether to 403 — so an attacker who passes
  // their own store in the query string (satisfying the middleware) while
  // putting a victim store in the body could reach here with an
  // attacker-chosen `store` neither this middleware nor this variable's
  // old definition actually verified against req.user.store. Only
  // super_admin may explicitly target another store; everyone else is
  // pinned to req.user.store regardless of what the body claims.
  const store =
    req.user?.roleType === 'super_admin'
      ? req.body.store || req.user?.store
      : req.user?.store
  const {
    customerName,
    customerPhone,
    customerEmail,
    guestCount,
    reservationDate,
    startTime,
    endTime,
    notes,
    status,
    tableId
  } = req.body

  try {
    const reservation = await Reservation.findOne({
      where: scalarStoreScope(req, { id })
    })
    if (!reservation) {
      return res
        .status(404)
        .json({ success: false, message: 'Reservation not found' })
    }

    if (tableId) {
      const table = await Table.findOne({
        where: { id: tableId, store: store ?? reservation.store }
      })
      if (!table) {
        return res
          .status(400)
          .json({ success: false, message: 'Table not found' })
      }
    }

    await reservation.update({
      customerName: customerName ?? reservation.customerName,
      customerPhone: customerPhone ?? reservation.customerPhone,
      customerEmail: customerEmail ?? reservation.customerEmail,
      guestCount: guestCount ?? reservation.guestCount,
      reservationDate: reservationDate ?? reservation.reservationDate,
      startTime: startTime ?? reservation.startTime,
      endTime: endTime ?? reservation.endTime,
      notes: notes ?? reservation.notes,
      status: status ?? reservation.status,
      tableId: tableId !== undefined ? tableId : reservation.tableId,
      modifiedBy: req.user?.id
    })

    const resolvedStatus = status || reservation.status
    const resolvedTableId =
      tableId !== undefined ? tableId : reservation.tableId
    if (resolvedTableId) {
      const tableStatus =
        resolvedStatus === 'confirmed' ? 'reserved' : 'available'
      await Table.update(
        { status: tableStatus },
        { where: { id: resolvedTableId } }
      )
    }

    createAudit(
      req,
      'update',
      'reservation',
      id,
      `Updated reservation for ${customerName || reservation.customerName}`
    )

    return res.status(200).json({
      success: true,
      message: 'Reservation updated',
      data: reservation
    })
  } catch (error) {
    console.error('Error:', error)
    return res
      .status(500)
      .json({ success: false, message: 'Internal Server Error' })
  }
}

exports.remove = async (req, res) => {
  const { id } = req.params

  try {
    // Same IDOR fix as update() — never trust req.body.store.
    const reservation = await Reservation.findOne({
      where: scalarStoreScope(req, { id })
    })
    if (!reservation) {
      return res
        .status(404)
        .json({ success: false, message: 'Reservation not found' })
    }

    if (reservation.tableId) {
      await Table.update(
        { status: 'available' },
        { where: { id: reservation.tableId } }
      )
    }
    await reservation.destroy()
    createAudit(req, 'delete', 'reservation', id, `Deleted reservation #${id}`)

    return res
      .status(200)
      .json({ success: true, message: 'Reservation deleted' })
  } catch (error) {
    console.error('Error:', error)
    return res
      .status(500)
      .json({ success: false, message: 'Internal Server Error' })
  }
}

exports.getAvailableTables = async (req, res) => {
  const store = req.query.store ||
      (req.user?.roleType !== 'super_admin' ? req.user?.store : null)
  const { date, startTime, endTime } = req.query

  try {
    if (!date || !startTime) {
      return res
        .status(400)
        .json({ success: false, message: 'date and startTime are required' })
    }

    const allTables = await Table.findAll({
      where: { store, status: 'available' }
    })

    const conflictingReservations = await Reservation.findAll({
      where: {
        store,
        reservationDate: date,
        status: ['pending', 'confirmed'],
        [db.Sequelize.Op.or]: endTime
          ? [
              {
                startTime: { [db.Sequelize.Op.lt]: endTime },
                endTime: { [db.Sequelize.Op.gt]: startTime }
              },
              { startTime: { [db.Sequelize.Op.lt]: endTime }, endTime: null }
            ]
          : [
              {
                startTime: {
                  [db.Sequelize.Op.lt]:
                    `${String(Number(startTime.split(':')[0]) + 2).padStart(2, '0')}:00`
                },
                endTime: { [db.Sequelize.Op.gt]: startTime }
              }
            ]
      }
    })

    const reservedTableIds = new Set(
      conflictingReservations.filter((r) => r.tableId).map((r) => r.tableId)
    )
    const available = allTables.filter((t) => !reservedTableIds.has(t.id))

    return res.status(200).json({ success: true, data: available })
  } catch (error) {
    console.error('Error:', error)
    return res
      .status(500)
      .json({ success: false, message: 'Internal Server Error' })
  }
}
