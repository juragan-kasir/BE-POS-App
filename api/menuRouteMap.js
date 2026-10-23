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
//                               (waves 2–3, utils/menuWriteGate.js). An entry
//                               is one gate, or an array of gates each
//                               confined to its own `only` path prefixes.
//   GATED_LEGACY_ROUTE_FILES  — staged rollout (DR-24 C-02). Empty since wave
//                               3 (FG-SEC-01): every file is either
//                               write-gated or allowlisted with its owner gate.

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
  'type-payment.js': gate('/type-payment-list', CRUD),

  // Wave 3 (FG-SEC-01): the remaining back-office writes. Cashier, floor and
  // self-service paths stay out (they are allowlisted below or not listed in
  // `only`) — a cashier role's menu does not carry these back-office keys.
  'accountsReceivable.js': gate('/accounts-receivable', ['view']),
  'backup.js': gate('/backup', ['view']),
  'businessTrip.js': gate('/business-trip', CRUD),
  'cashRegister.js': gate('/cash-register/current', ['view', 'add']),
  'department.js': gate('/department-list', CRUD),
  'employee.js': gate('/employee-list', CRUD),
  'inventory.js': gate('/stock-adjustment', ['add'], { only: ['/batch', '/reconcile'] }),
  'invoice.js': gate('/invoice-page', ['add', 'edit', 'view']),
  'member.js': gate('/member-list', CRUD),
  'memberTier.js': gate('/member-tier', CRUD),
  'pos.js': Object.freeze([
    gate('/stock-adjustment', ['add'], { only: ['/adjust'] }),
    gate('/stock-transfer', ['view', 'add', 'delete'], { only: ['/transfer'] }),
    gate('/price-list-template', ['view', 'edit'], { only: ['/product/update-price-by-store'] }),
    gate('/purchase-return', ['view'], { only: ['/purchase-order'] }),
    gate('/goods-receipt', ['add', 'view', 'delete'], { only: ['/product/add-batch'] })
  ]),
  'position.js': gate('/position-list', CRUD),
  'salesReturn.js': gate('/sales-return', ['view']),
  'shift.js': gate('/shift-list', CRUD),
  'shiftTemplate.js': gate('/shift-template-list', CRUD),
  'social-media.js': gate('/invoice-page', ['add', 'edit', 'view']),
  'stockHistory.js': gate('/low-stock', ['view']),
  'supplierPerformance.js': gate('/supplier-score-list', ['view', 'add'])
})

const ALLOWLISTED_ROUTE_FILES = Object.freeze({
  'internal.js':
    'External scheduler surface, not a user menu; fail-closed CRON_SECRET (Bearer) gate.',
  'auth.js':
    'Public authentication + account self-service; the authorization/session layer owns admission.',
  // Canonical-permission surfaces (authorizationContextMiddleware + scope).
  'assignment.js': 'Store assignments; every mutation is re-authorized from the canonical context in the T-03A service.',
  'authorizationContext.js': 'Session context selection for the caller itself; authorization owns admission.',
  'effectiveScope.js': 'Read-only effective scope of the caller.',
  'membership.js': 'Tenant memberships; every mutation is re-authorized from the canonical context in the T-03A service.',
  'tenant.js': 'Tenant administration; requireTenantAdministration (platform or own tenant_admin).',
  'assistant.js': 'Service secret (ASSISTANT_SERVICE_SECRET) or canonical store.manage for the owner link.',
  'auditLog.js': 'Read-only; canonical audit.read scope (requireAuditRead).',
  // Cashier / floor flows: money actions use DR-23 capabilities; the cashier
  // role menu does not carry back-office keys, so a menu gate would break them.
  'order.js': 'Counter/QR orders; payment.collect / order.cancel / order.void capabilities; public QR create is rate-limited.',
  'splitBill.js': 'Split bills; split.manage / payment.collect capabilities.',
  'parkedCart.js': 'Cashier parked carts; store-scoped, any authenticated cashier.',
  'receipt.js': 'Read-only receipt for a store-scoped order.',
  'queue.js': 'Floor queue; requireRole(super_admin, admin, kasir) — cashier menus carry no /queue-list.',
  'waiter-request.js': 'Diner waiter call (public, rate-limited) + floor status by requireRole(super_admin, admin, kasir).',
  'thermalPrinter.js': 'Receipt print for the cashier; configure is super_admin only; router-level authorization + store access.',
  'notification.js': "The caller's own notifications (mark read).",
  // Self-service HR with role-gated approvals.
  'attendance.js': "The caller's own clock-in/out.",
  'overtime.js': 'Own overtime requests; approval/payroll by requireRole(super_admin, admin).',
  'shiftSwap.js': 'Own swap requests; approval by requireRole(super_admin, admin).',
  // Read-only / reporting surfaces (no writes).
  'best-selling.js': 'Read-only reporting.',
  'exportMaster.js': 'Read-only Excel export.',
  'overview.js': 'Read-only dashboard.',
  'region.js': 'Read-only Indonesian region reference data.',
  'report.js': 'Read-only reporting.',
  'reportExport.js': 'Read-only report data/export; audited (REPORT_EXPORT).',
  'reporting.js': 'Read-only platform rollup.',
  'faq.js': 'Public FAQ + rate-limited AI ask; no business data written.',
  'currency.js': 'No UI caller; requireRole(super_admin, admin); scheduled for removal by DR-27.'
})

const GATED_LEGACY_ROUTE_FILES = Object.freeze([])

module.exports = {
  MENU_ENFORCED_ROUTES,
  MENU_WRITE_GATED_ROUTES,
  ALLOWLISTED_ROUTE_FILES,
  GATED_LEGACY_ROUTE_FILES
}
