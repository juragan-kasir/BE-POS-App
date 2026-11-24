'use strict'

const db = require('../../../db/models')
const { salonRoute, withStatus } = require('./http')
const { SalonError } = require('../../service/salonContext')
const { OpenShiftInput, CloseShiftInput } = require('../../validation/salonSchemas')
const { expectedCash } = require('../../service/salonMoney')
const { toIso } = require('../../service/salonTime')

// Salon shift (SALON-BA BR-SLN-009, BR-SLN-016) = the POS cash register of the
// outlet (DR-SLN-06): one open drawer per outlet, shared by the salon kasir
// screens and FE-POS. The figures are read from the ledger every time
// (transaction rows of the drawer + cash deposits taken into it), never kept
// as counters, so a retried or concurrent write cannot drift them.

// The applied-deposit transaction row written at checkout carries this key
// prefix. Its cash already counted as depositCash when it was taken at
// booking, so the shift figures leave it out of cashSales.
const DEPOSIT_KEY_PREFIX = 'salon-deposit:'

/** Open drawer of the outlet, or null. */
const findOpenRegister = (store, transaction, lock) =>
  db.cashRegister.findOne({
    where: { store: store.id, status: 'open' },
    order: [['id', 'DESC']],
    transaction,
    ...(lock ? { lock } : {})
  })

/** Open drawer of the outlet, or SHIFT_CLOSED. */
const requireOpenRegister = async (store, transaction, message = 'Buka shift kasir dulu') => {
  const register = await findOpenRegister(store, transaction, transaction.LOCK.SHARE)
  if (!register) throw new SalonError('SHIFT_CLOSED', message, 409)
  return register
}

const statsFor = async (registerIds, transaction) => {
  const empty = () => ({ cashSales: 0, nonCashSales: 0, refunds: 0, depositCash: 0, orderCount: 0 })
  const out = new Map(registerIds.map((id) => [id, empty()]))
  if (!registerIds.length) return out
  const opts = { replacements: { ids: registerIds, deposit: `${DEPOSIT_KEY_PREFIX}%` }, type: db.sequelize.QueryTypes.SELECT, transaction }
  const money = await db.sequelize.query(
    `SELECT t."cashRegisterId" AS id,
            COALESCE(SUM(CASE WHEN t.amount > 0 AND t."typePayment" IN ('cash','CASH') THEN t.amount ELSE 0 END), 0)::bigint AS "cashSales",
            COALESCE(SUM(CASE WHEN t.amount > 0 AND t."typePayment" NOT IN ('cash','CASH') THEN t.amount ELSE 0 END), 0)::bigint AS "nonCashSales",
            COALESCE(SUM(CASE WHEN t.amount < 0 AND t."typePayment" IN ('cash','CASH') THEN -t.amount ELSE 0 END), 0)::bigint AS refunds
       FROM "transaction" t
      WHERE t."cashRegisterId" IN (:ids)
        AND (t."idempotencyKey" IS NULL OR t."idempotencyKey" NOT LIKE :deposit)
      GROUP BY t."cashRegisterId"`,
    opts
  )
  const deposits = await db.sequelize.query(
    `SELECT "depositCashRegisterId" AS id, COALESCE(SUM("depositAmount"), 0)::bigint AS "depositCash"
       FROM "salon_appointment"
      WHERE "depositCashRegisterId" IN (:ids) AND "depositMethod" = 'cash' AND "depositAmount" > 0
      GROUP BY "depositCashRegisterId"`,
    opts
  )
  const orders = await db.sequelize.query(
    `SELECT o."cashRegisterId" AS id, COUNT(*)::int AS "orderCount"
       FROM "salon_order" so JOIN "order" o ON o.id = so."orderId"
      WHERE o."cashRegisterId" IN (:ids)
      GROUP BY o."cashRegisterId"`,
    opts
  )
  for (const r of money) Object.assign(out.get(Number(r.id)), { cashSales: Number(r.cashSales), nonCashSales: Number(r.nonCashSales), refunds: Number(r.refunds) })
  for (const r of deposits) out.get(Number(r.id)).depositCash = Number(r.depositCash)
  for (const r of orders) out.get(Number(r.id)).orderCount = r.orderCount
  return out
}

