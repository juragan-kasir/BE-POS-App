'use strict'

/**
 * T-03B read side for membership / assignment / effective-scope (D8).
 *
 * Visibility is decided from the viewer's server-resolved canonical context
 * (req.authContext) and persisted rows only:
 *
 *   platform  — platform capability (`user.manage`) with NO active tenant:
 *               any user, every tenant.
 *   tenant    — `user.manage` within the active tenant (tenant_admin, or a
 *               platform actor that selected a tenant): users with a
 *               membership row of any status in that tenant; only that
 *               tenant's data.
 *   store     — store_admin in its active tenant: same-tenant members whose
 *               persisted role is strictly below store_admin; assignments
 *               only at the viewer's assigned stores.
 *   self      — everyone else (cashier, staff, no context): self only.
 *
 * A single keyed query decides whether a target is visible, so an invisible
 * target and a nonexistent one cost the same query and yield the same 404.
 * Effective assignments come from the canonical resolver; no authorization
 * logic is re-derived here. Responses are DTOs — never raw resolver output.
 *
 * L2 boundary: this is canonical-scope data. Legacy routes still authorize
 * from the account's roleType/store; membership state shown here does not
 * describe legacy-route access.
 */

const db = require('../../db/models')
const { can, resolveAuthorizationContext } = require('../../utils/authContext')
const { rolesBelow } = require('./membershipAssignmentService')

const { Op } = db.Sequelize

const STORE_VISIBLE_ROLES = rolesBelow('store_admin')

const viewerOf = (ctx) => {
  if (!ctx || ctx.eligible !== true) return { kind: 'self' }
  const permissions = ctx.permissions || []
  if (ctx.isPlatformAdmin && ctx.activeTenantId == null && permissions.includes('user.manage')) {
    return { kind: 'platform' }
  }
  if (ctx.activeTenantId != null && can(ctx, 'user.manage', { tenantId: ctx.activeTenantId })) {
    return { kind: 'tenant', tenantId: Number(ctx.activeTenantId) }
  }
  if (ctx.activeTenantId != null && (ctx.activeRole === 'store_admin' || ctx.activeRole === 'admin')) {
    const tenantStores = (ctx.tenantStoreIds || []).map(Number)
    const storeIds = (ctx.assignedStoreIds || []).map(Number).filter((id) => tenantStores.includes(id))
    return { kind: 'store', tenantId: Number(ctx.activeTenantId), storeIds }
  }
  return { kind: 'self' }
}

// Membership rows a viewer may read (self rows are always included).
const membershipScopeWhere = (viewer, selfId) => {
  if (viewer.kind === 'platform') return {}
  if (viewer.kind === 'tenant') return { tenantId: viewer.tenantId }
  if (viewer.kind === 'store') {
    return { tenantId: viewer.tenantId, [Op.or]: [{ role: STORE_VISIBLE_ROLES }, { userId: selfId }] }
  }
  return { userId: selfId }
}

const membershipDto = (row) => ({
  id: row.id,
  userId: row.userId,
  tenantId: row.tenantId,
  role: row.role,
  status: row.status
})

const assignmentDto = (row) => ({
  id: row.id,
  userId: row.userId,
  tenantId: row.tenantId,
  storeId: row.storeId
})

// Pagination contract for GET /memberships and GET /assignments:
//   page  — positive integer, default 1 (anything else → 1)
//   limit — positive integer, default 20, capped at 100 (anything else → 20)
// Result: { items, pagination: { page, limit, total, totalPages } } with
// totalPages = ceil(total / limit) (0 when there are no rows).
const DEFAULT_PAGE_LIMIT = 20
const MAX_PAGE_LIMIT = 100

const page = ({ page: p, limit: l }) => {
  const toPositive = (value, fallback) => {
    const n = Number(value)
    return Number.isInteger(n) && n > 0 ? n : fallback
  }
  const pageNo = toPositive(p, 1)
  const limit = Math.min(toPositive(l, DEFAULT_PAGE_LIMIT), MAX_PAGE_LIMIT)
  return { pageNo, limit, offset: (pageNo - 1) * limit }
}

const paginated = (items, { pageNo, limit }, total) => ({
  items,
  pagination: { page: pageNo, limit, total, totalPages: Math.ceil(total / limit) }
})

// Optional list filters. An unparseable filter matches nothing rather than
// being ignored (a filter must never widen a result).
const filterId = (value) => {
  if (value === undefined) return undefined
  const n = Number(value)
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(n) ? n : -1
}

const listMemberships = async (viewer, selfId, query) => {
  const paging = page(query)
  const { limit, offset } = paging
  const filters = {}
  for (const key of ['userId', 'tenantId']) {
    const id = filterId(query[key])
    if (id !== undefined) filters[key] = id
  }
  const { rows, count } = await db.tenantMembership.findAndCountAll({
    where: { [Op.and]: [membershipScopeWhere(viewer, selfId), filters] },
    attributes: ['id', 'userId', 'tenantId', 'role', 'status'],
    order: [['id', 'ASC']],
    limit,
    offset
  })
  return paginated(rows.map(membershipDto), paging, count)
}

// Single keyed query: the membership row by id within the viewer's scope.
const findVisibleMembership = (viewer, selfId, id) =>
  db.tenantMembership.findOne({
    where: { [Op.and]: [{ id }, membershipScopeWhere(viewer, selfId)] },
    attributes: ['id', 'userId', 'tenantId', 'role', 'status']
  })

