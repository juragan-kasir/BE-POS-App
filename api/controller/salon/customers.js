'use strict'

const { Op } = require('sequelize')
const db = require('../../../db/models')
const { salonRoute, withStatus } = require('./http')
const { SalonError } = require('../../service/salonContext')
const { CustomerInput } = require('../../validation/salonSchemas')
const { canonicalPhone, isGuestPhone } = require('../../../utils/memberIdentity')
const { idParam, notFound, optionalStore } = require('./shared')
const { serializeAppointments, appointmentInclude } = require('./appointments')

// Salon customers = the shared `member` table, one list per tenant (the
// contract has no outlet on /salon/customers). A row is still stored on an
// outlet (member.store drives member.tenantId and the per-outlet unique
// indexes); the phone is unique across the whole tenant here.

const LIST_LIMIT = 100
const HISTORY_LIMIT = 50
// BR-SLN-019: tier by total spend.
const SILVER_FROM = 1000000
const GOLD_FROM = 3000000

const tierOf = (spent) => (spent >= GOLD_FROM ? 'gold' : spent >= SILVER_FROM ? 'silver' : 'regular')

/** '+628123…' → '08123…' (the contract's Indonesian format); guests → ''. */
const localPhone = (phone) => {
  if (!phone || isGuestPhone(phone)) return ''
  return phone.startsWith('+62') ? `0${phone.slice(3)}` : phone
}

const toE164 = (phone) => {
  try {
    return canonicalPhone(phone)
  } catch {
    throw new SalonError('VALIDATION_FAILED', 'Nomor HP tidak valid', 400, { field: 'phone' })
  }
}

/** Visits and spend from paid salon orders (filled from S2 checkout on). */
const statsFor = async (memberIds) => {
  if (!memberIds.length) return new Map()
  const rows = await db.sequelize.query(
    `SELECT o."customerId" AS "memberId",
            COUNT(*)::int AS "visitCount",
            MAX(so."createdAt") AS "lastVisitAt",
            COALESCE(SUM((so.quote->>'total')::bigint), 0)::bigint AS "totalSpent"
       FROM "salon_order" so
       JOIN "order" o ON o.id = so."orderId"
      WHERE so.status = 'paid' AND o."customerId" IN (:ids)
      GROUP BY o."customerId"`,
    { replacements: { ids: memberIds }, type: db.sequelize.QueryTypes.SELECT }
  )
  return new Map(rows.map((r) => [Number(r.memberId), r]))
}

const serializeCustomer = (m, stats) => {
  const s = stats.get(m.id)
  const totalSpent = s ? Number(s.totalSpent) : 0
  return {
    id: String(m.id),
    name: m.name,
    phone: localPhone(m.phoneNumber),
    points: m.totalPoints || 0,
    tier: tierOf(totalSpent),
    notes: m.notes || '',
    visitCount: s ? s.visitCount : 0,
    lastVisitAt: s && s.lastVisitAt ? new Date(s.lastVisitAt).toISOString() : null,
    totalSpent,
    createdAt: new Date(m.createdAt).toISOString()
  }
}

const publicCustomers = async (rows) => {
  const stats = await statsFor(rows.map((m) => m.id))
  return rows.map((m) => serializeCustomer(m, stats))
}

const findCustomer = async (salon, rawId, transaction) => {
  const row = await db.member.findOne({
    where: { id: idParam(rawId, 'Pelanggan tidak ditemukan'), tenantId: salon.tenant.id },
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined
  })
  if (!row) throw notFound('Pelanggan tidak ditemukan')
  return row
}

const assertPhoneFree = async (salon, phone, excludeId, transaction) => {
  const clash = await db.member.findOne({
    where: {
      tenantId: salon.tenant.id,
      phoneNumber: phone,
      ...(excludeId ? { id: { [Op.ne]: excludeId } } : {})
    },
    attributes: ['id'],
    transaction
  })
  if (clash) throw new SalonError('DUPLICATE', 'Nomor HP sudah terdaftar', 409, { field: 'phone' })
}

