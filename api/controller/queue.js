const db = require('../../db/models')
const { Op } = require('sequelize')
const { enrichAuditFields } = require('../../utils/auditFields')
const { emitToStore } = require('../service/socket')
const { arrayStoreScope } = require('../../utils/tenantScope')

const generateQueueNumber = () => {
  const date = new Date()
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const random = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, '0')
  return `Q${hours}${minutes}-${random}`
}

const queueController = {
  async getQueueList(req, res) {
    try {
      const { search, status, priority, page = 1, limit = 20 } = req.query
      const store = req.query.store

      const where = {}
      if (req.user?.roleType !== 'super_admin') {
        if (req.user?.store) {
          where.store = { [Op.contains]: [Number(req.user.store)] }
        }
      } else if (store && store !== '') {
        where.store = { [Op.contains]: [Number(store)] }
      }

      if (status && status !== 'all') {
        where.status = status
      }
      if (priority && priority !== 'all') {
        where.priority = priority
      }
      if (search) {
        where[Op.or] = [
          { queueNumber: { [Op.iLike]: `%${search}%` } },
          { customerName: { [Op.iLike]: `%${search}%` } },
          { customerPhone: { [Op.iLike]: `%${search}%` } }
        ]
      }

      const offset = (parseInt(page) - 1) * parseInt(limit)

      const [queues, total, waitingCount, seatedCount, cancelledCount] =
        await Promise.all([
          db.queue.findAll({
            where,
            order: [
              ['priority', 'ASC'],
              ['checkedInAt', 'ASC']
            ],
            limit: parseInt(limit),
            offset,
            include: [
              {
                model: db.table,
                as: 'table',
                attributes: ['id', 'name', 'capacity']
              }
            ]
          }),
          db.queue.count({ where }),
          db.queue.count({ where: { ...where, status: 'waiting' } }),
          db.queue.count({ where: { ...where, status: 'seated' } }),
          db.queue.count({ where: { ...where, status: 'cancelled' } })
        ])

      await enrichAuditFields(db, queues)

      return res.status(200).json({
        success: true,
        message: 'Success get queue list',
        data: queues,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit))
        },
        stats: {
          total,
          waiting: waitingCount,
          seated: seatedCount,
          cancelled: cancelledCount
        }
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async getQueueById(req, res) {
    try {
      const { id } = req.params

      // Same IDOR fix as updateQueue: was findByPk(id) with no ownership
      // check, leaking another store's queue/customer data on a guessed id.
      const queue = await db.queue.findOne({
        where: arrayStoreScope(req, { id }),
        include: [
          {
            model: db.table,
            as: 'table',
            attributes: ['id', 'name', 'capacity', 'status']
          }
        ]
      })

      if (!queue) {
        return res
          .status(404)
          .json({ success: false, message: 'Queue entry not found' })
      }

      await enrichAuditFields(db, [queue])

      return res.status(200).json({
        success: true,
        message: 'Success get queue entry',
        data: queue
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async createQueue(req, res) {
    try {
      const {
        store,
        customerName,
        customerPhone,
        partySize,
        priority,
        estimatedWaitMinutes,
        notes,
        assignedTo
      } = req.body

      const queueNumber = generateQueueNumber()

      const queue = await db.queue.create({
        store,
        queueNumber,
        customerName,
        customerPhone,
        partySize: partySize || 1,
        priority: priority || 'normal',
        estimatedWaitMinutes,
        notes,
        assignedTo,
        status: 'waiting',
        checkedInAt: new Date(),
        createdBy: req.user?.id
      })

      await enrichAuditFields(db, [queue])

      emitToStore(store, 'queue:created', queue)

      return res.status(201).json({
        success: true,
        message: 'Customer added to queue',
        data: queue
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async updateQueue(req, res) {
    try {
      const { id } = req.params
      const {
        customerName,
        customerPhone,
        partySize,
        priority,
        estimatedWaitMinutes,
        notes,
        assignedTo
      } = req.body

      // `store` on this model is a JSONB array (a queue entry can be shared
      // across stores) — arrayStoreScope matches with the same Op.contains
      // convention getQueueList already uses. IDOR fix: was findByPk(id)
      // with no ownership check, so any authenticated store could update
      // another store's queue entry.
      const queue = await db.queue.findOne({
        where: arrayStoreScope(req, { id })
      })
      if (!queue) {
        return res
          .status(404)
          .json({ success: false, message: 'Queue entry not found' })
      }

      await queue.update({
        customerName: customerName || queue.customerName,
        customerPhone:
          customerPhone !== undefined ? customerPhone : queue.customerPhone,
        partySize: partySize || queue.partySize,
        priority: priority || queue.priority,
        estimatedWaitMinutes:
          estimatedWaitMinutes !== undefined
            ? estimatedWaitMinutes
            : queue.estimatedWaitMinutes,
        notes: notes !== undefined ? notes : queue.notes,
        assignedTo: assignedTo !== undefined ? assignedTo : queue.assignedTo,
        modifiedBy: req.user?.id
      })

      await enrichAuditFields(db, [queue])

      emitToStore(queue.store, 'queue:updated', queue)

      return res.status(200).json({
        success: true,
        message: 'Queue entry updated',
        data: queue
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async updateQueueStatus(req, res) {
    try {
      const { id } = req.params
      const { status, tableId, notes } = req.body

      // Same IDOR fix as updateQueue.
      const queue = await db.queue.findOne({
        where: arrayStoreScope(req, { id })
      })
      if (!queue) {
        return res
          .status(404)
          .json({ success: false, message: 'Queue entry not found' })
      }

      const updates = {
        status,
        modifiedBy: req.user?.id
      }

      if (status === 'seated') {
        updates.seatedAt = new Date()
        updates.tableId = tableId
        if (queue.checkedInAt) {
          updates.actualWaitMinutes = Math.round(
            (new Date() - new Date(queue.checkedInAt)) / 60000
          )
        }

        if (tableId) {
          await db.table.update(
            { status: 'occupied', modifiedBy: req.user?.id },
            { where: { id: tableId } }
          )
        }
      } else if (status === 'cancelled' || status === 'no_show') {
        updates.cancelledAt = new Date()
      }

      if (notes !== undefined) {
        updates.notes = notes
      }

      await queue.update(updates)

      await enrichAuditFields(db, [queue])

      emitToStore(queue.store, 'queue:statusChanged', queue)

      return res.status(200).json({
        success: true,
        message: `Queue status updated to ${status}`,
        data: queue
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async deleteQueue(req, res) {
    try {
      const { id } = req.params

      // Same IDOR fix as updateQueue.
      const queue = await db.queue.findOne({
        where: arrayStoreScope(req, { id })
      })
      if (!queue) {
        return res
          .status(404)
          .json({ success: false, message: 'Queue entry not found' })
      }

      await queue.destroy()

      emitToStore(queue.store, 'queue:deleted', { id })

      return res.status(200).json({
        success: true,
        message: 'Queue entry deleted'
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async getQueueStats(req, res) {
    try {
      const store = req.query.store

      const where = {}
      if (req.user?.roleType !== 'super_admin') {
        if (req.user?.store) {
          where.store = { [Op.contains]: [Number(req.user.store)] }
        }
      } else if (store && store !== '') {
        where.store = { [Op.contains]: [Number(store)] }
      }

      const today = new Date()
      today.setHours(0, 0, 0, 0)

      const [totalToday, waitingNow, seatedToday, cancelledToday, avgWaitTime] =
        await Promise.all([
          db.queue.count({
            where: {
              ...where,
              createdAt: { [Op.gte]: today }
            }
          }),
          db.queue.count({
            where: { ...where, status: 'waiting' }
          }),
          db.queue.count({
            where: {
              ...where,
              status: 'seated',
              seatedAt: { [Op.gte]: today }
            }
          }),
          db.queue.count({
            where: {
              ...where,
              status: { [Op.in]: ['cancelled', 'no_show'] },
              cancelledAt: { [Op.gte]: today }
            }
          }),
          db.queue.findOne({
            attributes: [
              [
                db.sequelize.fn('AVG', db.sequelize.col('actualWaitMinutes')),
                'avgWait'
              ]
            ],
            where: {
              ...where,
              status: 'seated',
              actualWaitMinutes: { [Op.not]: null },
              seatedAt: { [Op.gte]: today }
            },
            raw: true
          })
        ])

      return res.status(200).json({
        success: true,
        message: 'Success get queue stats',
        data: {
          totalToday,
          waitingNow,
          seatedToday,
          cancelledToday,
          avgWaitMinutes: avgWaitTime?.avgWait
            ? Math.round(parseFloat(avgWaitTime.avgWait))
            : 0
        }
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  }
}

module.exports = queueController
