const db = require('../../db/models')
const { Op } = require('sequelize')
const { enrichAuditFields } = require('../../utils/auditFields')
const { redactAndAudit, AUDIT_ACTIONS } = require('../../utils/auditLog')
const { withDeadlockRetry } = require('../../utils/deadlockRetry')
const { scalarStoreScope } = require('../../utils/tenantScope')
const { assertIntegerRupiah } = require('../../utils/moneyGuard')
const { reportingBucket, CANONICAL_METHOD_ORDER } = require('../service/canonicalPayment')

// P1 (DR-PAY-ATTR-06): payment-breakdown bucketing speaks canonical
// methods. Historical rows whose tender cannot be mapped are summed into
// an explicit UNRECONCILED bucket — never silently merged into another
// tender and never rewritten. Pure function over aggregate rows.
function bucketPaymentsByCanonical(rows) {
  const buckets = new Map()
  for (const row of rows) {
    const type = reportingBucket(row.typePayment)
    const bucket = buckets.get(type) || { type, total: 0, count: 0 }
    bucket.total += Number(row.total || 0)
    bucket.count += Number(row.count || 0)
    buckets.set(type, bucket)
  }
  // Deterministic: total descending, canonical method order (§21) on ties.
  return [...buckets.values()].sort(
    (a, b) =>
      b.total - a.total ||
      (CANONICAL_METHOD_ORDER[a.type] ?? CANONICAL_METHOD_ORDER.UNRECONCILED) -
        (CANONICAL_METHOD_ORDER[b.type] ?? CANONICAL_METHOD_ORDER.UNRECONCILED)
  )
}

// Same channel rule as order.js: a QR order is one created by
// createCustomerOrder (source 'qr', no createdBy); every other order is POS.
const isQrChannelOrder = (order) => order?.source === 'qr' && order?.createdBy == null

const DEFAULT_CASH_OUT_APPROVAL_THRESHOLD = 500000
const DEFAULT_CASH_VARIANCE_THRESHOLD = 25000

const getStore = (req) =>
  req.storeId ||
  req.body.storeId ||
  req.body.store ||
  req.query.store ||
  req.cookies.store ||
  req.cookies.activeStore ||
  req.user?.store

// Phase 39 Batch 6C: the only table population eligible for reset-on-open
// cleanup is OCCUPIED with no order in an active status — same active-
// status list already used by table.js's own active-order checks
// (deleteTable, getTableWithActiveOrders). RESERVED, MAINTENANCE,
// AVAILABLE, and OCCUPIED-with-an-active-order are never touched.
//
// Recomputed fresh here, never trusted from a client-supplied id list or
// count, so a table that gains an active order between the FE's preview
// call and the cashier's confirmation is never reset out from under a
// live order (the preview and the actual cleanup both call this same
// function independently, each at its own point in time).
const TABLE_RESET_ACTIVE_ORDER_STATUSES = ['pending', 'confirmed', 'preparing', 'ready', 'served']

async function getEligibleTableResetIds(store) {
  const occupiedTables = await db.table.findAll({
    where: { store, status: 'occupied' },
    attributes: ['id']
  })
  if (occupiedTables.length === 0) return []

  const occupiedIds = occupiedTables.map((t) => t.id)
  const activeOrders = await db.order.findAll({
    where: {
      store,
      tableId: { [Op.in]: occupiedIds },
      status: TABLE_RESET_ACTIVE_ORDER_STATUSES
    },
    attributes: ['tableId'],
    raw: true
  })
  const activeTableIds = new Set(activeOrders.map((o) => o.tableId))
  const candidateIds = occupiedIds.filter((id) => !activeTableIds.has(id))
  if (candidateIds.length === 0) return []

  // Phase 39 — a POS dine-in visit holds its table until staff release it
  // (Set Available), even though its order is already paid. An occupied
  // table whose most recent order is a POS order is therefore a live visit,
  // not stale, whatever that order's status.
  const candidateOrders = await db.order.findAll({
    where: { store, tableId: { [Op.in]: candidateIds } },
    attributes: ['id', 'tableId', 'source', 'createdBy'],
    raw: true
  })
  const latestByTable = new Map()
  for (const o of candidateOrders) {
    const current = latestByTable.get(o.tableId)
    if (!current || o.id > current.id) latestByTable.set(o.tableId, o)
  }
  return candidateIds.filter((id) => {
    const latest = latestByTable.get(id)
    return !latest || isQrChannelOrder(latest)
  })
}

// Best-effort cleanup — never throws. Re-checks `status: 'occupied'` in the
// UPDATE's WHERE clause as a narrow race guard against the table having
// changed status between the SELECT above and this write. Failure of any
// individual table update is counted, never allowed to abort the loop or
// propagate — the caller (open()) must be able to report a deterministic
// attempted/succeeded/failed outcome no matter what goes wrong here.
async function performTableResetCleanup(store) {
  let succeeded = 0
  let failed = 0
  try {
    const eligibleIds = await getEligibleTableResetIds(store)
    for (const id of eligibleIds) {
      try {
        const [count] = await db.table.update(
          { status: 'available' },
          { where: { id, store, status: 'occupied' } }
        )
        if (count > 0) succeeded += 1
        else failed += 1
      } catch (updateError) {
        console.log(updateError)
        failed += 1
      }
    }
    return { succeeded, failed, warning: failed > 0 ? `${failed} table(s) could not be reset to available` : undefined }
  } catch (error) {
    console.log(error)
    return {
      succeeded,
      failed,
      warning: 'Table cleanup failed unexpectedly; register remains open'
    }
  }
}

// Centralized so close(), getCurrent(), and the X/Z reports (buildReportData)
// can never silently diverge on what "expected cash" means — the exact bug
// this feature fixes (two different formulas coexisted before F2). All
// three call this rather than recomputing any part of it inline.
//
// cashSalesReceived is NET CASH RETAINED IN THE DRAWER (cashReceived minus
// changeGiven), never gross customer tender — do not sum raw cashReceived
// alone for any expected-cash purpose.
async function computeCashLedgerSummary({
  registerId,
  store,
  openingBalance,
  openedAt,
  endAt,
  transaction
}) {
  const replacements = {
    registerId,
    store,
    openedAt,
    endAt: endAt || new Date()
  }
  const queryOpts = {
    replacements,
    type: db.sequelize.QueryTypes.SELECT,
    ...(transaction ? { transaction } : {})
  }

  // F4: intentionally NOT filtered by o.paymentStatus = 'paid'. A
  // transaction row's mere existence already means real, completed money
  // moved (confirmed: every creation site across this codebase writes one
  // exactly when a payment or refund actually happens, never for a
  // pending/speculative one) — cashRegisterId is set once at order
  // creation and never changes. Filtering on the order's CURRENT
  // paymentStatus meant a refund (which routinely moves paymentStatus
  // away from 'paid') silently erased the order's entire cash
  // contribution — both the original sale AND the refund itself — from
  // every subsequent computation. Summing every 'cash' row for the
  // register regardless of the order's current status is what actually
  // nets out correctly: +100,000 cash sale followed by a -20,000 cash
  // refund nets to +80,000, with no special-casing for the status change
  // in between. P1: new rows carry their own cashRegisterId (COALESCE
  // above); the order header remains the fallback for legacy rows only.
  // P1 (DR-PAY-ATTR-01/05): drawer ownership is per financial record.
  // COALESCE prefers the row's own cashRegisterId and falls back to the
  // legacy order header, so historical rows keep their existing drawer
  // membership while new rows attribute exactly where they were collected.
  // P1 close-window bound: only rows created inside [openedAt, endAt] count,
  // so late-arriving rows for other shifts can never leak into this
  // register's frozen snapshot. Canonical CASH only (legacy lowercase kept
  // for transition); negatives are refunds and net out of the same leg.
  const [cashSalesRow] = await db.sequelize.query(
    `SELECT COALESCE(SUM(COALESCE(t."cashReceived", t.amount) - COALESCE(t."changeGiven", 0)), 0) as "cashSalesReceived",
            COALESCE(SUM(CASE WHEN t."amount" > 0 THEN COALESCE(t."cashReceived", t.amount) - COALESCE(t."changeGiven", 0) ELSE 0 END), 0) as "cashSettlements",
            COALESCE(SUM(CASE WHEN t."amount" < 0 THEN -(COALESCE(t."cashReceived", t.amount) - COALESCE(t."changeGiven", 0)) ELSE 0 END), 0) as "cashRefundsTotal",
            COALESCE(SUM(CASE WHEN t."amount" < 0 THEN -t."amount" ELSE 0 END), 0) as "refundsTotal",
            COUNT(CASE WHEN t."amount" < 0 THEN 1 END)::int as "refundCount"
       FROM "transaction" t
       JOIN "order" o ON o.id = t."order"
      WHERE COALESCE(t."cashRegisterId", o."cashRegisterId") = :registerId
        AND t."typePayment" IN ('cash', 'CASH')
        AND t."createdAt" >= :openedAt AND t."createdAt" <= :endAt`,
    queryOpts
  )

  // Cash expenses: store + paymentMethod='cash' + status='approved' +
  // createdAt (NOT date — date is free-form/user-editable, createdAt is
  // system-generated) within the register's open window. No createdBy
  // filter — the register's opener is not the only person who can record
  // a cash expense against it. Known limitation: an expense created in one
  // shift but approved in a later shift still attributes to the creation
  // shift, since there is no approvedAt column on expense; not fixed here.
  const [expenseRow] = await db.sequelize.query(
    `SELECT COALESCE(SUM("amount"), 0) as "cashExpenses"
       FROM expense
      WHERE "store" = :store
        AND "paymentMethod" = 'cash'
        AND "status" = 'approved'
        AND "createdAt" >= :openedAt AND "createdAt" <= :endAt`,
    queryOpts
  )

  const [movementRow] = await db.sequelize.query(
    `SELECT
        COALESCE(SUM(CASE WHEN type = 'cash_in'  AND status = 'active' THEN amount ELSE 0 END), 0) as "activeCashIn",
        COALESCE(SUM(CASE WHEN type = 'cash_out' AND status = 'active' THEN amount ELSE 0 END), 0) as "activeCashOut"
       FROM cash_movement
      WHERE "cashRegisterId" = :registerId`,
    queryOpts
  )

  const cashSalesReceived = Number(cashSalesRow.cashSalesReceived || 0)
  const cashExpenses = Number(expenseRow.cashExpenses || 0)
  const activeCashIn = Number(movementRow.activeCashIn || 0)
  const activeCashOut = Number(movementRow.activeCashOut || 0)
  const cashRefundsTotal = Number(cashSalesRow.cashRefundsTotal || 0)
  const refundsTotal = Number(cashSalesRow.refundsTotal || 0)
  const refundCount = Number(cashSalesRow.refundCount || 0)
  const expectedCash =
    Number(openingBalance || 0) +
    cashSalesReceived +
    activeCashIn -
    activeCashOut -
    cashExpenses

  return {
    cashSalesReceived,
    cashExpenses,
    activeCashIn,
    activeCashOut,
    expectedCash,
    cashRefundsTotal,
    refundsTotal,
    refundCount
  }
}

