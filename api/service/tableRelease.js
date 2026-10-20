'use strict'

// Client request 2026-10-20 (BA DR-24 C-16 amended): the cashier can put a
// table back to "available" from the cashier screen — e.g. guests left
// after a paid dine-in, or a table picked/reserved by mistake.
//
//   * A table with an OPEN, UNPAID order (QR order not settled, partial
//     payment) is never released by a kasir — only by admin/owner, because
//     freeing it lets a second party order on top of an unpaid bill.
//   * A reason is always required and every release is audited.
//   * The table row is locked and the unpaid-order check runs under that
//     lock, so a QR order landing at the same moment (which also locks the
//     table to claim it) is serialized against the release.

const db = require('../../db/models')
const { recordAudit } = require('../../utils/auditLog')

const OPEN_ORDER_STATUSES = [
  'pending',
  'confirmed',
  'preparing',
  'ready',
  'served'
]
const UNPAID_PAYMENT_STATUSES = ['unpaid', 'partial']
const ELEVATED_ROLES = ['super_admin', 'admin']

const isElevated = (req) => ELEVATED_ROLES.includes(req.user?.roleType)

const unpaidOpenOrderWhere = (tableIds) => ({
  tableId: tableIds,
  status: OPEN_ORDER_STATUSES,
  paymentStatus: UNPAID_PAYMENT_STATUSES
})

const failure = (statusCode, code, message, extra = {}) =>
  Object.assign(new Error(message), { statusCode, code, extra })

/**
 * Tables of one store with what the cashier needs to decide a reset.
 * @returns {Promise<Array<{id, name, status, capacity, unpaidOrders, canRelease, blockedReason}>>}
 */
async function listTableReleaseStatus(storeId, req) {
  const tables = await db.table.findAll({
    where: { store: storeId },
    attributes: ['id', 'name', 'status', 'capacity'],
    order: [['name', 'ASC']]
  })
  const ids = tables.map((t) => t.id)
  const unpaid = ids.length
    ? await db.order.findAll({
        where: { store: storeId, ...unpaidOpenOrderWhere(ids) },
        attributes: [
          'id',
          'tableId',
          'orderNumber',
          'source',
          'status',
          'paymentStatus',
          'totalPrice'
        ]
      })
    : []
  const byTable = new Map()
  for (const o of unpaid) {
    if (!byTable.has(o.tableId)) byTable.set(o.tableId, [])
    byTable.get(o.tableId).push({
      id: o.id,
      orderNumber: o.orderNumber,
      source: o.source,
      status: o.status,
      paymentStatus: o.paymentStatus,
      totalPrice: Number(o.totalPrice) || 0
    })
  }
  const elevated = isElevated(req)
  return tables.map((t) => {
    const unpaidOrders = byTable.get(t.id) || []
    let blockedReason = null
    if (t.status === 'available') blockedReason = 'ALREADY_AVAILABLE'
    else if (t.status === 'maintenance' && !elevated)
      blockedReason = 'TABLE_IN_MAINTENANCE'
    else if (unpaidOrders.length > 0 && !elevated)
      blockedReason = 'TABLE_HAS_UNPAID_ORDER'
    return {
      id: t.id,
      name: t.name,
      status: t.status,
      capacity: t.capacity,
      unpaidOrders,
      canRelease: blockedReason === null,
      blockedReason
    }
  })
}

/**
 * Release one table to "available". Throws an Error with statusCode/code on
 * refusal; returns { changed, table } on success (changed=false when it was
 * already available — releasing is idempotent).
 */
async function releaseTable(req, { tableId, reason, storeScope }) {
  const releaseReason = typeof reason === 'string' ? reason.trim() : ''
  if (!releaseReason) {
    throw failure(
      400,
      'RELEASE_REASON_REQUIRED',
      'A reason is required to release a table'
    )
  }
  const elevated = isElevated(req)

  const outcome = await db.sequelize.transaction(async (t) => {
    const table = await db.table.findOne({
      where: { ...storeScope, id: tableId },
      transaction: t,
      lock: t.LOCK.UPDATE
    })
    if (!table) throw failure(404, 'TABLE_NOT_FOUND', 'Table not found')
    if (table.status === 'available')
      return { changed: false, table, previousStatus: 'available' }
    if (table.status === 'maintenance' && !elevated) {
      throw failure(
        409,
        'TABLE_IN_MAINTENANCE',
        'Meja sedang dalam perawatan — hanya admin yang dapat mengubahnya'
      )
    }

    const unpaid = await db.order.findAll({
      where: { store: table.store, ...unpaidOpenOrderWhere([table.id]) },
      attributes: ['id', 'orderNumber'],
      transaction: t
    })
    if (unpaid.length > 0 && !elevated) {
      throw failure(
        409,
        'TABLE_HAS_UNPAID_ORDER',
        'Meja masih punya pesanan yang belum dibayar — minta admin untuk mengosongkannya',
        { data: { unpaidOrders: unpaid.map((o) => o.orderNumber) } }
      )
    }

    const previousStatus = table.status
    await table.update({ status: 'available' }, { transaction: t })
    // Same as the admin release (table.updateTableStatus): an active
    // reservation on this table is closed with it.
    await db.reservation.update(
      { status: 'completed', modifiedBy: req.user?.id },
      {
        where: { tableId: table.id, status: ['pending', 'confirmed'] },
        transaction: t
      }
    )
    return {
      changed: true,
      table,
      previousStatus,
      unpaidOrders: unpaid.map((o) => o.orderNumber)
    }
  })

  if (outcome.changed) {
    await recordAudit({
      req,
      action: 'update',
      entity: 'table',
      entityId: outcome.table.id,
      description: `Released table ${outcome.table.name || outcome.table.id} from the cashier: ${releaseReason}`,
      reason: releaseReason,
      previousState: { status: outcome.previousStatus },
      newState: { status: 'available' },
      metadata: {
        channel: 'cashier',
        actorRole: req.user?.roleType || null,
        unpaidOrdersOverridden: outcome.unpaidOrders
      }
    })
  }
  return { changed: outcome.changed, table: outcome.table }
}

module.exports = { listTableReleaseStatus, releaseTable, OPEN_ORDER_STATUSES }
