require('dotenv').config()

// Fail fast with a clear message instead of limping into an opaque
// Sequelize connection error, or every authenticated request failing
// cryptically because JWT_SECRET_KEY was never set.
const REQUIRED_ENV_VARS =
  process.env.NODE_ENV === 'production'
    ? [
        'POSTGRES_USER',
        'POSTGRES_PASSWORD',
        'POSTGRES_DATABASE',
        'POSTGRES_HOST',
        'JWT_SECRET_KEY'
      ]
    : ['JWT_SECRET_KEY']
const missingEnvVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key])
if (missingEnvVars.length > 0) {
  console.error(
    `Missing required environment variable(s): ${missingEnvVars.join(', ')}`
  )
  process.exit(1)
}

const Sentry = require('./instrument')
require('express-async-errors')
const express = require('express')
const http = require('http')
const cors = require('cors')
const cookieParser = require('cookie-parser')
const rateLimit = require('express-rate-limit')
const helmet = require('helmet')
const compression = require('compression')

const { initSocket } = require('./service/socket')
const userContext = require('../utils/userContext')

const productRoutes = require('./routes/product')
const authRoutes = require('./routes/auth')
const authorizationContextRoutes = require('./routes/authorizationContext')
const membershipRoutes = require('./routes/membership')
const tenantRoutes = require('./routes/tenant')
const assignmentRoutes = require('./routes/assignment')
const effectiveScopeRoutes = require('./routes/effectiveScope')
const categoryRoutes = require('./routes/category')
const locationRoutes = require('./routes/location')
const memberRoutes = require('./routes/member')
const discountRoutes = require('./routes/discount')
const shiftRoutes = require('./routes/shift')
const typePaymentRoutes = require('./routes/type-payment')
const bestSellingRoutes = require('./routes/best-selling')
const overviewRoutes = require('./routes/overview')
const socialMediaRoutes = require('./routes/social-media')
const invoiceRoutes = require('./routes/invoice')
const roleRoutes = require('./routes/role')
const positionRoutes = require('./routes/position')
const tableRoutes = require('./routes/table')
const orderRoutes = require('./routes/order')
const supplierRoutes = require('./routes/supplier')
const purchaseOrderRoutes = require('./routes/purchaseOrder')
const ingredientRoutes = require('./routes/ingredient')
const stockHistoryRoutes = require('./routes/stockHistory')
const stockOpnameRoutes = require('./routes/stockOpname')
const expenseCategoryRoutes = require('./routes/expenseCategory')
const expenseRoutes = require('./routes/expense')
const cashRegisterRoutes = require('./routes/cashRegister')
const parkedCartRoutes = require('./routes/parkedCart')
const reportRoutes = require('./routes/report')
const splitBillRoutes = require('./routes/splitBill')
const memberTierRoutes = require('./routes/memberTier')
const employeeRoutes = require('./routes/employee')
const departmentRoutes = require('./routes/department')
const taxConfigRoutes = require('./routes/taxConfig')
const posRoutes = require('./routes/pos')
const notificationRoutes = require('./routes/notification')
const currencyRoutes = require('./routes/currency')
const auditLogRoutes = require('./routes/auditLog')
const receiptRoutes = require('./routes/receipt')
const backupRoutes = require('./routes/backup')
const accountingRoutes = require('./routes/accounting')
const productionOrderRoutes = require('./routes/productionOrder')
const goodsReceiptRoutes = require('./routes/goodsReceipt')
const salesReturnRoutes = require('./routes/salesReturn')
const purchaseReturnRoutes = require('./routes/purchaseReturn')
const bomRoutes = require('./routes/bom')
const reservationRoutes = require('./routes/reservation')
const ingredientCategoryRoutes = require('./routes/ingredientCategory')
const purchasePaymentRoutes = require('./routes/purchasePayment')
const accountsReceivableRoutes = require('./routes/accountsReceivable')
const exportMasterRoutes = require('./routes/exportMaster')
const faq = require('./routes/faq')
const deliveryRoutes = require('./routes/delivery')
const queueRoutes = require('./routes/queue')
const waiterRequestRoutes = require('./routes/waiter-request')
const supplierPerformanceRoutes = require('./routes/supplierPerformance')
const supplierCategoryRoutes = require('./routes/supplierCategory')
const supplierContactRoutes = require('./routes/supplierContact')
const supplierBankAccountRoutes = require('./routes/supplierBankAccount')
const promoRoutes = require('./routes/promo')
const productBundleRoutes = require('./routes/productBundle')
const reportingRoutes = require('./routes/reporting')
const reportConfigRoutes = require('./routes/reportConfig')
const reportExportRoutes = require('./routes/reportExport')
const inventoryRoutes = require('./routes/inventory')
const thermalPrinterRoutes = require('./routes/thermalPrinter')
const goodsRequestRoutes = require('./routes/goodsRequest')
const businessTripRoutes = require('./routes/businessTrip')
const regionRoutes = require('./routes/region')
const internalRoutes = require('./routes/internal')
const assistantRoutes = require('./routes/assistant')
const shiftTemplateRoutes = require('./routes/shiftTemplate')
const shiftSwapRoutes = require('./routes/shiftSwap')
const attendanceRoutes = require('./routes/attendance')
const overtimeRoutes = require('./routes/overtime')