async function buildReportData({
  register,
  store,
  user,
  openedAt,
  endAt,
  storeData,
  userData
}) {
  const replacements = {
    registerId: register.id,
    store,
    user,
    openedAt,
    endAt
  }

  // totalSales/totalSubtotal/totalDiscount/totalTax/totalServiceCharge and
  // the payments-by-type breakdown below are gross figures across every
  // payment method, attributed to the REGISTER that collected the money
  // (per-row cashRegisterId with order-header fallback — same membership
  // rule as the cash ledger above), not to the opener. Never used in the
  // expectedCash formula; kept purely for backward-compatible display.
  const [salesAgg, paymentRows, expCatRows, productRows] = await Promise.all([
    db.sequelize
      .query(
        `SELECT COUNT(*) as "totalTransactions",
                COALESCE(SUM("subTotal"), 0) as "totalSubtotal",
                COALESCE(SUM("discountAmount"), 0) as "totalDiscount",
                COALESCE(SUM("taxAmount"), 0) as "totalTax",
                COALESCE(SUM("serviceChargeAmount"), 0) as "totalServiceCharge",
                COALESCE(SUM("totalQuantity"), 0) as "totalQuantity",
                COALESCE(SUM("totalCovers"), 0) as "totalCovers",
                COALESCE(SUM("totalPrice"), 0) as "totalSales"
         FROM "order" o
         WHERE "store" = :store
           AND EXISTS (
             SELECT 1 FROM "transaction" t2
             WHERE t2."order" = o.id
               AND COALESCE(t2."cashRegisterId", o."cashRegisterId") = :registerId
           )
           AND o."createdAt" >= :openedAt AND o."createdAt" <= :endAt
           AND o."paymentStatus" = 'paid'`,
        { replacements, type: db.sequelize.QueryTypes.SELECT }
      )
      .then((r) => r[0]),
    db.sequelize.query(
      `SELECT t."typePayment",
                COALESCE(SUM(t."amount"), 0) as total,
                COUNT(*)::int as "count"
         FROM "transaction" t
         JOIN "order" o ON o.id = t."order"
         WHERE o."store" = :store
           AND COALESCE(t."cashRegisterId", o."cashRegisterId") = :registerId
           AND o."createdAt" >= :openedAt AND o."createdAt" <= :endAt
           AND o."paymentStatus" = 'paid'
         GROUP BY t."typePayment"
         ORDER BY total DESC, t."typePayment" ASC`,
      { replacements, type: db.sequelize.QueryTypes.SELECT }
    ),
    // Same createdBy-removal / date->createdAt correction as the cash
    // expense term above — this breakdown must stay consistent with the
    // total it explains, not silently keep the old buggy attribution.
    // Payment-method scope intentionally left unfiltered (unchanged): this
    // is a general expense-by-category view, not the cash-only figure.
    db.sequelize.query(
      `SELECT COALESCE(ec.name, 'Lainnya') as "category",
                COALESCE(SUM(e."amount"), 0) as total,
                COUNT(*)::int as "count"
         FROM expense e
         LEFT JOIN expense_category ec ON ec.id = e."category"
         WHERE e."store" = :store
           AND e."createdAt" >= :openedAt AND e."createdAt" <= :endAt
           AND e."status" = 'approved'
         GROUP BY ec.name
         ORDER BY total DESC`,
      { replacements, type: db.sequelize.QueryTypes.SELECT }
    ),
    // BA finding #1 (Waroeng Bakso dummy, 2026-10-17): the X/Z report was
    // aggregates only (totals by tender and expense category) — no
    // product-level view, so a shift could not be inspected per item.
    // Same membership rule as the sales aggregate above (register
    // attribution, lifecycle window, paid) so every quantity/revenue here
    // reconciles with summary.totalQuantity/totalSales. Rows are grouped
    // per product id so two products sharing a name stay distinct; SKU
    // comes from the current product row (nullable for deleted products).
    db.sequelize
      .query(
        `SELECT oi."productName" as "productName",
                p."sku" as sku,
                COALESCE(SUM(oi."quantity"), 0)::int as quantity,
                ROUND(COALESCE(SUM(oi."totalPrice"), 0)::numeric / NULLIF(SUM(oi."quantity"), 0)) as "unitPrice",
                COALESCE(SUM(oi."totalPrice"), 0) as "totalSales"
           FROM "order_item" oi
           JOIN "order" o ON o.id = oi."order"
           LEFT JOIN "product" p ON p.id = oi."product"
          WHERE o."store" = :store
            AND EXISTS (
              SELECT 1 FROM "transaction" t2
              WHERE t2."order" = o.id
                AND COALESCE(t2."cashRegisterId", o."cashRegisterId") = :registerId
            )
            AND o."createdAt" >= :openedAt AND o."createdAt" <= :endAt
            AND o."paymentStatus" = 'paid'
          GROUP BY oi."product", oi."productName", p."sku"
          ORDER BY quantity DESC, oi."productName" ASC`,
        { replacements, type: db.sequelize.QueryTypes.SELECT }
      )
  ])

  const totalSales = Number(salesAgg.totalSales || 0)
  const totalSubtotal = Number(salesAgg.totalSubtotal || 0)
  const totalDiscount = Number(salesAgg.totalDiscount || 0)
  const totalTax = Number(salesAgg.totalTax || 0)
  const totalServiceCharge = Number(salesAgg.totalServiceCharge || 0)

  const payments = bucketPaymentsByCanonical(
    paymentRows.map((r) => ({ typePayment: r.typePayment, total: r.total, count: r.count }))
  ).map((b) => ({ type: b.type, amount: b.total, count: b.count }))

  const salesByProduct = productRows.map((r) => ({
    productName: r.productName,
    sku: r.sku || null,
    quantity: Number(r.quantity || 0),
    unitPrice: Number(r.unitPrice || 0),
    totalSales: Number(r.totalSales || 0)
  }))

  const totalNonCashPayment = payments.reduce((s, p) => s + p.amount, 0)

  const openingBalance = Number(register.openingBalance || 0)
  const closingBalance = Number(register.closingBalance || 0)

  const {
    cashSalesReceived,
    cashExpenses,
    activeCashIn,
    activeCashOut,
    expectedCash,
    cashRefundsTotal,
    refundsTotal,
    refundCount
  } = await computeCashLedgerSummary({
    registerId: register.id,
    store,
    openingBalance,
    openedAt,
    endAt
  })

  const variance =
    register.status === 'closed' ? closingBalance - expectedCash : null

  return {
    register: {
      id: register.id,
      shift: register.shift,
      status: register.status,
      openedAt: register.openedAt,
      closedAt: register.closedAt,
      notes: register.notes,
      openingBalance,
      closingBalance
    },
    store: storeData
      ? {
          id: storeData.id,
          name: storeData.name,
          address: storeData.address,
          city: storeData.city,
          phone: storeData.phoneNumber || storeData.phone || null,
          // Phase 39 Batch 6-prereq: expose the store's authoritative IANA
          // timezone (utils/businessDate.js's DEFAULT_TIMEZONE convention)
          // so FE can render register timestamps in store-local time
          // instead of the viewer's browser timezone. Plumbing only — no
          // register-window comparison here ever depended on this; instant
          // comparisons (createdAt >= openedAt) are timezone-agnostic.
          timezone: storeData.timezone || null
        }
      : null,
    cashier: userData
      ? { id: userData.id, fullName: userData.fullName }
      : { id: user },
    summary: {
      totalTransactions: Number(salesAgg.totalTransactions || 0),
      totalQuantity: Number(salesAgg.totalQuantity || 0),
      totalCovers: Number(salesAgg.totalCovers || 0),
      subtotal: totalSubtotal,
      discount: totalDiscount,
      tax: totalTax,
      serviceCharge: totalServiceCharge,
      totalSales,
      totalExpenses: cashExpenses,
      totalCashPayment: cashSalesReceived,
      totalNonCashPayment,
      activeCashIn,
      activeCashOut,
      expectedCash,
      cashRefundsTotal,
      refundsTotal,
      refundCount,
      variance
    },
    payments,
    salesByProduct,
    expenses: expCatRows.map((r) => ({
      category: r.category,
      amount: Number(r.total || 0),
      count: Number(r.count || 0)
    }))
  }
}

