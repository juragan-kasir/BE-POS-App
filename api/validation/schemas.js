const { z } = require('zod')
const { isValidTimezone } = require('../../utils/businessDate')
const { parsePhoneInput } = require('../../utils/memberIdentity')

// D-05: member phone must be parseable to canonical E.164. Missing/empty/
// whitespace-only values take the server-side guest path in the controller.
// GUEST-* identifiers are server-generated only: never accepted on create;
// on update the controller accepts one only when it equals the member's
// current value (allowGuest defers that check to the controller).
const memberPhoneNumber = ({ allowGuest = false } = {}) =>
  z
    .string()
    .optional()
    .nullable()
    .refine(
      (v) => {
        try {
          const parsed = parsePhoneInput(v)
          return parsed.kind !== 'guest' || allowGuest
        } catch {
          return false
        }
      },
      { message: 'Nomor telepon tidak valid' }
    )

// --- Helpers ---
const ianaTimezone = () =>
  z
    .string()
    .refine((v) => isValidTimezone(v), {
      message: 'must be a valid IANA timezone identifier (e.g. Asia/Jakarta)'
    })

const strToNum = () =>
  z
    .any()
    .transform((v) => (v === '' || v === null || v === undefined ? 0 : Number(v)))
    .refine((v) => !isNaN(v), { message: 'must be a number' })
    .refine((v) => v >= 0, { message: 'must not be negative' })

// ponytail: null = "semua toko" untuk promo campaign (store column JSONB)
const strToNumNullable = () =>
  z
    .any()
    .transform((v) => {
      if (v === '' || v === null || v === undefined) return null
      return Number(v)
    })
    .refine((v) => v === null || (!isNaN(v) && v >= 0), {
      message: 'must be a valid number or null'
    })

const optionalStrToNum = () =>
  z
    .any()
    .refine((v) => v !== '' && v !== null && v !== undefined, {
      message: 'required'
    })
    .transform((v) => Number(v))
    .refine((v) => !isNaN(v), { message: 'must be a number' })
    .optional()
    .transform((v) => {
      if (v === '' || v === null || v === undefined) return null
      const n = Number(v)
      return isNaN(n) ? null : n
    })
    .refine((v) => v === null || v >= 0, { message: 'must not be negative' })

const storeParam = () =>
  z
    .any()
    .optional()
    .nullable()
    .transform((v) => {
      if (v === '' || v === null || v === undefined) return null
      const arr = Array.isArray(v) ? v : [v]
      return arr.map((x) => Number(x))
    })
    .refine((v) => v === null || v.every((n) => !Number.isNaN(n)), {
      message: 'must be a number'
    })

const jsonField = () =>
  z.union([z.string(), z.array(z.any()), z.record(z.any())]).transform((v) => {
    if (typeof v === 'string') {
      if (v === '' || v === 'null' || v === 'undefined') return null
      try {
        return JSON.parse(v)
      } catch {
        throw new Error('invalid JSON')
      }
    }
    return v
  })

const storeArray = () =>
  z
    .union([z.array(z.number().int()), z.array(strToNum()), z.string()])
    .transform((v) => {
      if (typeof v === 'string') {
        if (v === '' || v === 'null' || v === 'undefined') return null
        try {
          const p = JSON.parse(v)
          return Array.isArray(p) ? p.map(Number) : [Number(p)]
        } catch {
          const num = Number(v)
          return isNaN(num) || num === 0 ? null : [num]
        }
      }
      return v.map(Number)
    })

const statusEnumBase = z.enum(['active', 'inactive', 'draft'])
const statusEnum = statusEnumBase.default('active')

// F7: explicit fulfillment-strategy flag — an unrecognized value must fail
// clearly at the boundary, never be silently coerced to a valid mode.
// Base enum has no default: updateProductSchema below overrides the field
// with this bare (defaultless) version so an omitted field on a partial
// update parses to undefined, not 'stocked' — Zod's `.partial()` does NOT
// strip an existing `.default()` from a field (verified), so reusing the
// create schema's defaulted version here would silently reset every
// existing product's inventoryMode back to 'stocked' on any unrelated edit.
const inventoryModeValues = ['stocked', 'make_to_order', 'hybrid']
const inventoryModeEnumBase = z.enum(inventoryModeValues)
const inventoryModeEnum = inventoryModeEnumBase.optional().default('stocked')

// ===================== Auth =====================
exports.loginSchema = z.object({
  userName: z.string().min(1, 'Username/email is required'),
  password: z.string().min(1, 'Password is required')
})

// Public self-registration. Caller-controlled tenant/privilege fields
// (`store`, `userType`, `shift`, `position`, `accessMenu`) are NOT accepted —
// Zod strips them before the controller ever sees them. A registered public
// user is always unassigned (`store: null`) and stores are assigned later by
// an authorized admin via /auth/change-profile-user. (CRIT-1)
exports.registerSchema = z
  .object({
    userName: z.string().min(1, 'Username is required'),
    password: z.string().min(6, 'Password min 6 characters'),
    confirmPassword: z.string().min(1, 'Confirm password is required'),
    email: z.string().email('Invalid email').optional().or(z.literal('')),
    fullName: z.string().optional().default(''),
    phoneNumber: z.string().optional().default(''),
    gender: z.string().optional().default(''),
    address: z.string().optional().default(''),
    dateOfBirth: z.string().optional().nullable(),
    placeOfBirth: z.string().optional().default('')
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: 'Password and confirm password do not match',
    path: ['confirmPassword']
  })

exports.resetPasswordSchema = z.object({
  email: z.string().email('Invalid email').optional(),
  userName: z.string().optional()
})

// ===================== Product =====================
exports.createProductSchema = z.object({
  nameProduct: z.string().optional().default(''),
  category: optionalStrToNum(),
  status: statusEnum,
  description: z.string().optional().default(''),
  price: optionalStrToNum().default(0),
  costPrice: optionalStrToNum().default(0),
  stock: strToNum().optional().default(0),
  minStock: strToNum().optional().default(0),
  unit: z.string().optional().default('pcs'),
  baseUnit: z.string().optional().default('pcs'),
  conversionFactor: z.coerce.string().optional().default('1'),
  point: strToNum().optional().default(0),
  barcode: z.string().optional().nullable(),
  brand: z.string().optional().nullable(),
  hasModifiers: z.union([z.boolean(), z.string()]).optional().default(false),
  modifiers: jsonField().optional().default([]),
  isOption: z.union([z.boolean(), z.string()]).optional().default(false),
  options: jsonField().optional().default([]),
  isAvailable: z.union([z.boolean(), z.string()]).optional().default(true),
  stores: storeArray().optional().nullable(),
  supplier: strToNum().optional().nullable(),
  tax: jsonField().optional().nullable(),
  priceTiers: jsonField().optional().default([]),
  currencyId: strToNum().optional().nullable(),
  currencyCode: z.string().optional().nullable(),
  tipeProduk: z.string().optional().default('menu'),
  inventoryMode: inventoryModeEnum,
  composition: jsonField().optional().default([]),
  redeemPoints: strToNum().optional().default(0),
  estimationTime: strToNum().optional().default(0),
  createdBy: z.union([z.number(), strToNum()]).optional().nullable(),
  image: z.string().optional().nullable(),
  imageOrder: z.string().optional().nullable()
})

exports.updateProductSchema = exports.createProductSchema.partial().extend({
  id: strToNum(),
  inventoryMode: inventoryModeEnumBase.optional()
})

// ===================== Category =====================
exports.createCategorySchema = z.object({
  name: z.string().min(1, 'Category name is required'),
  description: z.string().optional().nullable(),
  parentId: z.coerce.number().optional().nullable(),
  color: z.string().optional().nullable(),
  sortOrder: z.coerce.number().optional().default(0),
  value: z.string().optional(),
  image: z.string().optional().nullable(),
  icon: z.string().optional().nullable(),
  status: statusEnum,
  store: storeArray().optional().nullable(),
  isActive: z.union([z.boolean(), z.string()]).optional()
})

exports.updateCategorySchema = exports.createCategorySchema.partial()

// ===================== Order =====================
const orderItemSchema = z
  .object({
    product: strToNum(),
    productId: strToNum().optional(),
    productName: z.string().optional(),
    quantity: strToNum(),
    price: strToNum().optional().default(0),
    // W3-2: optional client echo of the final charged unit price for
    // mismatch detection (comparison-only, never persisted). Absent/null/''
    // means the line is not enrolled; a present value must be an integer
    // >= 0 or the request fails closed with 400 (never a 409).
    expectedPrice: z
      .any()
      .optional()
      .transform((v) => {
        if (v === undefined || v === null || v === '') return undefined
        return Number(v)
      })
      .refine((v) => v === undefined || (typeof v === 'number' && Number.isFinite(v)), {
        message: 'expectedPrice must be a finite number'
      })
      .refine((v) => v === undefined || (Number.isInteger(v) && v >= 0), {
        message: 'expectedPrice must be an integer >= 0'
      }),
    priceOverride: z
      .any()
      .optional()
      .transform((v) => {
        if (v === undefined || v === null || v === '') return undefined
        const n = Number(v)
        return Number.isNaN(n) ? v : n
      })
      .refine((v) => v === undefined || (typeof v === 'number' && Number.isFinite(v)), {
        message: 'priceOverride must be a finite number'
      })
      .refine((v) => v === undefined || v >= 0, {
        message: 'priceOverride must not be negative'
      })
      .refine((v) => v === undefined || Number.isInteger(v), {
        message: 'priceOverride must be an integer'
      }),
    notes: z.string().optional().default(''),
    modifiers: z.array(z.any()).optional().default([]),
    variant: z.string().optional()
  })
  .passthrough()

