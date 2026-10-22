'use strict'

const db = require('../db/models')
const authorization = require('./authorization')
const { resolveEffectiveMenuAccess, canMenuAction } = require('./effectiveMenuAccess')
const { MENU_WRITE_GATED_ROUTES } = require('../api/menuRouteMap')

// DR-24 C-02 wave 2: the Role Management checkboxes become a server-side
// boundary for back-office WRITES, with the client's exact rule
// (FE src/utils/pageAccess.js):
//   * POST → add, PUT/PATCH → edit, DELETE → delete; import/export/approve
//     paths ask for that action;
//   * an action the role matrix never offers for the menu can't be granted,
//     so it falls back to "any action of the menu" (as the FE does);
//   * reads stay open — the same lists feed the cashier, pickers in other
//     forms and dashboards; role/store gates keep governing them;
//   * only menu-controlled accounts are confined (own or role accessMenu);
//     a super_admin without its own menu and accounts with no menu at all
//     keep their existing gates unchanged.

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const actionFor = (method, path) => {
  if (/import|upload-excel/.test(path)) return 'import'
  if (/export/.test(path)) return 'export'
  if (/approve|reject/.test(path)) return 'approve'
  if (/status/.test(path)) return 'update-status'
  if (method === 'DELETE') return 'delete'
  if (method === 'POST' && !/archive|reactivate|start|complete|cancel|receive|send-to/.test(path)) {
    return 'add'
  }
  return 'edit'
}

const pathMatches = (pattern, path) => path === pattern || path.startsWith(`${pattern}/`)

const menuWriteGate = (file) => {
  const config = MENU_WRITE_GATED_ROUTES[file]
  if (!config) throw new Error(`menuWriteGate: ${file} is not in MENU_WRITE_GATED_ROUTES`)
  const { menu, aliases = [], offered, only = [], exclude = [] } = config
  const keys = [menu, ...aliases]

  const grants = (entries, action) => {
    const wanted = offered.includes(action) ? [action] : offered
    return keys.some((key) => wanted.some((a) => canMenuAction(entries, key, a)))
  }

  const check = async (req, res, next) => {
    try {
      const account = await db.user.findByPk(req.user.id, {
        attributes: ['id', 'accessMenu', 'roleId', 'roleType']
      })
      const { entries, scoped, bypass } = await resolveEffectiveMenuAccess(
        db,
        account || { ...req.user, accessMenu: [] }
      )
      if (bypass || !scoped) return next()
      const action = actionFor(req.method, req.path)
      if (grants(entries, action)) return next()
      return res.status(403).json({
        code: 'MENU_ACTION_DENIED',
        message: `Your role does not include "${action}" access on ${menu}`
      })
    } catch (error) {
      console.error('Menu write gate failed:', error)
      return res.status(500).json({ message: 'Internal Server Error' })
    }
  }

  return (req, res, next) => {
    if (!WRITE_METHODS.has(req.method)) return next()
    if (only.length > 0 && !only.some((p) => pathMatches(p, req.path))) return next()
    if (exclude.some((p) => pathMatches(p, req.path))) return next()
    // Mounted before the route's own `authorization`, which then re-reads
    // the same session (read-only) — identity comes first either way.
    if (!req.user) return authorization(req, res, () => check(req, res, next))
    return check(req, res, next)
  }
}

module.exports = { menuWriteGate, actionFor }