// P1 (DR-PAY-ATTR-04): authoritative close-time snapshot, computed once
// inside close()'s transaction (which already holds the register UPDATE
// lock, so no settlement/refund can race into the gap between calculation
// and the status flip). Cash/drawer/refund legs are per-record attribution
// (transaction.cashRegisterId with legacy order-header fallback); gross and
// payment/expense breakdowns freeze the existing creator-basis display
// queries byte-for-byte as computed live at close time. Everything is
// derived from immutable rows — no history is rewritten to build it.
async function buildCloseSnapshot({ registerId, store, user, openedAt, endAt, openingBalance, transaction }) {
  const replacements = { registerId, store, user, openedAt, endAt }
  const queryOpts = {
    replacements,
    type: db.sequelize.QueryTypes.SELECT,
    ...(transaction ? { transaction } : {})
  }
  const [salesAgg, paymentRows, expCatRows, productRows, ledger] = await Promise.all([
    db.sequelize.query(
      `SELECT COUNT(*) as "totalTransactions",
              COALESCE(SUM("subTotal"), 0) as "totalSubtotal",
              COALESCE(SUM("discountAmount"), 0) as "totalDiscount",
              COALESCE(SUM("taxAmount"), 0) as "totalTax",
              COALESCE(SUM("serviceChargeAmount"), 0) as "totalServiceCharge",
              COALESCE(SUM("totalQuantity"), 0) as "totalQuantity",
              COALESCE(SUM("totalCovers"), 0) as "totalCovers",
              COALESCE(SUM("totalPrice"), 0) as "totalSales"
         FROM "order" o
         WHERE "store" = :store
           AND EXISTS (
             SELECT 1 FROM "transaction" t2
             WHERE t2."order" = o.id
               AND COALESCE(t2."cashRegisterId", o."cashRegisterId") = :registerId
           )
           AND o."createdAt" >= :openedAt AND o."createdAt" <= :endAt
           AND o."paymentStatus" = 'paid'`,
      queryOpts
    ).then((r) => r[0]),
    db.sequelize.query(
      `SELECT t."typePayment",
                COALESCE(SUM(t."amount"), 0) as total,
                COUNT(*)::int as "count"
         FROM "transaction" t
         JOIN "order" o ON o.id = t."order"
         WHERE o."store" = :store
           AND COALESCE(t."cashRegisterId", o."cashRegisterId") = :registerId
           AND o."createdAt" >= :openedAt AND o."createdAt" <= :endAt
           AND o."paymentStatus" = 'paid'
         GROUP BY t."typePayment"
         ORDER BY total DESC, t."typePayment" ASC`,
      queryOpts
    ),
    db.sequelize.query(
      `SELECT COALESCE(ec.name, 'Lainnya') as "category",
              COALESCE(SUM(e."amount"), 0) as total,
              COUNT(*)::int as "count"
         FROM expense e
         LEFT JOIN expense_category ec ON ec.id = e."category"
        WHERE e."store" = :store
          AND e."createdAt" >= :openedAt AND e."createdAt" <= :endAt
          AND e."status" = 'approved'
         GROUP BY ec.name
         ORDER BY total DESC, ec.name ASC`,
      queryOpts
    ),
    // BA finding #1: same product-level breakdown as the live X/Z report,
    // frozen into the close snapshot so a closed register keeps serving
    // its per-product figures (see buildReportData for the membership
    // rule rationale).
    db.sequelize
      .query(
        `SELECT oi."productName" as "productName",
                p."sku" as sku,
                COALESCE(SUM(oi."quantity"), 0)::int as quantity,
                ROUND(COALESCE(SUM(oi."totalPrice"), 0)::numeric / NULLIF(SUM(oi."quantity"), 0)) as "unitPrice",
                COALESCE(SUM(oi."totalPrice"), 0) as "totalSales"
           FROM "order_item" oi
           JOIN "order" o ON o.id = oi."order"
           LEFT JOIN "product" p ON p.id = oi."product"
          WHERE o."store" = :store
            AND EXISTS (
              SELECT 1 FROM "transaction" t2
              WHERE t2."order" = o.id
                AND COALESCE(t2."cashRegisterId", o."cashRegisterId") = :registerId
            )
            AND o."createdAt" >= :openedAt AND o."createdAt" <= :endAt
            AND o."paymentStatus" = 'paid'
          GROUP BY oi."product", oi."productName", p."sku"
          ORDER BY quantity DESC, oi."productName" ASC`,
        queryOpts
      ),
    computeCashLedgerSummary({ registerId, store, openingBalance, openedAt, endAt, transaction })
  ])
  const payments = bucketPaymentsByCanonical(
    paymentRows.map((r) => ({ typePayment: r.typePayment, total: r.total, count: r.count }))
  ).map((b) => ({ type: b.type, total: b.total, count: b.count }))
  const expenses = expCatRows.map((r) => ({
    category: r.category,
    total: Number(r.total || 0),
    count: Number(r.count || 0)
  }))
  const salesByProduct = productRows.map((r) => ({
    productName: r.productName,
    sku: r.sku || null,
    quantity: Number(r.quantity || 0),
    unitPrice: Number(r.unitPrice || 0),
    totalSales: Number(r.totalSales || 0)
  }))
  return {
    expectedCash: ledger.expectedCash,
    activeCashIn: ledger.activeCashIn,
    activeCashOut: ledger.activeCashOut,
    cashRefundsTotal: ledger.cashRefundsTotal,
    refundsTotal: ledger.refundsTotal,
    refundCount: ledger.refundCount,
    totalTransactions: Number(salesAgg.totalTransactions || 0),
    gross: {
      subtotal: Number(salesAgg.totalSubtotal || 0),
      discount: Number(salesAgg.totalDiscount || 0),
      tax: Number(salesAgg.totalTax || 0),
      serviceCharge: Number(salesAgg.totalServiceCharge || 0),
      quantity: Number(salesAgg.totalQuantity || 0),
      covers: Number(salesAgg.totalCovers || 0),
      totalSales: Number(salesAgg.totalSales || 0)
    },
    payments,
    expenses,
    salesByProduct,
    // Cash inputs shared with the scalar columns above, kept inside the
    // document so the snapshot is self-describing for auditors.
    cash: {
      cashSalesReceived: ledger.cashSalesReceived,
      cashExpenses: ledger.cashExpenses
    }
  }
}