exports.createOrderSchema = z.object({
  store: strToNum().optional(),
  tableId: strToNum().optional().nullable(),
  customerId: strToNum().optional().nullable(),
  customerName: z.string().optional().nullable(),
  customerPhone: z.string().optional().nullable(),
  items: z.array(orderItemSchema).min(1, 'At least one item is required'),
  discountId: strToNum().optional().nullable(),
  promoCode: z.string().optional().nullable(),
  discountType: z
    .enum(['none', 'percent', 'nominal'])
    .optional()
    .default('none'),
  discountValue: strToNum().optional().default(0),
  notes: z.string().optional().default(''),
  source: z.enum(['pos', 'online', 'qr', 'waiter']).optional().default('pos'),
  cashierId: strToNum().optional().nullable(),
  cashierName: z.string().optional().nullable(),
  currencyId: strToNum().optional().nullable(),
  currencyCode: z.string().optional().nullable(),
  exchangeRate: z.string().optional().default('1'),
  totalCovers: strToNum().optional().default(0),
  shiftId: strToNum().optional().nullable(),
  subTotal: strToNum().optional().default(0),
  taxRate: z.any().optional(),
  serviceChargeRate: z.any().optional(),
  paymentMethod: z.string().max(50).optional(),
  // P1: optional client reference for non-cash settlement, persisted on
  // the immutable ledger row (never trusted for cash math).
  referenceNumber: z.string().max(255).optional().nullable(),
  appliedDiscountId: strToNum().optional().nullable(),
  pointDiscountAmount: strToNum().optional().default(0),
  redeemedPoints: strToNum().optional().default(0),
  // Optional client-generated key (e.g. a UUID minted once per checkout
  // attempt) — a retried/duplicate submit with the same key returns the
  // order already created instead of creating a second one.
  idempotencyKey: z.string().max(255).optional().nullable(),
  // Bare type coercion ONLY — no range/negativity check here. The full
  // cash-tender invariant (cashReceived >= amountDue, changeGiven >= 0,
  // cashReceived - changeGiven === amountDue) must return 422 (semantic
  // validation), but this schema's ZodError handler always resolves to
  // 400 (see api/middleware/validate.js) — so every semantic check for
  // these two fields lives in validateCashTender() in the controller,
  // never here. A non-numeric string coerces to NaN and is caught there.
  cashAmount: z.any().transform((v) =>
    v === '' || v === null || v === undefined ? null : Number(v)
  ).optional(),
  changeAmount: z.any().transform((v) =>
    v === '' || v === null || v === undefined ? null : Number(v)
  ).optional(),
  // DR-24 D-01: the cashier tax toggle is removed. This field is kept for
  // backward compatibility with older clients (it also documents the quote /
  // create body shape), but it is no longer read — pricing always uses the
  // resolved outlet PPN rate (DR-17).
  useTax: z.boolean().optional().default(true),
  // DR-23 §M TOTAL_CHANGED: optional payable the client showed the customer
  // (e.g. its server quote's totalPrice). Comparison-only, never persisted:
  // a differing server payable is refused with 409 before any write.
  // Absent/null/'' = not enrolled (legacy clients unaffected).
  expectedTotal: z
    .any()
    .optional()
    .transform((v) => (v === undefined || v === null || v === '' ? undefined : Number(v)))
    .refine((v) => v === undefined || (Number.isInteger(v) && v >= 0), {
      message: 'expectedTotal must be an integer >= 0'
    })
})

exports.updateOrderStatusSchema = z.object({
  id: strToNum(),
  store: z
    .any()
    .optional()
    .nullable()
    .transform((v) =>
      v === '' || v === null || v === undefined ? null : Number(v)
    )
    .refine((v) => v === null || !isNaN(v), { message: 'must be a number' })
    .refine((v) => v === null || v >= 0, { message: 'must not be negative' }),
  status: z.enum([
    'pending',
    'confirmed',
    'preparing',
    'ready',
    'served',
    'paid',
    'cancelled',
    'void'
  ]),
  changedBy: strToNum().optional().nullable(),
  changedByName: z.string().optional().nullable(),
  customerId: strToNum().optional().nullable(),
  notes: z.string().optional().default(''),
  // DR-04: tender fields for settling an order to paid via update-status.
  // Optional so non-paid transitions keep their existing shape; when
  // status is 'paid' the controller requires a complete tender (method,
  // cash detail when cash) and resolves register attribution server-side.
  // cashAmount/changeAmount use the same bare coercion as order create —
  // semantic checks live in validateCashTender (422), never here (400).
  // P1 (DR-PAY-ATTR-06): any string reaches the controller, where the
  // canonicalizer maps locked aliases and refuses unknown tenders with
  // 422 (a Zod enum would reject them with 400 at the shape boundary).
  paymentMethod: z.string().max(50).optional(),
  cashAmount: z.any().transform((v) =>
    v === '' || v === null || v === undefined ? null : Number(v)
  ).optional(),
  changeAmount: z.any().transform((v) =>
    v === '' || v === null || v === undefined ? null : Number(v)
  ).optional(),
  // P1: client reference for non-cash settlement, persisted (trimmed) on the
  // immutable ledger row, never trusted for cash math. Shape only here: the
  // tender may come from the order itself, so "required for every tender
  // but CASH and POINTS" (DR-23 §D) is enforced in
  // resolvePaidSettlement after normalization (422 REFERENCE_REQUIRED).
  referenceNumber: z.string().max(255).optional().nullable(),
  // DR-23 (BA §35.10): explicit settlement amount — must equal the current
  // outstanding amount (validated under the order lock, 409/422 in the
  // controller). Omitted = legacy claim of the order's full total.
  amount: z.any().transform((v) =>
    v === '' || v === null || v === undefined ? null : Number(v)
  ).optional(),
  // DR-23: reference for the non-cash portion of a void refund.
  refundReference: z.string().max(255).optional().nullable(),
  // Phase 31 Batch 1: required (non-empty after trim) when cancelling a
  // paid order — enforced in updateOrderStatus, which alone knows the
  // locked oldPaymentStatus. Optional here so unrelated transitions keep
  // their existing shape. Non-strings are rejected by z.string (400).
  reason: z
    .string()
    .max(255, 'reason must be at most 255 characters')
    .optional()
    .nullable()
})

exports.updateOrderItemStatusSchema = z.object({
  id: strToNum(),
  itemId: strToNum(),
  // Phase 31 Batch 2 (B-3): constrain to the order_item status enum at the
  // request boundary so invalid values return the normal 400 validation
  // shape instead of reaching PostgreSQL and surfacing as a 500 enum error.
  // Matches db/models/order_item.js and enum_order_item_status in prod.
  itemStatus: z.enum(['pending', 'preparing', 'ready', 'served'])
})

// ===================== Store lifecycle / tenant ownership =====================

const STORE_LIFECYCLE_STATUSES = Object.freeze([
  'active',
  'inactive',
  'draft',
  'closed',
  'retired',
  'quarantined'
])

// Only 'active' stores are operationally usable. Everything else is an
// explicitly non-operational state: draft (not published yet), inactive /
// closed (temporarily out of service), retired / quarantined (terminal).
const OPERATIONAL_STORE_STATUSES = Object.freeze(['active'])
const NON_OPERATIONAL_STORE_STATUSES = Object.freeze(
  STORE_LIFECYCLE_STATUSES.filter((status) => !OPERATIONAL_STORE_STATUSES.includes(status))
)
const IRREVERSIBLE_STORE_STATUSES = Object.freeze(['retired', 'quarantined'])

// Statuses an ordinary request may never move INTO 'active'. 'draft' is
// excluded on purpose: publishing a freshly created draft store is the normal
// create-then-activate flow, not a reactivation.
const REQUEST_BLOCKED_ACTIVATION_STATUSES = Object.freeze(
  NON_OPERATIONAL_STORE_STATUSES.filter((status) => status !== 'draft')
)

const strictTenantId = (value) => {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null
  }
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const normalized = Number(value)
    return Number.isSafeInteger(normalized) ? normalized : null
  }
  return null
}

const normalizeLifecycleStatus = (value) => {
  if (value === undefined || value === null || value === '') {
    return { provided: false, value: null, known: true }
  }
  if (typeof value !== 'string') return { provided: true, value: null, known: false }
  const normalized = value.trim().toLowerCase()
  if (!normalized) return { provided: false, value: null, known: true }
  if (!STORE_LIFECYCLE_STATUSES.includes(normalized)) {
    return { provided: true, value: null, known: false }
  }
  return { provided: true, value: normalized, known: true }
}

// HB-2 R1: deterministic lifecycle-intent resolution for store edits.
//
// `status` is authoritative: when provided (including legacy booleans, which
// the update schema historically accepted), it decides and `isActive` is
// ignored entirely, so a stale/legacy boolean can never override it. When
// `status` is absent, only an actual boolean `isActive` carries intent
// (true → active, false → inactive, preserving the legacy contract); any
// other value (notably the strings "true"/"false" produced by FormData
// serialization) passes through untouched so normalizeLifecycleStatus
// rejects it as unknown instead of JavaScript truthiness silently coercing
// "false" to active. Absent/absent yields undefined: a config-only edit
// requests no lifecycle transition.
const resolveRequestedLifecycleStatus = ({ status, isActive } = {}) => {
  if (status !== undefined) {
    if (status === true) return 'active'
    if (status === false) return 'draft'
    return status
  }
  if (isActive === true) return 'active'
  if (isActive === false) return 'inactive'
  return isActive
}

const normalizeOptionalTenantId = (value) => {
  if (value === undefined || value === null || value === '') {
    return { provided: false, value: null, valid: true }
  }
  const normalized = strictTenantId(value)
  return { provided: true, value: normalized, valid: normalized !== null }
}

const lifecycleRejection = (code, field, message) => ({
  ok: false,
  code,
  field,
  message,
  tenantId: null,
  status: null,
  becomesOperational: false
})

