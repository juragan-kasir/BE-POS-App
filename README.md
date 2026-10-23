# Bisa Nota - Backend API

[![Node.js](https://img.shields.io/badge/Node.js-v18+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

Point of Sale (POS) backend API built with Node.js, Express, and PostgreSQL.

> **Checkpoint:** reconciled against `master` `c9fe118` on 2026-10-23. Current scale: 544 route handlers + 3 inline routes, 111 models, 242 migrations, 331 Jest test files, 6 Vercel daily crons.

## Tech Stack

| Category | Technology |
|----------|-----------|
| **Runtime** | Node.js v18+ |
| **Framework** | Express.js |
| **Database** | PostgreSQL with Sequelize ORM |
| **Real-time** | Socket.IO |
| **Auth** | JWT + bcrypt + DB-backed authorization session (`disabledAt`, revocation) |
| **Validation** | Zod |
| **File Storage** | Cloudinary (`@aws-sdk/client-s3` is a dependency but no code imports it) |
| **PDF Generation** | PDFKit |
| **Excel** | ExcelJS |
| **Security** | Helmet, CORS, express-rate-limit |
| **Monitoring** | Sentry (`SENTRY_DSN`) |
| **Deployment** | Vercel (serverless, 6 daily crons) |

---

## Getting Started

### Prerequisites

- Node.js v18+
- PostgreSQL v14+
- npm or yarn

### Installation

```bash
git clone <repository-url>
cd BE-POS-APP
npm install
```

### Environment Variables

Copy `.env.example` to `.env` and fill it in. Variables read by the code (`process.env.*` in `api/`, `utils/`, `config/`):

| Group | Variables |
|-------|-----------|
| Server | `PORT` (default 5001), `NODE_ENV`, `TRUST_PROXY_HOPS`, `VERCEL` (set by Vercel; disables Socket.IO + in-process schedulers) |
| Database | dev `DB_DEV_HOST/PORT/USERNAME/PASSWORD/DATABASE`; test `DB_TEST_DATABASE`; staging `STAGING_DB_*`; production `POSTGRES_HOST/PORT/USER/PASSWORD/DATABASE` |
| Auth | `JWT_SECRET_KEY`, `JWT_EXPIRED_IN`, `PUBLIC_REGISTRATION_ENABLED` (sign-up closed unless set) |
| CORS | `CORS_ORIGIN`, `FRONTEND_URL` |
| Rate limits | `GLOBAL_RATE_LIMIT_WINDOW_MS`, `GLOBAL_RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_WINDOW_MS`, `AUTH_RATE_LIMIT_MAX`, `CUSTOMER_ORDER_RATE_LIMIT` |
| Schedulers | `CRON_SECRET` (min 32 chars; `/internal/*` fail closed without it), `QR_PENDING_EXPIRY_MINUTES` (QR expiry off when unset), `BACKUP_DIR` |
| Integrations | `CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET`, `SMTP_HOST/PORT/USER/PASS/FROM`, `SENTRY_DSN`, `GEMINI_API_KEY` (FAQ), `ASSISTANT_SERVICE_SECRET` + `AI_CORE_URL` + `AI_CORE_API_KEY` (AI assistant), `BT_PRINTER_MAC` |
| Misc | `APP_NAME`, `ATTENDANCE_GEOFENCE_METERS`, `REVIEW_AUTO_PUBLISH` |

> `.env.example` does not yet list `QR_PENDING_EXPIRY_MINUTES`, `SMTP_*`, `GEMINI_API_KEY` or the rate-limit overrides. The AWS S3 variables in older docs are not read by any code.

### Database Setup

> **DANGER — `npm run sync` is NOT a migration runner.** It is a destructive
> schema recreation (`sequelize.sync({ force: true })`: drops and recreates
> schema objects). Production execution is **default-deny**: without both
> `ALLOW_DESTRUCTIVE_SYNC=I_UNDERSTAND_THIS_WIPES_PROD` and `--force` the
> command refuses before connecting. Destructive production sync is prohibited.
> Production migration-ledger reconciliation is a separate upcoming phase and
> is not covered by any command below.

```bash
# DESTRUCTIVE local-only schema recreation (drops local schema, NOT migrations):
npm run sync -- --force            # requires NODE_ENV=development/test, explicit --force

npm run sync:inventory    # UNAVAILABLE — referenced script is not present in this repo; do not use

# Fresh local database (empty or not yet created) — run this FIRST:
npm run db:bootstrap               # loads scripts/dev-schema.sql, stamps db/migration-baseline.txt, then runs npm run migrate
npm run db:bootstrap -- --env test # same for the test database
npx sequelize-cli db:seed:all      # optional: default roles, admin users, payment methods, tax configs

# Sequelize migration workflow (incremental, ledger-tracked):
npm run migrate                    # scripts/run-migrations.js: preflight checks, then pinned sequelize-cli db:migrate (never run against production in this phase)
# NOTE: the migration chain is snapshot-first — core tables (user, product,
# order, location, category) have no createTable migration, so `migrate` on
# an EMPTY database fails at the second file. Use db:bootstrap for that.

# Test/dev database setup (deterministic, isolated test DB):
# Jest globalSetup (scripts/setup-test-db.js) clones the dev schema and
# truncates the isolated test database automatically; no manual sync needed.
```

### Development

```bash
npm run dev               # Start server with nodemon
```

### Production

```bash
npm start                 # Start server
```

---

## Project Structure

```
BE-POS-APP/
├── api/
│   ├── index.js              # Express app entry + 3 inline HTTP routes + thermal print endpoint
│   ├── controller/           # Route controllers (76 files)
│   ├── routes/               # API routes (77 modules)
│   ├── middleware/
│   │   └── validate.js       # Zod validation middleware
│   ├── service/
│   │   └── socket.js         # Socket.IO service
│   └── validation/
│       └── schemas.js        # Zod schemas
├── config/
│   ├── config.js             # Sequelize DB config
│   └── database.js           # Database connection
├── db/
│   ├── models/               # Sequelize models (111 files)
│   ├── migrations/           # Database migrations
│   └── seeders/              # Database seeders
├── utils/
│   ├── authorization.js      # Auth middleware + RBAC
│   ├── jwtConvert.js         # JWT helpers
│   ├── cloudinaryStorage.js  # Cloud storage
│   ├── excelTemplate.js      # Excel import/export
│   ├── generateInvoicePdf.js # PDF generation
│   ├── auditLog.js           # Audit logging
│   ├── auditFields.js        # Audit field enrichment
│   ├── constants.js          # App constants
│   ├── createNotification.js # Notification helper
│   ├── storeValidation.js    # Store access validation
│   ├── userContext.js        # AsyncLocalStorage user context
├── scripts/                  # Migration & utility scripts
├── docs/                     # Documentation
├── API_DOCUMENTATION.md      # Full API reference (547 routes)
└── vercel.json               # Vercel deployment config
```

---

## API Response Format

### Success
```json
{
  "success": true,
  "message": "Success",
  "data": { ... }
}
```

### Error
```json
{
  "success": false,
  "message": "Error message"
}
```

### Paginated
```json
{
  "success": true,
  "message": "Success",
  "data": [...],
  "pagination": {
    "currentPage": 1,
    "pageSize": 10,
    "totalItems": 100,
    "totalPages": 10
  }
}
```

---

## API Endpoints

The endpoint reference is [`API_DOCUMENTATION.md`](./API_DOCUMENTATION.md) (every route, with auth, request and response). This README only lists the route modules, so it cannot drift from the code: 77 modules, 544 handlers, mounted in `api/index.js`, plus 3 inline routes (`GET /health`, `POST /print-thermal`, `GET /`).

| Mount | Route file (`api/routes/`) | Handlers |
|-------|----------------------------|----------|
| `/accounting` | `accounting.js` | 11 |
| `/accounts-receivable` | `accountsReceivable.js` | 7 |
| `/assignments` | `assignment.js` | 3 |
| `/assistant` | `assistant.js` | 7 |
| `/attendance` | `attendance.js` | 4 |
| `/audit-log` | `auditLog.js` | 2 |
| `/auth` | `auth.js` | 11 |
| `/auth` | `authorizationContext.js` | 4 |
| `/backup` | `backup.js` | 7 |
| `/best-selling` | `best-selling.js` | 5 |
| `/bom` | `bom.js` | 6 |
| `/business-trip` | `businessTrip.js` | 6 |
| `/cash-register` | `cashRegister.js` | 13 |
| `/category` | `category.js` | 8 |
| `/currency` | `currency.js` | 6 |
| `/delivery` | `delivery.js` | 17 |
| `/department` | `department.js` | 9 |
| `/discount` | `discount.js` | 10 |
| `/effective-scope` | `effectiveScope.js` | 1 |
| `/employee` | `employee.js` | 9 |
| `/expense` | `expense.js` | 14 |
| `/expense-category` | `expenseCategory.js` | 4 |
| `/export` | `exportMaster.js` | 1 |
| `/faq` | `faq.js` | 2 |
| `/goods-receipt` | `goodsReceipt.js` | 8 |
| `/goods-request` | `goodsRequest.js` | 6 |
| `/ingredient` | `ingredient.js` | 11 |
| `/ingredient-category` | `ingredientCategory.js` | 8 |
| `/internal` | `internal.js` | 7 |
| `/inventory` | `inventory.js` | 11 |
| `/invoice` | `invoice.js` | 3 |
| `/location` | `location.js` | 12 |
| `/member` | `member.js` | 6 |
| `/member-tier` | `memberTier.js` | 7 |
| `/memberships` | `membership.js` | 5 |
| `/notification` | `notification.js` | 4 |
| `/order` | `order.js` | 15 |
| `/overtime` | `overtime.js` | 5 |
| `/overview` | `overview.js` | 10 |
| `/parked-cart` | `parkedCart.js` | 5 |
| `/pos` | `pos.js` | 20 |
| `/position` | `position.js` | 10 |
| `/product` | `product.js` | 10 |
| `/product-bundle` | `productBundle.js` | 7 |
| `/production-order` | `productionOrder.js` | 8 |
| `/promo` | `promo.js` | 11 |
| `/purchase-order` | `purchaseOrder.js` | 11 |
| `/purchase-payment` | `purchasePayment.js` | 7 |
| `/purchase-return` | `purchaseReturn.js` | 6 |
| `/queue` | `queue.js` | 7 |
| `/receipt` | `receipt.js` | 1 |
| `/regions` | `region.js` | 6 |
| `/report` | `report.js` | 5 |
| `/report` | `reportExport.js` | 2 |
| `/report-config` | `reportConfig.js` | 4 |
| `/reports` | `reporting.js` | 4 |
| `/reservation` | `reservation.js` | 6 |
| `/role` | `role.js` | 9 |
| `/sales-return` | `salesReturn.js` | 4 |
| `/shift` | `shift.js` | 6 |
| `/shift-swap` | `shiftSwap.js` | 4 |
| `/shift-template` | `shiftTemplate.js` | 6 |
| `/social-media` | `social-media.js` | 4 |
| `/split-bill` | `splitBill.js` | 5 |
| `/stock-history` | `stockHistory.js` | 5 |
| `/stock-opname` | `stockOpname.js` | 11 |
| `/supplier` | `supplier.js` | 12 |
| `/supplier-bank-account` | `supplierBankAccount.js` | 5 |
| `/supplier-category` | `supplierCategory.js` | 5 |
| `/supplier-contact` | `supplierContact.js` | 5 |
| `/supplier-performance` | `supplierPerformance.js` | 6 |
| `/table` | `table.js` | 7 |
| `/tax-config` | `taxConfig.js` | 12 |
| `/tenants` | `tenant.js` | 5 |
| `/thermal-printer` | `thermalPrinter.js` | 4 |
| `/type-payment` | `type-payment.js` | 9 |
| `/waiter-request` | `waiter-request.js` | 5 |

Sub-category endpoints are **not mounted**; use categories.

---

## Roles & Permissions

| Role | Description | Access |
|------|-------------|--------|
| **super_admin** | Owner | All stores, all features |
| **admin** | Store Manager | Store-level access |
| **kasir** | POS Staff | POS + Membership |
| **user** | General Staff | Limited access |

RBAC is enforced via `requireRole` middleware in `utils/authorization.js`. Granular per-menu permissions are stored in the `role` model; menu-level enforcement is currently partial (30/77 route files write-gated, `MENU_ENFORCED_ROUTES` empty) — see `FG-SEC-01`.

---

## Database Models

111 Sequelize models covering:

| Domain | Models |
|--------|--------|
| **Users & Auth** | user, role |
| **Store** | location |
| **Products** | product, category, product_batch, product_store_price, product_store_stock |
| **Orders** | order, order_item, order_status, checkout, transaction |
| **Tables** | table, reservation |
| **Members** | member, memberTier, member_point_history |
| **Finance** | type_payment, discount, taxConfig, cashRegister, expense, expenseCategory, accounts_receivable, ar_payment |
| **Inventory** | stockHistory, stockOpname, stockOpnameItem, stock_transfer, stock_transfer_item |
| **Procurement** | supplier, purchaseOrder, purchaseOrderItem, purchasePayment, purchase_return, purchase_return_item |
| **Returns** | sales_return, sales_return_item |
| **Production** | bom_header, bom_line, productionOrder, goodsReceipt, goodsReceiptItem, ingredient, ingredientCategory |
| **People** | employee, department, position |
| **Settings** | shift, invoice_setting, social_media, currency, taxConfig |
| **System** | notification, auditLog, best_selling, daily_report, dailySummary, splitBill, station_dapur |

---

## Socket.IO Events

Socket.IO starts only on a long-running server (`if (!process.env.VERCEL)` in `api/index.js`). **On Vercel there is no socket server**; FE KDS/queue screens fall back to polling. Clients join `store-<id>` / `kitchen-<id>` rooms (numeric store ids only; a rejected join gets `join-rejected`).

| Room | Events |
|------|--------|
| `kitchen-<id>` (mirrored to `kitchen-all`) | `new-order`, `order-updated`, `item-status-updated` |
| `store-<id>` | `new-notification`, `new-notification-global`, `queue:created/updated/statusChanged/deleted`, `waiter-request:new/statusChanged`, `promo:created/updated/activated/expired/statusChanged/used/deleted`, `new-delivery-order`, `delivery-assigned`, `delivery-status-updated`, `delivery-cancelled`, `shift:membersChanged`, `shift:membersRemoved`, `shift:swapped`, `employee:shiftChanged` |

---

## Deployment

Deployed on **Vercel** with serverless functions.

- **API Base URL**: https://api-bisa-nota.vercel.app
- **Frontend**: https://bisa-nota-demo.vercel.app
- **Crons**: 6 daily jobs in `vercel.json` (`0 0 * * *` UTC) call `/internal/*` with `CRON_SECRET`: accounting outbox drain, QR order expiry, backup, recurring expenses, shift-swap expiry, AP reminders.
- **CI**: GitHub Actions is currently disabled at the organisation level; run `npm test` (sharded Jest, `scripts/run-tests-sharded.js`) locally before pushing. There is no `lint` script in this repo.

---

## Related

- [Frontend App](../FE-POS-App/README.md)
- [API Documentation](./API_DOCUMENTATION.md) (all 547 routes with request/response examples)
- [API Response Contracts — ERP/Akuntansi](./docs/api-response-contracts.md) (envelope, error codes, response shapes untuk FE)
