'use strict'

// Tenant administration (DR-01 / DR-02): the platform capability that creates
// and maintains the tenant rows stores are subordinate to.
//
//   GET    /tenants       tenants with their store / active-member counts
//   GET    /tenants/:id   one tenant
//   POST   /tenants       { code, name }            create (status 'active')
//   PATCH  /tenants/:id   { name?, status? }        rename / suspend / resume
//   DELETE /tenants/:id                             retire an EMPTY tenant
//
// Every route is gated by requireTenantAdministration
// (utils/tenantAdministration.js): a platform actor (tenant.manage) sees every
// tenant; a store-bound super_admin that is tenant_admin (a client's own super
// admin) sees only its own tenants, becomes tenant_admin of a tenant it
// creates, may rename and delete them, but not suspend/resume (that stays
// platform-only, so it cannot lock itself out). `code` is the stable
// business identifier and is immutable once created; it is never reused, so
// the uniqueness check includes retired (soft-deleted) tenants. Suspending a
// tenant makes it authorize nothing (resolveAuthorizationContext) — the store
// rows and memberships stay untouched and resume with it.
//
// Mutations write their audit row inside the same transaction (fail-closed,
// like the T-03 membership lifecycle).

const db = require('../../db/models')
const { Op } = require('sequelize')
const { recordAudit } = require('../../utils/auditLog')
const { page: pageOf, paginated } = require('../service/scopeVisibilityService')

const CODE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/
const NAME_MAX = 100
const STATUSES = ['active', 'suspended']
const AUDIT_SOURCE = 'tenant-admin'

const fail = (status, code, field, message) => ({ status, body: { success: false, code, field, message } })
const send = (res, err) => res.status(err.status).json(err.body)

const toId = (value) => (typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) ? Number(value) : null)

const normalizeName = (value) => {
  if (typeof value !== 'string') return null
  const name = value.trim().replace(/\s+/g, ' ')
  return name && name.length <= NAME_MAX ? name : null
}

const normalizeCode = (value) => {
  if (typeof value !== 'string') return null
  const code = value.trim().toLowerCase()
  return CODE_PATTERN.test(code) ? code : null
}

const snapshot = (row) => ({ id: row.id, code: row.code, name: row.name, status: row.status })

// Store and ACTIVE-membership counts for the given tenant ids, one grouped
// query each (no N+1).
const countsFor = async (tenantIds) => {
  const stores = new Map()
  const members = new Map()
  if (tenantIds.length === 0) return { stores, members }
  const [storeRows, memberRows] = await Promise.all([
    db.location.findAll({
      where: { tenantId: tenantIds },
      attributes: ['tenantId', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'count']],
      group: ['tenantId'],
      raw: true
    }),
    db.tenantMembership.findAll({
      where: { tenantId: tenantIds, status: 'ACTIVE' },
      attributes: ['tenantId', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'count']],
      group: ['tenantId'],
      raw: true
    })
  ])
  for (const r of storeRows) stores.set(Number(r.tenantId), Number(r.count))
  for (const r of memberRows) members.set(Number(r.tenantId), Number(r.count))
  return { stores, members }
}

const present = (row, counts) => ({
  ...snapshot(row),
  storeCount: counts.stores.get(row.id) || 0,
  activeMemberCount: counts.members.get(row.id) || 0,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
})

const audit = (req, { action, row, before, after, transaction }) =>
  recordAudit({
    actor: { id: req.user?.id, type: 'USER' },
    req,
    action,
    entity: 'tenant',
    entityId: row.id,
    description: `${action}: tenant ${row.code}`,
    tenantId: row.id,
    storeId: null,
    previousState: before,
    newState: after,
    result: 'SUCCESS',
    source: AUDIT_SOURCE,
    transaction
  })