// Batch B: explainable register reconciliation for
// /cash-register/history/detail. The detail page used to render a frozen
// close-time snapshot (paid-only, opener-attributed) next to a live
// store+date order list of ALL statuses with no stated inclusion rules,
// so "Total Penjualan Rp0 next to 15 transactions" could never be
// reconciled. This helper reuses the EXACT close-time membership semantics
// (store + createdBy=opener + [openedAt,endAt] window + paymentStatus) and
// additionally partitions every other plausibly-relevant record into
// explicit exclusion buckets with reason codes. Additive, read-only, no
// schema change; monetary SUMs use the same Number() handling as the rest
// of this controller (exact for values under Number.MAX_SAFE_INTEGER).
async function buildRegisterReconciliation({ registerId, store, user, openedAt, endAt, transaction }) {
  const queryOpts = {
    type: db.sequelize.QueryTypes.SELECT,
    ...(transaction ? { transaction } : {})
  }
  const eligibleWhere = `"store" = :store AND "createdBy" = :user
    AND "createdAt" >= :openedAt AND "createdAt" <= :endAt
    AND "paymentStatus" = 'paid'
    AND "status" NOT IN ('cancelled', 'void')`
  const base = { store, user, openedAt, endAt }

  const pack = (rows) => {
    const list = rows || []
    return {
      count: list.length,
      // DB integers aggregate exactly; Number() matches the canonical money
      // handling used throughout this controller.
      total: list.reduce((s, r) => s + Number(r.totalPrice || 0), 0),
      orderIds: list.map((r) => r.id)
    }
  }
  const bucket = (code, reason, rows) => ({ code, reason, ...pack(rows) })

  const [eligibleRows, methodRows] = await Promise.all([
    db.sequelize.query(
      `SELECT id, "totalPrice" FROM "order" WHERE ${eligibleWhere} ORDER BY id`,
      { replacements: base, ...queryOpts }
    ),
    // Method split over the same eligible population, sourced from recorded
    // payment rows (a transaction row exists exactly when money moved —
    // same convention as the payments breakdown in buildReportData).
    db.sequelize.query(
      `SELECT t."typePayment" as type,
              COALESCE(SUM(t."amount"), 0) as amount,
              COUNT(DISTINCT o.id)::int as orders
         FROM "transaction" t
         JOIN "order" o ON o.id = t."order"
        WHERE o."store" = :store AND o."createdBy" = :user
          AND o."createdAt" >= :openedAt AND o."createdAt" <= :endAt
          AND o."paymentStatus" = 'paid'
          AND o."status" NOT IN ('cancelled', 'void')
        GROUP BY t."typePayment" ORDER BY amount DESC`,
      { replacements: base, ...queryOpts }
    )
  ])

  const excludedQueries = {
    UNPAID: [
      'UNPAID',
      'Order is not paid yet (paymentStatus is unpaid/partial), so it is not a recognized sale.'
    ],
    CANCELLED_VOID: [
      'CANCELLED_VOID',
      'Order was cancelled or voided, so it is excluded from sales.'
    ],
    REFUNDED: [
      'REFUNDED',
      'Order was refunded; its cash effect nets inside the cash ledger, not gross sales.'
    ],
    OTHER_CREATOR: [
      'OTHER_CREATOR',
      'Paid order recorded by another cashier/system account, outside this register opener attribution.'
    ],
    OUTSIDE_WINDOW: [
      'OUTSIDE_WINDOW',
      'Paid order created outside this register open window.'
    ]
  }
  const [unpaidRows, cancelledRows, refundedRows, otherCreatorRows, outsideRows] = await Promise.all([
    db.sequelize.query(
      `SELECT id, "totalPrice" FROM "order"
        WHERE "store" = :store AND "createdBy" = :user
          AND "createdAt" >= :openedAt AND "createdAt" <= :endAt
          AND "paymentStatus" IN ('unpaid', 'partial')
          AND "status" NOT IN ('cancelled', 'void') ORDER BY id`,
      { replacements: base, ...queryOpts }
    ),
    db.sequelize.query(
      `SELECT id, "totalPrice" FROM "order"
        WHERE "store" = :store AND "createdBy" = :user
          AND "createdAt" >= :openedAt AND "createdAt" <= :endAt
          AND "status" IN ('cancelled', 'void') ORDER BY id`,
      { replacements: base, ...queryOpts }
    ),
    db.sequelize.query(
      `SELECT id, "totalPrice" FROM "order"
        WHERE "store" = :store AND "createdBy" = :user
          AND "createdAt" >= :openedAt AND "createdAt" <= :endAt
          AND "paymentStatus" = 'refunded'
          AND "status" NOT IN ('cancelled', 'void') ORDER BY id`,
      { replacements: base, ...queryOpts }
    ),
    db.sequelize.query(
      `SELECT id, "totalPrice" FROM "order"
        WHERE "store" = :store
          AND ("createdBy" IS DISTINCT FROM :user)
          AND "createdAt" >= :openedAt AND "createdAt" <= :endAt
          AND "paymentStatus" IN ('paid', 'refunded')
          AND "status" NOT IN ('cancelled', 'void') ORDER BY id`,
      { replacements: base, ...queryOpts }
    ),
    db.sequelize.query(
      `SELECT id, "totalPrice" FROM "order"
        WHERE "store" = :store AND "createdBy" = :user
          AND ("createdAt" < :openedAt OR "createdAt" > :endAt)
          AND "paymentStatus" IN ('paid', 'refunded')
          AND "status" NOT IN ('cancelled', 'void') ORDER BY id`,
      { replacements: base, ...queryOpts }
    )
  ])

  // Cash expenses use the same contract as computeCashLedgerSummary
  // (store + cash method + approved + system-createdAt window, no
  // createdBy filter). Anything else is an explicit exclusion.
  const [cashExpRows, nonCashRows, notApprovedRows, expOutsideRows, cashExpRecords] = await Promise.all([
    db.sequelize.query(
      `SELECT id, amount FROM expense
        WHERE "store" = :store AND "paymentMethod" = 'cash' AND "status" = 'approved'
          AND "createdAt" >= :openedAt AND "createdAt" <= :endAt ORDER BY id`,
      { replacements: base, ...queryOpts }
    ),
    db.sequelize.query(
      `SELECT id, amount FROM expense
        WHERE "store" = :store AND "paymentMethod" <> 'cash' AND "status" = 'approved'
          AND "createdAt" >= :openedAt AND "createdAt" <= :endAt ORDER BY id`,
      { replacements: base, ...queryOpts }
    ),
    db.sequelize.query(
      `SELECT id, amount FROM expense
        WHERE "store" = :store AND "status" IN ('pending', 'rejected', 'draft')
          AND "createdAt" >= :openedAt AND "createdAt" <= :endAt ORDER BY id`,
      { replacements: base, ...queryOpts }
    ),
    db.sequelize.query(
      `SELECT id, amount FROM expense
        WHERE "store" = :store AND "status" = 'approved'
          AND ("createdAt" < :openedAt OR "createdAt" > :endAt) ORDER BY id`,
      { replacements: base, ...queryOpts }
    ),
    db.expense.findAll({
      where: {
        store,
        paymentMethod: 'cash',
        status: 'approved',
        createdAt: { [Op.gte]: openedAt, [Op.lte]: endAt }
      },
      include: [{ model: db.expense_category, as: 'categoryData', attributes: ['id', 'name'] }],
      order: [['id', 'ASC']],
      ...(transaction ? { transaction } : {})
    })
  ])
  const sumAmounts = (rows) => (rows || []).reduce((s, r) => s + Number(r.amount || 0), 0)

  const [moveInRows, moveOutRows, movePendingRows] = await Promise.all([
    db.sequelize.query(
      `SELECT COALESCE(SUM(amount), 0) as total, COUNT(*)::int as count FROM cash_movement
        WHERE "cashRegisterId" = :registerId AND type = 'cash_in' AND status = 'active'`,
      { replacements: { registerId }, ...queryOpts }
    ).then((r) => r[0]),
    db.sequelize.query(
      `SELECT COALESCE(SUM(amount), 0) as total, COUNT(*)::int as count FROM cash_movement
        WHERE "cashRegisterId" = :registerId AND type = 'cash_out' AND status = 'active'`,
      { replacements: { registerId }, ...queryOpts }
    ).then((r) => r[0]),
    db.sequelize.query(
      `SELECT COALESCE(SUM(amount), 0) as total, COUNT(*)::int as count FROM cash_movement
        WHERE "cashRegisterId" = :registerId AND status = 'pending_approval'`,
      { replacements: { registerId }, ...queryOpts }
    ).then((r) => r[0])
  ])

  const excluded = []
  const pushBucket = (code, rows) => {
    const [bucketCode, reason] = excludedQueries[code]
    if (rows && rows.length > 0) excluded.push(bucket(bucketCode, reason, rows))
  }
  pushBucket('UNPAID', unpaidRows)
  pushBucket('CANCELLED_VOID', cancelledRows)
  pushBucket('REFUNDED', refundedRows)
  pushBucket('OTHER_CREATOR', otherCreatorRows)
  pushBucket('OUTSIDE_WINDOW', outsideRows)

  const expExcluded = []
  const pushExpBucket = (code, reason, rows) => {
    if (rows && rows.length > 0) {
      expExcluded.push({
        code,
        reason,
        count: rows.length,
        total: sumAmounts(rows),
        expenseIds: rows.map((r) => r.id)
      })
    }
  }
  pushExpBucket(
    'NON_CASH_METHOD',
    'Approved expense paid by a non-cash method, so it is not part of the cash-register cash expenses.',
    nonCashRows
  )
  pushExpBucket(
    'NOT_APPROVED',
    'Expense is not approved, so it is excluded until approval.',
    notApprovedRows
  )
  pushExpBucket(
    'OUTSIDE_WINDOW',
    'Approved expense created outside this register open window.',
    expOutsideRows
  )

  return {
    window: { openedAt, endAt },
    sales: {
      eligible: {
        ...pack(eligibleRows),
        byPaymentMethod: (methodRows || []).map((r) => ({
          type: r.type,
          orders: Number(r.orders || 0),
          amount: Number(r.amount || 0)
        }))
      },
      excluded
    },
    expenses: {
      includedCash: {
        count: (cashExpRows || []).length,
        total: sumAmounts(cashExpRows),
        expenseIds: (cashExpRows || []).map((r) => r.id)
      },
      records: (cashExpRecords || []).map((e) => {
        const plain = e.get({ plain: true })
        return {
          id: plain.id,
          amount: Number(plain.amount || 0),
          category: plain.categoryData?.name || null,
          date: plain.date,
          createdAt: plain.createdAt,
          description: plain.description || null,
          notes: plain.notes || null,
          createdBy: plain.createdBy
        }
      }),
      excluded: expExcluded
    },
    movements: {
      cashIn: { count: Number(moveInRows.count || 0), total: Number(moveInRows.total || 0) },
      cashOut: { count: Number(moveOutRows.count || 0), total: Number(moveOutRows.total || 0) },
      pending: { count: Number(movePendingRows.count || 0), total: Number(movePendingRows.total || 0) }
    }
  }
}

