'use strict'
const db = require('../../db/models')
const {
  DEFAULT_TIMEZONE,
  isValidTimezone,
  getStoreLocalDate,
  getStoreDayBounds
} = require('../../utils/businessDate')
const aiAssistantLink = require('../service/aiAssistantLink')

// AI personal assistant (Telegram) data API.
//
// The AI service (ai-business-core) calls the service endpoints below with
// `Authorization: Bearer $ASSISTANT_SERVICE_SECRET`. The :storeId comes from
// the AI service's own Telegram ↔ store link — created only through the
// owner-authenticated /assistant/telegram-link flow — never from chat text,
// so one owner can never ask about another owner's store.
//
// Revenue semantics match /report: paymentStatus = 'paid' and status not
// cancelled/void, bucketed by the store's own timezone.

const PAID_ORDER = `o."paymentStatus" = 'paid' AND o.status NOT IN ('cancelled', 'void')`

const toNumber = (value) => (value == null ? 0 : Number(value))

const query = (sql, replacements) =>
  db.sequelize.query(sql, { replacements, type: db.sequelize.QueryTypes.SELECT })

const loadStore = (storeId) =>
  db.location.findByPk(storeId, {
    attributes: ['id', 'name', 'tenantId', 'city', 'status', 'timezone']
  })

const storeTimezone = (store) =>
  store.timezone && isValidTimezone(store.timezone) ? store.timezone : DEFAULT_TIMEZONE