// Pure, deterministic store-lifecycle / tenant-ownership decision. Returns the
// first failing rule in a fixed order, so the same input always produces the
// same code. `storeInput` fields:
//   currentStatus     persisted lifecycle status of the store (null on create)
//   requestedStatus   lifecycle status the request asks for (null = unchanged)
//   tenantId          target tenant CANDIDATE from the request (optional)
//   persistedTenantId tenant ownership already stored on the row (optional)
const assertOperationalStoreTenant = (context, storeInput) => {
  const input =
    storeInput && typeof storeInput === 'object' && !Array.isArray(storeInput)
      ? storeInput
      : {}

  if (!context || context.eligible !== true) {
    return lifecycleRejection(
      'CONTEXT_UNRESOLVED',
      'context',
      'an eligible resolved authorization context is required'
    )
  }

  const currentStatus = normalizeLifecycleStatus(input.currentStatus)
  const requestedStatus = normalizeLifecycleStatus(input.requestedStatus)
  if (!currentStatus.known) {
    return lifecycleRejection(
      'UNKNOWN_STORE_STATUS',
      'currentStatus',
      'currentStatus is not a known store lifecycle status'
    )
  }
  if (!requestedStatus.known) {
    return lifecycleRejection(
      'UNKNOWN_STORE_STATUS',
      'requestedStatus',
      'requestedStatus is not a known store lifecycle status'
    )
  }

  const requestedTenantId = normalizeOptionalTenantId(input.tenantId)
  if (!requestedTenantId.valid) {
    return lifecycleRejection(
      'INVALID_TENANT_ID',
      'tenantId',
      'tenantId must be a positive integer'
    )
  }
  const persistedTenantId = normalizeOptionalTenantId(input.persistedTenantId)
  if (!persistedTenantId.valid) {
    return lifecycleRejection(
      'INVALID_TENANT_ID',
      'persistedTenantId',
      'persistedTenantId must be a positive integer'
    )
  }

  const requestsOperational =
    requestedStatus.provided && OPERATIONAL_STORE_STATUSES.includes(requestedStatus.value)
  const wasOperational =
    currentStatus.provided && OPERATIONAL_STORE_STATUSES.includes(currentStatus.value)
  const becomesOperational = requestsOperational && !wasOperational

  if (
    requestsOperational &&
    currentStatus.provided &&
    !wasOperational &&
    REQUEST_BLOCKED_ACTIVATION_STATUSES.includes(currentStatus.value)
  ) {
    return IRREVERSIBLE_STORE_STATUSES.includes(currentStatus.value)
      ? lifecycleRejection(
          'STORE_STATUS_IRREVERSIBLE',
          'currentStatus',
          `${currentStatus.value} is a terminal store state and cannot be reactivated`
        )
      : lifecycleRejection(
          'STORE_ACTIVATION_NOT_PERMITTED',
          'currentStatus',
          `a ${currentStatus.value} store cannot become active by request`
        )
  }

  if (
    currentStatus.provided &&
    IRREVERSIBLE_STORE_STATUSES.includes(currentStatus.value) &&
    requestedStatus.provided &&
    requestedStatus.value !== currentStatus.value
  ) {
    return lifecycleRejection(
      'STORE_STATUS_IRREVERSIBLE',
      'currentStatus',
      `${currentStatus.value} is a terminal store state and cannot be changed by request`
    )
  }

  const contextTenantId = normalizeOptionalTenantId(context.activeTenantId)
  if (!contextTenantId.valid) {
    return lifecycleRejection(
      'INVALID_TENANT_ID',
      'context',
      'the resolved context carries a malformed tenant id'
    )
  }

  // GAP-1 (D1 Alt-3): an already-operational tenantless store is not a valid
  // permanent product state. A platform request that keeps it operational
  // without resolving a tenant is rejected here, before the target-tenant
  // branch, so the persisted-state violation reports STORE_TENANT_REQUIRED
  // while activation-without-target keeps TARGET_TENANT_REQUIRED.
  // Requests that resolve the state (first assignment of an approved tenant,
  // or a transition out of operational status) still pass, as do
  // non-operational tenantless migration states. Non-platform null-context
  // actors keep TENANT_SCOPE_REQUIRED below; ownership and terminal rules
  // below are untouched.
  const staysOperationalTenantless =
    context.isPlatformAdmin === true &&
    wasOperational &&
    persistedTenantId.value === null &&
    contextTenantId.value === null &&
    requestedTenantId.value === null &&
    (!requestedStatus.provided || requestsOperational)
  if (staysOperationalTenantless) {
    return lifecycleRejection(
      'STORE_TENANT_REQUIRED',
      'tenantId',
      'an operational store requires an approved tenant'
    )
  }

  let tenantId = contextTenantId.value
  if (tenantId === null) {
    if (context.isPlatformAdmin !== true) {
      return lifecycleRejection(
        'TENANT_SCOPE_REQUIRED',
        'context',
        'a resolved tenant context is required for store lifecycle changes'
      )
    }
    // Platform-wide context: it carries no tenant of its own, so an
    // operational store must name one explicitly. A non-operational store may
    // stay tenantless until the production cutover gate. An existing store
    // that already belongs to a tenant needs no restatement: its persisted
    // owner is the target (never a reassignment; approval is still checked
    // by the caller).
    if (requestedTenantId.value === null && persistedTenantId.value !== null) {
      tenantId = persistedTenantId.value
    } else if (requestedTenantId.value === null) {
      if (requestsOperational) {
        return lifecycleRejection(
          'TARGET_TENANT_REQUIRED',
          'tenantId',
          'platform store creation requires an explicit target tenant'
        )
      }
    } else {
      tenantId = requestedTenantId.value
    }
  } else if (requestedTenantId.value !== null && requestedTenantId.value !== tenantId) {
    return lifecycleRejection(
      'TENANT_SCOPE_MISMATCH',
      'tenantId',
      'the requested tenant is outside the resolved tenant context'
    )
  }

  if (requestsOperational && tenantId === null) {
    return lifecycleRejection(
      'STORE_TENANT_REQUIRED',
      'tenantId',
      'an operational store requires an approved tenant'
    )
  }

  if (
    persistedTenantId.value !== null &&
    tenantId !== null &&
    persistedTenantId.value !== tenantId
  ) {
    return lifecycleRejection(
      'TENANT_REASSIGNMENT_NOT_PERMITTED',
      'tenantId',
      'store tenant ownership cannot be reassigned by request'
    )
  }

  return {
    ok: true,
    code: null,
    field: null,
    message: null,
    tenantId,
    status: requestedStatus.provided ? requestedStatus.value : currentStatus.value,
    becomesOperational,
    wasOperational
  }
}

const PRODUCT_ASSIGNMENT_REJECTION = Object.freeze({
  PRODUCT_UNASSIGNED_NOT_SELLABLE:
    'a sellable product must be assigned to at least one store of one tenant'
})

// Pure, deterministic product-assignment decision. `assignmentProvided` is true
// only when the request actually carried a `stores` payload — omitting it is
// NOT a request to unassign, so historical assignments and their ownership are
// preserved untouched. An explicit empty assignment on a product that is still
// active/available is rejected: clearing every assignment would leave the
// product visible to every store (the "unassigned ⇒ globally sellable" fail
// open). Unassigning stays possible in the same request that makes the product
// non-sellable.
const assertSellableProductAssignment = (productInput) => {
  const input =
    productInput && typeof productInput === 'object' && !Array.isArray(productInput)
      ? productInput
      : {}
  const storeIds = Array.isArray(input.storeIds) ? input.storeIds : []
  const status = normalizeLifecycleStatus(input.status).value
  const isAvailable = input.isAvailable !== false && input.isAvailable !== 'false'

  if (input.assignmentProvided !== true) {
    return {
      ok: true,
      code: 'ASSIGNMENT_UNCHANGED',
      field: 'stores',
      message: null,
      storeIds,
      globallySellable: false
    }
  }

  if (storeIds.length === 0 && status === 'active' && isAvailable) {
    return {
      ok: false,
      code: 'PRODUCT_UNASSIGNED_NOT_SELLABLE',
      field: 'stores',
      message: PRODUCT_ASSIGNMENT_REJECTION.PRODUCT_UNASSIGNED_NOT_SELLABLE,
      storeIds,
      globallySellable: false
    }
  }

  return {
    ok: true,
    code: null,
    field: null,
    message: null,
    storeIds,
    globallySellable: false
  }
}

// ===================== Location =====================
exports.createLocationSchema = z.object({
  name: z.string().min(1, 'Location name is required'),
  store: strToNum().optional().nullable(),
  // Target-tenant candidate for the new store. It is validated against the
  // resolved authorization context by assertOperationalStoreTenant and is
  // never treated as ownership evidence on its own.
  tenantId: strToNum().optional().nullable(),
  address: z.string().optional().nullable(),
  detailLocation: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  province: z.string().optional().nullable(),
  district: z.string().optional().nullable(),
  village: z.string().optional().nullable(),
  postalCode: z.string().optional().nullable(),
  latitude: z.string().optional().nullable(),
  longitude: z.string().optional().nullable(),
  mainBranch: z.union([z.boolean(), z.string()]).optional().default(false),
  description: z.string().optional().nullable(),
  openingHours: jsonField().optional().nullable(),
  managerName: z.string().optional().nullable(),
  email: z.string().email().optional().or(z.literal('')),
  phoneNumber: z.string().optional().nullable(),
  category: z.string().optional().nullable(),
  status: statusEnum,
  timezone: ianaTimezone().optional(),
  socialMedia: jsonField().optional().nullable(),
  dailyTarget: strToNum().optional().default(0),
  image: z.string().optional().nullable()
})

// ponytail: passthrough preserves locationId, id, storeId, coordinates, etc.
// that the controller needs but aren't in the base schema.
// AUTH-2: `status` is overridden with the bare (defaultless) enum for the same
// reason inventoryMode is — `.partial()` does not strip `.default()`, so an
// omitted status on an edit parsed to 'active' and every partial edit silently
// reactivated the store, defeating the lifecycle rules entirely.
exports.updateLocationSchema = exports.createLocationSchema
  .partial()
  .passthrough()
  .extend({ status: statusEnumBase.optional() })

// W3 store configuration: explicit allowlist, partial semantics, strict.
// Unlike updateLocationSchema (partial + passthrough for the legacy
// super_admin edit flow), W3 forbids every non-allowlist key: .strict()
// turns immutable fields (store, tenantId, status, audit fields, ...) and
// arbitrary unknown keys into 400s instead of persisting them. `id` is the
// row selector only (loc-N); it is never written back.
// Thresholds reuse the existing nullable string-to-number shape: valid
// numerics accepted, null means built-in/default behavior, negatives and
// malformed values are rejected.
const locationIdSelector = z
  .string()
  .regex(/^loc-[1-9]\d*$/, 'must be a location id like loc-1')

// W3-local JSON shape: same accept-set as jsonField (string/array/object,
// '' → null), but a malformed JSON string is a validation issue (400), not
// a thrown error (which escapes as 500 on the legacy create/edit paths).
const w3JsonField = () =>
  z.union([z.string(), z.array(z.any()), z.record(z.any())]).transform((v, ctx) => {
    if (typeof v === 'string') {
      if (v === '' || v === 'null' || v === 'undefined') return null
      try {
        return JSON.parse(v)
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid JSON' })
        return z.NEVER
      }
    }
    return v
  })

exports.storeConfigurationSchema = z
  .object({
    id: locationIdSelector,
    name: z.string().min(1, 'Location name is required').optional(),
    phoneNumber: z.string().optional().nullable(),
    email: z.string().email().optional().or(z.literal('')),
    address: z.string().optional().nullable(),
    detailLocation: z.string().optional().nullable(),
    city: z.string().optional().nullable(),
    province: z.string().optional().nullable(),
    district: z.string().optional().nullable(),
    village: z.string().optional().nullable(),
    postalCode: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
    category: z.string().optional().nullable(),
    managerName: z.string().optional().nullable(),
    latitude: z.string().optional().nullable(),
    longitude: z.string().optional().nullable(),
    image: z.string().optional().nullable(),
    openingHours: w3JsonField().optional().nullable(),
    socialMedia: w3JsonField().optional().nullable(),
    timezone: ianaTimezone().optional(),
    mainBranch: z.union([z.boolean(), z.string()]).optional(),
    dailyTarget: strToNumNullable().optional(),
    maxActiveParkedCarts: strToNumNullable().optional(),
    parkedCartTtlMinutes: strToNumNullable().optional()
  })
  .strict()

exports.STORE_LIFECYCLE_STATUSES = STORE_LIFECYCLE_STATUSES
exports.OPERATIONAL_STORE_STATUSES = OPERATIONAL_STORE_STATUSES
exports.NON_OPERATIONAL_STORE_STATUSES = NON_OPERATIONAL_STORE_STATUSES
exports.IRREVERSIBLE_STORE_STATUSES = IRREVERSIBLE_STORE_STATUSES
exports.assertOperationalStoreTenant = assertOperationalStoreTenant
exports.resolveRequestedLifecycleStatus = resolveRequestedLifecycleStatus
exports.assertSellableProductAssignment = assertSellableProductAssignment