/** One writer per tenant's customer list, so the tenant-wide phone check holds. */
const lockTenantCustomers = (salon, transaction) =>
  db.sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', {
    replacements: { key: `salon_customer:${salon.tenant.id}` },
    transaction
  })

/** The per-outlet name index (uq_member_store_name_ci) answers as DUPLICATE. */
const duplicateName = (err) => {
  const code = err?.parent?.code || err?.original?.code
  const constraint = err?.parent?.constraint || err?.original?.constraint || ''
  if (code === '23505' && /name/.test(constraint)) {
    return new SalonError('DUPLICATE', 'Nama pelanggan sudah terdaftar di outlet ini', 409, { field: 'name' })
  }
  if (code === '23505' && /phone/i.test(constraint)) {
    return new SalonError('DUPLICATE', 'Nomor HP sudah terdaftar', 409, { field: 'phone' })
  }
  return err
}

exports.listCustomers = salonRoute({ perm: 'member.read' }, async ({ salon, query }) => {
  const q = String(query.q || '').trim()
  const digits = q.replace(/\D/g, '').replace(/^(62|0)/, '')
  const where = { tenantId: salon.tenant.id }
  if (q) {
    where[Op.or] = [
      { name: { [Op.iLike]: `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` } },
      ...(digits.length >= 3 ? [{ phoneNumber: { [Op.like]: `%${digits}%` } }] : [])
    ]
  }
  const rows = await db.member.findAll({ where, order: [['name', 'ASC'], ['id', 'ASC']], limit: LIST_LIMIT })
  return { data: await publicCustomers(rows) }
})

exports.createCustomer = salonRoute({ perm: 'member.manage' }, async ({ salon, user, body, query }) => {
  const input = CustomerInput.parse(body)
  const phone = toE164(input.phone)
  // Home outlet of the row: the requested/only outlet, else the first one.
  const home = optionalStore(salon, query.store) || salon.stores[0]
  if (!home) throw new SalonError('VALIDATION_FAILED', 'Buat outlet dulu sebelum menambah pelanggan', 400)
  try {
    const created = await db.sequelize.transaction(async (t) => {
      await lockTenantCustomers(salon, t)
      await assertPhoneFree(salon, phone, null, t)
      return db.member.create(
        {
          store: home.id,
          name: input.name,
          phoneNumber: phone,
          notes: input.notes || null,
          status: 'active',
          totalPoints: 0,
          lifetimePoints: 0,
          createdBy: user.id
        },
        { transaction: t }
      )
    })
    return withStatus(201, (await publicCustomers([created]))[0])
  } catch (err) {
    throw duplicateName(err)
  }
})

exports.updateCustomer = salonRoute({ perm: 'member.manage' }, async ({ salon, user, body, params }) => {
  const input = CustomerInput.parse(body)
  const phone = toE164(input.phone)
  try {
    const row = await db.sequelize.transaction(async (t) => {
      await lockTenantCustomers(salon, t)
      const member = await findCustomer(salon, params.id, t)
      await assertPhoneFree(salon, phone, member.id, t)
      await member.update(
        { name: input.name, phoneNumber: phone, notes: input.notes || null, modifiedBy: user.id },
        { transaction: t }
      )
      return member
    })
    return (await publicCustomers([row]))[0]
  } catch (err) {
    throw duplicateName(err)
  }
})

exports.customerHistory = salonRoute({ perm: 'member.read' }, async ({ salon, params }) => {
  const member = await findCustomer(salon, params.id)
  const storeIds = salon.stores.map((s) => s.id)
  const appointments = await db.salon_appointment.findAll({
    where: { tenantId: salon.tenant.id, memberId: member.id, store: storeIds },
    include: appointmentInclude,
    order: [['startAt', 'DESC'], ['id', 'DESC']],
    limit: HISTORY_LIMIT
  })
  return {
    appointments: await serializeAppointments(appointments),
    // Salon orders arrive with checkout (S2-a); until then there are none.
    orders: []
  }
})

module.exports.localPhone = localPhone
module.exports.tierOf = tierOf
