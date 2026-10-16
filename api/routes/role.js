const express = require('express')
const router = express.Router()

const roleController = require('../controller/role')
const authorization = require('../../utils/authorization')
const { requireRole } = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { validate } = require('../middleware/validate')
const { createRoleSchema, updateRoleSchema } = require('../validation/schemas')
const { resolveAuthorizationContext } = require('../../utils/authContext')
const db = require('../../db/models')

// D5 (DR-12 §35.4 Q11/Q14): besides the legacy roleType gate, a canonical
// tenant_admin holding `role.manage` in its active tenant manages that
// tenant's store roles. The controller confines it via req.roleManagerTenant.
// A legacy super_admin keeps the legacy path unchanged.
const roleManagerGate = (...legacyRoles) => async (req, res, next) => {
  try {
    if (req.user?.roleType !== 'super_admin') {
      const session = req.authSession
      const ctx = await resolveAuthorizationContext(db, {
        userId: req.user?.id,
        activeTenantId: session?.activeTenantId,
        activeStoreId: session?.activeStoreId,
        authenticatedAt: session?.createdAt
      })
      if (
        ctx?.eligible === true &&
        ctx.activeRole === 'tenant_admin' &&
        ctx.activeTenantId != null &&
        ctx.permissions.includes('role.manage')
      ) {
        req.authContext = ctx
        req.roleManagerTenant = {
          tenantId: ctx.activeTenantId,
          storeIds: ctx.tenantStoreIds.map(Number)
        }
        return next()
      }
    }
    return requireRole(...legacyRoles)(req, res, next)
  } catch {
    return res
      .status(500)
      .json({ message: 'Internal Server Error', code: 'AUTHORIZATION_ERROR' })
  }
}

// Get All role — R-03: signed-in managers only, scoped to the caller
// (global + own-store roles; super_admin roles only for super_admin).
router.get(
  '/get-role',
  authorization,
  roleManagerGate('super_admin', 'admin'),
  roleController.getAllRole
)

// Get All List To Table (Super Admin, or a tenant admin in its tenant)
router.get(
  '/get-role-all',
  authorization,
  roleManagerGate('super_admin'),
  roleController.getAllRoleInTable
)

// Add role (Super Admin, or a tenant admin in its tenant)
router.post(
  '/add-new-role',
  authorization,
  roleManagerGate('super_admin'),
  validate(createRoleSchema),
  roleController.addNewRole
)

// Edit role (Super Admin, or a tenant admin in its tenant)
router.put(
  '/edit-role/:id',
  authorization,
  roleManagerGate('super_admin'),
  validate(updateRoleSchema),
  roleController.editRoleById
)

// Delete role (Super Admin, or a tenant admin in its tenant)
router.delete(
  '/delete-role/:id',
  authorization,
  roleManagerGate('super_admin'),
  roleController.deleteRoleById
)

// Get Role by ID — R-04: same audience and scope as /get-role; a role
// outside the caller's scope is 404.
router.get(
  '/get-role-by-id/:id',
  authorization,
  roleManagerGate('super_admin', 'admin'),
  roleController.getRoleById
)

// Update User Role (Super Admin, or a tenant admin in its tenant)
router.put(
  '/update-user-role',
  authorization,
  roleManagerGate('super_admin'),
  roleController.updateUserRole
)

// Get Users by Role (Super Admin / Admin) — P0-1: a user-management read.
// validateStoreAccess pins an admin to the token's store and rejects foreign
// or unassigned scopes before the controller narrows by store.
router.get(
  '/get-users-by-role',
  authorization,
  validateStoreAccess,
  requireRole('super_admin', 'admin'),
  roleController.getUsersByRole
)

// Update Access Menu for Role (Super Admin, or a tenant admin in its tenant)
router.put(
  '/update-access-menu',
  authorization,
  roleManagerGate('super_admin'),
  roleController.updateRoleAccessMenu
)

module.exports = router
