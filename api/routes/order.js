const express = require('express')
const router = express.Router()
const rateLimit = require('express-rate-limit')
const { ipKeyGenerator } = rateLimit
const orderController = require('../controller/order')
const authorization = require('../../utils/authorization')
const { validateStoreAccess } = require('../../utils/storeValidation')
const { requireCapability } = require('../../utils/financialCapabilities')
const { validate } = require('../middleware/validate')
const {
  createOrderSchema,
  updateOrderStatusSchema,
  updateOrderItemStatusSchema
} = require('../validation/schemas')

// FND-002 (security) — dedicated rate limiter for the anonymous QR order
// creation endpoint. SEC-004 idempotency only replays the SAME
// (store, idempotencyKey); an attacker can spin a unique key per request (or
// omit the key entirely) and flood pending orders. Bucket key is
// <store>:<clientIP> so customers sharing one store's NAT never consume
// another store's budget.
//
// NOTE: first-layer mitigation only. express-rate-limit's default MemoryStore
// is per-process / per-serverless-instance (Vercel has no Redis or shared
// limiter here), so this is NOT a globally coordinated ceiling across cold
// starts, concurrent instances, or rotated IPs.
//
// Store is pre-parsed here just for keying. Values that fail a quick integer
// check collapse into one 'invalid:<ip>' bucket (they can never mint unlimited
// per-store buckets); the controller would reject such bodies with 400 before
// any DB order write, so this only ever throttles malformed traffic.
const customerCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // Tune via CUSTOMER_ORDER_RATE_LIMIT; default 50 orders per (store, IP) per
  // 15 min is comfortable for legitimate multi-customer QR ordering on shared
  // NAT networks while bounding trivial floods.
  max: Number.parseInt(process.env.CUSTOMER_ORDER_RATE_LIMIT, 10) || 50,
  keyGenerator: (req) => {
    const store = Number(req.body && req.body.store)
    const storeKey = Number.isInteger(store) && store > 0 ? store : 'invalid'
    return `${storeKey}:${ipKeyGenerator(req.ip)}`
  },
  message: {
    success: false,
    message: 'Too many requests, please try again later.'
  }
})

// Order CRUD - All authenticated users (POS operations)
router.post(
  '/create',
  authorization,
  validateStoreAccess,
  requireCapability('payment.collect', { entity: 'order' }),
  validate(createOrderSchema),
  orderController.createOrder
)
router.get(
  '/get-orders',
  authorization,
  validateStoreAccess,
  orderController.getOrdersByStore
)
router.get(
  '/get-order/:id',
  authorization,
  validateStoreAccess,
  orderController.getOrderById
)
router.get(
  '/kitchen',
  authorization,
  validateStoreAccess,
  orderController.getKitchenOrders
)
router.put(
  '/update-status',
  authorization,
  validateStoreAccess,
  validate(updateOrderStatusSchema),
  orderController.updateOrderStatus
)
router.put(
  '/update-item-status',
  authorization,
  validateStoreAccess,
  validate(updateOrderItemStatusSchema),
  orderController.updateOrderItemStatus
)
// Customer-facing (no auth)
router.get('/customer-menu', orderController.getCustomerMenu)
router.get('/customer-member', orderController.getCustomerMember)
router.get('/customer-orders', orderController.getCustomerOrders)
// :token is the order's opaque publicToken (not its database id) —
// required so this unauthenticated route can't be used to enumerate
// other stores' orders. See api/controller/order.js: getCustomerOrder.
router.get('/customer-order/:token', orderController.getCustomerOrder)
router.post('/customer-create', customerCreateLimiter, orderController.createCustomerOrder)
router.get('/receipt-html/:token', orderController.getReceiptHTML)
router.get('/customer-tax-rate', orderController.getCustomerTaxRate)
router.get('/customer-reviews', orderController.getProductReviews)
router.post('/customer-review', orderController.createCustomerReview)

module.exports = router