const assignmentScopeWhere = async (viewer, selfId) => {
  if (viewer.kind === 'platform') return {}
  if (viewer.kind === 'tenant') return { tenantId: viewer.tenantId }
  if (viewer.kind === 'store') {
    const members = await db.tenantMembership.findAll({
      where: { tenantId: viewer.tenantId, role: STORE_VISIBLE_ROLES },
      attributes: ['userId']
    })
    const userIds = [...new Set([selfId, ...members.map((m) => Number(m.userId))])]
    return { tenantId: viewer.tenantId, storeId: viewer.storeIds, userId: userIds }
  }
  return { userId: selfId }
}

const listAssignments = async (viewer, selfId, query) => {
  const paging = page(query)
  const { limit, offset } = paging
  const filters = {}
  for (const key of ['userId', 'storeId', 'tenantId']) {
    const id = filterId(query[key])
    if (id !== undefined) filters[key] = id
  }
  const { rows, count } = await db.storeAssignment.findAndCountAll({
    where: { [Op.and]: [await assignmentScopeWhere(viewer, selfId), filters] },
    attributes: ['id', 'userId', 'tenantId', 'storeId'],
    order: [['id', 'ASC']],
    limit,
    offset
  })
  return paginated(rows.map(assignmentDto), paging, count)
}

// D8 target lookup — ONE keyed query per viewer kind, no user-first lookup:
//   platform:       user by id
//   tenant / store: membership by (userId, viewer tenant) [+ role below
//                   store_admin] joined to its user
// Returns { user, membership } or null (invisible and nonexistent alike).
const findVisibleTarget = async (viewer, targetUserId) => {
  if (viewer.kind === 'platform') {
    const user = await db.user.findByPk(targetUserId, { attributes: ['id', 'userName'] })
    return user ? { user, membership: null } : null
  }
  if (viewer.kind === 'tenant' || viewer.kind === 'store') {
    const where = { userId: targetUserId, tenantId: viewer.tenantId }
    if (viewer.kind === 'store') where.role = STORE_VISIBLE_ROLES
    const membership = await db.tenantMembership.findOne({
      where,
      attributes: ['id', 'userId', 'tenantId', 'role', 'status'],
      include: [{ model: db.user, as: 'user', attributes: ['id', 'userName'], required: true }]
    })
    return membership ? { user: membership.user, membership } : null
  }
  return null
}

// Recorded assignments with an `effective` flag taken from the canonical
// resolver for that tenant (the session's authentication instant applies to
// self views, so the flag reflects what THIS session can use).
const withEffective = async (userId, rows, authenticatedAt) => {
  const effectiveByTenant = new Map()
  for (const tenantId of [...new Set(rows.map((r) => Number(r.tenantId)))]) {
    const ctx = await resolveAuthorizationContext(db, { userId, activeTenantId: tenantId, authenticatedAt })
    effectiveByTenant.set(tenantId, new Set((ctx.assignedStoreIds || []).map(Number)))
  }
  return rows.map((r) => ({
    tenantId: Number(r.tenantId),
    storeId: Number(r.storeId),
    effective: effectiveByTenant.get(Number(r.tenantId)).has(Number(r.storeId))
  }))
}

const scopeMembershipDto = (row) => ({ tenantId: Number(row.tenantId), role: row.role, status: row.status })

const loadMemberships = (userId) =>
  db.tenantMembership.findAll({
    where: { userId },
    attributes: ['tenantId', 'role', 'status'],
    order: [['tenantId', 'ASC']]
  })

const loadAssignments = (where) =>
  db.storeAssignment.findAll({
    where,
    attributes: ['tenantId', 'storeId'],
    order: [['tenantId', 'ASC'], ['storeId', 'ASC']]
  })

// Self: every own membership (any status), every own recorded assignment with
// its effective flag for this session, and the session's active context.
const buildSelfScope = async ({ user, ctx, session }) => {
  const [memberships, assignments] = await Promise.all([
    loadMemberships(user.id),
    loadAssignments({ userId: user.id })
  ])
  return {
    user: { id: user.id, userName: user.userName },
    memberships: memberships.map(scopeMembershipDto),
    assignments: await withEffective(user.id, assignments, session?.createdAt),
    context: {
      activeTenantId: ctx?.activeTenantId ?? null,
      activeStoreId: ctx?.activeStoreId ?? null,
      role: ctx?.activeRole ?? null,
      permissions: [...(ctx?.permissions || [])]
    }
  }
}

// Visible target: data filtered to the viewer's scope; no `context`.
const buildTargetScope = async (viewer, { user, membership }) => {
  const userId = Number(user.id)
  let memberships
  let assignmentWhere
  if (viewer.kind === 'platform') {
    memberships = (await loadMemberships(userId)).map(scopeMembershipDto)
    assignmentWhere = { userId }
  } else if (viewer.kind === 'tenant') {
    memberships = [scopeMembershipDto(membership)]
    assignmentWhere = { userId, tenantId: viewer.tenantId }
  } else {
    memberships = [scopeMembershipDto(membership)]
    assignmentWhere = { userId, tenantId: viewer.tenantId, storeId: viewer.storeIds }
  }
  const assignments = await withEffective(userId, await loadAssignments(assignmentWhere))
  return { user: { id: userId, userName: user.userName }, memberships, assignments }
}

module.exports = {
  viewerOf,
  listMemberships,
  findVisibleMembership,
  listAssignments,
  findVisibleTarget,
  buildSelfScope,
  buildTargetScope,
  // Canonical list pagination contract, shared with the W3 store reads.
  page,
  paginated
}