// ===================== Supplier =====================
exports.createSupplierSchema = z.object({
  name: z.string().min(1, 'Supplier name is required'),
  store: storeArray().optional().nullable(),
  phone: z.string().optional().nullable(),
  email: z.string().email().optional().or(z.literal('')),
  contactPerson: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  status: statusEnum,
  paymentType: z.enum(['cbd', 'cad', 'tempo']).optional().default('cbd'),
  tempoDays: z.number().optional().default(0),
  categoryId: z.number().optional().nullable(),
  mobile: z.string().optional().nullable(),
  whatsapp: z.string().optional().nullable(),
  fax: z.string().optional().nullable(),
  website: z.string().optional().nullable(),
  taxInclude: z.boolean().optional().default(true),
  taxType: z.string().optional().nullable(),
  taxNumber: z.string().optional().nullable(),
  taxName: z.string().optional().nullable(),
  nitku: z.string().optional().nullable(),
  taxTransactionType: z.string().optional().nullable(),
  defaultDiscount: z.number().optional().default(0),
  defaultDescription: z.string().optional().nullable(),
  products: z
    .array(
      z
        .object({
          name: z.string().min(1),
          price: strToNum().optional().default(0),
          unit: z.string().optional().default('pcs'),
          leadTime: z.number().optional().default(0),
          leadTimeUnit: z.string().optional().default('hari'),
          qualityRating: strToNum().optional().default(0),
          minOrderQty: z.string().optional().default('1'),
          notes: z.string().optional().nullable(),
          lastPrice: z.number().optional().default(0),
          productId: z.number().optional().nullable()
        })
        .passthrough()
    )
    .optional()
    .nullable(),
  contacts: z
    .array(
      z
        .object({
          fullName: z.string().min(1),
          position: z.string().optional().nullable(),
          email: z.string().optional().nullable(),
          phone: z.string().optional().nullable()
        })
        .passthrough()
    )
    .optional()
    .nullable(),
  bankAccounts: z
    .array(
      z
        .object({
          bankName: z.string().min(1),
          accountNumber: z.string().min(1),
          accountName: z.string().min(1),
          isDefault: z.boolean().optional().default(false),
          status: statusEnum.optional().default('active')
        })
        .passthrough()
    )
    .optional()
    .nullable()
})

exports.updateSupplierSchema = exports.createSupplierSchema.partial()

// ===================== Supplier Category =====================
exports.createSupplierCategorySchema = z.object({
  name: z.string().min(1, 'Category name is required'),
  description: z.string().optional().nullable(),
  status: statusEnum
})

exports.updateSupplierCategorySchema =
  exports.createSupplierCategorySchema.partial()

// ===================== Ingredient =====================
exports.createIngredientSchema = z.object({
  name: z.string().min(1, 'Ingredient name is required'),
  store: strToNum().optional().nullable(),
  category: strToNum().optional().nullable(),
  supplier: strToNum().optional().nullable(),
  stock: strToNum().optional().default(0),
  minStock: strToNum().optional().default(0),
  unit: z.string().optional().default('pcs'),
  baseUnit: z.string().optional().default('pcs'),
  conversionFactor: z.coerce.string().optional().default('1'),
  costPrice: strToNum().optional().default(0),
  status: statusEnum
})

// Explicit (not createIngredientSchema.partial()): under zod 4 a partial
// schema still applies the create defaults, so an edit that omitted `stock`
// parsed it as 0 and silently zeroed the ingredient's stock (and reset
// unit/costPrice/status). Omitted = unchanged.
exports.updateIngredientSchema = z.object({
  name: z.string().min(1, 'Ingredient name is required').optional(),
  store: strToNum().optional().nullable(),
  category: strToNum().optional().nullable(),
  supplier: strToNum().optional().nullable(),
  stock: strToNum().optional(),
  minStock: strToNum().optional(),
  unit: z.string().optional(),
  baseUnit: z.string().optional(),
  conversionFactor: z.coerce.string().optional(),
  costPrice: strToNum().optional(),
  status: statusEnumBase.optional()
})

exports.adjustIngredientStockSchema = z.object({
  type: z.enum(['add', 'subtract', 'set']),
  quantity: z.coerce.number().finite().nonnegative(),
  notes: z.string().max(500).optional().nullable()
})

// ===================== User =====================
const userBaseSchema = z.object({
  userName: z.string().min(1, 'Username is required'),
  password: z.string().min(6, 'Password min 6 characters'),
  confirmPassword: z.string().min(1, 'Confirm password is required'),
  email: z.string().email().optional().or(z.literal('')),
  userType: z.enum(['admin', 'user', 'kasir']).default('user'),
  fullName: z.string().optional().default(''),
  phoneNumber: z.string().optional().default(''),
  gender: z.string().optional().default(''),
  address: z.string().optional().default(''),
  dateOfBirth: z.string().optional().nullable(),
  placeOfBirth: z.string().optional().default(''),
  store: optionalStrToNum().nullable(),
  shift: strToNumNullable(),
  position: optionalStrToNum().nullable(),
  roleId: optionalStrToNum().nullable(),
  department: z.string().optional().nullable(),
  departmentId: optionalStrToNum().nullable(),
  employmentType: z.string().optional().nullable(),
  startDate: z.string().optional().nullable(),
  status: statusEnum,
  accessMenu: jsonField().optional().nullable(),
  monthlySalary: z.string().optional().nullable(),
  dailySalary: z.string().optional().nullable()
})
exports.createUserSchema = userBaseSchema.refine(
  (d) => d.password === d.confirmPassword,
  {
    message: 'Passwords do not match',
    path: ['confirmPassword']
  }
)

const employeeBaseSchema = z.object({
  userName: z.string().optional().nullable(),
  password: z.string().optional().nullable(),
  confirmPassword: z.string().optional().nullable(),
  email: z.string().email().optional().or(z.literal('')),
  userType: z.enum(['admin', 'user', 'kasir']).default('user'),
  fullName: z.string().optional().default(''),
  phoneNumber: z.string().optional().default(''),
  gender: z.string().optional().default(''),
  address: z.string().optional().default(''),
  dateOfBirth: z.string().optional().nullable(),
  placeOfBirth: z.string().optional().default(''),
  employeeId: z.string().optional().nullable(),
  store: optionalStrToNum().nullable(),
  shift: strToNumNullable(),
  position: optionalStrToNum().nullable(),
  roleId: optionalStrToNum().nullable(),
  department: z.string().optional().nullable(),
  departmentId: optionalStrToNum().nullable(),
  employmentType: z.string().optional().nullable(),
  startDate: z.string().optional().nullable(),
  endDate: z.string().optional().nullable(),
  contractDuration: z.string().optional().nullable(),
  status: statusEnum,
  accessMenu: jsonField().optional().nullable(),
  monthlySalary: z.string().optional().nullable(),
  dailySalary: z.string().optional().nullable()
})
exports.createEmployeeSchema = employeeBaseSchema.superRefine((d, ctx) => {
  if (d.status !== 'draft') {
    if (!d.userName)
      ctx.addIssue({
        code: 'custom',
        message: 'Username is required',
        path: ['userName']
      })
    if (!d.password || d.password.length < 6)
      ctx.addIssue({
        code: 'custom',
        message: 'Password min 6 characters',
        path: ['password']
      })
    if (!d.confirmPassword)
      ctx.addIssue({
        code: 'custom',
        message: 'Confirm password is required',
        path: ['confirmPassword']
      })
    if (d.password !== d.confirmPassword)
      ctx.addIssue({
        code: 'custom',
        message: 'Passwords do not match',
        path: ['confirmPassword']
      })
  }
})
exports.updateUserSchema = userBaseSchema.partial().extend({
  id: strToNum(),
  status: statusEnumBase.optional(),
  deletedDocuments: jsonField().optional().nullable()
})

// ===================== Discount =====================
exports.createDiscountSchema = z.object({
  name: z.string().min(1, 'Discount name is required'),
  store: strToNum().nullable().optional(),
  type: z.preprocess(
    (val) => (val === '' || val === undefined ? 'percent' : val),
    z.enum(['percent', 'nominal'])
  ),
  value: strToNum().optional().default(0),
  maximumDiscount: strToNum().optional().default(0),
  minimumOrder: strToNum().optional().default(0),
  startDate: z.string().optional().nullable(),
  endDate: z.string().optional().nullable(),
  code: z.string().nullable().optional(),
  conditions: jsonField().optional(),
  status: z.union([z.boolean(), z.string()]).optional().default(true),
  description: z.string().nullable().optional()
})

exports.updateDiscountSchema = exports.createDiscountSchema.partial()

// ===================== Purchase Order =====================
const poItemSchema = z.object({
  product: strToNum().optional().nullable(),
  productName: z.string().optional(),
  ingredient: strToNum().optional().nullable(),
  ingredientName: z.string().optional(),
  supplier: strToNum().optional().nullable(),
  quantity: strToNum(),
  price: strToNum().optional().default(0),
  unit: z.string().optional().default('pcs'),
  conversionToBase: strToNum().optional().default(1)
})

exports.createPurchaseOrderSchema = z.object({
  store: strToNum(),
  items: z.array(poItemSchema).min(1, 'At least one item is required'),
  notes: z.string().optional().default(''),
  discount: strToNum().optional().default(0),
  additionalCost: strToNum().optional().default(0),
  overDeliveryTolerance: strToNum().optional().default(10),
  pic: strToNum().optional().nullable(),
  createdBy: z.union([z.number(), strToNum()]).optional().nullable(),
  status: z
    .enum(['draft', 'pending', 'ordered', 'received', 'cancelled'])
    .optional()
    .default('draft'),
  orderDate: z.string().optional(),
  dueDate: z.string().optional().nullable(),
  paymentMethod: z.enum(['cash', 'credit']).optional().default('cash'),
  tenor: strToNum().optional().default(0),
  dpPercent: strToNum().optional().default(0),
  taxRate: strToNum()
    .optional()
    .default(0)
    .refine((v) => v >= 0 && v <= 100, {
      message: 'taxRate must be between 0 and 100'
    })
})

exports.updatePurchaseOrderSchema = z
  .object({
    store: strToNum().optional(),
    items: z.array(poItemSchema).optional(),
    notes: z.string().optional(),
    discount: strToNum().optional(),
    additionalCost: strToNum().optional(),
    additionalCostNotes: z.string().optional().nullable(),
    overDeliveryTolerance: strToNum().optional(),
    pic: strToNum().optional().nullable(),
    createdBy: z.union([z.number(), strToNum()]).optional().nullable(),
    orderDate: z.string().optional(),
    dueDate: z.string().optional().nullable(),
    paymentMethod: z.enum(['cash', 'credit']).optional(),
    tenor: strToNum().optional(),
    dpPercent: strToNum().optional(),
    taxRate: strToNum()
      .optional()
      .refine((v) => v === undefined || (v >= 0 && v <= 100), {
        message: 'taxRate must be between 0 and 100'
      }),
    status: z.enum(['draft', 'pending', 'ordered', 'received', 'cancelled']).optional()
  })
  .superRefine((data, ctx) => {
    if (data.taxRate !== undefined) {
      const n = Number(data.taxRate)
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        ctx.addIssue({
          code: 'custom',
          path: ['taxRate'],
          message: 'taxRate must be between 0 and 100'
        })
      }
    }
  })

// ===================== Goods Request (Permintaan Barang) =====================
const goodsRequestItemSchema = z.object({
  product: strToNum().optional().nullable(),
  productName: z.string().optional().nullable(),
  ingredient: strToNum().optional().nullable(),
  ingredientName: z.string().optional().nullable(),
  supplier: strToNum().optional().nullable(),
  qty: strToNum(),
  unit: z.string().optional().default('pcs'),
  notes: z.string().optional().nullable()
})

exports.createGoodsRequestSchema = z.object({
  store: strToNum().optional().nullable(),
  items: z
    .array(goodsRequestItemSchema)
    .min(1, 'At least one item is required'),
  requestedBy: z.string().optional().default(''),
  requestDate: z.string().optional().nullable(),
  neededDate: z.string().optional().nullable(),
  notes: z.string().optional().default('')
})