const app = express()
const server = http.createServer(app)

// ponytail: kebijakan CORS bersama (Express + Socket.IO) di utils/corsOptions
const { corsOptions } = require('./utils/corsOptions')

// Rate limit only anonymous traffic; authenticated requests are never throttled
// so a busy POS terminal (many requests per transaction) is not blocked.
const isAuthenticated = (req) =>
  Boolean(
    req.headers?.authorization &&
    req.headers.authorization.startsWith('Bearer ')
  )

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  skip: (req) => req.method === 'OPTIONS' || isAuthenticated(req),
  message: {
    success: false,
    message: 'Too many requests, please try again later.'
  }
})

app.set('trust proxy', 1)
app.use(helmet())
app.use(compression())
app.use(cors(corsOptions))

// ponytail: health sebelum rate-limiter — probe monitoring tidak boleh kena throttle
app.get('/health', async (_, res) => {
  try {
    const { sequelize } = require('../db/models')
    await sequelize.query('SELECT 1')
    res.status(200).json({
      success: true,
      status: 'ok',
      database: 'up',
      uptime: Math.round(process.uptime())
    })
  } catch {
    // ponytail: pesan generik — jangan bocorkan detail internal
    console.log(
      JSON.stringify({ level: 'error', service: 'pos-api', path: '/health', status: 'db_down' })
    )
    res.status(503).json({
      success: false,
      status: 'degraded',
      database: 'down'
    })
  }
})

app.use(limiter)
app.use(express.urlencoded({ extended: true }))
app.use(express.json())
app.use(cookieParser())
app.use(express.static('public'))

app.use((req, res, next) => {
  userContext.run({ userId: undefined }, () => next())
})

// ponytail: structured request log JSON — sumber p95/p99 & error rate,
// tanpa body/PII; skip OPTIONS (preflight noise)
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return next()
  const start = Date.now()
  const path = req.originalUrl.split('?')[0]
  res.on('finish', () => {
    const status = res.statusCode
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info'
    console.log(
      JSON.stringify({
        level,
        service: 'pos-api',
        method: req.method,
        path,
        status,
        duration_ms: Date.now() - start
      })
    )
  })
  next()
})