exports.list = async (req, res) => {
  try {
    const q = req.query || {}
    const where = {}
    if (q.status !== undefined && q.status !== 'all') {
      if (!STATUSES.includes(q.status)) {
        return send(res, fail(400, 'INVALID_STATUS', 'status', `status must be one of ${STATUSES.join(', ')}`))
      }
      where.status = q.status
    }
    if (req.tenantAdministration?.all !== true) where.id = req.tenantAdministration?.tenantIds || []
    const search = typeof q.search === 'string' ? q.search.trim() : ''
    if (search) {
      const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
      where[Op.or] = [{ name: { [Op.iLike]: like } }, { code: { [Op.iLike]: like } }]
    }
    const paging = pageOf(q)
    const { rows, count } = await db.tenant.findAndCountAll({
      where,
      order: [['name', 'ASC'], ['id', 'ASC']],
      limit: paging.limit,
      offset: paging.offset
    })
    const counts = await countsFor(rows.map((r) => r.id))
    const { items, pagination } = paginated(
      rows.map((r) => present(r, counts)),
      paging,
      count
    )
    return res.status(200).json({ success: true, message: 'Success', data: items, pagination })
  } catch (err) {
    console.error('[tenant] list failed:', err)
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Internal Server Error' })
  }
}

// A tenant outside the caller's administration scope is indistinguishable
// from a nonexistent one.
const inScope = (req, id) => {
  const scope = req.tenantAdministration
  return scope?.all === true || (scope?.tenantIds || []).includes(id)
}

const findTenant = async (req, transaction) => {
  const id = toId(req.params.id)
  if (id == null || !inScope(req, id)) return { error: fail(404, 'RESOURCE_NOT_FOUND', 'id', 'tenant not found') }
  const row = await db.tenant.findByPk(id, transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {})
  if (!row) return { error: fail(404, 'RESOURCE_NOT_FOUND', 'id', 'tenant not found') }
  return { row }
}

exports.getById = async (req, res) => {
  try {
    const { row, error } = await findTenant(req)
    if (error) return send(res, error)
    const counts = await countsFor([row.id])
    return res.status(200).json({ success: true, message: 'Success', data: present(row, counts) })
  } catch (err) {
    console.error('[tenant] getById failed:', err)
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Internal Server Error' })
  }
}

exports.create = async (req, res) => {
  const body = req.body || {}
  const code = normalizeCode(body.code)
  if (code == null) {
    return send(
      res,
      fail(400, 'INVALID_CODE', 'code', 'code must be 1-50 lowercase letters, digits or inner hyphens')
    )
  }
  const name = normalizeName(body.name)
  if (name == null) {
    return send(res, fail(400, 'INVALID_NAME', 'name', `name is required (max ${NAME_MAX} characters)`))
  }
  try {
    const created = await db.sequelize.transaction(async (t) => {
      // Codes are never reused: a retired (soft-deleted) tenant still owns it.
      const taken = await db.tenant.findOne({ where: { code }, paranoid: false, transaction: t })
      if (taken) return null
      const row = await db.tenant.create({ code, name, status: 'active' }, { transaction: t })
      await audit(req, { action: 'create', row, before: null, after: snapshot(row), transaction: t })
      // A client's own super admin owns what it creates: without the
      // membership the new tenant would be invisible to it.
      if (req.tenantAdministration?.all !== true) {
        const membership = await db.tenantMembership.create(
          { userId: req.user.id, tenantId: row.id, role: 'tenant_admin', status: 'ACTIVE' },
          { transaction: t }
        )
        await recordAudit({
          actor: { id: req.user?.id, type: 'USER' },
          req,
          action: 'create',
          entity: 'membership',
          entityId: membership.id,
          description: `create: user ${req.user.id} (creator of tenant ${row.code})`,
          tenantId: row.id,
          storeId: null,
          previousState: null,
          newState: { userId: membership.userId, tenantId: row.id, role: membership.role, status: membership.status },
          result: 'SUCCESS',
          source: AUDIT_SOURCE,
          transaction: t
        })
      }
      return row
    })
    if (!created) return send(res, fail(409, 'TENANT_CODE_TAKEN', 'code', 'this tenant code is already used'))
    const counts = await countsFor([created.id])
    return res.status(201).json({ success: true, message: 'Tenant created', data: present(created, counts) })
  } catch (err) {
    // A concurrent create of the same code loses on the unique index.
    if (err?.name === 'SequelizeUniqueConstraintError') {
      return send(res, fail(409, 'TENANT_CODE_TAKEN', 'code', 'this tenant code is already used'))
    }
    console.error('[tenant] create failed:', err)
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Internal Server Error' })
  }
}