const cashRegisterController = {
  async open(req, res) {
    try {
      // Explicit selection only: req.storeId is middleware-resolved
      // (query/body store for super_admin, own store for tenants). A stale
      // activeStore cookie must not silently pick the store here — it used
      // to bypass the 400 below and open the register in the wrong store.
      const store = req.storeId
      const { openingBalance = 0, shift, confirmTableReset } = req.body
      const userId = req.user?.id || null

      if (!store) {
        return res.status(400).json({
          success: false,
          message: 'Store not selected'
        })
      }

      // Fast, friendly fast-path — the partial unique index below
      // (cash_register_store_open_unique) is the real, race-safe
      // guarantee for the case this check can't catch.
      const openRegister = await db.cashRegister.findOne({
        where: { store, status: 'open' }
      })

      if (openRegister) {
        return res.status(400).json({
          success: false,
          message: 'Store already has an open cash register'
        })
      }

      let cashRegister
      try {
        cashRegister = await withDeadlockRetry(() =>
          db.sequelize.transaction(async (t) => {
            const created = await db.cashRegister.create(
              {
                store,
                user: userId,
                shift,
                openingBalance,
                status: 'open',
                openedAt: new Date()
              },
              { transaction: t }
            )

            await redactAndAudit(req, {
              action: AUDIT_ACTIONS.CREATE,
              entity: 'cash_register',
              entityId: created.id,
              description: `Opened cash register for store ${store}`,
              newValues: created,
              transaction: t
            })

            return created
          })
        )
      } catch (error) {
        if (error.name === 'SequelizeUniqueConstraintError') {
          return res.status(409).json({
            success: false,
            message: 'Store already has an open cash register'
          })
        }
        throw error
      }

      const location = await db.location.findByPk(store, {
        attributes: ['id', 'name', 'address', 'city', 'timezone']
      })

      // Phase 39 Batch 6C: cleanup runs AFTER the register-creation
      // transaction has already committed, and is never allowed to affect
      // this response's success — the register is open regardless of
      // whether cleanup was requested, ran cleanly, partially failed, or
      // threw. `attempted` reflects whether confirmTableReset was set at
      // all, independent of whether any table was actually eligible.
      let tableCleanupResult = { attempted: false, succeeded: 0, failed: 0 }
      if (confirmTableReset) {
        const { succeeded, failed, warning } = await performTableResetCleanup(store)
        tableCleanupResult = { attempted: true, succeeded, failed, ...(warning ? { warning } : {}) }
      }

      return res.status(201).json({
        success: true,
        message: 'Cash register opened',
        data: { ...cashRegister.toJSON(), storeData: location },
        tableCleanupResult
      })
    } catch (error) {
      console.log(error)
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Internal server error'
      })
    }
  },

  async getTableResetPreview(req, res) {
    try {
      // Same cookie rule as open(): explicit selection only.
      const store = req.storeId
      if (!store) {
        return res.status(400).json({
          success: false,
          message: 'Store not selected'
        })
      }
      const eligibleIds = await getEligibleTableResetIds(store)
      return res.status(200).json({
        success: true,
        message: 'Success',
        data: { eligibleCount: eligibleIds.length }
      })
    } catch (error) {
      console.log(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async close(req, res) {
    try {
      const { id } = req.params
      // Same cookie rule as open(): the close target is scoped by the
      // explicit selection, never by a stale cookie.
      const store = req.storeId
      const { closingBalance, notes } = req.body

      if (!store) {
        return res.status(400).json({
          success: false,
          message: 'Store not selected'
        })
      }

      const result = await withDeadlockRetry(() =>
        db.sequelize.transaction(async (t) => {
          // This lock is the SAME lock createMovement/decideMovement/
          // reverseMovement acquire before acting — that shared contention
          // is what makes "movement against an already-closed register"
          // deterministic (409) rather than racy.
          //
          // Postgres rejects FOR UPDATE combined with a LEFT OUTER JOIN
          // ("FOR UPDATE cannot be applied to the nullable side of an
          // outer join") — Sequelize's belongsTo `include` defaults to
          // LEFT JOIN, so the lock and the include cannot be in the same
          // query. Lock the bare row first, then reload with the
          // associations needed for the response/threshold lookup —
          // still inside the same transaction, still fully consistent,
          // since the lock is already held by the time the reload runs.
          const cashRegister = await db.cashRegister.findOne({
            where: { id, store, status: 'open' },
            transaction: t,
            lock: t.LOCK.UPDATE
          })

          if (!cashRegister) {
            const e = new Error('Open cash register not found')
            e.statusCode = 404
            throw e
          }

          await cashRegister.reload({
            include: [
              {
                model: db.user,
                as: 'userData',
                attributes: ['id', 'fullName']
              },
              {
                model: db.location,
                as: 'storeData',
                attributes: ['id', 'name', 'cashVarianceThreshold']
              }
            ],
            transaction: t
          })

          const pendingCount = await db.cashMovement.count({
            where: {
              cashRegisterId: cashRegister.id,
              status: 'pending_approval'
            },
            transaction: t
          })
          if (pendingCount > 0) {
            const e = new Error(
              'Cannot close: this register has cash movements awaiting approval'
            )
            e.statusCode = 409
            throw e
          }

          const now = new Date()
          // P1 (DR-PAY-ATTR-04): the snapshot is computed here, inside the
          // same transaction that already holds the register UPDATE lock —
          // calculate -> unlock -> later UPDATE is forbidden because a
          // settlement/refund could race into the gap. Every figure below
          // is what the live report would show at this exact instant, so
          // the frozen Z is byte-equivalent to close-time live output.
          const snapshot = await buildCloseSnapshot({
            registerId: cashRegister.id,
            store,
            user: cashRegister.user,
            openedAt: cashRegister.openedAt,
            endAt: now,
            openingBalance: cashRegister.openingBalance,
            transaction: t
          })

          const totalSales = snapshot.gross.totalSales
          const totalPayments = {}
          for (const p of snapshot.payments) {
            totalPayments[p.type] = p.total
          }

          const {
            expectedCash,
            activeCashIn,
            activeCashOut,
            cashRefundsTotal,
            refundsTotal,
            refundCount,
            totalTransactions
          } = snapshot
          const cashSalesReceived = snapshot.cash.cashSalesReceived
          const cashExpenses = snapshot.cash.cashExpenses

          const variance = (closingBalance || 0) - expectedCash
          const threshold =
            cashRegister.storeData?.cashVarianceThreshold ??
            DEFAULT_CASH_VARIANCE_THRESHOLD
          const varianceApprovalStatus =
            Math.abs(variance) <= threshold ? 'auto_approved' : 'pending_approval'

          await cashRegister.update(
            {
              closingBalance: closingBalance || 0,
              totalSales,
              cashSalesReceived,
              totalExpenses: cashExpenses,
              totalPayments,
              expectedCash,
              activeCashIn,
              activeCashOut,
              cashRefundsTotal,
              refundsTotal,
              refundCount,
              totalTransactions,
              closeSnapshot: {
                gross: snapshot.gross,
                payments: snapshot.payments,
                expenses: snapshot.expenses,
                salesByProduct: snapshot.salesByProduct
              },
              variance,
              varianceApprovalStatus,
              status: 'closed',
              closedAt: now,
              notes
            },
            { transaction: t }
          )

          await redactAndAudit(req, {
            action: AUDIT_ACTIONS.UPDATE,
            entity: 'cash_register',
            entityId: cashRegister.id,
            description: `Closed cash register for store ${store}`,
            oldValues: { status: 'open' },
            newValues: {
              status: 'closed',
              closingBalance: closingBalance || 0,
              variance,
              varianceApprovalStatus
            },
            transaction: t
          })

          return {
            cashRegister,
            totalSales,
            cashSalesReceived,
            totalExpenses: cashExpenses,
            totalPayments,
            activeCashIn,
            activeCashOut,
            expectedCash,
            cashRefundsTotal,
            refundsTotal,
            refundCount,
            totalTransactions,
            closeSnapshot: {
              gross: snapshot.gross,
              payments: snapshot.payments,
              expenses: snapshot.expenses,
              salesByProduct: snapshot.salesByProduct
            },
            variance,
            varianceApprovalStatus
          }
        })
      )

      // P1 (DR-PAY-ATTR-04): the close response carries the same report
      // shape a frozen Z serves (summary/payments/expenses), so a closed
      // Z re-fetch is byte-equivalent to close-time output by
      // construction. varianceApprovalStatus is close-only metadata.
      const closePayments = result.closeSnapshot.payments.map((p) => ({
        type: p.type,
        amount: p.total,
        count: p.count
      }))
      const closeExpenses = result.closeSnapshot.expenses.map((e) => ({
        category: e.category,
        amount: e.total,
        count: e.count
      }))
      const closeGross = result.closeSnapshot.gross || {}
      return res.status(200).json({
        success: true,
        message: 'Cash register closed',
        data: {
          register: {
            id: result.cashRegister.id,
            shift: result.cashRegister.shift,
            status: 'closed',
            openedAt: result.cashRegister.openedAt,
            closedAt: result.cashRegister.closedAt,
            notes: result.cashRegister.notes,
            openingBalance: Number(result.cashRegister.openingBalance || 0),
            closingBalance: Number(result.cashRegister.closingBalance || 0)
          },
          store: result.cashRegister.storeData
            ? {
                id: result.cashRegister.storeData.id,
                name: result.cashRegister.storeData.name,
                address: result.cashRegister.storeData.address,
                city: result.cashRegister.storeData.city,
                phone:
                  result.cashRegister.storeData.phoneNumber ||
                  result.cashRegister.storeData.phone ||
                  null,
                timezone: result.cashRegister.storeData.timezone || null
              }
            : null,
          cashier: result.cashRegister.userData
            ? { id: result.cashRegister.userData.id, fullName: result.cashRegister.userData.fullName }
            : { id: result.cashRegister.user },
          summary: {
            totalTransactions: result.totalTransactions,
            totalQuantity: Number(closeGross.quantity || 0),
            totalCovers: Number(closeGross.covers || 0),
            subtotal: Number(closeGross.subtotal || 0),
            discount: Number(closeGross.discount || 0),
            tax: Number(closeGross.tax || 0),
            serviceCharge: Number(closeGross.serviceCharge || 0),
            totalSales: result.totalSales,
            totalExpenses: result.totalExpenses,
            totalCashPayment: result.cashSalesReceived,
            cashSalesReceived: result.cashSalesReceived,
            totalNonCashPayment: closePayments
              .filter((p) => p.type !== 'CASH')
              .reduce((s, p) => s + p.amount, 0),
            activeCashIn: result.activeCashIn,
            activeCashOut: result.activeCashOut,
            expectedCash: result.expectedCash,
            cashRefundsTotal: result.cashRefundsTotal,
            refundsTotal: result.refundsTotal,
            refundCount: result.refundCount,
            variance: result.variance,
            varianceApprovalStatus: result.varianceApprovalStatus
          },
          payments: closePayments,
          expenses: closeExpenses,
          salesByProduct: result.closeSnapshot.salesByProduct
        }
      })
    } catch (error) {
      console.log(error)
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Internal server error'
      })
    }
  },

  // PUT /cash-register/:id/decide-variance — { decision: 'approve' | 'reject' }
  // Only a CLOSED register with varianceApprovalStatus = 'pending_approval'
  // may be decided. Rejecting does NOT reopen the register or change
  // variance — it only records the approval decision and who/when.
  async decideVariance(req, res) {
    try {
      const { id } = req.params
      const { decision } = req.body

      // BE-1: serialize concurrent decisions on the same register with a
      // row-level lock inside a transaction (same pattern as
      // decideMovement/createMovement). The eligibility check and the
      // winning state transition are atomic: the loser blocks on the lock,
      // then re-reads decided state and receives 409 without writing audit.
      const cashRegister = await withDeadlockRetry(() =>
        db.sequelize.transaction(async (t) => {
          const locked = await db.cashRegister.findOne({
            where: scalarStoreScope(req, { id }),
            transaction: t,
            lock: t.LOCK.UPDATE
          })

          if (!locked) {
            const e = new Error('Cash register not found')
            e.statusCode = 404
            throw e
          }

          if (
            locked.status !== 'closed' ||
            locked.varianceApprovalStatus !== 'pending_approval'
          ) {
            const e = new Error(
              `Cannot decide variance for a register in status ${locked.status}/${locked.varianceApprovalStatus}`
            )
            e.statusCode = 409
            throw e
          }

          const newStatus = decision === 'approve' ? 'approved' : 'rejected'

          await locked.update(
            {
              varianceApprovalStatus: newStatus,
              approvedBy: req.user?.id || null,
              approvedAt: new Date()
            },
            { transaction: t }
          )

          await redactAndAudit(req, {
            action:
              decision === 'approve' ? AUDIT_ACTIONS.APPROVE : AUDIT_ACTIONS.REJECT,
            entity: 'cash_register',
            entityId: locked.id,
            description: `Cash register variance ${decision}d`,
            oldValues: { varianceApprovalStatus: 'pending_approval' },
            newValues: { varianceApprovalStatus: newStatus },
            transaction: t
          })

          return locked
        })
      )

      return res.status(200).json({
        success: true,
        message: `Variance ${decision}d`,
        data: cashRegister
      })
    } catch (error) {
      console.log(error)
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Internal server error'
      })
    }
  },

  // GET /cash-register/:id/movements — newest first. The register lookup
  // carries the tenant/store scope, so a non-owning row reads as 404 rather
  // than 403 (same convention as the movement write paths).
  async listMovements(req, res) {
    try {
      const { id } = req.params

      const cashRegister = await db.cashRegister.findOne({
        where: scalarStoreScope(req, { id })
      })

      if (!cashRegister) {
        return res.status(404).json({
          success: false,
          message: 'Cash register not found'
        })
      }

      const movements = await db.cashMovement.findAll({
        where: { cashRegisterId: cashRegister.id },
        order: [['id', 'DESC']]
      })

      return res.status(200).json({
        success: true,
        message: 'Cash movements retrieved',
        data: movements
      })
    } catch (error) {
      console.log(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  // POST /cash-register/:id/movement
  async createMovement(req, res) {
    try {
      const { id: cashRegisterId } = req.params
      const { type, reasonCode, amount, notes, idempotencyKey } = req.body

      // Semantic validation deliberately NOT expressed in the Zod schema
      // (see schemas.js comment) — every ZodError resolves to 400, but
      // these two must be 422 per the F2 API contract.
      if (!(Number(amount) > 0)) {
        return res.status(422).json({
          success: false,
          message: 'amount must be positive'
        })
      }
      // F-MON-1: cash_movement.amount is INT4 — reject fractional or
      // out-of-range values here instead of silent DB rounding/overflow.
      assertIntegerRupiah(amount, 'amount')
      if (reasonCode === 'other' && !notes?.trim()) {
        return res.status(422).json({
          success: false,
          message: 'notes is required when reasonCode is other'
        })
      }

      // Fast-path idempotency check — a plain read outside the
      // transaction. The authoritative guarantee is the partial unique
      // index, enforced below if two such requests race.
      if (idempotencyKey) {
        const existing = await db.cashMovement.findOne({
          where: { cashRegisterId, idempotencyKey }
        })
        if (existing) {
          // F-IDEM-1: identity is direction + magnitude — a different
          // type or amount under the same key is a conflict, not a replay.
          if (
            existing.type !== type ||
            Number(existing.amount) !== Number(amount)
          ) {
            return res.status(409).json({
              success: false,
              message: 'idempotencyKey already used with a different payload'
            })
          }
          return res.status(200).json({
            success: true,
            message: 'Movement already recorded',
            data: existing
          })
        }
      }

      let movement
      try {
        movement = await withDeadlockRetry(() =>
          db.sequelize.transaction(async (t) => {
            // Same Postgres FOR-UPDATE-vs-outer-join constraint as close()
            // — lock the bare row first, then a separate, unlocked read
            // for the threshold.
            const register = await db.cashRegister.findOne({
              where: scalarStoreScope(req, { id: cashRegisterId }),
              transaction: t,
              lock: t.LOCK.UPDATE // serializes against close(), decideMovement(), reverseMovement()
            })
            if (!register) {
              const e = new Error('Cash register not found')
              e.statusCode = 404
              throw e
            }
            if (register.status !== 'open') {
              const e = new Error(
                'Cannot record a cash movement against a closed register'
              )
              e.statusCode = 409
              throw e
            }

            const registerLocation = await db.location.findByPk(register.store, {
              attributes: ['id', 'cashOutApprovalThreshold'],
              transaction: t
            })
            const threshold =
              registerLocation?.cashOutApprovalThreshold ??
              DEFAULT_CASH_OUT_APPROVAL_THRESHOLD
            const status =
              type === 'cash_out' && Number(amount) > threshold
                ? 'pending_approval'
                : 'active'

            const created = await db.cashMovement.create(
              {
                store: register.store,
                cashRegisterId: register.id,
                type,
                reasonCode,
                amount: Number(amount),
                notes: notes || null,
                status,
                createdBy: req.user?.id || null,
                idempotencyKey: idempotencyKey || null
              },
              { transaction: t }
            )

            await redactAndAudit(req, {
              action: AUDIT_ACTIONS.CREATE,
              entity: 'cash_movement',
              entityId: created.id,
              description: `${type} of ${amount} (${reasonCode}) on register ${register.id}`,
              newValues: created,
              transaction: t
            })

            return created
          })
        )
      } catch (error) {
        // Destructured locals live inside the try above — re-read them
        // from the request here.
        const catchKey = req.body?.idempotencyKey
        const catchRegisterId = req.params?.id
        const catchType = req.body?.type
        const catchAmount = req.body?.amount
        if (error.name === 'SequelizeUniqueConstraintError' && catchKey) {
          const existing = await db.cashMovement.findOne({
            where: { cashRegisterId: catchRegisterId, idempotencyKey: catchKey }
          })
          if (existing) {
            if (
              existing.type !== catchType ||
              Number(existing.amount) !== Number(catchAmount)
            ) {
              return res.status(409).json({
                success: false,
                message: 'idempotencyKey already used with a different payload'
              })
            }
            return res.status(200).json({
              success: true,
              message: 'Movement already recorded',
              data: existing
            })
          }
        }
        throw error
      }

      return res.status(201).json({
        success: true,
        message: 'Cash movement recorded',
        data: movement
      })
    } catch (error) {
      console.log(error)
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Internal server error'
      })
    }
  },

  // POST /cash-register/movement/:id/decide — { decision: 'approve' | 'reject' }
  async decideMovement(req, res) {
    try {
      const { id } = req.params
      const { decision } = req.body

      const movement = await withDeadlockRetry(() =>
        db.sequelize.transaction(async (t) => {
          const mv = await db.cashMovement.findOne({
            where: scalarStoreScope(req, { id }),
            transaction: t
          })
          if (!mv) {
            const e = new Error('Cash movement not found')
            e.statusCode = 404
            throw e
          }

          // Register lock FIRST — same row close() locks.
          const register = await db.cashRegister.findByPk(mv.cashRegisterId, {
            transaction: t,
            lock: t.LOCK.UPDATE
          })
          if (!register || register.status !== 'open') {
            const e = new Error('Cannot decide a movement on a closed register')
            e.statusCode = 409
            throw e
          }

          // THEN the movement row.
          const lockedMv = await db.cashMovement.findByPk(id, {
            transaction: t,
            lock: t.LOCK.UPDATE
          })
          if (lockedMv.status !== 'pending_approval') {
            const e = new Error(
              `Cannot ${decision} a movement in status ${lockedMv.status}`
            )
            e.statusCode = 409
            throw e
          }

          const newStatus = decision === 'approve' ? 'active' : 'rejected'
          await lockedMv.update(
            {
              status: newStatus,
              approvedBy: req.user?.id || null,
              approvedAt: new Date()
            },
            { transaction: t }
          )

          await redactAndAudit(req, {
            action:
              decision === 'approve'
                ? AUDIT_ACTIONS.APPROVE
                : AUDIT_ACTIONS.REJECT,
            entity: 'cash_movement',
            entityId: lockedMv.id,
            description: `Cash movement ${decision}d`,
            oldValues: { status: 'pending_approval' },
            newValues: { status: newStatus },
            transaction: t
          })

          return lockedMv
        })
      )

      return res.status(200).json({
        success: true,
        message: `Movement ${decision}d`,
        data: movement
      })
    } catch (error) {
      console.log(error)
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Internal server error'
      })
    }
  },

  // POST /cash-register/movement/:id/reverse
  async reverseMovement(req, res) {
    try {
      const { id } = req.params
      const { notes } = req.body

      const reversal = await withDeadlockRetry(() =>
        db.sequelize.transaction(async (t) => {
          const original = await db.cashMovement.findOne({
            where: scalarStoreScope(req, { id }),
            transaction: t
          })
          if (!original) {
            const e = new Error('Cash movement not found')
            e.statusCode = 404
            throw e
          }

          const register = await db.cashRegister.findByPk(
            original.cashRegisterId,
            { transaction: t, lock: t.LOCK.UPDATE }
          )
          if (!register || register.status !== 'open') {
            const e = new Error('Cannot reverse a movement on a closed register')
            e.statusCode = 409
            throw e
          }

          const lockedOriginal = await db.cashMovement.findByPk(id, {
            transaction: t,
            lock: t.LOCK.UPDATE
          })
          if (lockedOriginal.status !== 'active') {
            const e = new Error(
              `Cannot reverse a movement in status ${lockedOriginal.status}`
            )
            e.statusCode = 409
            throw e
          }

          await lockedOriginal.update({ status: 'reversed' }, { transaction: t })

          const created = await db.cashMovement.create(
            {
              store: register.store,
              cashRegisterId: register.id,
              type: lockedOriginal.type === 'cash_in' ? 'cash_out' : 'cash_in',
              reasonCode: 'correction',
              amount: lockedOriginal.amount,
              notes: notes || `Reversal of movement #${lockedOriginal.id}`,
              status: 'active',
              reversalOfId: lockedOriginal.id,
              createdBy: req.user?.id || null
            },
            { transaction: t }
          )

          await redactAndAudit(req, {
            action: AUDIT_ACTIONS.UPDATE,
            entity: 'cash_movement',
            entityId: lockedOriginal.id,
            description: `Movement reversed by #${created.id}`,
            oldValues: { status: 'active' },
            newValues: { status: 'reversed', reversalId: created.id },
            transaction: t
          })

          return created
        })
      )

      return res.status(201).json({
        success: true,
        message: 'Movement reversed',
        data: reversal
      })
    } catch (error) {
      console.log(error)
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Internal server error'
      })
    }
  },

  async getCurrent(req, res) {
    try {
      // Same cookie rule as open(): explicit selection only.
      const store = req.storeId
      const userId = req.user?.id || null

      if (!store) {
        return res.status(400).json({
          success: false,
          message: 'Store not selected'
        })
      }

      const cashRegister = await db.cashRegister.findOne({
        where: { store, user: userId, status: 'open' },
        include: [
          {
            model: db.user,
            as: 'userData',
            attributes: ['id', 'fullName']
          },
          {
            model: db.location,
            as: 'storeData',
            // Phase 39 Batch 6F: openingHours added so the FE close screen
            // can show an informational overtime notice — display only,
            // nothing here reads or enforces it server-side.
            attributes: ['id', 'name', 'address', 'city', 'timezone', 'openingHours']
          }
        ]
      })

      if (!cashRegister) {
        return res.status(200).json({
          success: true,
          message: 'No open cash register',
          data: null
        })
      }

      // totalSales: UNCHANGED existing meaning/computation.
      const [salesAgg] = await db.sequelize.query(
        `SELECT COUNT(*) as "totalTransactions",
                COALESCE(SUM("totalPrice"), 0) as "totalSales"
           FROM "order"
          WHERE "store" = :store AND "createdBy" = :user
            AND "createdAt" >= :openedAt AND "paymentStatus" = 'paid'`,
        {
          replacements: { store, user: userId, openedAt: cashRegister.openedAt },
          type: db.sequelize.QueryTypes.SELECT
        }
      )

      const totalSales = Number(salesAgg.totalSales || 0)

      const {
        cashSalesReceived,
        cashExpenses,
        activeCashIn,
        activeCashOut,
        expectedCash
      } = await computeCashLedgerSummary({
        registerId: cashRegister.id,
        store,
        openingBalance: cashRegister.openingBalance,
        openedAt: cashRegister.openedAt,
        endAt: new Date()
      })

      return res.status(200).json({
        success: true,
        message: 'Success get current register',
        data: {
          register: cashRegister,
          currentSales: totalSales,
          cashSalesReceived,
          totalExpenses: cashExpenses,
          activeCashIn,
          activeCashOut,
          totalTransactions: Number(salesAgg.totalTransactions || 0),
          expectedCash
        }
      })
    } catch (error) {
      console.log(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async getHistory(req, res) {
    try {
      // Semua Toko (global super_admin, no explicit store) must stay unscoped.
      // req.storeId is the middleware-resolved explicit selection (query/body
      // store for super_admin, own store for tenants). Ambient cookies such as
      // a stale activeStore left by another page must not silently scope this
      // list — it used to hide other stores here via getStore's fallback.
      const store = req.storeId
      const { startDate, endDate, page = 1, limit = 50, search } = req.query
      const isSuperAdmin = req.user?.roleType === 'super_admin'

      const where = {}
      if (store) {
        where.store = store
      } else if (!isSuperAdmin) {
        return res.status(400).json({
          success: false,
          message: 'Store not selected'
        })
      }

      if (search) {
        where[Op.or] = [
          { '$userData.fullName$': { [Op.iLike]: `%${search}%` } },
          { '$storeData.name$': { [Op.iLike]: `%${search}%` } },
          { status: { [Op.iLike]: `%${search}%` } }
        ]
      }

      if (startDate || endDate) {
        where.openedAt = {}
        if (startDate) where.openedAt[Op.gte] = new Date(startDate)
        if (endDate) where.openedAt[Op.lte] = new Date(endDate + 'T23:59:59')
      }

      const offset = (parseInt(page) - 1) * parseInt(limit)

      const { count, rows } = await db.cashRegister.findAndCountAll({
        where,
        include: [
          {
            model: db.user,
            as: 'userData',
            attributes: ['id', 'fullName']
          },
          {
            model: db.location,
            as: 'storeData',
            attributes: ['id', 'name', 'address', 'city', 'timezone']
          }
        ],
        order: [['openedAt', 'DESC']],
        limit: parseInt(limit),
        offset
      })

      await enrichAuditFields(db, rows)

      const openRegisters = rows.filter((r) => r.status === 'open')

      let salesMap = {}
      let expenseMap = {}

      if (openRegisters.length > 0) {
        const salesQueries = openRegisters.map(async (row) => {
          const d = row.get({ plain: true })
          const [result] = await db.sequelize.query(
            `SELECT COUNT(*) as "totalTransactions",
                    COALESCE(SUM("totalPrice"), 0) as "totalSales"
             FROM "order"
             WHERE "store" = :store AND "createdBy" = :user
               AND "createdAt" >= :openedAt AND "paymentStatus" = 'paid'`,
            {
              replacements: {
                store: d.store,
                user: d.user,
                openedAt: d.openedAt
              },
              type: db.sequelize.QueryTypes.SELECT
            }
          )
          salesMap[d.id] = {
            totalSales: Number(result.totalSales || 0),
            totalTransactions: Number(result.totalTransactions || 0)
          }
        })

        const expenseQueries = openRegisters.map(async (row) => {
          const d = row.get({ plain: true })
          const [result] = await db.sequelize.query(
            `SELECT COALESCE(SUM("amount"), 0) as "totalExpenses"
             FROM expense
             WHERE "store" = :store AND "createdBy" = :user
               AND "date" >= :openedAt AND "status" = 'approved'`,
            {
              replacements: {
                store: d.store,
                user: d.user,
                openedAt: d.openedAt
              },
              type: db.sequelize.QueryTypes.SELECT
            }
          )
          expenseMap[d.id] = Number(result.totalExpenses || 0)
        })

        await Promise.all([...salesQueries, ...expenseQueries])
      }

      const enriched = rows.map((row) => {
        if (row.status !== 'open') return row
        const data = row.get({ plain: true })
        const sales = salesMap[data.id] || {
          totalSales: 0,
          totalTransactions: 0
        }
        data.totalSales = sales.totalSales
        data.totalExpenses = expenseMap[data.id] || 0
        return data
      })

      // Phase 39 Batch 4 follow-up: per-register outside-window sales
      // population for the /cash-register/history list ("Di luar periode:
      // Nx · RpY") so users can see why a register's closing balance only
      // reflects its own window. Same OUTSIDE_WINDOW membership as the
      // reconciliation bucket (store + opener + paid/refunded + not
      // cancelled/void, outside [openedAt, closedAt||now]); one aggregate
      // query per listed register, bounded by the page limit. Read-only,
      // additive — no stored financial meaning is changed.
      const outsideMap = {}
      await Promise.all(
        rows.map(async (row) => {
          const d = typeof row.get === 'function' ? row.get({ plain: true }) : row
          const [outside] = await db.sequelize.query(
            `SELECT COUNT(*)::int as count, COALESCE(SUM("totalPrice"), 0) as total
               FROM "order"
              WHERE "store" = :store AND "createdBy" = :user
                AND ("createdAt" < :openedAt OR "createdAt" > :endAt)
                AND "paymentStatus" IN ('paid', 'refunded')
                AND "status" NOT IN ('cancelled', 'void')`,
            {
              replacements: {
                store: d.store,
                user: d.user,
                openedAt: d.openedAt,
                endAt: d.closedAt || new Date()
              },
              type: db.sequelize.QueryTypes.SELECT
            }
          )
          outsideMap[d.id] = {
            count: Number(outside.count || 0),
            total: Number(outside.total || 0)
          }
        })
      )
      for (const row of enriched) {
        const plain = typeof row.get === 'function' ? row.get({ plain: true }) : row
        const value = outsideMap[plain.id] || { count: 0, total: 0 }
        if (typeof row.setDataValue === 'function') row.setDataValue('outsideWindow', value)
        else row.outsideWindow = value
      }

      return res.status(200).json({
        success: true,
        message: 'Success get register history',
        data: enriched,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / parseInt(limit))
        }
      })
    } catch (error) {
      console.log(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async getOpenRegisters(req, res) {
    try {
      // Same cookie rule as getHistory(): global super_admin stays unscoped.
      const store = req.storeId
      const where = { status: 'open' }
      if (store) {
        where.store = store
      }

      const openRegisters = await db.cashRegister.findAll({
        where,
        attributes: ['id', 'store', 'user', 'status', 'openedAt'],
        include: [
          {
            model: db.location,
            as: 'storeData',
            attributes: ['id', 'name']
          },
          {
            model: db.user,
            as: 'userData',
            attributes: ['id', 'fullName']
          }
        ],
        order: [['openedAt', 'ASC']]
      })

      return res.status(200).json({
        success: true,
        message: 'Success get open registers',
        data: openRegisters
      })
    } catch (error) {
      console.log(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async getXReport(req, res) {
    try {
      // Same cookie rule as open(): explicit selection only.
      const store = req.storeId
      const userId = req.user?.id || null

      if (!store) {
        return res.status(400).json({
          success: false,
          message: 'Store not selected'
        })
      }

      const register = await db.cashRegister.findOne({
        where: { store, user: userId, status: 'open' },
        include: [
          {
            model: db.user,
            as: 'userData',
            attributes: ['id', 'fullName']
          },
          {
            model: db.location,
            as: 'storeData',
            attributes: ['id', 'name', 'address', 'city', 'phoneNumber', 'timezone']
          }
        ]
      })

      if (!register) {
        return res.status(200).json({
          success: true,
          message: 'No open cash register',
          data: null
        })
      }

      const data = await buildReportData({
        register,
        store,
        user: userId,
        openedAt: register.openedAt,
        endAt: new Date(),
        storeData: register.storeData,
        userData: register.userData
      })

      return res.status(200).json({
        success: true,
        message: 'X report generated',
        data
      })
    } catch (error) {
      console.log(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async getZReport(req, res) {
    try {
      const { id } = req.params
      const store = getStore(req)
      const isSuperAdmin = req.user?.roleType === 'super_admin'

      const register = await db.cashRegister.findByPk(id, {
        include: [
          {
            model: db.user,
            as: 'userData',
            attributes: ['id', 'fullName']
          },
          {
            model: db.location,
            as: 'storeData',
            attributes: ['id', 'name', 'address', 'city', 'phoneNumber', 'timezone']
          }
        ]
      })

      if (!register) {
        return res.status(404).json({
          success: false,
          message: 'Cash register not found'
        })
      }

      if (!isSuperAdmin && register.store !== Number(store)) {
        return res.status(403).json({
          success: false,
          message: 'Forbidden'
        })
      }

      // P1 (DR-PAY-ATTR-04): a closed register with a persisted snapshot
      // serves its frozen close-time figures — never a live recomputation
      // that later settlements/refunds/movements could drift. Registers
      // closed before snapshots existed (NULL closeSnapshot) keep the
      // legacy live path for backward compatibility.
      let data
      if (register.status === 'closed' && register.closeSnapshot) {
        const snap = register.closeSnapshot
        const gross = snap.gross || {}
        const frozenPayments = Array.isArray(snap.payments) ? snap.payments : []
        const frozenExpenses = Array.isArray(snap.expenses) ? snap.expenses : []
        const num = (v) => Number(v || 0)
        const closingBalance = num(register.closingBalance)
        const frozenExpected = num(register.expectedCash)
        data = {
          register: {
            id: register.id,
            shift: register.shift,
            status: register.status,
            openedAt: register.openedAt,
            closedAt: register.closedAt,
            notes: register.notes,
            openingBalance: num(register.openingBalance),
            closingBalance
          },
          store: register.storeData
            ? {
                id: register.storeData.id,
                name: register.storeData.name,
                address: register.storeData.address,
                city: register.storeData.city,
                phone: register.storeData.phoneNumber || register.storeData.phone || null,
                timezone: register.storeData.timezone || null
              }
            : null,
          cashier: register.userData
            ? { id: register.userData.id, fullName: register.userData.fullName }
            : { id: register.user },
          summary: {
            totalTransactions: num(register.totalTransactions),
            totalQuantity: num(gross.quantity),
            totalCovers: num(gross.covers),
            subtotal: num(gross.subtotal),
            discount: num(gross.discount),
            tax: num(gross.tax),
            serviceCharge: num(gross.serviceCharge),
            totalSales: num(register.totalSales),
            totalExpenses: num(register.totalExpenses),
            totalCashPayment: num(register.cashSalesReceived),
            cashSalesReceived: num(register.cashSalesReceived),
            totalNonCashPayment: frozenPayments
              .filter((p) => p.type !== 'CASH')
              .reduce((s, p) => s + num(p.total), 0),
            activeCashIn: num(register.activeCashIn),
            activeCashOut: num(register.activeCashOut),
            expectedCash: frozenExpected,
            cashRefundsTotal: num(register.cashRefundsTotal),
            refundsTotal: num(register.refundsTotal),
            refundCount: num(register.refundCount),
            variance: closingBalance - frozenExpected,
            varianceApprovalStatus: register.varianceApprovalStatus || null
          },
          payments: frozenPayments.map((p) => ({ type: p.type, amount: num(p.total), count: num(p.count) })),
          expenses: frozenExpenses.map((e) => ({ category: e.category, amount: num(e.total), count: num(e.count) })),
          // BA finding #1: per-product breakdown frozen at close time.
          // Snapshots taken before this field existed carry none → [] (the
          // FE renders the section only when non-empty).
          salesByProduct: Array.isArray(snap.salesByProduct)
            ? snap.salesByProduct.map((r) => ({
                productName: r.productName,
                sku: r.sku || null,
                quantity: num(r.quantity),
                unitPrice: num(r.unitPrice),
                totalSales: num(r.totalSales)
              }))
            : []
        }
      } else {
        data = await buildReportData({
          register,
          store: register.store,
          user: register.user,
          openedAt: register.openedAt,
          endAt: register.closedAt || new Date(),
          storeData: register.storeData,
          userData: register.userData
        })
      }

      // Batch B: additive reconciliation so /cash-register/history/detail can
      // explain exactly which transactions feed the summary and which are
      // excluded (and why). Existing response fields are untouched.
      data.reconciliation = await buildRegisterReconciliation({
        registerId: register.id,
        store: register.store,
        user: register.user,
        openedAt: register.openedAt,
        endAt: register.closedAt || new Date()
      })

      return res.status(200).json({
        success: true,
        message: 'Z report generated',
        data
      })
    } catch (error) {
      console.log(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  }
}

module.exports = cashRegisterController