const routes = [
  { path: '/auth', route: authRoutes },
  { path: '/auth', route: authorizationContextRoutes },
  // T-03B canonical membership / assignment / effective-scope API.
  { path: '/memberships', route: membershipRoutes },
  // Platform tenant administration (tenant.manage).
  { path: '/tenants', route: tenantRoutes },
  { path: '/assignments', route: assignmentRoutes },
  { path: '/effective-scope', route: effectiveScopeRoutes },
  { path: '/product', route: productRoutes },
  { path: '/category', route: categoryRoutes },
  { path: '/location', route: locationRoutes },
  { path: '/member', route: memberRoutes },
  { path: '/order', route: orderRoutes },
  // DR-10: cron-authenticated scheduler endpoints (inert without CRON_SECRET).
  { path: '/internal', route: internalRoutes },
  // AI personal assistant (Telegram): service data API + owner link flow.
  { path: '/assistant', route: assistantRoutes },
  { path: '/table', route: tableRoutes },
  { path: '/discount', route: discountRoutes },
  { path: '/shift', route: shiftRoutes },
  { path: '/type-payment', route: typePaymentRoutes },
  { path: '/best-selling', route: bestSellingRoutes },
  { path: '/overview', route: overviewRoutes },
  { path: '/social-media', route: socialMediaRoutes },
  { path: '/invoice', route: invoiceRoutes },
  { path: '/role', route: roleRoutes },
  { path: '/position', route: positionRoutes },
  { path: '/supplier', route: supplierRoutes },
  { path: '/supplier-category', route: supplierCategoryRoutes },
  { path: '/supplier-contact', route: supplierContactRoutes },
  { path: '/supplier-bank-account', route: supplierBankAccountRoutes },
  { path: '/purchase-order', route: purchaseOrderRoutes },
  { path: '/ingredient', route: ingredientRoutes },
  { path: '/stock-history', route: stockHistoryRoutes },
  { path: '/stock-opname', route: stockOpnameRoutes },
  { path: '/expense-category', route: expenseCategoryRoutes },
  { path: '/expense', route: expenseRoutes },
  { path: '/cash-register', route: cashRegisterRoutes },
  { path: '/parked-cart', route: parkedCartRoutes },
  { path: '/report', route: reportRoutes },
  { path: '/split-bill', route: splitBillRoutes },
  { path: '/member-tier', route: memberTierRoutes },
  { path: '/employee', route: employeeRoutes },
  { path: '/department', route: departmentRoutes },
  { path: '/tax-config', route: taxConfigRoutes },
  { path: '/pos', route: posRoutes },
  { path: '/notification', route: notificationRoutes },
  { path: '/currency', route: currencyRoutes },
  { path: '/audit-log', route: auditLogRoutes },
  { path: '/receipt', route: receiptRoutes },
  { path: '/production-order', route: productionOrderRoutes },
  { path: '/goods-receipt', route: goodsReceiptRoutes },
  { path: '/goods-request', route: goodsRequestRoutes },
  { path: '/business-trip', route: businessTripRoutes },
  { path: '/sales-return', route: salesReturnRoutes },
  { path: '/purchase-return', route: purchaseReturnRoutes },
  { path: '/bom', route: bomRoutes },
  { path: '/reservation', route: reservationRoutes },
  { path: '/ingredient-category', route: ingredientCategoryRoutes },
  { path: '/purchase-payment', route: purchasePaymentRoutes },
  { path: '/accounts-receivable', route: accountsReceivableRoutes },
  { path: '/export', route: exportMasterRoutes },
  { path: '/faq', route: faq },
  { path: '/delivery', route: deliveryRoutes },
  { path: '/queue', route: queueRoutes },
  { path: '/waiter-request', route: waiterRequestRoutes },
  { path: '/supplier-performance', route: supplierPerformanceRoutes },
  { path: '/promo', route: promoRoutes },
  { path: '/product-bundle', route: productBundleRoutes },
  { path: '/reports', route: reportingRoutes },
  { path: '/report-config', route: reportConfigRoutes },
  { path: '/report', route: reportExportRoutes },
  { path: '/inventory', route: inventoryRoutes },
  { path: '/thermal-printer', route: thermalPrinterRoutes },
  { path: '/backup', route: backupRoutes },
  { path: '/accounting', route: accountingRoutes },
  { path: '/regions', route: regionRoutes },
  { path: '/shift-template', route: shiftTemplateRoutes },
  { path: '/shift-swap', route: shiftSwapRoutes },
  { path: '/attendance', route: attendanceRoutes },
  { path: '/overtime', route: overtimeRoutes }
]

routes.forEach(({ path, route }) => app.use(path, route))

const { execSync } = require('child_process')
const fs = require('fs')

const ESCPOS_RECEIPT_WIDTH = 32
const escposPadBoth = (left, right, width) => {
  const w = width || ESCPOS_RECEIPT_WIDTH
  const space = Math.max(1, w - left.length - right.length)
  return left + ' '.repeat(space) + right
}
const escposLine = (char, width) =>
  (char || '-').repeat(width || ESCPOS_RECEIPT_WIDTH)
