'use strict'

const { canonicalRoleOf } = require('../../utils/ownerRoles')
const { recordAudit } = require('../../utils/auditLog')

const fail = (code, field, message) => Object.assign(new Error(message), { code, field })

const createTenantWithOwner = async (
  db,
  { userId, code, name, businessType = 'fnb', req = null, source = 'owner-onboarding', sessionId = null }
) => {
  if (!Number.isInteger(Number(userId)) || Number(userId) <= 0) {
    throw fail('INVALID_OWNER', 'userId', 'userId must reference an existing user')
  }
  return db.sequelize.transaction(async (transaction) => {
    const taken = await db.tenant.findOne({ where: { code }, paranoid: false, transaction })
    if (taken) throw fail('TENANT_CODE_TAKEN', 'code', 'this tenant code is already used')

    const tenant = await db.tenant.create(
      { code, name, businessType, ownerId: userId, status: 'active' },
      { transaction }
    )
    const membership = await db.tenantMembership.create(
      { userId, tenantId: tenant.id, role: 'owner', status: 'ACTIVE' },
      { transaction }
    )

    // Spec onboarding step 4: select the new tenant on this session in the
    // same transaction. The membership above is committed atomically with it.
    if (sessionId) {
      await db.authorizationContextSession.update(
        {
          activeTenantId: tenant.id,
          activeStoreId: null,
          version: db.sequelize.literal('"version" + 1')
        },
        { where: { sessionId, userId }, transaction }
      )
    }

    await recordAudit({
      actor: { id: userId, type: 'USER' },
      req,
      action: 'create',
      entity: 'tenant',
      entityId: tenant.id,
      description: `create: tenant ${tenant.code} by owner ${userId}`,
      tenantId: tenant.id,
      storeId: null,
      previousState: null,
      newState: { code: tenant.code, name: tenant.name, businessType, ownerId: userId },
      result: 'SUCCESS',
      source,
      transaction
    })

    return { tenant, membership }
  })
}

const assertOwnerConsistency = async (db, tenantId, { transaction } = {}) => {
  const tenant = await db.tenant.findByPk(tenantId, { transaction })
  if (!tenant) throw fail('RESOURCE_NOT_FOUND', 'id', 'tenant not found')

  const memberships = await db.tenantMembership.findAll({ where: { tenantId }, transaction })
  const activeOwners = memberships.filter(
    (m) => m.status === 'ACTIVE' && canonicalRoleOf(m.role) === 'owner'
  )

  if (activeOwners.length !== 1) {
    throw fail(
      'OWNER_INVARIANT',
      'ownerId',
      `tenant must have exactly one active owner (found ${activeOwners.length})`
    )
  }
  if (Number(activeOwners[0].userId) !== Number(tenant.ownerId)) {
    throw fail('OWNER_INVARIANT', 'ownerId', 'tenant.ownerId does not match the active owner membership')
  }
  return { tenant, owner: activeOwners[0] }
}

const transferTenantOwnership = async (
  db,
  { tenantId, fromUserId, toUserId, req = null, source = 'owner-transfer' }
) => {
  return db.sequelize.transaction(async (transaction) => {
    const tenant = await db.tenant.findByPk(tenantId, { transaction, lock: transaction.LOCK.UPDATE })
    if (!tenant) throw fail('RESOURCE_NOT_FOUND', 'id', 'tenant not found')
    if (Number(tenant.ownerId) !== Number(fromUserId)) {
      throw fail('FORBIDDEN', 'fromUserId', 'only the current owner may transfer ownership')
    }

    const next = await db.tenantMembership.findOne({
      where: { tenantId, userId: toUserId },
      transaction,
      lock: transaction.LOCK.UPDATE
    })
    if (!next) throw fail('RESOURCE_NOT_FOUND', 'toUserId', 'target user is not a tenant member')
    // A deactivated/retired member is never silently re-activated as owner:
    // reactivation is its own audited lifecycle step (BE audit P1-6).
    if (next.status !== 'ACTIVE') throw fail('TARGET_NOT_ACTIVE', 'toUserId', 'target membership is not active')

    const current = await db.tenantMembership.findOne({
      where: { tenantId, userId: fromUserId, status: 'ACTIVE' },
      transaction,
      lock: transaction.LOCK.UPDATE
    })
    if (!current) throw fail('OWNER_INVARIANT', 'fromUserId', 'current owner membership is not active')

    await current.update({ role: 'admin' }, { transaction })
    await next.update({ role: 'owner' }, { transaction })
    await tenant.update({ ownerId: toUserId }, { transaction })

    await recordAudit({
      actor: { id: fromUserId, type: 'USER' },
      req,
      action: 'update',
      entity: 'tenant',
      entityId: tenant.id,
      description: `transfer ownership: tenant ${tenant.code} ${fromUserId} -> ${toUserId}`,
      tenantId: tenant.id,
      storeId: null,
      previousState: { ownerId: fromUserId },
      newState: { ownerId: toUserId },
      result: 'SUCCESS',
      source,
      transaction
    })

    return { tenant, owner: next }
  })
}

module.exports = {
  createTenantWithOwner,
  assertOwnerConsistency,
  transferTenantOwnership
}