exports.updateGoodsRequestSchema = exports.createGoodsRequestSchema.partial()

// ===================== Reservation =====================
exports.createReservationSchema = z.object({
  store: strToNum(),
  customerName: z.string().min(1, 'Customer name is required'),
  customerPhone: z.string().optional().nullable(),
  customerEmail: z.string().email().optional().or(z.literal('')),
  reservationDate: z.string().min(1, 'Date is required'),
  startTime: z.string().min(1, 'Time is required'),
  endTime: z.string().optional().nullable(),
  guestCount: strToNum().optional().default(1),
  tableId: strToNum().optional().nullable(),
  notes: z.string().optional().default(''),
  status: z
    .enum(['pending', 'confirmed', 'completed', 'cancelled', 'no_show'])
    .optional()
    .default('pending')
})

exports.updateReservationSchema = exports.createReservationSchema.partial()

// ===================== Table =====================
exports.createTableSchema = z.object({
  store: strToNum().optional().nullable(),
  name: z.string().min(1, 'Table name is required'),
  capacity: strToNum().optional().default(4),
  status: z
    .enum(['available', 'occupied', 'reserved', 'maintenance'])
    .optional()
    .default('available'),
  description: z.string().optional().nullable()
})

exports.updateTableSchema = exports.createTableSchema.partial().extend({
  id: strToNum()
})

// ===================== Tax Config =====================
exports.createTaxConfigSchema = z.object({
  store: strToNum().optional().nullable(),
  name: z.string().min(1, 'Tax name is required'),
  rate: z.union([z.number(), z.string()])
    .transform((v) => {
      if (typeof v === 'number') return v
      return parseFloat(v)
    })
    // T1: a rate must be finite. NaN (e.g. from a non-numeric string)
    // and Infinity can never be valid under any rate policy; finite
    // decimals, zero, negatives, and large integers remain accepted
    // (no maximum or decimal policy decided here). Flows into the
    // update schema via .partial() below.
    .refine((v) => Number.isFinite(v), {
      message: 'rate must be a finite number'
    }),
  type: z.enum(['ppn', 'service_charge', 'other']).optional().default('ppn'),
  status: statusEnum,
  description: z.string().optional().nullable()
})

exports.updateTaxConfigSchema = exports.createTaxConfigSchema.partial().extend({
  // P1: `.partial()` does NOT strip the create-schema `.default()`s, so the
  // bare (defaultless) versions are restored here — same convention as
  // updateProductSchema/inventoryModeEnumBase above. Otherwise an omitted
  // `type`/`status` on a partial update would parse to 'ppn'/'active' and
  // silently convert service-charge or inactive rows. Omitted fields parse
  // to undefined and the controller keeps the persisted values.
  type: z.enum(['ppn', 'service_charge', 'other']).optional(),
  status: statusEnumBase.optional()
})

// ===================== Expense =====================
exports.createExpenseSchema = z
  .object({
    store: strToNum().optional().nullable(),
    categoryId: strToNum().optional().nullable(),
    amount: strToNum().optional().nullable(),
    description: z.string().optional().nullable(),
    date: z.string().optional(),
    notes: z.string().optional().default(''),
    payee: z.string().optional().nullable(),
    employeeId: strToNum().optional().nullable(),
    paymentMethod: z.enum(['cash', 'bank', 'e-wallet']).optional().nullable(),
    frequency: z
      .enum(['once', 'daily', 'weekly', 'monthly', 'yearly'])
      .optional()
      .nullable()
      .transform((v) => (v === 'once' ? null : v)),
    recurringEndDate: z.string().optional().nullable(),
    status: z
      .enum(['draft', 'pending', 'approved', 'rejected'])
      .optional()
      .default('pending')
  })
  .passthrough()

// F22-B9-01: createExpenseSchema.partial() alone still carries the base
// schema's `.default('pending')` on `status` — Zod's .partial() only makes
// a field optional, it doesn't strip an existing default. That meant a
// PUT /expense/edit/:id body with no `status` at all had 'pending'
// silently injected by validation, so the controller's
// `status: status || expense.status` saw a truthy value and overwrote an
// approved (or rejected) expense's status. Overriding `status` here to a
// plain optional enum (no default) makes an omitted field parse to
// undefined, so the controller's existing fallback correctly preserves
// the expense's current status. createExpenseSchema itself is untouched —
// create still defaults a missing status to 'pending'.
exports.updateExpenseSchema = exports.createExpenseSchema.partial().extend({
  status: z.enum(['draft', 'pending', 'approved', 'rejected']).optional()
})

exports.bulkCreateExpensesSchema = z
  .object({
    store: strToNum().optional().nullable(),
    items: z
      .array(
        z
          .object({
            store: strToNum().optional().nullable(),
            categoryId: strToNum().optional().nullable(),
            category: strToNum().optional().nullable(),
            amount: strToNum().optional().nullable(),
            description: z.string().optional().nullable(),
            date: z.string().optional(),
            notes: z.string().optional().default(''),
            payee: z.string().optional().nullable(),
            employeeId: strToNum().optional().nullable(),
            paymentMethod: z
              .enum(['cash', 'bank', 'e-wallet'])
              .optional()
              .nullable(),
            frequency: z
              .enum(['once', 'daily', 'weekly', 'monthly', 'yearly'])
              .optional()
              .nullable()
              .transform((v) => (v === 'once' ? null : v)),
            recurringEndDate: z.string().optional().nullable(),
            status: z
              .enum(['draft', 'pending', 'approved', 'rejected'])
              .optional()
              .default('pending')
          })
          .passthrough()
      )
      .min(1, 'At least one expense item is required')
  })
  .passthrough()

exports.generateSalarySchema = z
  .object({
    store: strToNum().optional().nullable(),
    month: z.string().optional().default(''),
    employeeIds: z.array(strToNum()).optional().default([]),
    paymentMethod: z
      .enum(['cash', 'bank', 'e-wallet'])
      .optional()
      .default('cash')
  })
  .passthrough()

exports.markExpensePaidSchema = z
  .object({
    paymentDate: z.string().optional().nullable(),
    paymentMethod: z.enum(['cash', 'bank', 'e-wallet']).optional().nullable(),
    note: z.string().optional().nullable()
  })
  .passthrough()

// ===================== Member =====================
exports.createMemberSchema = z.object({
  store: strToNum().optional().nullable(),
  nameMember: z.string().min(1, 'Member name is required'),
  phoneNumber: memberPhoneNumber(),
  email: z.string().email().optional().or(z.literal('')),
  point: strToNum().optional().default(0),
  tier: strToNum().optional().nullable(),
  birthDate: z.string().optional().nullable(),
  gender: z.string().optional().default(''),
  address: z.string().optional().nullable(),
  createdBy: strToNum().optional(),
  status: z.string().optional().default('active')
})

exports.updateMemberSchema = exports.createMemberSchema.partial().extend({
  phoneNumber: memberPhoneNumber({ allowGuest: true })
})

// ===================== Goods Receipt =====================
const grItemSchema = z.object({
  purchaseOrderItem: strToNum().optional().nullable(),
  product: strToNum().optional().nullable(),
  productName: z.string().optional(),
  ingredient: strToNum().optional().nullable(),
  ingredientName: z.string().optional(),
  qtyReceived: strToNum().optional().default(0),
  quantity: strToNum().optional().default(0),
  conditionNotes: z.string().optional().default(''),
  unit: z.string().optional().default('pcs'),
  price: strToNum().optional().default(0),
  costPrice: strToNum().optional().default(0),
  conversionToBase: strToNum().optional().default(1),
  batchNumber: z.string().optional().nullable(),
  expiryDate: z.string().optional().nullable()
})

exports.createGoodsReceiptSchema = z.object({
  store: strToNum().optional().nullable(),
  purchaseOrderId: strToNum().optional().nullable(),
  supplier: strToNum().optional().nullable(),
  pic: strToNum().optional().nullable(),
  documentation: z.string().optional().nullable(),
  suratJalan: z.string().optional().nullable(),
  taxInvoiceNo: z.string().optional().nullable(),
  shippingCost: strToNum().optional().default(0),
  items: z.array(grItemSchema).min(1, 'At least one item is required'),
  notes: z.string().optional().default(''),
  receivedDate: z.string().optional(),
  idempotencyKey: z.string().max(255).optional().nullable(),
  status: z
    .enum(['draft', 'completed', 'cancelled'])
    .optional()
    .default('completed')
})

exports.updateGoodsReceiptSchema = exports.createGoodsReceiptSchema.partial().extend({
  // F22-B9-01 (same trap as updateExpenseSchema): .partial() alone keeps
  // the base schema's `.default('completed')` on `status`, so an update
  // body without `status` had 'completed' silently injected — every
  // items/metadata edit on a draft completed it as a side effect (and,
  // post-P1-5, posted its stock). A plain optional enum leaves an omitted
  // field undefined so the controller preserves the current status.
  status: z.enum(['draft', 'completed', 'cancelled']).optional()
})

// ===================== Production Order =====================
exports.createProductionOrderSchema = z.object({
  store: strToNum().optional().nullable(),
  productItemId: strToNum(),
  plannedQty: strToNum(),
  scheduledDate: z.string().optional().nullable(),
  notes: z.string().optional().default(''),
  status: z
    .enum(['planned', 'in_progress', 'completed', 'cancelled', 'draft'])
    .optional()
    .default('planned')
})

exports.updateProductionOrderSchema =
  exports.createProductionOrderSchema.partial()

// ===================== Stock Opname =====================
exports.createStockOpnameSchema = z.object({
  store: strToNum().optional().nullable(),
  auditDate: z.string().optional().nullable(),
  auditor: z.string().optional().nullable(),
  notes: z.string().optional().default(''),
  status: statusEnum,
  items: z.array(z.record(z.any())).optional().default([])
})

exports.updateStockOpnameSchema = exports.createStockOpnameSchema.partial()

// ===================== Shift =====================
const { SHIFT_TYPES } = require('../../utils/shiftConstants')
const shiftTypeSchema = z.enum(SHIFT_TYPES, {
  message: `Tipe shift harus salah satu dari: ${SHIFT_TYPES.join(', ')}`
})

exports.createShiftSchema = z.object({
  store: z.any().optional().nullable(),
  nama_shift: z.string().min(1, 'Shift name is required'),
  tipe_shift: shiftTypeSchema.optional().default(SHIFT_TYPES[0]),
  jam_mulai: z.string().min(1, 'Start time is required'),
  jam_selesai: z.string().min(1, 'End time is required'),
  tanggal_mulai: z.string().optional().nullable(),
  tanggal_selesai: z.string().optional().nullable(),
  karyawan: jsonField().optional().default([]),
  status: statusEnum
})

exports.updateShiftSchema = exports.createShiftSchema.partial().extend({
  id: strToNum()
})

// ===================== Department / Position =====================
exports.createDepartmentSchema = z.object({
  store: strToNum().optional().nullable(),
  name: z.string().min(1, 'Department name is required'),
  description: z.string().optional().nullable(),
  status: statusEnum
})