/** Contract `Shift` for cash_register rows. */
const serializeShifts = async (registers, transaction) => {
  if (!registers.length) return []
  const stats = await statsFor(registers.map((r) => r.id), transaction)
  const users = await db.user.findAll({
    where: { id: [...new Set(registers.map((r) => r.user))] },
    attributes: ['id', 'fullName', 'userName'],
    paranoid: false,
    transaction
  })
  const names = new Map(users.map((u) => [u.id, u.fullName || u.userName || '']))
  return registers.map((r) => {
    const s = stats.get(r.id)
    const open = r.status === 'open'
    return {
      id: String(r.id),
      store: String(r.store),
      userName: names.get(r.user) || '',
      openedAt: toIso(r.openedAt || r.createdAt),
      openingCash: Number(r.openingBalance) || 0,
      closedAt: open ? null : toIso(r.closedAt),
      countedCash: open ? null : Number(r.closingBalance) || 0,
      expectedCash: open ? null : r.expectedCash == null ? null : Number(r.expectedCash),
      variance: open ? null : r.variance == null ? null : Number(r.variance),
      cashSales: s.cashSales,
      nonCashSales: s.nonCashSales,
      refunds: s.refunds,
      depositCash: s.depositCash,
      orderCount: s.orderCount,
      status: open ? 'open' : 'closed'
    }
  })
}

const serializeShift = async (register, transaction) => (await serializeShifts([register], transaction))[0]

exports.currentShift = salonRoute({ perm: 'pos.sell', store: true }, async ({ store }) => {
  const register = await findOpenRegister(store)
  return { shift: register ? await serializeShift(register) : null }
})

exports.listShifts = salonRoute({ perm: ['shift.manage', 'report.read'], store: true }, async ({ store }) => {
  const rows = await db.cashRegister.findAll({
    where: { store: store.id },
    order: [['openedAt', 'DESC'], ['id', 'DESC']],
    limit: 30
  })
  return { data: await serializeShifts(rows) }
})

exports.openShift = salonRoute({ perm: 'shift.manage', store: true }, async ({ store, user, body }) => {
  const { openingCash } = OpenShiftInput.parse(body)
  const register = await db.sequelize.transaction(async (t) => {
    // The outlet row lock serializes two "open" clicks: one drawer per outlet.
    await db.location.findByPk(store.id, { attributes: ['id'], transaction: t, lock: t.LOCK.UPDATE })
    if (await findOpenRegister(store, t)) throw new SalonError('SHIFT_ALREADY_OPEN', 'Shift outlet ini sudah dibuka', 409)
    return db.cashRegister.create(
      {
        store: store.id,
        user: user.id,
        openingBalance: openingCash,
        openedAt: new Date(),
        status: 'open',
        createdBy: user.id
      },
      { transaction: t }
    )
  })
  return withStatus(201, await serializeShift(register))
})

exports.closeShift = salonRoute({ perm: 'shift.manage', store: true }, async ({ store, user, body }) => {
  const { countedCash } = CloseShiftInput.parse(body)
  const id = await db.sequelize.transaction(async (t) => {
    const register = await findOpenRegister(store, t, t.LOCK.UPDATE)
    if (!register) throw new SalonError('SHIFT_CLOSED', 'Tidak ada shift yang terbuka', 409)
    const s = (await statsFor([register.id], t)).get(register.id)
    const openingCash = Number(register.openingBalance) || 0
    // BR-SLN-016 blind count: the counted cash is taken first, the system
    // figure and the variance are only shown back after the close.
    const expected = expectedCash({ openingCash, ...s })
    await register.update(
      {
        status: 'closed',
        closedAt: new Date(),
        closingBalance: countedCash,
        expectedCash: expected,
        variance: countedCash - expected,
        cashSalesReceived: s.cashSales + s.depositCash - s.refunds,
        cashRefundsTotal: s.refunds,
        modifiedBy: user.id
      },
      { transaction: t }
    )
    return register.id
  })
  return serializeShift(await db.cashRegister.findByPk(id))
})

module.exports.DEPOSIT_KEY_PREFIX = DEPOSIT_KEY_PREFIX
module.exports.requireOpenRegister = requireOpenRegister
