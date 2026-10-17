const db = require('../../db/models')
const { recordAudit, ACTOR_TYPES } = require('../../utils/auditLog')

const { Op } = require('sequelize')

// BA gap 019 (DR-09): an unpaid pending QR order expires after a
// launch-configurable duration, so an abandoned order never keeps its
// table locked. The duration is the launch input QR_PENDING_EXPIRY_MINUTES
// (a positive whole number of minutes). Unset or invalid → expiry is off
// and nothing changes.
//
// Only an order nobody has acted on expires: a QR order (source 'qr',
// placed by a diner — createdBy NULL) that is still 'pending', has no
// money collected (no positive ledger row) and no split bill. It is
// cancelled with an 'expired' status note, its table is released when no
// other open order holds it, and the expiry is audited. A QR order takes
// no stock before payment, so there is nothing to give back.
const qrPendingExpiryMinutes = () => {
  const minutes = Number(process.env.QR_PENDING_EXPIRY_MINUTES)
  return Number.isInteger(minutes) && minutes > 0 ? minutes : null
}

const OPEN_STATUSES = ['pending', 'confirmed', 'preparing', 'ready', 'served']

const expireOne = async (orderId, cutoff, minutes, actorType) =>
  db.sequelize.transaction(async (t) => {
    const order = await db.order.findByPk(orderId, { transaction: t, lock: t.LOCK.UPDATE })
    // Re-checked under the lock: a payment, a staff action or a concurrent
    // expiry since the candidate read wins.
    if (
      !order ||
      order.source !== 'qr' ||
      order.createdBy != null ||
      order.status !== 'pending' ||
      order.paymentStatus !== 'unpaid' ||
      new Date(order.createdAt) >= cutoff
    ) {
      return null
    }
    const collected = await db.transaction.count({
      where: { order: order.id, amount: { [Op.gt]: 0 } },
      transaction: t
    })
    const splits = await db.split_bill.count({ where: { order: order.id }, transaction: t })
    if (collected > 0 || splits > 0) return null

    await order.update({ status: 'cancelled' }, { transaction: t })
    await db.order_status.create(
      {
        order: order.id,
        status: 'cancelled',
        createdBy: null,
        notes: `expired: unpaid QR order after ${minutes} minutes`
      },
      { transaction: t }
    )

    let tableReleased = false
    if (order.tableId) {
      const stillOpen = await db.order.count({
        where: {
          tableId: order.tableId,
          id: { [Op.ne]: order.id },
          status: OPEN_STATUSES
        },
        transaction: t
      })
      if (stillOpen === 0) {
        const [released] = await db.table.update(
          { status: 'available' },
          { where: { id: order.tableId, status: 'occupied' }, transaction: t }
        )
        tableReleased = released > 0
      }
    }

    await recordAudit({
      actor: { type: actorType, id: null, name: null },
      action: 'status_change',
      entity: 'order',
      entityId: order.id,
      storeId: order.store ?? null,
      description: `QR order ${order.orderNumber} expired unpaid after ${minutes} minutes`,
      reason: 'DR-09 unpaid pending QR order expiry',
      previousState: { status: 'pending', paymentStatus: 'unpaid' },
      newState: { status: 'cancelled', tableReleased },
      source: 'qr_order_expiry',
      transaction: t
    })
    return { id: order.id, tableId: order.tableId, tableReleased }
  })

// Expires every stale QR order in scope (optionally one store and/or one
// table). Each order commits on its own, so one failure never blocks the
// rest. Returns the expired orders.
const expireStaleQrOrders = async ({
  store = null,
  tableId = null,
  now = new Date(),
  actorType = ACTOR_TYPES.SYSTEM
} = {}) => {
  const minutes = qrPendingExpiryMinutes()
  if (!minutes) return []
  const cutoff = new Date(now.getTime() - minutes * 60 * 1000)
  const candidates = await db.order.findAll({
    where: {
      source: 'qr',
      createdBy: null,
      status: 'pending',
      paymentStatus: 'unpaid',
      createdAt: { [Op.lt]: cutoff },
      ...(store != null ? { store } : {}),
      ...(tableId != null ? { tableId } : {})
    },
    attributes: ['id'],
    order: [['id', 'ASC']]
  })
  const expired = []
  for (const { id } of candidates) {
    const result = await expireOne(id, cutoff, minutes, actorType)
    if (result) expired.push(result)
  }
  return expired
}

module.exports = { qrPendingExpiryMinutes, expireStaleQrOrders }