exports.updateDepartmentSchema = exports.createDepartmentSchema
  .partial()
  .extend({
    id: strToNum()
  })

// ===================== Shift Template =====================
exports.createShiftTemplateSchema = z.object({
  store: strToNum().optional().nullable(),
  name: z.string().min(1, 'Template name is required'),
  startTime: z.string().min(1, 'Start time is required'),
  endTime: z.string().min(1, 'End time is required'),
  description: z.string().optional().nullable(),
  status: statusEnum
})

exports.updateShiftTemplateSchema = exports.createShiftTemplateSchema
  .partial()
  .extend({
    id: strToNum()
  })

exports.createPositionSchema = z.object({
  store: strToNum().optional().nullable(),
  name: z.string().min(1, 'Position name is required'),
  departmentId: strToNum().optional().nullable(),
  description: z.string().optional().nullable(),
  status: statusEnum
})

exports.updatePositionSchema = exports.createPositionSchema.partial().extend({
  id: strToNum()
})

// ===================== Cash Register =====================
exports.createCashRegisterSchema = z.object({
  store: strToNum().optional().nullable(),
  storeId: strToNum().optional().nullable(),
  openingBalance: strToNum().optional().default(0),
  shift: strToNum().optional().nullable(),
  notes: z.string().optional().default(''),
  // Phase 39 Batch 6C: explicit cashier confirmation to also reset stale
  // OCCUPIED-with-no-active-order tables to AVAILABLE as part of opening.
  confirmTableReset: z.boolean().optional().default(false)
})

exports.updateCashRegisterSchema = z.object({
  store: strToNum().optional().nullable(),
  storeId: strToNum().optional().nullable(),
  closingBalance: strToNum().optional().nullable(),
  notes: z.string().optional().default('')
})

// ===================== Cash Movement =====================
// `amount > 0` and "notes required when reasonCode='other'" are
// deliberately NOT enforced here via .refine()/.superRefine() — every
// ZodError this schema could throw resolves to 400 via
// api/middleware/validate.js, but the F2 blueprint's API contract
// specifies 422 (semantic validation) for both of these cases. They are
// enforced in the createMovement controller instead, which throws with
// e.statusCode = 422. This schema only validates shape/type.
exports.createCashMovementSchema = z.object({
  type: z.enum(['cash_in', 'cash_out']),
  reasonCode: z.enum([
    'float_topup',
    'bank_drop',
    'petty_cash',
    'owner_draw',
    'change_fund',
    'correction',
    'other'
  ]),
  amount: z.any().transform((v) => Number(v)),
  notes: z.string().optional().default(''),
  idempotencyKey: z.string().max(255).optional().nullable()
})

exports.decideCashMovementSchema = z.object({
  decision: z.enum(['approve', 'reject'])
})

exports.reverseCashMovementSchema = z.object({
  notes: z.string().optional().default('')
})

exports.decideVarianceSchema = z.object({
  decision: z.enum(['approve', 'reject'])
})

// ===================== BOM =====================
exports.createBomSchema = z.object({
  productId: strToNum(),
  name: z.string().optional().default(''),
  notes: z.string().optional().default(''),
  // Only an 'active' recipe deducts at sale; 'draft'/'inactive' never do.
  // An unknown value (a typo) is refused instead of silently disabling it.
  status: statusEnumBase.optional().default('active'),
  createdBy: strToNum().optional(),
  lines: z
    .array(
      z.object({
        ingredientId: strToNum(),
        qty: z.union([z.number(), strToNum()]),
        unit: z.string().optional().default('pcs'),
        notes: z.string().optional().default('')
      })
    )
    .min(1, 'At least one ingredient is required')
})

// Explicit (not createBomSchema.partial()): under zod 4 a partial schema still
// applies the create defaults, so an update that omitted `status`/`name`
// silently re-activated a draft BOM and blanked its name. Omitted = unchanged.
exports.updateBomSchema = z.object({
  name: z.string().optional(),
  notes: z.string().optional(),
  status: statusEnumBase.optional(),
  lines: z
    .array(
      z.object({
        ingredientId: strToNum(),
        qty: z.union([z.number(), strToNum()]),
        unit: z.string().optional().default('pcs'),
        notes: z.string().optional().default('')
      })
    )
    .min(1, 'At least one ingredient is required')
    .optional()
})

// ===================== Stock Transfer =====================
exports.createStockTransferSchema = z.object({
  fromStore: strToNum(),
  toStore: strToNum(),
  transferredBy: z.string().optional().default(''),
  items: z
    .array(
      z.object({
        product: strToNum().optional(),
        productId: strToNum().optional(),
        quantity: strToNum().optional(),
        qty: strToNum().optional(),
        unit: z.string().optional().default('pcs'),
        notes: z.string().optional().default('')
      })
    )
    .min(1, 'At least one item is required'),
  notes: z.string().optional().default('')
})

// ===================== Checkout / POS =====================
exports.createCheckoutSchema = z.object({
  idCustomer: z.union([z.number(), strToNum()]).optional(),
  discountId: z.union([z.number(), strToNum()]).nullable().optional(),
  paymentMethod: z.string().min(1),
  paymentAmount: z.union([z.number(), strToNum()]),
  notes: z.string().optional().default(''),
  items: z
    .array(
      z.object({
        idProduct: z.union([z.number(), strToNum()]),
        qty: z.union([z.number(), strToNum()]),
        price: z.union([z.number(), strToNum()]).optional(),
        notes: z.string().optional().default('')
      })
    )
    .min(1, 'At least one item is required')
})

// ===================== Type Payment =====================
exports.createTypePaymentSchema = z.object({
  name: z.string().min(1, 'name is required'),
  icon: z.string().optional().default(''),
  type: z.string().optional().default('cash'),
  status: z.union([z.boolean(), z.string()]).optional().default('active'),
  store: z
    .union([z.string(), z.array(z.number().int()), z.array(strToNum())])
    .optional()
    .nullable()
    .transform((v) => {
      if (v === null || v === undefined || v === '') return null
      if (typeof v === 'string') {
        if (v === 'all') return 'all'
        try {
          const p = JSON.parse(v)
          return Array.isArray(p) ? p.map(Number) : [Number(p)]
        } catch {
          return [Number(v)]
        }
      }
      return v.map(Number)
    })
})
exports.updateTypePaymentSchema = exports.createTypePaymentSchema.partial()

// ===================== Expense Category =====================
exports.createExpenseCategorySchema = z.object({
  name: z.string().min(1, 'name is required'),
  description: z.string().optional().default(''),
  icon: z.string().optional().default(''),
  accountCode: z.string().optional().default(''),
  status: statusEnum
})
exports.updateExpenseCategorySchema =
  exports.createExpenseCategorySchema.partial()

// ===================== Ingredient Category =====================
exports.createIngredientCategorySchema = z.object({
  name: z.string().min(1, 'name is required'),
  description: z.string().optional().default(''),
  status: z.enum(['active', 'inactive', 'draft']).optional().default('active')
})
exports.updateIngredientCategorySchema =
  exports.createIngredientCategorySchema.partial()

// ===================== Member Tier =====================
// Benefits historically arrived as a newline-joined string from the FE
// (formData.perks.map(...).join("\n")), while the DB column is JSONB array.
// An empty benefits list therefore arrived as "" (empty string) and the
// schema's `z.array(... )` rejected it with "expected array, received
// string" — the exact user-test failure. Preprocess coerces both "" and
// any newline-delimited string into the canonical array form so empty,
// string, and array callers all converge to [] or ["a","b"] without
// changing the stored contract (JSONB array).
const normalizeBenefitsInput = (v) => {
  if (typeof v === 'string') {
    if (v.trim() === '') return []
    return v
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  if (Array.isArray(v)) {
    return v
      .map((b) => (typeof b === 'string' ? b : (b?.text ?? '')))
      .map((s) => (typeof s === 'string' ? s.trim() : ''))
      .filter(Boolean)
  }
  return v
}

exports.createMemberTierSchema = z.object({
  name: z.string().min(1, 'name is required'),
  minPoints: z.union([z.number(), strToNum()]).optional().default(0),
  maxPoints: z.union([z.number(), strToNum()]).nullable().optional(),
  discountPercent: z.union([z.number(), strToNum()]).optional().default(0),
  pointMultiplier: z.union([z.number(), strToNum()]).optional().default(1),
  benefits: z.preprocess(
    normalizeBenefitsInput,
    z.array(z.union([z.string(), z.object({ text: z.string() })])).optional().default([])
  ),
  color: z.string().optional().default(''),
  status: statusEnum
})
exports.updateMemberTierSchema = exports.createMemberTierSchema.partial()

// ===================== Role =====================
// R-07 / DR-12 §35.4: accessMenu is a presentation list (never the security
// boundary), but it must stay well-formed: one entry per menu key with
// boolean (or null = not applicable) action flags.
const roleAccessMenuSchema = z.array(
  z
    .object({ menu: z.string().trim().min(1, 'menu is required') })
    .catchall(z.union([z.boolean(), z.null()]))
)
exports.roleAccessMenuSchema = roleAccessMenuSchema

exports.createRoleSchema = z.object({
  name: z.string().min(1, 'name is required'),
  description: z.string().optional().default(''),
  status: z.string().optional().default('active'),
  createdBy: z.union([z.number(), z.string()]).optional().nullable(),
  roleType: z
    .enum(['super_admin', 'admin', 'kasir', 'user'])
    .optional()
    .default('user'),
  store: z.union([z.number(), z.string()]).optional().nullable(),
  accessMenu: roleAccessMenuSchema.optional().default([]),
  permissions: z
    .union([z.string(), z.array(z.any()), z.record(z.any())])
    .optional()
    .default({})
})
// R-02: no defaults here. zod 4 `.partial()` keeps `.default()` values, so
// deriving this from createRoleSchema filled an omitted roleType with 'user'
// and accessMenu with [] — every edit that left them out downgraded the role.
// An edit changes only the fields it sends.
exports.updateRoleSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  name: z.string().min(1, 'name is required').optional(),
  description: z.string().optional(),
  status: z.string().optional(),
  roleType: z.enum(['super_admin', 'admin', 'kasir', 'user']).optional(),
  store: z.union([z.number(), z.string()]).optional().nullable(),
  accessMenu: roleAccessMenuSchema.optional(),
  createdBy: z.union([z.number(), z.string()]).optional().nullable(),
  modifiedBy: z.union([z.number(), z.string()]).optional().nullable(),
  permissions: z
    .union([z.string(), z.array(z.any()), z.record(z.any())])
    .optional()
})

// ===================== Purchase Payment =====================
exports.createPurchasePaymentSchema = z.object({
  purchaseOrder: z.union([z.number(), strToNum()]),
  supplier: z.union([z.number(), strToNum()]).optional(),
  amount: z.union([z.number(), strToNum()]),
  paymentMethod: z.string().min(1),
  paymentDate: z.string().optional(),
  reference: z.string().optional().default(''),
  notes: z.string().optional().default(''),
  idempotencyKey: z.string().max(255).optional().nullable()
})
exports.updatePurchasePaymentSchema =
  exports.createPurchasePaymentSchema.partial()