const escposPrice = (val) => `Rp${Number(val || 0).toLocaleString('id-ID')}`
const fmtPrice = (val) => Number(val || 0).toLocaleString('id-ID')
const escposCell = (txt, width, align) => {
  const s = String(txt),
    w = Math.max(1, width)
  if (align === 'right') return s.slice(0, w).padStart(w)
  if (align === 'center')
    return s
      .slice(0, w)
      .padStart(Math.ceil((w + s.length) / 2))
      .slice(0, w)
      .padEnd(w)
  return s.slice(0, w).padEnd(w)
}
const escposDate = (date) => {
  const d = new Date(date)
  return d
    .toLocaleDateString('id-ID', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })
    .toLowerCase()
}
const escposTime = (date) => {
  const d = new Date(date)
  return d
    .toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
    .replace('.', ':')
}

function generateESCPOS(data) {
  const w = ESCPOS_RECEIPT_WIDTH
  const {
    storeName = 'TOKO ANDA',
    storeAddress = '',
    storePhone = '',
    storeEmail = '',
    memberName = '',
    memberTier = '',
    memberPoints = 0,
    orderNumber = '',
    cashier = '',
    date = new Date().toISOString(),
    items = [],
    subtotal = 0,
    discount = 0,
    serviceCharge = 0,
    tax = 0,
    total = 0,
    socialMedia = [],
    socialMediaVisible = {},
    footer = 'Terima kasih atas kunjungan Anda'
  } = data

  let enc = ''
  enc += '\x1B\x40'
  enc +=
    '\x1B\x61\x01\x1B\x21\x20\x1B\x45\x01' +
    storeName +
    '\n\x1B\x45\x00\x1B\x21\x00'
  enc += '\x1B\x61\x01'
  if (storeAddress) enc += storeAddress + '\n'
  if (storePhone) enc += 'Telp: ' + storePhone + '\n'
  if (storeEmail) enc += storeEmail + '\n'
  enc += 'invoice: ' + orderNumber + '\n'
  enc += escposLine('-', w) + '\n\x1B\x61\x00'
  enc += escposPadBoth(escposDate(date), escposTime(date)) + '\n'
  enc += 'kasir: ' + cashier + '\n'
  if (memberName) {
    enc += 'Member: ' + memberName + '\n'
    if (memberTier) enc += 'Tier: ' + memberTier + '\n'
    if (memberPoints)
      enc += 'Poin: ' + Number(memberPoints).toLocaleString('id-ID') + '\n'
  }
  enc += escposLine('-', w) + '\n'
  enc +=
    escposCell('Item', 11) +
    escposCell('Qty', 3, 'center') +
    escposCell('Harga', 9, 'right') +
    escposCell('Total', 9, 'right') +
    '\n'
  enc += escposLine('-', w) + '\n'
  items.forEach((item) => {
    const name = item.name || item.productName || '-'
    const qty = item.qty || item.quantity || 0
    const price = item.price || 0
    const itemTotal = item.total || item.subtotal || qty * price
    enc +=
      escposCell(name, 11) +
      escposCell(String(qty), 3, 'center') +
      escposCell(fmtPrice(price), 9, 'right') +
      escposCell(fmtPrice(itemTotal), 9, 'right') +
      '\n'
  })
  enc += escposLine('=', w) + '\n'
  enc += escposPadBoth('Subtotal', escposPrice(subtotal)) + '\n'
  if (discount > 0)
    enc += escposPadBoth('Diskon', '-' + escposPrice(discount)) + '\n'
  if (serviceCharge > 0)
    enc += escposPadBoth('Biaya Layanan', escposPrice(serviceCharge)) + '\n'
  enc += escposPadBoth('Pajak (10%)', escposPrice(tax)) + '\n'
  enc += escposLine('-', w) + '\n'
  enc +=
    '\x1B\x45\x01' +
    escposPadBoth('TOTAL', escposPrice(total)) +
    '\n\x1B\x45\x00'
  enc += escposLine('-', w) + '\n'
  enc += '\x1B\x61\x01' + footer + '\n'
  const vSocial = (socialMedia || []).filter(
    (_, i) => socialMediaVisible && socialMediaVisible[i]
  )
  if (vSocial.length > 0) {
    vSocial.forEach((sm) => {
      enc += (sm.platform || '') + ': ' + (sm.account || '') + '\n'
    })
  }
  enc += '\x1B\x61\x00\n\n\n'
  return enc
}

