'use strict'

const db = require('../db/models')
const {
  resolveEffectiveMenuAccess,
  canMenuAction
} = require('./effectiveMenuAccess')

// DR-24 C-02: server-side enforcement of the role accessMenu for route
// modules classified as menu-enforced (api/menuRouteMap.js).
//
// Semantics (mirrors the client exactly, see utils/effectiveMenuAccess.js):
//   * super_admin without an own menu bypasses (platform operator);
//   * any account WITH an effective menu is confined to it — the request is
//     denied 403 MENU_ACTION_DENIED unless the menu grants the action;
//   * accounts with NO effective menu (legacy accounts/roles that never had
//     a menu definition) keep the pre-existing role/capability gates — the
//     staged rollout never widens or silently breaks them.
//
// The account row is re-read here because `req.user` (utils/authorization)
// intentionally carries only identity/scope; menu data is authorization data
// owned by the DB row.
const requireMenuAction = (menuKey, action) => async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' })
    }
    const account = await db.user.findByPk(req.user.id, {
      attributes: ['id', 'accessMenu', 'roleId', 'roleType']
    })
    const { entries, scoped, bypass } = await resolveEffectiveMenuAccess(
      db,
      account || { ...req.user, accessMenu: [] }
    )
    if (bypass) return next()
    if (!scoped) return next()
    if (canMenuAction(entries, menuKey, action)) return next()
    return res.status(403).json({
      code: 'MENU_ACTION_DENIED',
      message: `Your role does not include "${action}" access on ${menuKey}`
    })
  } catch (error) {
    console.error('Menu access check failed:', error)
    return res.status(500).json({ message: 'Internal Server Error' })
  }
}

module.exports = { requireMenuAction }