// ===================== Purchase Return =====================
exports.createPurchaseReturnSchema = z.object({
  purchaseOrder: z.union([z.number(), strToNum()]),
  reason: z.string().optional().nullable(),
  returnedBy: z
    .union([z.number(), z.string().min(1)])
    .optional()
    .nullable(),
  items: z.array(z.record(z.any())).min(1, 'At least one item is required'),
  notes: z.string().optional().nullable()
})
exports.updatePurchaseReturnSchema =
  exports.createPurchaseReturnSchema.partial()

// ===================== Split Bill =====================
exports.createSplitBillSchema = z.object({
  order: z.union([z.number(), strToNum()]),
  items: z
    .array(
      z.object({
        amount: z.union([z.number(), strToNum()])
      })
    )
    .min(1, 'At least one item is required'),
  idempotencyKey: z.string().max(255).optional().nullable()
})

// ===================== Currency =====================
exports.createCurrencySchema = z.object({
  code: z.string().min(1, 'code is required').max(10),
  name: z.string().min(1, 'name is required'),
  symbol: z.string().optional().default(''),
  exchangeRate: z.union([z.number(), strToNum()]).optional().default(1),
  isDefault: z
    .union([
      z.boolean(),
      z.string().transform((v) => v === 'true' || v === '1')
    ])
    .optional()
    .default(false)
})
exports.updateCurrencySchema = exports.createCurrencySchema.partial()

// ===================== Social Media =====================
exports.createSocialMediaSchema = z.object({
  name: z.string().min(1, 'name is required'),
  url: z.string().min(1, 'url is required'),
  icon: z.string().optional().default(''),
  isActive: z
    .union([
      z.boolean(),
      z.string().transform((v) => v === 'true' || v === '1')
    ])
    .optional()
    .default(true)
})
exports.updateSocialMediaSchema = exports.createSocialMediaSchema.partial()

// ===================== FAQ =====================
exports.createFaqSchema = z.object({
  question: z.string().min(1, 'question is required'),
  answer: z.string().min(1, 'answer is required'),
  category: z.string().optional().default(''),
  order: z.union([z.number(), strToNum()]).optional().default(0),
  isActive: z
    .union([
      z.boolean(),
      z.string().transform((v) => v === 'true' || v === '1')
    ])
    .optional()
    .default(true)
})
exports.updateFaqSchema = exports.createFaqSchema.partial()

// ===================== Notification =====================
exports.createNotificationSchema = z.object({
  title: z.string().min(1, 'title is required'),
  message: z.string().min(1, 'message is required'),
  type: z.string().optional().default('info'),
  targetUser: z.union([z.number(), strToNum()]).nullable().optional()
})

// ===================== Accounts Receivable =====================
exports.createAccountsReceivableSchema = z.object({
  orderId: z.union([z.number(), strToNum()]),
  customerId: z.union([z.number(), strToNum()]).optional().nullable(),
  customerName: z.string().optional().default(''),
  totalAmount: z.union([z.number(), strToNum()]),
  paidAmount: z.union([z.number(), strToNum()]).optional().default(0),
  dueDate: z.string().optional(),
  creditTerm: z.union([z.number(), strToNum()]).optional().nullable(),
  status: z.string().optional(),
  notes: z.string().optional().default('')
})
exports.updateAccountsReceivableSchema =
  exports.createAccountsReceivableSchema.partial()

// ===================== Invoice =====================
exports.createInvoiceSchema = z.object({
  orderId: z.union([z.number(), strToNum()]),
  customerName: z.string().optional().default(''),
  notes: z.string().optional().default('')
})
exports.updateInvoiceSchema = exports.createInvoiceSchema.partial()

// ===================== Invoice Setting =====================
exports.updateInvoiceSettingSchema = z.object({
  store: strToNum(),
  showStoreName: z.union([z.boolean(), z.string()]).optional(),
  showAddress: z.union([z.boolean(), z.string()]).optional(),
  showMemberInfo: z.union([z.boolean(), z.string()]).optional(),
  showLogo: z.union([z.boolean(), z.string()]).optional(),
  showSocialMedia: z.union([z.boolean(), z.string()]).optional(),
  socialMediaVisibility: z.union([z.string(), z.record(z.any())]).optional(),
  addressFieldsVisibility: z.union([z.string(), z.record(z.any())]).optional(),
  memberFieldsVisibility: z.union([z.string(), z.record(z.any())]).optional(),
  footer: z.string().optional().default('Terima kasih atas kunjungan Anda'),
  removeLogo: z.union([z.boolean(), z.string()]).optional(),
  logo: z.any().optional()
})

// ===================== POS endpoints =====================
exports.createPosTransferSchema = z.object({
  fromStore: strToNum(),
  toStore: strToNum(),
  idempotencyKey: z.string().max(255).optional().nullable(),
  items: z
    .array(
      z.object({
        productId: strToNum(),
        qty: strToNum(),
        unit: z.string().optional().default('pcs'),
        notes: z.string().optional().default('')
      })
    )
    .min(1, 'At least one item'),
  notes: z.string().optional().default(''),
  transferredBy: z.string().optional().default('')
})

exports.createPosAdjustSchema = z.object({
  productId: strToNum(),
  qty: strToNum().optional(),
  sign: z.enum(['+', '-']).optional(),
  value: strToNum().optional(),
  reason: z.string().optional().default(''),
  storeId: strToNum().optional()
})

exports.createPosReturnSchema = z.object({
  items: z.array(z.record(z.any())).min(1, 'At least one item'),
  reason: z.string().optional().default(''),
  returnedBy: strToNum().optional()
})

exports.updatePriceByStoreSchema = z.object({
  productId: strToNum(),
  storePrices: z
    .array(
      z.object({
        storeId: z.union([z.literal('base'), strToNum()]),
        price: z
          .any()
          .refine((v) => typeof v !== 'boolean', { message: 'price must not be a boolean' })
          .transform((v) => {
            if (v === '' || v === null || v === undefined) return undefined
            return Number(v)
          })
          .refine((v) => v !== undefined, { message: 'price is required' })
          .refine((v) => Number.isInteger(v), { message: 'price must be an integer' })
          .refine((v) => v >= 0, { message: 'price must not be negative' })
          .refine((v) => v <= 2147483647, { message: 'price exceeds maximum (2147483647)' })
          .refine((v) => Number.isSafeInteger(v), { message: 'price is not a safe integer' })
      })
    )
    .min(1, 'At least one store price is required')
})

exports.sendInvoiceEmailSchema = z.object({
  orderId: z.union([z.number(), strToNum()]),
  email: z.string().email('Invalid email')
})

exports.addBatchSchema = z.object({
  productId: strToNum(),
  batchCode: z.string().min(1, 'Batch code is required'),
  expiryDate: z.string().optional().nullable(),
  qty: strToNum(),
  store: strToNum()
})

// ===================== DELIVERY =====================
exports.createDriverSchema = z.object({
  name: z.string().min(1, 'Driver name is required'),
  store: storeArray().optional().nullable(),
  phone: z.string().optional().nullable(),
  email: z.string().email().optional().or(z.literal('')),
  vehicleType: z.string().optional().nullable(),
  vehiclePlate: z.string().optional().nullable(),
  status: statusEnum,
  notes: z.string().optional().nullable()
})
exports.updateDriverSchema = exports.createDriverSchema.partial()

exports.createDeliveryOrderSchema = z.object({
  order: optionalStrToNum(),
  store: strToNum(),
  customerName: z.string().min(1, 'Customer name is required'),
  customerPhone: z.string().optional().nullable(),
  deliveryAddress: z.string().min(1, 'Delivery address is required'),
  deliveryNotes: z.string().optional().nullable(),
  destinationLat: optionalStrToNum(),
  destinationLng: optionalStrToNum(),
  deliveryFee: optionalStrToNum().default(0),
  totalDistance: optionalStrToNum(),
  source: z.string().optional().default('pos')
})

exports.updateDeliveryStatusSchema = z.object({
  id: strToNum(),
  status: z.enum([
    'pending',
    'assigned',
    'picked_up',
    'in_transit',
    'delivered',
    'cancelled'
  ]),
  note: z.string().optional().nullable(),
  changedBy: optionalStrToNum(),
  changedByName: z.string().optional().nullable()
})

exports.assignDriverSchema = z.object({
  driverId: strToNum(),
  driverName: z.string().optional().nullable()
})

exports.cancelDeliverySchema = z.object({
  reason: z.string().min(1, 'Cancellation reason is required')
})

exports.updateDriverStatusSchema = z.object({
  status: z.enum(['active', 'inactive', 'busy', 'offline', 'draft'])
})

exports.marketplaceConfigSchema = z.object({
  store: strToNum(),
  gofood: z
    .object({
      enabled: z.boolean().optional().default(false),
      merchantId: z.string().optional().nullable(),
      apiKey: z.string().optional().nullable()
    })
    .optional()
    .nullable(),
  grabfood: z
    .object({
      enabled: z.boolean().optional().default(false),
      merchantId: z.string().optional().nullable(),
      apiKey: z.string().optional().nullable()
    })
    .optional()
    .nullable(),
  shopeefood: z
    .object({
      enabled: z.boolean().optional().default(false),
      merchantId: z.string().optional().nullable(),
      apiKey: z.string().optional().nullable()
    })
    .optional()
    .nullable()
})

// ===================== FAQ =====================
exports.askFaqSchema = z.object({
  question: z.string().min(1, 'Question is required')
})

// ===================== Queue / Waitlist =====================
exports.createQueueSchema = z.object({
  store: strToNum(),
  customerName: z.string().min(1, 'Customer name is required'),
  customerPhone: z.string().optional().nullable(),
  partySize: z
    .number()
    .int()
    .min(1, 'Party size must be at least 1')
    .default(1),
  priority: z
    .enum(['normal', 'vip', 'elderly', 'pregnant', 'disabled'])
    .default('normal'),
  estimatedWaitMinutes: z.number().int().optional().nullable(),
  notes: z.string().optional().nullable(),
  assignedTo: strToNum().optional().nullable()
})

exports.updateQueueSchema = z.object({
  customerName: z.string().min(1).optional(),
  customerPhone: z.string().optional().nullable(),
  partySize: z.number().int().min(1).optional(),
  priority: z
    .enum(['normal', 'vip', 'elderly', 'pregnant', 'disabled'])
    .optional(),
  estimatedWaitMinutes: z.number().int().optional().nullable(),
  notes: z.string().optional().nullable(),
  assignedTo: strToNum().optional().nullable()
})

exports.updateQueueStatusSchema = z.object({
  status: z.enum(['waiting', 'seated', 'cancelled', 'no_show', 'expired']),
  tableId: strToNum().optional().nullable(),
  notes: z.string().optional().nullable()
})

// ===================== Supplier Performance =====================
exports.calculateSupplierScoreSchema = z.object({
  store: storeParam(),
  supplierId: strToNum(),
  period: z.enum(['monthly', 'quarterly', 'yearly', 'all_time']),
  periodStart: z.string().optional().nullable(),
  periodEnd: z.string().optional().nullable()
})

exports.updateSupplierScoreNoteSchema = z.object({
  notes: z.string().optional().nullable()
})

