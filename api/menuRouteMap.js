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
//   GATED_LEGACY_ROUTE_FILES  — staged rollout (DR-24 C-02): the file keeps
//                               its existing role/capability/store gates and
//                               is scheduled for menu enforcement in a later
//                               wave; listed explicitly so drift is visible.

const MENU_ENFORCED_ROUTES = Object.freeze({
  'table.js': Object.freeze({
    menus: ['/table'],
    note: 'Reference module: view/add/edit/delete actions mirror the /table menu.'
  })
})

const ALLOWLISTED_ROUTE_FILES = Object.freeze({
  'internal.js':
    'External scheduler surface, not a user menu; fail-closed CRON_SECRET (Bearer) gate.',
  'auth.js':
    'Public authentication + account self-service; the authorization/session layer owns admission.'
})

const GATED_LEGACY_ROUTE_FILES = Object.freeze([
  'accounting.js',
  'accountsReceivable.js',
  'assignment.js',
  'attendance.js',
  'auditLog.js',
  'authorizationContext.js',
  'backup.js',
  'best-selling.js',
  'bom.js',
  'businessTrip.js',
  'cashRegister.js',
  'category.js',
  'currency.js',
  'delivery.js',
  'department.js',
  'discount.js',
  'effectiveScope.js',
  'employee.js',
  'expense.js',
  'expenseCategory.js',
  'exportMaster.js',
  'faq.js',
  'goodsReceipt.js',
  'goodsRequest.js',
  'ingredient.js',
  'ingredientCategory.js',
  'inventory.js',
  'invoice.js',
  'location.js',
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
  'product.js',
  'productBundle.js',
  'productionOrder.js',
  'promo.js',
  'purchaseOrder.js',
  'purchasePayment.js',
  'purchaseReturn.js',
  'queue.js',
  'receipt.js',
  'region.js',
  'report.js',
  'reportConfig.js',
  'reportExport.js',
  'reporting.js',
  'reservation.js',
  'role.js',
  'salesReturn.js',
  'shift.js',
  'shiftSwap.js',
  'shiftTemplate.js',
  'social-media.js',
  'splitBill.js',
  'stockHistory.js',
  'stockOpname.js',
  'supplier.js',
  'supplierBankAccount.js',
  'supplierCategory.js',
  'supplierContact.js',
  'supplierPerformance.js',
  'taxConfig.js',
  'tenant.js',
  'thermalPrinter.js',
  'type-payment.js',
  'waiter-request.js'
])

module.exports = {
  MENU_ENFORCED_ROUTES,
  ALLOWLISTED_ROUTE_FILES,
  GATED_LEGACY_ROUTE_FILES
}