app.post('/print-thermal', (req, res) => {
  const { data } = req.body
  if (!data)
    return res.status(400).json({ success: false, message: 'No receipt data' })

  const script = `${__dirname}/thermal-bt.py`
  if (!fs.existsSync(script)) {
    return res
      .status(500)
      .json({ success: false, message: 'thermal-bt.py not found' })
  }

  try {
    const escpos = generateESCPOS(data)
    const proc = execSync(`python3 "${script}"`, {
      input: escpos,
      maxBuffer: escpos.length + 1024,
      timeout: 15000
    })
    res.json({ success: true, message: proc.toString().trim() || 'Printed' })
  } catch (e) {
    res.status(500).json({
      success: false,
      message: e.message || e.stderr?.toString().trim() || 'Print failed'
    })
  }
})

app.get('/', (_, res) => {
  res.status(200).json({
    success: true,
    message: 'POS API is running',
    socket: '/socket.io'
  })
})

// Must be the LAST app.use/app.get — Express only routes errors from
// handlers registered before an error-handling middleware, so this has to
// come after every route (it previously sat above app.get('/'), which meant
// that route's errors bypassed it entirely).
app.use((err, req, res, _next) => {
  console.error(err.stack)
  Sentry.captureException(err)
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error'
  })
})

// Catch errors outside the request lifecycle (schedulers, socket handlers,
// stray promise rejections) that the Express error middleware above never
// sees.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason)
  Sentry.captureException(reason)
})
// Process state after a truly uncaught exception is not safe to keep
// serving requests on — report it, then exit so the process manager
// (nodemon/pm2/systemd) restarts into a known-good state instead of
// continuing to run half-broken.
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err)
  Sentry.captureException(err)
  Sentry.flush(2000).finally(() => process.exit(1))
})

const port = process.env.PORT || 5001

if (!process.env.VERCEL) {
  const io = initSocket(server)
  server.listen(port, () => {
    console.log(`Server running on port ${port}`)
    console.log(`Socket.IO enabled`)
  })
  const { startBackupScheduler } = require('./service/backupScheduler')
  startBackupScheduler()
  const { startExpenseScheduler } = require('./service/expenseScheduler')
  startExpenseScheduler()
  const { startShiftSwapScheduler } = require('./service/shiftSwapScheduler')
  startShiftSwapScheduler()
  const {
    startAccountingOutboxScheduler
  } = require('./service/accountingOutboxScheduler')
  startAccountingOutboxScheduler()
  const { startApReminderScheduler } = require('./service/apReminderScheduler')
  startApReminderScheduler()

  // ponytail: graceful shutdown agar koneksi aktif (HTTP & DB pool) tidak
  // terputus paksa saat deploy/restart di tengah trafik tinggi
  const gracefulShutdown = async (signal) => {
    console.log(`${signal} received, closing server gracefully...`)
    setTimeout(() => process.exit(1), 10000).unref()

    // ponytail: socket.io (koneksi persisten) ditutup lebih dulu, jika tidak
    // server.close() tak pernah selesai dan DB pool mati tanpa cleanup
    try {
      await Promise.allSettled([
        new Promise((resolve) => (io ? io.close(resolve) : resolve())),
        new Promise((resolve) =>
          server ? server.close(() => resolve()) : resolve()
        )
      ])
    const { sequelize } = require('../db/models')
      await sequelize.close()
      console.log('DB pool closed. Bye.')
      process.exit(0)
    } catch (e) {
      console.error('Error during shutdown:', e.message)
      process.exit(1)
    }
  }
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
  process.on('SIGINT', () => gracefulShutdown('SIGINT'))
}

module.exports = app