// ===================== Automated Promotions =====================
exports.createPromoCampaignSchema = z.object({
  // ponytail: null = "semua toko" — strToNumNullable agar FE boleh kirim null
  store: strToNumNullable(),
  name: z.string().min(1, 'Campaign name is required'),
  description: z.string().optional().nullable(),
  code: z.string().optional().nullable(),
  type: z.enum([
    'happy_hour',
    'birthday',
    'buy_x_get_y',
    'spend_get',
    'manual',
    'automatic'
  ]),
  discountType: z
    .enum(['percentage', 'fixed', 'free_item', 'buy_x_get_y'])
    .default('percentage'),
  discountValue: z.number().int().min(0).default(0),
  maxDiscount: z.number().int().optional().nullable(),
  minPurchase: z.number().int().min(0).default(0),
  startDate: z.string().min(1, 'Start date is required'),
  endDate: z.string().min(1, 'End date is required'),
  startTime: z.string().optional().nullable(),
  endTime: z.string().optional().nullable(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).optional().nullable(),
  applicableTo: z
    .enum([
      'all',
      'specific_products',
      'specific_categories',
      'specific_members'
    ])
    .default('all'),
  applicableIds: z.array(z.number().int()).optional().nullable(),
  maxUsageTotal: z.number().int().optional().nullable(),
  maxUsagePerMember: z.number().int().optional().nullable(),
  priority: z.number().int().min(0).default(0),
  isCombinable: z.boolean().default(false),
  autoActivate: z.boolean().default(false),
  rules: z
    .array(
      z.object({
        ruleType: z.enum([
          'time',
          'birthday',
          'buy_x_get_y',
          'spend_threshold',
          'member_tier',
          'first_purchase',
          'custom'
        ]),
        condition: z.record(z.any()),
        priority: z.number().int().min(0).default(0)
      })
    )
    .optional(),
  rewards: z
    .array(
      z.object({
        rewardType: z.enum([
          'discount_percentage',
          'discount_fixed',
          'free_item',
          'buy_x_get_y',
          'points_multiplier',
          'cashback'
        ]),
        rewardValue: z.number().int().min(0),
        maxRewardValue: z.number().int().optional().nullable(),
        productId: z.number().int().optional().nullable(),
        productIds: z.array(z.number().int()).optional().nullable(),
        quantity: z.number().int().min(1).default(1),
        condition: z.record(z.any()).optional().nullable(),
        priority: z.number().int().min(0).default(0)
      })
    )
    .optional()
})

exports.updatePromoCampaignSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  code: z.string().optional().nullable(),
  type: z
    .enum([
      'happy_hour',
      'birthday',
      'buy_x_get_y',
      'spend_get',
      'manual',
      'automatic'
    ])
    .optional(),
  discountType: z
    .enum(['percentage', 'fixed', 'free_item', 'buy_x_get_y'])
    .optional(),
  discountValue: z.number().int().min(0).optional(),
  maxDiscount: z.number().int().optional().nullable(),
  minPurchase: z.number().int().min(0).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  startTime: z.string().optional().nullable(),
  endTime: z.string().optional().nullable(),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).optional().nullable(),
  applicableTo: z
    .enum([
      'all',
      'specific_products',
      'specific_categories',
      'specific_members'
    ])
    .optional(),
  applicableIds: z.array(z.number().int()).optional().nullable(),
  maxUsageTotal: z.number().int().optional().nullable(),
  maxUsagePerMember: z.number().int().optional().nullable(),
  priority: z.number().int().min(0).optional(),
  isCombinable: z.boolean().optional(),
  autoActivate: z.boolean().optional(),
  status: z
    .enum(['draft', 'active', 'paused', 'expired', 'cancelled'])
    .optional()
})

exports.applyPromoSchema = z.object({
  store: strToNum(),
  orderId: strToNum().optional().nullable(),
  memberId: strToNum().optional().nullable(),
  code: z.string().optional(),
  cartItems: z
    .array(
      z.object({
        productId: z.number().int(),
        quantity: z.number().int().min(1),
        price: z.number().int().min(0)
      })
    )
    .optional(),
  subtotal: z.number().int().min(0).optional()
})

// ===================== Query param helpers =====================
exports.paginationSchema = z.object({
  page: z.string().optional().default('1'),
  limit: z.string().optional().default('10'),
  store: z.string().optional(),
  status: z.string().optional(),
  search: z.string().optional()
})

// ===================== Sales Return =====================
const returnItemSchema = z.object({
  productId: strToNum(),
  orderItemId: strToNum().optional(),
  qty: strToNum().refine((q) => q > 0, 'Qty must be greater than 0'),
  unit: z.string().optional().default('pcs'),
  // F-RET-1: conversion is informational only — the approval reverses the
  // immutable historical sale mutation and never multiplies by this value
  // (the sale path has no conversion concept). Still validated so a client
  // cannot persist garbage: positive, finite, at most 4 decimal places
  // (the DECIMAL(10,4) stock contract). Boolean-returning refines only —
  // a thrown error here would escape as a 500 instead of a 422.
  conversionToBase: z.coerce
    .number()
    .refine((v) => Number.isFinite(v), {
      message: 'conversionToBase must be a finite number'
    })
    .refine((v) => v > 0, {
      message: 'conversionToBase must be greater than 0'
    })
    .refine(
      (v) => {
        if (!Number.isFinite(v)) return true
        const scaled = v * 10000
        return Math.abs(scaled - Math.round(scaled)) <= 1e-6
      },
      { message: 'conversionToBase supports at most 4 decimal places' }
    )
    .optional()
    .default(1),
  notes: z.string().optional().default('')
})

exports.createSalesReturnSchema = z.object({
  items: z.array(returnItemSchema).min(1, 'At least one item required'),
  reason: z.string().min(1, 'Reason is required'),
  returnedBy: z.union([strToNum(), z.string()]).optional(),
  refundMethod: z.string().max(50).optional(),
  idempotencyKey: z.string().max(255).optional().nullable()
})

// The return id is the :id route param (the controllers read req.params.id);
// the FE sends only the optional refund reference in the body.
exports.salesReturnIdParamsSchema = z.object({
  id: strToNum()
})

exports.approveSalesReturnSchema = z.object({
  refundReference: z.string().max(255).optional().nullable()
})

// ===================== Shift Swap (Ubah Jadwal) =====================
exports.createShiftSwapSchema = z.object({
  store: strToNumNullable().optional(),
  requesterId: strToNumNullable().optional(),
  targetId: strToNumNullable(),
  requesterShiftId: strToNumNullable(),
  targetShiftId: strToNumNullable(),
  tanggal_mulai: z.string().optional().nullable(),
  tanggal_selesai: z.string().optional().nullable(),
  note: z.string().optional().nullable()
})

exports.updateShiftSwapStatusSchema = z.object({
  status: z.enum(['approved', 'rejected'])
})

// ===================== Overtime (Lembur) =====================
const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Format waktu HH:MM')

exports.createOvertimeSchema = z.object({
  store: strToNumNullable().optional(),
  shift_id: strToNumNullable(),
  employee_id: strToNumNullable().optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Tanggal harus format YYYY-MM-DD'),
  start_time: timeSchema,
  end_time: timeSchema,
  note: z.string().optional().nullable()
})

exports.updateOvertimeStatusSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  note: z.string().optional().nullable()
})

exports.postOvertimePayrollSchema = z.object({
  store: strToNumNullable().optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/, 'Bulan harus format YYYY-MM')
})

// ===================== Parked Cart (F3) =====================
// `cart.items` is intentionally NOT length-validated here (no .min(1)) —
// an empty cart must be rejected with 422 (semantic validation), and
// every ZodError in this codebase resolves to 400 regardless of content
// (see api/middleware/validate.js). The empty-cart check lives in the
// controller. Item shape is a passthrough snapshot — this payload is
// display-only and is never re-priced/re-validated from here; the real
// checkout still re-prices everything fresh via /order/create.
exports.createParkedCartSchema = z.object({
  tableId: strToNumNullable().optional(),
  customerId: strToNumNullable().optional(),
  customerName: z.string().optional().nullable(),
  customerPhone: z.string().optional().nullable(),
  discountId: strToNumNullable().optional(),
  promoCode: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  cart: z.object({
    items: z.array(z.object({}).passthrough()),
    totalCovers: strToNumNullable().optional(),
    orderType: z.string().optional().nullable()
  }),
  idempotencyKey: z.string().max(255).optional().nullable()
})

// ===================== Thermal print (FG-SEC-09) =====================
// The payload allowlist mirrors exactly the fields `generateESCPOS`
// (api/index.js) reads. Anything else is dropped before it can reach the
// Python subprocess, so the surface stays as small as the printer needs.
//
// `data` deliberately strips unknown keys instead of rejecting them: the
// cashier FE posts the whole receipt model (labels, tender detail, paper
// settings, ...), and the FE is not changed by this fix, so rejecting those
// keys would break in-store Bluetooth printing. The request envelope itself
// stays strict: an unknown top-level key is a 400.
//
// Money may arrive as a numeric string because the order tables keep money
// in BIGINT/DECIMAL columns and the Postgres driver can return those as
// strings; it is normalised to a finite, non-negative number.
const stripThermalControlBytes = (value) =>
  value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')

const thermalText = (max) =>
  z.string().max(max).transform(stripThermalControlBytes)

const printThermalAmount = z
  .union([
    z.number(),
    z.string().regex(/^\d+(?:\.\d+)?$/, 'Angka tidak valid')
  ])
  .transform((value) => Number(value))
  .refine((value) => Number.isFinite(value) && value >= 0, {
    message: 'Nilai tidak boleh negatif'
  })

const optionalThermalAmount = printThermalAmount
  .nullish()
  .transform((value) => value ?? 0)

const printThermalItemSchema = z.object({
  name: thermalText(120).optional(),
  productName: thermalText(120).optional(),
  qty: optionalThermalAmount.optional(),
  quantity: optionalThermalAmount.optional(),
  price: optionalThermalAmount.optional(),
  total: optionalThermalAmount.optional(),
  subtotal: optionalThermalAmount.optional()
})

const printThermalSocialSchema = z.object({
  platform: thermalText(40).nullish(),
  account: thermalText(120).nullish()
})

exports.printThermalSchema = z.strictObject({
  data: z
    .object({
      storeName: thermalText(120).optional(),
      storeAddress: thermalText(300).optional(),
      storePhone: thermalText(60).optional(),
      storeEmail: thermalText(120).optional(),
      memberName: thermalText(120).optional(),
      memberTier: thermalText(60).optional(),
      memberPoints: optionalThermalAmount.optional(),
      orderNumber: thermalText(60).optional(),
      cashier: thermalText(120).optional(),
      date: thermalText(60).optional(),
      items: z.array(printThermalItemSchema).max(200).optional(),
      subtotal: optionalThermalAmount.optional(),
      discount: optionalThermalAmount.optional(),
      serviceCharge: optionalThermalAmount.optional(),
      tax: optionalThermalAmount.optional(),
      total: optionalThermalAmount.optional(),
      socialMedia: z.array(printThermalSocialSchema).max(20).optional(),
      socialMediaVisible: z.record(z.string(), z.boolean()).optional(),
      footer: thermalText(300).optional()
    })
    .optional()
})
