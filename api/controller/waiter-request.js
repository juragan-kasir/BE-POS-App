const db = require('../../db/models')
const { Op } = require('sequelize')
const { enrichAuditFields } = require('../../utils/auditFields')
const { emitToStore } = require('../service/socket')
const { arrayStoreScope } = require('../../utils/tenantScope')

const generateRequestNumber = () => {
  const date = new Date()
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const random = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, '0')
  return `WR${hours}${minutes}-${random}`
}

const waiterRequestController = {
  // ——— Public (no auth) — customer submits a waiter request ———
  async customerCreate(req, res) {
    const { store, tableId, orderId, type, notes, customerName } = req.body

    try {
      if (!store || !type) {
        return res.status(400).json({ message: 'store and type are required' })
      }

      // N-5 (security): public, unauthenticated endpoint — derive the store
      // from a valid table belonging to the claimed store (the physical QR/
      // table is the server-authoritative capability), and reject a
      // table-less or mismatched request so an attacker cannot direct the
      // persisted row or its realtime emission into an arbitrary store.
      const tableIdNum =
        tableId === '' || tableId == null ? null : Number(tableId)
      if (!Number.isInteger(tableIdNum)) {
        return res.status(400).json({ message: 'tableId is required' })
      }
      const table = await db.table.findOne({
        where: { id: tableIdNum, store: Number(store) }
      })
      if (!table) {
        return res.status(400).json({ message: 'Table not found' })
      }
      const storeId = Number(table.store) || Number(store)

      const allowedTypes = ['sendok', 'tisu', 'refill', 'bill', 'call']
      if (!allowedTypes.includes(type)) {
        return res.status(400).json({ message: 'Invalid request type' })
      }

      const requestNumber = generateRequestNumber()

      const orderIdNum =
        orderId === '' || orderId == null ? null : Number(orderId)

      const waiterRequest = await db.waiter_request.create({
        store: [storeId],
        requestNumber,
        tableId: tableIdNum,
        orderId: Number.isInteger(orderIdNum) ? orderIdNum : null,
        type,
        notes: notes || null,
        customerName: customerName || null,
        status: 'pending'
      })

      const fullRequest = await db.waiter_request.findByPk(waiterRequest.id, {
        include: [
          { model: db.table, as: 'table', attributes: ['id', 'name'] },
          { model: db.order, as: 'order', attributes: ['id', 'orderNumber'] }
        ]
      })

      emitToStore(storeId, 'waiter-request:new', fullRequest)
      emitToStore(storeId, 'new-notification', {
        type: 'waiter_request',
        referenceId: waiterRequest.id,
        title: 'Permintaan Pelayan Baru',
        message: `${type} dari meja ${tableId ? `#${tableId}` : '-'}`,
        createdAt: new Date().toISOString()
      })

      return res.status(201).json({
        success: true,
        message: 'Waiter request created',
        data: fullRequest
      })
    } catch (error) {
      console.error('Error:', error)
      return res.status(500).json({ error: 'Internal Server Error' })
    }
  },

  // ——— Public — customer views their own requests (by store + table) ———
  // C-8: this endpoint is unauthenticated, so it MUST NOT allow an attacker to
  // list another tenant's requests by guessing a `store` value alone. Require
  // BOTH store and tableId, verify the table physically belongs to that store
  // (same capability check as customerCreate — the physical QR/table is the
  // server-authoritative capability), and return ONLY that table's requests.
  async getCustomerList(req, res) {
    try {
      const { store, tableId, limit = 50 } = req.query
      const storeId = Number(store)
      const tableNum =
        tableId === '' || tableId == null ? NaN : Number(tableId)

      if (!Number.isInteger(storeId) || storeId <= 0) {
        return res.status(400).json({ message: 'Invalid store value' })
      }
      if (!Number.isInteger(tableNum)) {
        return res.status(400).json({ message: 'tableId is required' })
      }

      // Verify the table belongs to the claimed store; otherwise reject
      // (prevents a store-A/table-B cross-tenant read).
      const table = await db.table.findOne({
        where: { id: tableNum, store: storeId }
      })
      if (!table) {
        return res.status(400).json({ message: 'Table not found' })
      }

      const where = {
        store: { [Op.contains]: [storeId] },
        tableId: tableNum
      }

      const requests = await db.waiter_request.findAll({
        where,
        order: [['updatedAt', 'DESC']],
        limit: Number(limit),
        include: [
          { model: db.table, as: 'table', attributes: ['id', 'name'] },
          { model: db.order, as: 'order', attributes: ['id', 'orderNumber'] }
        ]
      })

      return res.status(200).json({
        success: true,
        message: 'Success get customer waiter requests',
        data: requests
      })
    } catch (error) {
      console.error('Error:', error)
      return res.status(500).json({ error: 'Internal Server Error' })
    }
  },

  // ——— Admin — list pending requests ———
  async getPendingList(req, res) {
    try {
      const { page = 1, limit = 50 } = req.query
      const store = req.query.store ||
      (req.user?.roleType !== 'super_admin' ? req.user?.store : null)

      const where = { status: 'pending' }
      if (store) {
        const storeId = Number(store)
        if (!isNaN(storeId)) {
          where.store = { [Op.contains]: [storeId] }
        }
      }

      const offset = (Number(page) - 1) * Number(limit)

      const [requests, total] = await Promise.all([
        db.waiter_request.findAll({
          where,
          order: [['updatedAt', 'ASC']],
          limit: Number(limit),
          offset,
          include: [
            { model: db.table, as: 'table', attributes: ['id', 'name'] },
            { model: db.order, as: 'order', attributes: ['id', 'orderNumber'] }
          ]
        }),
        db.waiter_request.count({ where })
      ])

      await enrichAuditFields(db, requests)

      return res.status(200).json({
        success: true,
        message: 'Success get waiter requests',
        data: requests,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          totalPages: Math.ceil(total / Number(limit))
        }
      })
    } catch (error) {
      console.error('Error:', error)
      return res.status(500).json({ error: 'Internal Server Error' })
    }
  },

  // ——— Admin — list all requests with optional status filter ———
  async getList(req, res) {
    try {
      const { status, page = 1, limit = 20 } = req.query
      const store = req.query.store ||
      (req.user?.roleType !== 'super_admin' ? req.user?.store : null)

      const where = {}
      if (status && status !== 'all') where.status = status
      if (store) {
        const storeId = Number(store)
        if (!isNaN(storeId)) {
          where.store = { [Op.contains]: [storeId] }
        }
      }

      const offset = (Number(page) - 1) * Number(limit)

      const [requests, total] = await Promise.all([
        db.waiter_request.findAll({
          where,
          order: [['updatedAt', 'DESC']],
          limit: Number(limit),
          offset,
          include: [
            { model: db.table, as: 'table', attributes: ['id', 'name'] },
            { model: db.order, as: 'order', attributes: ['id', 'orderNumber'] }
          ]
        }),
        db.waiter_request.count({ where })
      ])

      await enrichAuditFields(db, requests)

      return res.status(200).json({
        success: true,
        message: 'Success get waiter requests',
        data: requests,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          totalPages: Math.ceil(total / Number(limit))
        }
      })
    } catch (error) {
      console.error('Error:', error)
      return res.status(500).json({ error: 'Internal Server Error' })
    }
  },

  // ——— Admin — update status (approve/reject/done) ———
  async updateStatus(req, res) {
    try {
      const { id } = req.params
      const { status, notes } = req.body

      // IDOR fix: was findByPk(id) with no store filter, reachable by
      // kasir — any store's staff could approve/reject/resolve another
      // store's waiter call. `store` here really is written as a JSONB
      // array on create ([storeId]), so arrayStoreScope applies directly.
      const waiterRequest = await db.waiter_request.findOne({
        where: arrayStoreScope(req, { id })
      })
      if (!waiterRequest) {
        return res
          .status(404)
          .json({ success: false, message: 'Waiter request not found' })
      }

      const allowedStatus = ['pending', 'approved', 'rejected', 'done']
      if (!allowedStatus.includes(status)) {
        return res.status(400).json({ message: 'Invalid status' })
      }

      const updates = {
        status,
        resolvedBy: req.user?.id || null,
        modifiedBy: req.user?.id || null
      }

      if (status === 'approved' || status === 'rejected' || status === 'done') {
        updates.resolvedAt = new Date()
      }

      if (notes !== undefined) {
        updates.notes = notes
      }

      await waiterRequest.update(updates)

      const fullRequest = await db.waiter_request.findByPk(id, {
        include: [
          { model: db.table, as: 'table', attributes: ['id', 'name'] },
          { model: db.order, as: 'order', attributes: ['id', 'orderNumber'] }
        ]
      })

      const storeId = Array.isArray(waiterRequest.store)
        ? waiterRequest.store[0]
        : waiterRequest.store
      emitToStore(storeId, 'waiter-request:statusChanged', fullRequest)

      return res.status(200).json({
        success: true,
        message: `Waiter request ${status}`,
        data: fullRequest
      })
    } catch (error) {
      console.error('Error:', error)
      return res.status(500).json({ error: 'Internal Server Error' })
    }
  }
}

module.exports = waiterRequestController
