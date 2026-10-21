# Bisa Nota - Backend API

[![CI/CD](https://github.com/teddferdy/BE-POS-App/actions/workflows/ci.yml/badge.svg)](https://github.com/teddferdy/BE-POS-App/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-v18+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

Point of Sale (POS) backend API built with Node.js, Express, and PostgreSQL.

## Tech Stack

| Category | Technology |
|----------|-----------|
| **Runtime** | Node.js v18+ |
| **Framework** | Express.js |
| **Database** | PostgreSQL with Sequelize ORM |
| **Real-time** | Socket.IO |
| **Auth** | JWT + bcrypt |
| **Validation** | Zod |
| **File Storage** | AWS S3, Cloudinary |
| **PDF Generation** | Puppeteer, PDFKit |
| **Excel** | ExcelJS |
| **Security** | Helmet, CORS, express-rate-limit |
| **Deployment** | Vercel |

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

Create `.env` file:

```env
# Server
PORT=5001
NODE_ENV=development

# Database (Development)
DB_DEV_HOST=127.0.0.1
DB_DEV_PORT=5432
DB_DEV_DATABASE=cashier_app
DB_DEV_USERNAME=postgres
DB_DEV_PASSWORD=your_password

# Database (Production)
POSTGRES_USER=your_user
POSTGRES_PASSWORD=your_password
POSTGRES_DATABASE=your_database
POSTGRES_HOST=your_host

# Auth
JWT_SECRET=your_jwt_secret

# CORS
FRONTEND_URL=http://localhost:3000

# AWS S3
AWS_ACCESS_KEY_ID=your_key
AWS_SECRET_ACCESS_KEY=your_secret
AWS_REGION=your_region
AWS_BUCKET_NAME=your_bucket

# Cloudinary
CLOUDINARY_CLOUD_NAME=your_cloud
CLOUDINARY_API_KEY=your_key
CLOUDINARY_API_SECRET=your_secret

# AI (Optional - for FAQ assistant)
GEMINI_API_KEY=your_gemini_key
```

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
npm run migrate                    # npx sequelize-cli db:migrate (never run against production in this phase)
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
│   ├── index.js              # Express app entry + thermal print endpoint
│   ├── controller/           # Route controllers (46 files)
│   ├── routes/               # API routes (47 modules)
│   ├── middleware/
│   │   └── validate.js       # Zod validation middleware
│   ├── service/
│   │   └── socket.js         # Socket.IO service
│   └── validation/
│       └── schemas.js        # Zod schemas (875 lines)
├── config/
│   ├── config.js             # Sequelize DB config
│   └── database.js           # Database connection
├── db/
│   ├── models/               # Sequelize models (60 files)
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
├── API_DOCUMENTATION.md      # Full API reference (~210 endpoints)
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

### Authentication
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/auth/login` | Login |
| POST | `/auth/register` | Register |
| GET | `/auth/get-user` | Get current user |
| PUT | `/auth/edit-user` | Update user |

### Roles & Permissions
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/role/get-role` | Get all roles (dropdown) |
| GET | `/role/get-role-all` | Get roles (paginated) |
| POST | `/role/add-new-role` | Create role |
| PUT | `/role/edit-role/:id` | Update role |
| DELETE | `/role/delete-role/:id` | Delete role |
| PUT | `/role/update-user-role` | Change user role |
| GET | `/role/get-users-by-role` | Get users by role |
| PUT | `/role/update-access-menu` | Update role permissions |

### Store / Location
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/location/get-location` | Get all stores (dropdown) |
| GET | `/location/get-location-all` | Get stores (paginated) |
| POST | `/location/add-new-location` | Create store |
| PUT | `/location/edit-location` | Update store |
| DELETE | `/location/delete-location/:id` | Delete store |
| GET | `/location/template/:storeId` | Download Excel template |
| POST | `/location/import` | Import from Excel |

### Products
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/product/get-product` | Get products for cashier |
| GET | `/product/get-product-by-super-admin` | Get by store (superadmin) |
| GET | `/product/get-product-all` | Get products (paginated) |
| POST | `/product/add-product` | Create product |
| PUT | `/product/edit-product` | Update product |
| DELETE | `/product/delete-product/:id` | Delete product |
| GET | `/product/template/:storeId` | Download template |
| POST | `/product/import` | Import from Excel |

### Categories
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/category/get-category` | Get categories (dropdown) |
| GET | `/category/get-category-all` | Get categories (paginated) |
| POST | `/category/add-new-category` | Create category |
| PUT | `/category/edit-category/:id` | Update category |
| DELETE | `/category/delete-category/:id` | Delete category |
| GET | `/category/download-excel` | Export to Excel |

### Sub-Categories
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/sub-category/get-all-sub-category` | Get all sub-categories |
| GET | `/sub-category/by-category/:id` | Get by category |
| POST | `/sub-category/add-new-sub-category` | Create sub-category |
| PUT | `/sub-category/edit-sub-category/:id` | Update sub-category |
| DELETE | `/sub-category/delete-sub-category/:id` | Delete sub-category |

### Employees
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/employee/get-employee` | Get employees (paginated) |
| POST | `/employee/add-new-employee` | Create employee |
| PUT | `/employee/edit-employee/:id` | Update employee |
| DELETE | `/employee/delete-employee/:id` | Delete employee |

### Departments
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/department/get-department` | Get departments (dropdown) |
| GET | `/department/get-department-all` | Get departments (paginated) |
| POST | `/department/add-new-department` | Create department |
| PUT | `/department/edit-department/:id` | Update department |
| DELETE | `/department/delete-department/:id` | Delete department |

### Positions
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/position/get-position` | Get positions (dropdown) |
| GET | `/position/get-position-all` | Get positions (paginated) |
| POST | `/position/add-new-position` | Create position |
| PUT | `/position/edit-position/:id` | Update position |
| DELETE | `/position/delete-position/:id` | Delete position |

### Members & Loyalty
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/member/get-member` | Get members |
| POST | `/member/add-new-member` | Create member |
| PUT | `/member/edit-member/:id` | Update member |
| DELETE | `/member/delete-member/:id` | Delete member |

### Member Tiers
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/member-tier/get-member-tier` | Get all tiers |
| POST | `/member-tier/add-new-member-tier` | Create tier |
| PUT | `/member-tier/edit-member-tier/:id` | Update tier |
| DELETE | `/member-tier/delete-member-tier/:id` | Delete tier |

### Orders
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/order/create-order` | Create order |
| GET | `/order/get-order-by-store` | Get orders by store |
| GET | `/order/get-order-by-id/:id` | Get order by ID |
| PUT | `/order/edit-order/:id` | Update order |
| PUT | `/order/update-status/:id` | Update order status |
| PUT | `/order/edit-item/:id` | Update order item |
| DELETE | `/order/delete-order/:id` | Delete order |
| POST | `/order/apply-discount/:id` | Apply discount |

### Checkout & Transactions
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/checkout/checkout-item` | Process checkout |
| PUT | `/checkout/edit-checkout/:id` | Update checkout |
| DELETE | `/checkout/delete-checkout/:id` | Delete checkout |

### Payment Types
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/type-payment/get-type-payment-by-location` | Get active payment types |
| GET | `/type-payment/get-type-payment` | Get all payment types |
| POST | `/type-payment/add-new-type-payment` | Create payment type |
| PUT | `/type-payment/edit-type-payment/:id` | Update payment type |
| DELETE | `/type-payment/delete-type-payment/:id` | Delete payment type |

### Discounts
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/discount/get-discount-by-location` | Get active discounts |
| GET | `/discount/get-discount` | Get all discounts |
| POST | `/discount/add-new-discount` | Create discount |
| PUT | `/discount/edit-discount/:id` | Update discount |
| DELETE | `/discount/delete-discount/:id` | Delete discount |

### Tables
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/table/get-table` | Get tables by store |
| GET | `/table/availability` | Get table availability |
| GET | `/table/active-orders` | Get tables with active orders |
| POST | `/table/add-new-table` | Create table |
| PUT | `/table/edit-table/:id` | Update table |
| PUT | `/table/edit-status/:id` | Update status |
| DELETE | `/table/delete-table/:id` | Delete table |

### Shifts
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/shift/get-shift` | Get all shifts |
| POST | `/shift/add-new-shift` | Create shift |
| PUT | `/shift/edit-shift/:id` | Update shift |
| DELETE | `/shift/delete-shift/:id` | Delete shift |

### Cash Register
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/cash-register/open` | Open cash register |
| POST | `/cash-register/:id/close` | Close cash register |
| GET | `/cash-register/current` | Get current register |
| GET | `/cash-register/history` | Get register history |

### Suppliers
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/supplier` | Get all suppliers |
| POST | `/supplier` | Create supplier |
| PUT | `/supplier/:id` | Update supplier |
| DELETE | `/supplier/:id` | Delete supplier |

### Purchase Orders
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/purchase-order` | Get all purchase orders |
| POST | `/purchase-order` | Create purchase order |
| PUT | `/purchase-order/:id` | Update purchase order |
| POST | `/purchase-order/:id/receive` | Receive order |

### Purchase Payments
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/purchase-payment` | Get purchase payments |
| POST | `/purchase-payment` | Create purchase payment |
| GET | `/purchase-payment/dashboard` | AP dashboard |

### Goods Receipt
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/goods-receipt` | Get all goods receipts |
| POST | `/goods-receipt` | Create goods receipt |
| PUT | `/goods-receipt/:id` | Update goods receipt |

### Ingredients
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/ingredient` | Get all ingredients |
| POST | `/ingredient` | Create ingredient |
| PUT | `/ingredient/:id` | Update ingredient |
| DELETE | `/ingredient/:id` | Delete ingredient |

### Ingredient Categories
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/ingredient-category` | Get all categories |
| POST | `/ingredient-category` | Create category |
| PUT | `/ingredient-category/:id` | Update category |
| DELETE | `/ingredient-category/:id` | Delete category |

### BOM (Bill of Materials)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/bom` | Get all BOMs |
| POST | `/bom` | Create BOM |
| PUT | `/bom/:id` | Update BOM |
| DELETE | `/bom/:id` | Delete BOM |

### Production Orders
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/production-order` | Get all production orders |
| POST | `/production-order` | Create production order |
| PUT | `/production-order/:id/start` | Start production |
| PUT | `/production-order/:id/complete` | Complete production |
| PUT | `/production-order/:id/cancel` | Cancel production |

### Stock Management
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/stock-history` | Get stock history |
| GET | `/stock-opname` | Get stock opname |
| POST | `/stock-opname` | Create stock opname |
| POST | `/pos/adjust` | Stock adjustment |
| POST | `/pos/transfer` | Inter-store stock transfer |
| GET | `/pos/transfer-history` | Transfer history |
| GET | `/pos/transfer/:id` | Transfer detail |
| PUT | `/pos/transfer/:id/receive` | Confirm receipt |
| PUT | `/pos/transfer/:id/cancel` | Cancel transfer |

### Returns
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/sales-return` | Get sales returns |
| POST | `/sales-return` | Create sales return |
| GET | `/purchase-return` | Get purchase returns |
| POST | `/purchase-return` | Create purchase return |

### Expense Management
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/expense-category` | Get expense categories |
| POST | `/expense-category` | Create category |
| GET | `/expense` | Get all expenses |
| POST | `/expense` | Create expense |
| PUT | `/expense/:id` | Update expense |
| POST | `/expense/:id/approve` | Approve expense |

### Tax Configuration
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/tax-config` | Get tax configs |
| POST | `/tax-config` | Create tax config |
| PUT | `/tax-config/:id` | Update tax config |

### Accounts Receivable
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/accounts-receivable` | Get AR list |
| GET | `/accounts-receivable/aging` | AR aging report |
| POST | `/accounts-receivable/:id/payment` | Record AR payment |

### Reservations
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/reservation` | Get all reservations |
| POST | `/reservation` | Create reservation |
| PUT | `/reservation/:id` | Update reservation |
| DELETE | `/reservation/:id` | Cancel reservation |

### Split Bill
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/split-bill` | Create split bill |
| POST | `/split-bill/:id/pay` | Pay split bill |
| POST | `/split-bill/:id/cancel` | Cancel split bill |
| POST | `/split-bill/merge` | Merge split bills |

### Notifications
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/notification` | Get notifications |
| GET | `/notification/unread-count` | Get unread count |
| PUT | `/notification/:id/read` | Mark as read |
| PUT | `/notification/read-all` | Mark all as read |

### Reports
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/report/sales` | Sales report |
| GET | `/report/daily-summary` | Daily summary |
| GET | `/report/profit-loss` | Profit & loss |
| GET | `/best-selling/get-best-selling` | Best selling products |
| GET | `/best-selling/get-chart-by-month` | Monthly chart |
| GET | `/best-selling/get-chart-current-and-seven-days-before` | 7-day chart |

### Dashboard & Analytics
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/overview/dashboard-summary` | Dashboard summary |
| GET | `/pos/dashboard/summary` | POS dashboard data |
| GET | `/best-selling/get-earning-today` | Today's earnings |

### POS Operations
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/pos/lookup-barcode` | Barcode scan lookup |
| GET | `/pos/product/price-by-store` | Multi-store pricing |
| PUT | `/pos/product/update-price-by-store` | Update store prices |
| POST | `/pos/product/add-batch` | Add product batch |
| GET | `/pos/product/batches` | Get product batches |
| GET | `/pos/member/:id/point-history` | Member point history |

### Invoice & Receipt
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/invoice/logo` | Get logos |
| POST | `/invoice/logo` | Upload logo |
| PUT | `/invoice/logo/:id` | Update logo |
| GET | `/invoice/footer` | Get footers |
| POST | `/invoice/footer` | Create footer |
| GET | `/receipt/:orderId` | Get order receipt |
| GET | `/pos/invoice/wa-text/:orderId` | Receipt as WhatsApp text (opened via wa.me; nothing is sent) |
| POST | `/pos/invoice/send-email` | Send receipt via email |

### Social Media
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/social-media` | Get social media links |
| POST | `/social-media` | Create social media link |
| PUT | `/social-media/:id` | Update social media link |

### Currency
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/currency` | Get currencies |
| POST | `/currency` | Create currency |
| PUT | `/currency/default/:id` | Set default currency |

### Audit Log
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/audit-log` | Get audit logs (super_admin only) |

### FAQ
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/faq` | Search static FAQ |
| POST | `/faq/ask` | Ask AI-powered FAQ assistant |

### Export
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/export/master` | Export all master data to Excel |

### Thermal Printing
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/print-thermal` | ESC/POS thermal Bluetooth print |

---

## Roles & Permissions

| Role | Description | Access |
|------|-------------|--------|
| **super_admin** | Owner | All stores, all features |
| **admin** | Store Manager | Store-level access |
| **user** | General Staff | Limited access |
| **cashier** | POS Staff | POS + Membership |
| **kitchen** | Kitchen Staff | KDS only |

RBAC is enforced via `requireRole` middleware in `utils/authorization.js`. Granular per-menu permissions are stored in the `role` model.

---

## Database Models

60 Sequelize models covering:

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

Real-time events at `/socket.io`:

| Event | Description |
|-------|-------------|
| `order:created` | New order created |
| `order:updated` | Order status changed |
| `table:updated` | Table status changed |

---

## Deployment

Deployed on **Vercel** with serverless functions.

- **API Base URL**: https://api-bisa-nota.vercel.app
- **Frontend**: https://bisa-nota-demo.vercel.app

---

## Related

- [Frontend App](../FE-POS-App/README.md)
- [API Documentation](./API_DOCUMENTATION.md) (~210 endpoints with request/response examples)
- [API Response Contracts — ERP/Akuntansi](./docs/api-response-contracts.md) (envelope, error codes, response shapes untuk FE)
