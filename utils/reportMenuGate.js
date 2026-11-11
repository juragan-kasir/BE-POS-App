'use strict'

const db = require('../db/models')
const { resolveEffectiveMenuAccess, canMenuAction } = require('./effectiveMenuAccess')

// Report data and exports carry cost, margin and per-cashier figures. A role
// confined to a menu (e.g. a kasir) may read a report only when one of the
// screens that shows it is in that menu. The lists follow the FE pages that
// call each key: the dedicated report page, the sales report tabs and
// Advanced Reporting. Accounts without a menu keep their existing access,
// exactly like requireMenuAction.
const REPORT_MENUS = Object.freeze({
  daily: ['/report/daily', '/advanced-reporting'],
  sales: ['/report/sales', '/advanced-reporting'],
  cashFlow: ['/report/cash-flow', '/advanced-reporting'],
  profitPerProduct: ['/report/daily', '/report/sales', '/advanced-reporting'],
  bestSeller: ['/best-selling', '/report/sales', '/advanced-reporting'],
  productSales: ['/report/sales', '/advanced-reporting'],
  categorySales: ['/report/sales', '/advanced-reporting'],
  kasirPerformance: ['/report/sales', '/advanced-reporting']
})

const requireReportMenu = async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ message: 'Unauthorized' })
    const menus = REPORT_MENUS[req.params.key]
    if (!menus) return next()
    const account = await db.user.findByPk(req.user.id, {
      attributes: ['id', 'accessMenu', 'roleId', 'roleType']
    })
    const { entries, scoped, bypass } = await resolveEffectiveMenuAccess(
      db,
      account || { ...req.user, accessMenu: [] }
    )
    if (bypass || !scoped) return next()
    if (menus.some((menu) => canMenuAction(entries, menu, 'view'))) return next()
    return res.status(403).json({
      code: 'MENU_ACTION_DENIED',
      message: `Your role does not include "view" access on ${menus[0]}`
    })
  } catch (error) {
    console.error('Report menu check failed:', error)
    return res.status(500).json({ message: 'Internal Server Error' })
  }
}

module.exports = { requireReportMenu, REPORT_MENUS }