const shiftDate = (dateStr, days) => {
  const date = new Date(`${dateStr}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

// Inclusive local-date range → UTC instants. Defaults to the last 7 days
// including today.
const resolveRange = (from, to, timezone) => {
  const today = getStoreLocalDate(timezone)
  const toDate = to || today
  const fromDate = from || shiftDate(toDate, -6)
  return {
    from: fromDate,
    to: toDate,
    start: getStoreDayBounds(fromDate, timezone).start,
    end: getStoreDayBounds(toDate, timezone).end
  }
}

const salesTotals = async (storeId, start, end) => {
  const [row] = await query(
    `SELECT COALESCE(SUM(o."totalPrice"), 0) AS revenue,
            COUNT(*) AS orders,
            COALESCE(SUM(o."totalQuantity"), 0) AS "itemsSold",
            COALESCE(SUM(o."discountAmount"), 0) AS discounts,
            COALESCE(SUM(o."taxAmount"), 0) AS tax
       FROM "order" o
      WHERE o.store = :storeId AND ${PAID_ORDER}
        AND o."createdAt" BETWEEN :start AND :end`,
    { storeId, start, end }
  )
  const revenue = toNumber(row.revenue)
  const orders = toNumber(row.orders)
  return {
    revenue,
    orders,
    itemsSold: toNumber(row.itemsSold),
    discounts: toNumber(row.discounts),
    tax: toNumber(row.tax),
    averageOrderValue: orders > 0 ? Math.round(revenue / orders) : 0
  }
}

const lowStockCount = async (storeId) => {
  const [row] = await query(
    `SELECT COUNT(*) AS count
       FROM product p
       JOIN product_store ps ON ps.product = p.id AND ps.store = :storeId
       LEFT JOIN product_store_stock pss ON pss.product = p.id AND pss.store = :storeId
      WHERE p."deletedAt" IS NULL AND p.status = 'active'
        AND COALESCE(pss.stock, p.stock) <= COALESCE(p."minStock", 0)`,
    { storeId }
  )
  return toNumber(row.count)
}

const withStore = (handler) => async (req, res) => {
  try {
    const store = await loadStore(req.params.storeId)
    if (!store) {
      return res.status(404).json({ success: false, code: 'STORE_NOT_FOUND', message: 'Store not found' })
    }
    return await handler(req, res, store)
  } catch (error) {
    console.error('Assistant data request failed:', error)
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Request failed' })
  }
}

// GET /assistant/stores/:storeId/summary — store info + today vs yesterday
exports.getSummary = withStore(async (req, res, store) => {
  const timezone = storeTimezone(store)
  const today = getStoreLocalDate(timezone)
  const yesterday = shiftDate(today, -1)
  const todayBounds = getStoreDayBounds(today, timezone)
  const yesterdayBounds = getStoreDayBounds(yesterday, timezone)

  const [todaySales, yesterdaySales, lowStock] = await Promise.all([
    salesTotals(store.id, todayBounds.start, todayBounds.end),
    salesTotals(store.id, yesterdayBounds.start, yesterdayBounds.end),
    lowStockCount(store.id)
  ])

  return res.status(200).json({
    success: true,
    data: {
      store: { id: store.id, name: store.name, city: store.city, status: store.status, timezone },
      currency: 'IDR',
      localDate: today,
      today: todaySales,
      yesterday: yesterdaySales,
      lowStockProducts: lowStock
    }
  })
})

// GET /assistant/stores/:storeId/stock?q=&lowOnly=&limit=
exports.getStock = withStore(async (req, res, store) => {
  const { q, lowOnly, limit } = req.query
  const conditions = [`p."deletedAt" IS NULL`, `p.status = 'active'`]
  const replacements = { storeId: store.id, limit }

  if (q) {
    conditions.push(`(p."nameProduct" ILIKE :like OR p.sku ILIKE :like OR p.barcode = :q)`)
    replacements.like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    replacements.q = q
  }
  if (lowOnly) {
    conditions.push(`COALESCE(pss.stock, p.stock) <= COALESCE(p."minStock", 0)`)
  }

  const from = `FROM product p
       JOIN product_store ps ON ps.product = p.id AND ps.store = :storeId
       LEFT JOIN product_store_stock pss ON pss.product = p.id AND pss.store = :storeId
      WHERE ${conditions.join(' AND ')}`

  const [rows, [count]] = await Promise.all([
    query(
      `SELECT p.id, p."nameProduct" AS name, p.sku, p.unit, p."minStock",
              COALESCE(pss.stock, p.stock) AS stock
       ${from}
       ORDER BY ${lowOnly ? 'COALESCE(pss.stock, p.stock) ASC,' : ''} p."nameProduct" ASC
       LIMIT :limit`,
      replacements
    ),
    query(`SELECT COUNT(*) AS total ${from}`, replacements)
  ])

  return res.status(200).json({
    success: true,
    data: {
      store: store.name,
      total: toNumber(count.total),
      products: rows.map((r) => {
        const stock = toNumber(r.stock)
        const minStock = toNumber(r.minStock)
        return {
          id: r.id,
          name: r.name,
          sku: r.sku,
          unit: r.unit,
          stock,
          minStock,
          isLow: stock <= minStock
        }
      })
    }
  })
})

// GET /assistant/stores/:storeId/sales?from=&to= — totals, per day, per payment method
exports.getSales = withStore(async (req, res, store) => {
  const timezone = storeTimezone(store)
  const range = resolveRange(req.query.from, req.query.to, timezone)
  const replacements = { storeId: store.id, start: range.start, end: range.end, timezone }

  const [totals, byDay, byPaymentMethod] = await Promise.all([
    salesTotals(store.id, range.start, range.end),
    query(
      `SELECT TO_CHAR(DATE(o."createdAt" AT TIME ZONE :timezone), 'YYYY-MM-DD') AS date,
              SUM(o."totalPrice") AS revenue, COUNT(*) AS orders
         FROM "order" o
        WHERE o.store = :storeId AND ${PAID_ORDER}
          AND o."createdAt" BETWEEN :start AND :end
        GROUP BY 1 ORDER BY 1 ASC`,
      replacements
    ),
    query(
      `SELECT COALESCE(o."paymentMethod", 'unknown') AS method,
              SUM(o."totalPrice") AS revenue, COUNT(*) AS orders
         FROM "order" o
        WHERE o.store = :storeId AND ${PAID_ORDER}
          AND o."createdAt" BETWEEN :start AND :end
        GROUP BY 1 ORDER BY 2 DESC`,
      replacements
    )
  ])

  return res.status(200).json({
    success: true,
    data: {
      store: store.name,
      currency: 'IDR',
      from: range.from,
      to: range.to,
      totals,
      byDay: byDay.map((r) => ({ date: r.date, revenue: toNumber(r.revenue), orders: toNumber(r.orders) })),
      byPaymentMethod: byPaymentMethod.map((r) => ({
        method: r.method,
        revenue: toNumber(r.revenue),
        orders: toNumber(r.orders)
      }))
    }
  })
})

// GET /assistant/stores/:storeId/best-sellers?from=&to=&limit=
exports.getBestSellers = withStore(async (req, res, store) => {
  const timezone = storeTimezone(store)
  const range = resolveRange(req.query.from, req.query.to, timezone)

  const rows = await query(
    `SELECT oi."productName" AS name, SUM(oi.quantity) AS quantity, SUM(oi."totalPrice") AS revenue
       FROM order_item oi
       JOIN "order" o ON o.id = oi."order"
      WHERE o.store = :storeId AND ${PAID_ORDER}
        AND o."createdAt" BETWEEN :start AND :end
      GROUP BY oi.product, oi."productName"
      ORDER BY 2 DESC
      LIMIT :limit`,
    { storeId: store.id, start: range.start, end: range.end, limit: req.query.limit }
  )

  return res.status(200).json({
    success: true,
    data: {
      store: store.name,
      currency: 'IDR',
      from: range.from,
      to: range.to,
      products: rows.map((r, i) => ({
        rank: i + 1,
        name: r.name,
        quantity: toNumber(r.quantity),
        revenue: toNumber(r.revenue)
      }))
    }
  })
})

// ---------------------------------------------------------------------------
// Owner-facing Telegram link (session-authenticated, store.manage).
// One client = one store = one assistant chat.
// ---------------------------------------------------------------------------

// The owner's store: the session's active store, or the tenant's only store.
const ownerStoreId = (req) => {
  const ctx = req.authContext
  if (!ctx || ctx.activeTenantId == null) return null
  if (ctx.activeStoreId != null) return Number(ctx.activeStoreId)
  const ids = ctx.tenantStoreIds || []
  return ids.length === 1 ? Number(ids[0]) : null
}

// Scope for requireCanonicalPermission('store.manage') — from the persisted row.
exports.ownerStoreScope = async (req) => {
  const storeId = ownerStoreId(req)
  if (storeId == null) return { tenantId: 'assistant-missing', storeId: 'assistant-missing' }
  const store = await db.location.findByPk(storeId, { attributes: ['id', 'tenantId'] })
  if (!store) return { tenantId: 'assistant-missing', storeId: 'assistant-missing' }
  return { tenantId: store.tenantId, storeId: store.id }
}

const withOwnerStore = (handler) => async (req, res) => {
  try {
    const storeId = ownerStoreId(req)
    const store = storeId == null ? null : await db.location.findByPk(storeId, { attributes: ['id', 'name'] })
    if (!store) {
      return res.status(400).json({ success: false, code: 'STORE_REQUIRED', message: 'Select a store first' })
    }
    return await handler(req, res, store)
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, code: error.code, message: error.message })
    }
    console.error('Assistant link request failed:', error)
    return res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: 'Request failed' })
  }
}

// POST /assistant/telegram-link — returns a one-time t.me deep link
exports.createTelegramLink = withOwnerStore(async (req, res, store) => {
  const link = await aiAssistantLink.createLink({ storeId: store.id, storeName: store.name })
  return res.status(201).json({ success: true, data: link })
})

// GET /assistant/telegram-link — is this store connected?
exports.getTelegramLink = withOwnerStore(async (req, res, store) => {
  const status = await aiAssistantLink.getLink(store.id)
  return res.status(200).json({ success: true, data: status })
})

// DELETE /assistant/telegram-link — disconnect Telegram from this store
exports.deleteTelegramLink = withOwnerStore(async (req, res, store) => {
  await aiAssistantLink.deleteLink(store.id)
  return res.status(200).json({ success: true, message: 'Telegram disconnected' })
})
