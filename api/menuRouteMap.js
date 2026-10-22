'use strict'

// DR-24 C-02: central classification of every API route file against the
// menu-permission model. Nothing else decides where `requireMenuAction` is
// applied — this registry is the single source of truth and the coverage
// suite (__tests__/menu-route-coverage.test.js) fails whenever a route file
// is added or removed without being classified here.
//
// Buckets:
//   MENU_ENFORCED_ROUTES      — every route in the file carries
//                               requireMenuAction(menu, action) in addition to
//                               its existing gates.
//   ALLOWLISTED_ROUTE_FILES   — not a user-menu surface; each entry states
//                               the gate that owns admission instead.
//   MENU_WRITE_GATED_ROUTES   — writes carry router.use(menuWriteGate(file))
//                               (wave 2, utils/menuWriteGate.js).
//   GATED_LEGACY_ROUTE_FILES  — staged rollout (DR-24 C-02): the file keeps
//                               its existing role/capability/store gates and
//                               is scheduled for menu enforcement in a later
//                               wave; listed explicitly so drift is visible.

const MENU_ENFORCED_ROUTES = Object.freeze({})

// Wave 2: back-office modules whose WRITES follow the Role Management
// checkboxes (utils/menuWriteGate.js; reads stay open). `menu` is the role
// matrix href and `offered` the actions the matrix offers for it — keep both
// in sync with FE src/page/role/rolePermissions.js (sidebarMenuSuperAdmin).
// `aliases` are legacy menu keys that grant the same; `only`/`exclude` list
// path prefixes (relative to the router) the gate applies to / skips —
// cashier and system flows stay out.
const ALL6 = Object.freeze(['add', 'edit', 'view', 'delete', 'import', 'export'])
const CRUD = Object.freeze(['add', 'edit', 'view', 'delete'])
const gate = (menu, offered, extra = {}) => Object.freeze({ menu, offered, ...extra })

const MENU_WRITE_GATED_ROUTES = Object.freeze({
  'accounting.js': gate('/accounting', ['view']),
  'bom.js': gate('/bom', ['add', 'view', 'delete']),
  'category.js': gate('/category-list', ALL6),
  'delivery.js': gate('/driver-list', CRUD, { only: ['/drivers'] }),
  'discount.js': gate('/discount-list', CRUD),
  'expense.js': gate('/expense', ['add', 'edit', 'view', 'approve']),
  'expenseCategory.js': gate('/expense-category', CRUD),
  'goodsReceipt.js': gate('/goods-receipt', ['add', 'view', 'delete']),
  'goodsRequest.js': gate('/goods-request', CRUD),
  'ingredient.js': gate('/ingredient', CRUD),
  'ingredientCategory.js': gate('/ingredient-category', ALL6),
  'location.js': gate('/location-list', ALL6, { exclude: ['/store-configuration'] }),
  'product.js': gate('/product-list', ALL6),
  'productBundle.js': gate('/bundle', CRUD),
  'productionOrder.js': gate('/production-order', CRUD),
  'promo.js': gate('/promo-list', CRUD, { exclude: ['/apply', '/usage', '/auto-activate'] }),
  'purchaseOrder.js': gate('/purchase-order', ['add', 'edit', 'view']),
  'purchasePayment.js': gate('/purchase-payment', ['view']),
  'purchaseReturn.js': gate('/purchase-return', ['view']),
  'reportConfig.js': gate('/report/settings', ['view']),
  'reservation.js': gate('/reservation', CRUD),
  'role.js': gate('/role-management', ALL6, { exclude: ['/update-user-role'] }),
  'stockOpname.js': gate('/stock-opname', ['add', 'view']),
  'supplier.js': gate('/supplier', ALL6),
  'supplierBankAccount.js': gate('/supplier', ALL6),
  'supplierCategory.js': gate('/supplier-category', CRUD),
  'supplierContact.js': gate('/supplier', ALL6),
  'table.js': gate('/table-list', [...CRUD, 'update-status'], { aliases: ['/table'] }),
  'taxConfig.js': gate('/tax-list', CRUD),
  'type-payment.js': gate('/type-payment-list', CRUD)
})

const ALLOWLISTED_ROUTE_FILES = Object.freeze({
  'internal.js':
    'External scheduler surface, not a user menu; fail-closed CRON_SECRET (Bearer) gate.',
  'auth.js':
    'Public authentication + account self-service; the authorization/session layer owns admission.'
})

const GATED_LEGACY_ROUTE_FILES = Object.freeze([
  'accountsReceivable.js',
  'assignment.js',
  'assistant.js',
  'attendance.js',
  'auditLog.js',
  'authorizationContext.js',
  'backup.js',
  'best-selling.js',
  'businessTrip.js',
  'cashRegister.js',
  'currency.js',
  'department.js',
  'effectiveScope.js',
  'employee.js',
  'exportMaster.js',
  'faq.js',
  'inventory.js',
  'invoice.js',
  'member.js',
  'memberTier.js',
  'membership.js',
  'notification.js',
  'order.js',
  'overtime.js',
  'overview.js',
  'parkedCart.js',
  'pos.js',
  'position.js',
  'queue.js',
  'receipt.js',
  'region.js',
  'report.js',
  'reportExport.js',
  'reporting.js',
  'salesReturn.js',
  'shift.js',
  'shiftSwap.js',
  'shiftTemplate.js',
  'social-media.js',
  'splitBill.js',
  'stockHistory.js',
  'supplierPerformance.js',
  'tenant.js',
  'thermalPrinter.js',
  'waiter-request.js'
])

module.exports = {
  MENU_ENFORCED_ROUTES,
  MENU_WRITE_GATED_ROUTES,
  ALLOWLISTED_ROUTE_FILES,
  GATED_LEGACY_ROUTE_FILES
}