exports.update = async (req, res) => {
  const body = req.body || {}
  if (body.code !== undefined) {
    return send(res, fail(400, 'CODE_IMMUTABLE', 'code', 'a tenant code cannot be changed'))
  }
  const changes = {}
  if (body.name !== undefined) {
    const name = normalizeName(body.name)
    if (name == null) {
      return send(res, fail(400, 'INVALID_NAME', 'name', `name is required (max ${NAME_MAX} characters)`))
    }
    changes.name = name
  }
  if (body.status !== undefined) {
    if (req.tenantAdministration?.all !== true) {
      return send(res, fail(403, 'TENANT_STATUS_PLATFORM_ONLY', 'status', 'only the platform can suspend or resume a tenant'))
    }
    if (!STATUSES.includes(body.status)) {
      return send(res, fail(400, 'INVALID_STATUS', 'status', `status must be one of ${STATUSES.join(', ')}`))
    }
    changes.status = body.status
  }
  if (Object.keys(changes).length === 0) {
    return send(res, fail(400, 'INVALID_OPERATION', null, 'name or status is required'))
  }
  try {
    const result = await db.sequelize.transaction(async (t) => {
      const { row, error } = await findTenant(req, t)
      if (error) return { error }
      const before = snapshot(row)
      const effective = Object.fromEntries(Object.entries(changes).filter(([k, v]) => row[k] !== v))
      // Idempotent: the desired state already holds — no write, no audit.
      if (Object.keys(effective).length === 0) return { row }
      await row.update(effective, { transaction: t })
      await audit(req, { action: 'update', row, before, after: snapshot(row), transaction: t })
      return { row }
    })
    if (result.error) return send(res, result.error)
    const counts = await countsFor([result.row.id])
    return res.status(200).json({ success: true, message: 'Tenant updated', data: present(result.row, counts) })
  } catch (err) {
    console.error('[tenant] update failed:', err)
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Internal Server Error' })
  }
}

// Retire an EMPTY tenant: no stores and no ACTIVE member other than the
// caller. A tenant in use can only be suspended (platform). The row is soft-
// deleted (paranoid; its code stays reserved) and its remaining memberships
// are RETIRED, so nothing resolves through it any more.
exports.remove = async (req, res) => {
  try {
    const result = await db.sequelize.transaction(async (t) => {
      const { row, error } = await findTenant(req, t)
      if (error) return { error }
      const stores = await db.location.count({ where: { tenantId: row.id }, transaction: t })
      if (stores > 0) {
        return { error: fail(409, 'TENANT_HAS_STORES', 'id', `the tenant still has ${stores} store(s); move or delete them first`) }
      }
      const members = await db.tenantMembership.count({
        where: { tenantId: row.id, status: 'ACTIVE', userId: { [Op.ne]: req.user.id } },
        transaction: t
      })
      if (members > 0) {
        return { error: fail(409, 'TENANT_HAS_MEMBERS', 'id', `the tenant still has ${members} active member(s)`) }
      }
      const before = snapshot(row)
      await db.tenantMembership.update(
        { status: 'RETIRED' },
        { where: { tenantId: row.id, status: { [Op.ne]: 'RETIRED' } }, transaction: t }
      )
      // A session that selected this tenant would otherwise fail every
      // request with STALE_TENANT_CONTEXT: drop it back to no selection.
      await db.authorizationContextSession.update(
        { activeTenantId: null, activeStoreId: null, version: db.sequelize.literal('"version" + 1') },
        { where: { activeTenantId: row.id }, transaction: t }
      )
      await row.destroy({ transaction: t })
      await audit(req, { action: 'delete', row, before, after: null, transaction: t })
      return { row }
    })
    if (result.error) return send(res, result.error)
    return res.status(200).json({ success: true, message: 'Tenant deleted', data: snapshot(result.row) })
  } catch (err) {
    console.error('[tenant] delete failed:', err)
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Internal Server Error' })
  }
}
