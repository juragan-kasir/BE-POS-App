const db = require('../../db/models')
const { Op } = require('sequelize')
const batchService = require('../service/batchService')
const { withDeadlockRetry } = require('../../utils/deadlockRetry')
const { assertDecimalQuantity } = require('../../utils/decimalQuantityGuard')
const { redactAndAudit, AUDIT_ACTIONS } = require('../../utils/auditLog')
const { scalarStoreScope, isSuperAdmin, resolveStoreId } = require('../../utils/tenantScope')
const { IRREVERSIBLE_STORE_STATUSES } = require('../validation/schemas')
const { canonicalPhone } = require('../../utils/memberIdentity')
const { listTableReleaseStatus, releaseTable } = require('../service/tableRelease')
const { computeOrderFinancials } = require('../service/orderFinancials')
const {
  reportingBucket,
  CANONICAL_METHOD_ORDER
} = require('../service/canonicalPayment')

// N-3 (security): authoritative store for reads scoped by ?storeId. For
// non-super-admin the store MUST be req.storeId (pinned by validateStoreAccess);
// a client-supplied ?storeId that targets another store is rejected. Only
// super_admin may explicitly target an arbitrary store. Returns a numeric store
// id or null. Its WhatsApp-session callers are gone (Fonnte removed); it stays
// for the cashier table panel endpoints (feat/cashier-table-release).
const getAuthorizedStoreId = (req) => {
  if (isSuperAdmin(req)) {
    const s = Number(req.query.storeId)
    return Number.isFinite(s) ? s : null
  }
  const own = Number(req.storeId)
  if (!Number.isFinite(own)) return null
  const claimed = Number(req.query.storeId)
  if (Number.isFinite(claimed) && claimed !== own) return null
  return own
}

let _psExists = null
let _csExists = null
let _opPromoCol = null
const hasTable = async (t) => {
  if (t === 'product_store') {
    if (_psExists !== null) return _psExists
  } else if (t === 'category_store') {
    if (_csExists !== null) return _csExists
  }
  try {
    await db.sequelize.query(`SELECT 1 FROM ${t} LIMIT 1`)
    if (t === 'product_store') _psExists = true
    if (t === 'category_store') _csExists = true
    return true
  } catch {
    if (t === 'product_store') _psExists = false
    if (t === 'category_store') _csExists = false
    return false
  }
}
const hasOrderCol = async (col) => {
  if (col === 'promoCampaignId') {
    if (_opPromoCol !== null) return _opPromoCol
    try {
      const [r] = await db.sequelize.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name='order' AND column_name='${col}' LIMIT 1`
      )
      _opPromoCol = r.length > 0
      return _opPromoCol
    } catch {
      _opPromoCol = false
      return false
    }
  }
  return true
}
const orderAttrs = async () =>
  (await hasOrderCol('promoCampaignId'))
    ? undefined
    : { exclude: ['promoCampaignId'] }

// Postgres JSONB does not preserve key insertion order — a value read
// back from the database can have different key ordering than a freshly
// parsed request body even when every field is identical, so a plain
// JSON.stringify comparison would false-positive as "different". Sorting
// keys recursively before stringifying makes the comparison
// order-independent. Same pattern established in F3 (parkedCart.js).
function canonicalJSON(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

// Normalizes a sales-return item to the same shape regardless of whether
// it came from the raw request body (productId/orderItemId) or from
// persisted sales_return_item rows (product/orderItem) — required so the
// idempotency comparison isn't fooled by field-name differences between
// the two representations of "the same" item.
function canonicalReturnItem(item) {
  return {
    product: item.product ?? item.productId ?? null,
    orderItem: item.orderItem ?? item.orderItemId ?? null,
    qty: Number(item.qty) || 0,
    unit: item.unit || 'pcs',
    conversionToBase: Number(item.conversionToBase || 1),
    notes: item.notes || null
  }
}

function salesReturnPayloadMatches(existing, existingItems, incoming) {
  return (
    (existing.reason || '').trim() === (incoming.reason || '').trim() &&
    (existing.refundMethod || null) === (incoming.refundMethod || null) &&
    (existing.returnedBy ?? null) === (incoming.returnedBy ?? null) &&
    canonicalJSON(existingItems.map(canonicalReturnItem)) ===
      canonicalJSON((incoming.items || []).map(canonicalReturnItem))
  )
}

// Phase 39 Batch 1 — transfer-send idempotency helpers, mirroring the
// goods-receipt convention (canonicalGrItemKey / grItemsMatchPayload):
// same key + identical semantic payload replays, same key + different
// payload is a 409. Scope (fromStore) lives in the lookup WHERE, exactly
// like GR scopes by purchaseOrderId.
const TRANSFER_IDEMPOTENCY_MISMATCH_MESSAGE =
  'Idempotency key was already used with a different transfer payload'

const canonicalTransferItemKey = (item) => {
  const productId = item.productId ?? item.product
  const qty = Number(item.qty ?? item.quantity)
  const unit = item.unit || 'pcs'
  return `${productId}:${Number.isFinite(qty) ? String(qty) : ''}:${unit}`
}

const transferItemsMatchPayload = (storedItems, incomingItems) => {
  if (!Array.isArray(storedItems) || !Array.isArray(incomingItems)) return false
  if (storedItems.length !== incomingItems.length) return false
  const a = storedItems.map(canonicalTransferItemKey).sort()
  const b = incomingItems.map(canonicalTransferItemKey).sort()
  return a.every((key, i) => key === b[i])
}

const transferPayloadMatches = (storedTransfer, toStore, items) =>
  Number(storedTransfer.toStore) === Number(toStore) &&
  transferItemsMatchPayload(storedTransfer.items, items)

const findTransferByIdempotencyKey = (fromStore, idempotencyKey, transaction) =>
  db.stock_transfer.findOne({
    where: { fromStore, idempotencyKey },
    include: [{ model: db.stock_transfer_item, as: 'items' }],
    ...(transaction ? { transaction } : {})
  })

// GAP-2: tenant/existence/terminal boundary for stock transfers, shared by
// send and receive. Both stores are loaded from persistence —
// Location.tenantId is authoritative; tenant is never inferred from JWT,
// membership, assignment, product/category junctions, or transfer history.
// Returns { ok: true, source, destination } or
// { ok: false, status, code?, message } using existing vocabulary only.
const assertTransferStoreBoundary = async ({ fromStore, toStore, isPlatformAdmin }) => {
  const sourceId = Number(fromStore)
  const destinationId = Number(toStore)
  const ids = [sourceId, destinationId].filter(
    (value) => Number.isSafeInteger(value) && value > 0
  )
  const stores = await db.location.findAll({
    where: { id: ids },
    attributes: ['id', 'tenantId', 'status']
  })
  const byId = new Map(stores.map((store) => [Number(store.id), store]))
  const source = byId.get(sourceId)
  const destination = byId.get(destinationId)
  if (!source || !destination) {
    return { ok: false, status: 404, message: 'Location not found.' }
  }
  if (IRREVERSIBLE_STORE_STATUSES.includes(destination.status)) {
    return {
      ok: false,
      status: 422,
      code: 'STORE_STATUS_IRREVERSIBLE',
      message: `a ${destination.status} store cannot receive stock transfers`
    }
  }
  const sourceTenant = source.tenantId ?? null
  const destinationTenant = destination.tenantId ?? null
  if (isPlatformAdmin) {
    // Platform lattice: NULL→NULL staging and X→X allowed; mixed and
    // cross-tenant rejected. No generic cross-tenant bypass.
    if (sourceTenant === null && destinationTenant === null) {
      return { ok: true, source, destination }
    }
    if (sourceTenant !== null && sourceTenant === destinationTenant) {
      return { ok: true, source, destination }
    }
    if (sourceTenant === null || destinationTenant === null) {
      return {
        ok: false,
        status: 422,
        code: 'STORE_TENANT_REQUIRED',
        message: 'stock transfer requires tenant-bound source and destination stores'
      }
    }
    return {
      ok: false,
      status: 422,
      code: 'TENANT_SCOPE_MISMATCH',
      message: 'stock transfer rejected: source and destination stores belong to different tenants'
    }
  }
  if (sourceTenant === null || destinationTenant === null) {
    return {
      ok: false,
      status: 422,
      code: 'STORE_TENANT_REQUIRED',
      message: 'stock transfer requires tenant-bound source and destination stores'
    }
  }
  if (sourceTenant !== destinationTenant) {
    return {
      ok: false,
      status: 422,
      code: 'TENANT_SCOPE_MISMATCH',
      message: 'stock transfer rejected: source and destination stores belong to different tenants'
    }
  }
  return { ok: true, source, destination }
}

const transferBoundaryRejection = (res, boundary) =>
  res.status(boundary.status).json(
    boundary.code
      ? { success: false, code: boundary.code, message: boundary.message }
      : { success: false, message: boundary.message }
  )

// WhatsApp receipt text for one order of the caller's store, built from
// the persisted order only (utils/receiptText — same sections and
// invoice-setting switches as the printed receipt). Null when the order is
// not the caller's (N-1: a foreign order is indistinguishable from a
// missing one).
async function loadOrderReceiptText(req, orderId) {
  const waAttrs = await orderAttrs()
  // N-1 (security): order must belong to the caller's tenant. The store
  // is derived from the authoritative req.storeId (pinned by
  // validateStoreAccess), never from the body; a foreign order is
  // indistinguishable from a nonexistent one and is rejected before any
  // external WhatsApp/email send can occur.
  const order = await db.order.findOne({
    where: { id: orderId, ...scalarStoreScope(req) },
    include: [
      { model: db.order_item, as: 'items' },
      { model: db.table, as: 'table' }
    ],
    ...(waAttrs ? { attributes: waAttrs } : {})
  })

  if (!order) return null

  const store = order.store
    ? await db.location.findByPk(order.store, {
        attributes: [
          'name',
          'address',
          'detailLocation',
          'city',
          'province',
          'district',
          'village',
          'postalCode',
          'phoneNumber',
          'email',
          'socialMedia',
          'timezone'
        ]
      })
    : null
  const settings = order.store
    ? await db.invoice_setting.findOne({ where: { store: order.store } })
    : null

  // Province/city/district/village are stored as region codes.
  const regionNames = {}
  if (store) {
    const codes = ['province', 'city', 'district', 'village']
      .map((k) => store[k])
      .filter(Boolean)
      .map(String)
    if (codes.length) {
      const rows = await db.region.findAll({
        where: { code: codes },
        attributes: ['code', 'name']
      })
      const byCode = new Map(rows.map((r) => [String(r.code), r.name]))
      for (const k of ['province', 'city', 'district', 'village']) {
        if (store[k]) regionNames[k] = byCode.get(String(store[k])) || null
      }
    }
  }

  // Member block: the order's customer phone joined to a member of this
  // store (D-05: canonical E.164 on both sides; order.customerPhone stays
  // historical/raw, an unparseable value never joins).
  let member = null
  let canonicalCustomerPhone = null
  if (order.customerPhone) {
    try {
      canonicalCustomerPhone = canonicalPhone(order.customerPhone)
    } catch {
      canonicalCustomerPhone = null
    }
  }
  if (canonicalCustomerPhone) {
    const found = await db.member.findOne({
      where: { phoneNumber: canonicalCustomerPhone, store: order.store }
    })
    if (found && found.totalPoints > 0) {
      let tierName = null
      if (found.tier) {
        const tier = await db.member_tier.findByPk(found.tier)
        if (tier) tierName = tier.name
      }
      member = { name: found.name, totalPoints: found.totalPoints, tierName }
    }
  }

  // Cash tender from the payment ledger (counter cash sale).
  const cashRow = await db.transaction.findOne({
    where: { order: order.id, cashReceived: { [Op.gt]: 0 } },
    attributes: ['cashReceived', 'changeGiven'],
    order: [['id', 'ASC']]
  })

  const { buildReceiptText } = require('../../utils/receiptText')
  const text = buildReceiptText({
    order,
    items: order.items || [],
    store,
    regionNames,
    settings,
    tableName: order.table ? order.table.name : null,
    member,
    tender: cashRow,
    timezone: (store && store.timezone) || 'Asia/Jakarta'
  })
  return { order, text }
}

const posController = {
  // Cashier table panel (client request 2026-10-20, BA C-16 amended):
  // every table of the store with its unpaid open orders and whether the
  // caller may put it back to "available" (server-decided).
  async getCashierTables(req, res) {
    try {
      const storeId = getAuthorizedStoreId(req)
      if (storeId === null) {
        return res
          .status(400)
          .json({ success: false, code: 'STORE_REQUIRED', message: 'storeId is required' })
      }
      const tables = await listTableReleaseStatus(storeId, req)
      return res.status(200).json({ success: true, message: 'Success', data: tables })
    } catch (error) {
      console.error('Error =>', error)
      return res.status(500).json({ success: false, message: 'Internal server error' })
    }
  },

  // Put one table back to "available" from the cashier. Reason required;
  // a kasir cannot release a table with an unpaid open order (admin can).
  async releaseCashierTable(req, res) {
    try {
      const tableId = Number(req.params.id)
      if (!Number.isInteger(tableId) || tableId <= 0) {
        return res
          .status(400)
          .json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid table id' })
      }
      const { changed, table } = await releaseTable(req, {
        tableId,
        reason: req.body?.reason,
        storeScope: scalarStoreScope(req)
      })
      return res.status(200).json({
        success: true,
        message: changed ? 'Meja tersedia kembali' : 'Meja sudah tersedia',
        data: { id: table.id, name: table.name, status: 'available', changed }
      })
    } catch (error) {
      if (error.statusCode && error.statusCode < 500) {
        return res.status(error.statusCode).json({
          success: false,
          code: error.code,
          message: error.message,
          ...(error.extra || {})
        })
      }
      console.error('Error =>', error)
      return res.status(500).json({ success: false, message: 'Internal server error' })
    }
  },

  // Barcode lookup untuk POS scan
  async lookupBarcode(req, res) {
    try {
      const { barcode } = req.query

      if (!barcode) {
        return res.status(400).json({
          success: false,
          message: 'Barcode is required'
        })
      }

      const product = await db.product.findOne({
        where: { barcode },
        attributes: [
          'id',
          'nameProduct',
          'barcode',
          'unit',
          'stock',
          'minStock',
          'price',
          'costPrice',
          'brand',
          'category'
        ],
        include: [
          { model: db.category, as: 'categoryData', attributes: ['id', 'name'] }
        ]
      })

      if (!product) {
        return res.status(404).json({
          success: false,
          message: 'Product not found'
        })
      }

      return res.status(200).json({
        success: true,
        message: 'Success',
        data: product
      })
    } catch (error) {
      console.error('Error =>', error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  // Stock transfer antar toko — 3-phase: sent → received / cancelled
  // Phase 39 Batch 1 — transfer-send idempotency contract, following the
  // established goods-receipt convention (canonical item keys + fast-path
  // replay + unique-violation race catch): the key is scoped to fromStore
  // (the ownership boundary pinned by the 403 check below), so a key can
  // never replay another store's transfer. Qty is normalized through
  // Number() so 1.5 and 1.50 fingerprint identically.
  async transfer(req, res) {
    try {
      const {
        fromStore,
        toStore,
        items,
        notes,
        transferredBy,
        reason,
        expectedArrival,
        idempotencyKey
      } = req.body

      if (!fromStore || !toStore || !items || items.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'fromStore, toStore, and items are required'
        })
      }

      if (fromStore === toStore) {
        return res.status(400).json({
          success: false,
          message: 'Source and destination stores cannot be the same'
        })
      }

      if (req.user?.roleType !== 'super_admin' && req.storeId) {
        if (Number(fromStore) !== Number(req.storeId)) {
          return res.status(403).json({
            success: false,
            message: 'Anda hanya dapat mentransfer stok dari toko Anda'
          })
        }
      }

      // Phase 39 Batch 1: quantities follow the DECIMAL(10,4) stock contract
      // (assertDecimalQuantity, 422) — never silently truncated. Positivity
      // is already enforced by createPosTransferSchema (strToNum >= 0).
      for (const [index, item] of items.entries()) {
        assertDecimalQuantity(Number(item.qty), `items[${index}].qty`)
      }

      // Phase 39 Batch 1: idempotency fast-path (goods-receipt convention).
      // Scoped to fromStore — the ownership boundary pinned above — so a key
      // can never replay another store's transfer.
      const transferKey =
        idempotencyKey === '' || idempotencyKey == null ? null : String(idempotencyKey)
      if (transferKey) {
        const existing = await findTransferByIdempotencyKey(fromStore, transferKey)
        if (existing) {
          if (!transferPayloadMatches(existing, toStore, items)) {
            return res.status(409).json({
              success: false,
              message: TRANSFER_IDEMPOTENCY_MISMATCH_MESSAGE
            })
          }
          return res.status(200).json({
            success: true,
            message: 'Stock transfer already exists for this idempotency key',
            data: existing
          })
        }
      }

      // GAP-2: tenant/existence/terminal boundary BEFORE any inventory
      // mutation. A rejected transfer never partially mutates stock.
      const sendBoundary = await assertTransferStoreBoundary({
        fromStore,
        toStore,
        isPlatformAdmin: req.user?.roleType === 'super_admin'
      })
      if (!sendBoundary.ok) {
        return transferBoundaryRejection(res, sendBoundary)
      }

      let result = null
      try {
        result = await withDeadlockRetry(() =>
          db.sequelize.transaction(async (t) => {
          const transfer = await db.stock_transfer.create(
            {
              // transferNumber has a bare (non-store-scoped) global unique
              // constraint. A millisecond timestamp ALONE has zero
              // collision resistance under real concurrency — two transfer
              // requests landing in the same millisecond (plausible with
              // multiple staff/branches submitting at once) previously hit
              // a hard unique-constraint 500, not a deadlock (so the
              // withDeadlockRetry wrapper around this transaction wouldn't
              // catch or retry it). The random suffix matches the pattern
              // already proven safe for order.orderNumber.
              transferNumber: `TRF-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
              fromStore,
              toStore,
              notes,
              reason: reason || null,
              expectedArrival: expectedArrival || null,
              status: 'sent',
              transferredBy,
              createdBy: req.user?.id || null,
              // Phase 39 Batch 1: persisted atomically with the transfer +
              // deduction inside this transaction; NULL when the client
              // sends no key (backward compatible).
              idempotencyKey: transferKey
            },
            { transaction: t }
          )

        // Lock every distinct product BEFORE inserting stock_transfer_item
        // rows that FK-reference them, in one batched query sorted by id.
        // Sorting alone isn't enough: inserting the referencing rows
        // first (as this used to) makes Postgres take an implicit FOR
        // KEY SHARE lock on each product row to validate the FK — then
        // this code's own later FOR UPDATE on that same row is a lock
        // *upgrade*. Under N-way concurrency every transaction can end up
        // holding its own FOR KEY SHARE while waiting on every other
        // transaction's FOR KEY SHARE to release before its FOR UPDATE
        // can proceed — a real N-way deadlock with only one product
        // involved, confirmed by a 4-concurrent-transfer test that
        // reproduced it reliably before this reordering. Locking first
        // means the FK check on insert sees a lock already held by this
        // same transaction (no upgrade, no conflict).
        const sortedItems = [...items].sort(
          (a, b) => (a.productId || 0) - (b.productId || 0)
        )
        const transferProductIds = [
          ...new Set(sortedItems.map((it) => it.productId).filter(Boolean))
        ].sort((a, b) => a - b)
        const transferProducts = transferProductIds.length
          ? await db.product.findAll({
              where: { id: transferProductIds },
              transaction: t,
              lock: t.LOCK.UPDATE
            })
          : []
        const transferProductById = new Map(
          transferProducts.map((p) => [p.id, p])
        )

        const transferItems = items.map((item) => ({
          stockTransfer: transfer.id,
          product: item.productId,
          qty: item.qty,
          unit: item.unit || 'pcs',
          notes: item.notes || null
        }))

        await db.stock_transfer_item.bulkCreate(transferItems, {
          transaction: t
        })

        for (const item of sortedItems) {
          const product = transferProductById.get(item.productId)
          if (!product) continue

          // F-STOCK-3: seed first, then lock-read the source row and gate
          // on the locked value. The gate read previously ran unlocked
          // after the product lock — sufficient against writers that also
          // take the product row lock (orders, returns, other transfers),
          // but holding this row's lock across gate→decrement additionally
          // serializes against any present-or-future locker of the same
          // source row, matching the convention used by the sibling stock
          // paths. Seeding before the read preserves behavior for stores
          // with no row yet (seeded 0 still fails the gate below).
          // ponytail: atomic upsert + deduct
          await db.sequelize.query(
            `INSERT INTO product_store_stock (product, store, stock, "createdAt", "updatedAt")
             VALUES ($1, $2, 0, NOW(), NOW())
             ON CONFLICT (product, store) DO NOTHING`,
            { bind: [item.productId, fromStore], transaction: t }
          )
          // Check stock before atomic deduct, on the locked row.
          const pssRow = await db.product_store_stock.findOne({
            where: { product: item.productId, store: fromStore },
            lock: t.LOCK.UPDATE,
            transaction: t
          })
          const availPss = Number(pssRow?.stock) || 0
          if (availPss < Number(item.qty)) {
            throw new Error(
              `Insufficient stock at source store for product "${product.nameProduct}" (SKU: ${product.sku || '-'})`
            )
          }

          // Phase 39 Batch 1: exact DECIMAL deduction — item.qty was
          // validated by assertDecimalQuantity above, so interpolating the
          // finite number is safe and preserves fractions (no Math.floor).
          const deductQty = Number(item.qty)
          await db.product_store_stock.update(
            {
              stock: db.sequelize.literal(
                `GREATEST(stock - ${deductQty}, 0)`
              )
            },
            {
              where: { product: item.productId, store: fromStore },
              transaction: t
            }
          )

          // ponytail: FIFO - consume oldest batches at source store
          await batchService.deductFifo({
            productId: item.productId,
            store: fromStore,
            qty: item.qty,
            transaction: t
          })

          const oldPssStock = availPss
          const newPssStock = availPss - Number(item.qty)

          // Phase 39 Batch 1: exact DECIMAL deduction (see above).
          const qty = Number(item.qty)
          await product.update(
            { stock: db.sequelize.literal(`GREATEST(stock - ${qty}, 0)`) },
            { transaction: t }
          )

          await db.stock_history.create(
            {
              product: item.productId,
              store: fromStore,
              referenceType: 'transfer',
              referenceId: transfer.id,
              quantityBefore: oldPssStock,
              quantityChange: -Number(item.qty),
              quantityAfter: newPssStock,
              unit: item.unit || 'pcs',
              notes: `Transfer sent to store ${toStore}`,
              createdBy: req.user?.id || null
            },
            { transaction: t }
          )
        }

        await redactAndAudit(req, {
          action: AUDIT_ACTIONS.CREATE,
          entity: 'stock_transfer',
          entityId: transfer.id,
          description: `Stock transfer from store ${fromStore} to store ${toStore}`,
          newValues: transfer,
          transaction: t
        })

        return transfer
          })
        )
      } catch (error) {
        // Phase 39 Batch 1: concurrent same-key race backstop
        // (goods-receipt convention). The partial unique index on
        // (fromStore, idempotencyKey) serializes the two racers: the loser
        // rolls back here and replays the winner instead of duplicating
        // the transfer + deduction.
        if (error.name === 'SequelizeUniqueConstraintError' && transferKey) {
          const existing = await findTransferByIdempotencyKey(fromStore, transferKey)
          if (existing) {
            if (!transferPayloadMatches(existing, toStore, items)) {
              return res.status(409).json({
                success: false,
                message: TRANSFER_IDEMPOTENCY_MISMATCH_MESSAGE
              })
            }
            return res.status(200).json({
              success: true,
              message: 'Stock transfer already exists for this idempotency key',
              data: existing
            })
          }
        }
        throw error
      }

      return res.status(201).json({
        success: true,
        message: 'Stock transfer created',
        data: result
      })
    } catch (error) {
      console.error('Error =>', error)
      // Phase 39 Batch 1: honor guard status codes (e.g. 422 from
      // assertDecimalQuantity); plain errors keep the legacy 400.
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || 'Internal server error'
      })
    }
  },

  // Receive stock transfer — confirm arrival at destination
  async receiveTransfer(req, res) {
    try {
      const { id } = req.params

      const where = { id }
      if (req.storeId && req.user?.roleType !== 'super_admin') {
        where.toStore = req.storeId
      }

      const existing = await db.stock_transfer.findOne({ where })

      if (!existing) {
        return res.status(404).json({
          success: false,
          message: 'Stock transfer not found'
        })
      }

      const { toStore } = existing

      // GAP-2: revalidate ownership at receive time from persistence — the
      // destination tenant may have changed between send and receive. On
      // failure the transfer stays 'sent': nothing is credited and no
      // junction propagation runs.
      const receiveBoundary = await assertTransferStoreBoundary({
        fromStore: existing.fromStore,
        toStore: existing.toStore,
        isPlatformAdmin: req.user?.roleType === 'super_admin'
      })
      if (!receiveBoundary.ok) {
        return transferBoundaryRejection(res, receiveBoundary)
      }

      let transfer = null

      await withDeadlockRetry(() =>
        db.sequelize.transaction(async (t) => {
        // Batch 10: re-read under a row lock so two concurrent receives of
        // the same transfer can't both pass the status guard — the plain
        // unlocked read above is only used for the 404/store-scope check.
        // The second transaction blocks here until the first commits, then
        // sees the committed 'received' status and safely aborts instead
        // of double-crediting destination stock.
        // FOR UPDATE can't be applied across the outer join an eager
        // `include` would add, so the row lock is taken on stock_transfer
        // alone; items are immutable once created, so a plain read of
        // them under the now-serialized header lock is safe.
        transfer = await db.stock_transfer.findOne({
          where: { id },
          transaction: t,
          lock: t.LOCK.UPDATE
        })

        if (!transfer || transfer.status !== 'sent') {
          throw new Error('Only sent transfers can be received')
        }

        transfer.items = await db.stock_transfer_item.findAll({
          where: { stockTransfer: id },
          transaction: t
        })

        // Locked in a stable (ascending product id) order — see the matching
        // comment in transfer() above.
        const sortedTransferItems = [...transfer.items].sort(
          (a, b) => (a.product || 0) - (b.product || 0)
        )

        for (const [index, item] of sortedTransferItems.entries()) {
          const product = await db.product.findByPk(item.product, {
            transaction: t,
            lock: t.LOCK.UPDATE
          })
          if (!product) continue

          // ponytail: atomic upsert + add
          await db.sequelize.query(
            `INSERT INTO product_store_stock (product, store, stock, "createdAt", "updatedAt")
             VALUES ($1, $2, 0, NOW(), NOW())
             ON CONFLICT (product, store) DO NOTHING`,
            { bind: [item.product, toStore], transaction: t }
          )
          // Phase 39 Batch 1: credit the exact stored transfer qty
          // (DECIMAL since the Batch 1 migration) — no Math.floor.
          const receiveQty = Number(item.qty)
          await db.product_store_stock.update(
            {
              stock: db.sequelize.literal(
                `stock + ${receiveQty}`
              )
            },
            { where: { product: item.product, store: toStore }, transaction: t }
          )

          const oldPssStock = 0
          const newPssStock = Number(item.qty)

          const qty = Number(item.qty)
          await product.update(
            { stock: db.sequelize.literal(`stock + ${qty}`) },
            { transaction: t }
          )

          // ponytail: FIFO - register incoming batch at destination store
          await batchService.addBatchStock({
            productId: item.product,
            store: toStore,
            qty,
            costPerUnit: Number(product.costPrice) || 0,
            batchCode: `TRF-${transfer.id}-${index + 1}`,
            supplier: null,
            transaction: t
          })

          await db.stock_history.create(
            {
              product: item.product,
              store: toStore,
              referenceType: 'transfer',
              referenceId: transfer.id,
              quantityBefore: oldPssStock,
              quantityChange: Number(item.qty),
              quantityAfter: newPssStock,
              unit: item.unit || 'pcs',
              notes: `Transfer received from store ${transfer.fromStore}`,
              createdBy: req.user?.id || null
            },
            { transaction: t }
          )

          // Add destination store to product's store list via junction table
          if (await hasTable('product_store')) {
            const existingProdStore = await db.product_store.findOne({
              where: { product: item.product, store: Number(toStore) },
              transaction: t
            })
            if (!existingProdStore) {
              await db.product_store.create(
                { product: item.product, store: Number(toStore) },
                { transaction: t }
              )
            }
          }

          // Add destination store to category's store list via junction table
          if (product.category && (await hasTable('category_store'))) {
            const category = await db.category.findByPk(product.category, {
              transaction: t
            })
            if (category) {
              const existingCatStore = await db.category_store.findOne({
                where: { category: category.id, store: Number(toStore) },
                transaction: t
              })
              if (!existingCatStore) {
                await db.category_store.create(
                  { category: category.id, store: Number(toStore) },
                  { transaction: t }
                )
              }
            }
          }
        }

        await transfer.update({ status: 'received' }, { transaction: t })

        await redactAndAudit(req, {
          action: AUDIT_ACTIONS.UPDATE,
          entity: 'stock_transfer',
          entityId: transfer.id,
          description: 'Stock transfer received',
          oldValues: { status: 'sent' },
          newValues: { status: 'received' },
          transaction: t
        })
        })
      )

      return res.status(200).json({
        success: true,
        message: 'Stock transfer received',
        data: transfer
      })
    } catch (error) {
      console.error('Error =>', error)
      return res.status(400).json({
        success: false,
        message: error.message || 'Internal server error'
      })
    }
  },

  // Cancel stock transfer — return stock to source store
  async cancelTransfer(req, res) {
    try {
      const { id } = req.params

      const where = { id }
      if (req.storeId && req.user?.roleType !== 'super_admin') {
        where.fromStore = req.storeId
      }

      const existing = await db.stock_transfer.findOne({ where })

      if (!existing) {
        return res.status(404).json({
          success: false,
          message: 'Stock transfer not found'
        })
      }

      let transfer = null

      await withDeadlockRetry(() =>
        db.sequelize.transaction(async (t) => {
        // Batch 11 (BATCH10-02): re-read under a row lock so two
        // concurrent cancels of the same transfer can't both pass the
        // status guard — the plain unlocked read above is only used for
        // the 404/store-scope check. The second transaction blocks here
        // until the first commits, then sees the committed 'cancelled'
        // status and safely aborts instead of double-crediting source
        // stock. Same pattern as the Batch 10 receiveTransfer() fix: FOR
        // UPDATE can't be applied across the outer join an eager
        // `include` would add, so the row lock is taken on stock_transfer
        // alone; items are immutable once created, so a plain read of
        // them under the now-serialized header lock is safe.
        transfer = await db.stock_transfer.findOne({
          where: { id },
          transaction: t,
          lock: t.LOCK.UPDATE
        })

        if (!transfer || transfer.status !== 'sent') {
          throw new Error('Only sent transfers can be cancelled')
        }

        transfer.items = await db.stock_transfer_item.findAll({
          where: { stockTransfer: id },
          transaction: t
        })

        // Locked in a stable (ascending product id) order — see the matching
        // comment in transfer() above.
        const sortedCancelItems = [...transfer.items].sort(
          (a, b) => (a.product || 0) - (b.product || 0)
        )

        for (const item of sortedCancelItems) {
          const product = await db.product.findByPk(item.product, {
            transaction: t,
            lock: t.LOCK.UPDATE
          })
          if (!product) continue

          // ponytail: atomic upsert + add
          await db.sequelize.query(
            `INSERT INTO product_store_stock (product, store, stock, "createdAt", "updatedAt")
             VALUES ($1, $2, 0, NOW(), NOW())
             ON CONFLICT (product, store) DO NOTHING`,
            { bind: [item.product, transfer.fromStore], transaction: t }
          )
          // Phase 39 Batch 1: reverse the exact stored transfer qty
          // (DECIMAL since the Batch 1 migration) — no Math.floor.
          const cancelQty = Number(item.qty)
          await db.product_store_stock.update(
            {
              stock: db.sequelize.literal(
                `stock + ${cancelQty}`
              )
            },
            {
              where: { product: item.product, store: transfer.fromStore },
              transaction: t
            }
          )

          const oldPssStock = 0
          const newPssStock = Number(item.qty)

          const qty = Number(item.qty)
          await product.update(
            { stock: db.sequelize.literal(`stock + ${qty}`) },
            { transaction: t }
          )

          await db.stock_history.create(
            {
              product: item.product,
              store: transfer.fromStore,
              referenceType: 'transfer',
              referenceId: transfer.id,
              quantityBefore: oldPssStock,
              quantityChange: Number(item.qty),
              quantityAfter: newPssStock,
              unit: item.unit || 'pcs',
              notes: `Transfer cancelled, returned to store ${transfer.fromStore}`,
              createdBy: req.user?.id || null
            },
            { transaction: t }
          )
        }

        await transfer.update({ status: 'cancelled' }, { transaction: t })

        await redactAndAudit(req, {
          action: AUDIT_ACTIONS.UPDATE,
          entity: 'stock_transfer',
          entityId: transfer.id,
          description: 'Stock transfer cancelled',
          oldValues: { status: 'sent' },
          newValues: { status: 'cancelled' },
          transaction: t
        })
        })
      )

      return res.status(200).json({
        success: true,
        message: 'Stock transfer cancelled',
        data: transfer
      })
    } catch (error) {
      console.error('Error =>', error)
      return res.status(400).json({
        success: false,
        message: error.message || 'Internal server error'
      })
    }
  },

  // Get stock transfer history
  async getTransferHistory(req, res) {
    try {
      const {
        page = 1,
        limit = 20,
        status,
        startDate,
        endDate,
        search
      } = req.query

      let where = {}
      const effectiveStore = req.storeId
      const storeClause = effectiveStore
        ? [{ fromStore: effectiveStore }, { toStore: effectiveStore }]
        : null

      if (status) where.status = status

      if (storeClause && search) {
        where[Op.and] = [
          { [Op.or]: storeClause },
          { transferNumber: { [Op.iLike]: `%${search}%` } }
        ]
      } else if (storeClause) {
        where[Op.or] = storeClause
      } else if (search) {
        where.transferNumber = { [Op.iLike]: `%${search}%` }
      }

      if (startDate || endDate) {
        where.createdAt = {}
        if (startDate) where.createdAt[Op.gte] = new Date(startDate)
        if (endDate) where.createdAt[Op.lte] = new Date(endDate + 'T23:59:59')
      }

      const offset = (parseInt(page) - 1) * parseInt(limit)

      const { count, rows } = await db.stock_transfer.findAndCountAll({
        where,
        include: [
          { model: db.stock_transfer_item, as: 'items' },
          {
            model: db.location,
            as: 'fromStoreData',
            attributes: ['id', 'name']
          },
          { model: db.location, as: 'toStoreData', attributes: ['id', 'name'] },
          {
            model: db.user,
            as: 'transferredByData',
            attributes: ['id', 'fullName']
          }
        ],
        order: [['updatedAt', 'DESC']],
        limit: parseInt(limit),
        offset
      })

      return res.status(200).json({
        success: true,
        message: 'Success',
        data: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / parseInt(limit))
        }
      })
    } catch (error) {
      console.error('Error =>', error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  // Get stock transfer by ID
  async getTransferById(req, res) {
    try {
      const { id } = req.params

      const where = { id }
      if (req.storeId && req.user?.roleType !== 'super_admin') {
        where[Op.or] = [{ fromStore: req.storeId }, { toStore: req.storeId }]
      }

      const transfer = await db.stock_transfer.findOne({
        where,
        include: [
          {
            model: db.stock_transfer_item,
            as: 'items',
            include: [
              {
                model: db.product,
                as: 'productData',
                attributes: [
                  'id',
                  'nameProduct',
                  'sku',
                  'image',
                  'barcode',
                  'stock',
                  'price'
                ]
              }
            ]
          },
          {
            model: db.location,
            as: 'fromStoreData',
            attributes: ['id', 'name', 'city', 'province', 'detailLocation']
          },
          {
            model: db.location,
            as: 'toStoreData',
            attributes: ['id', 'name', 'city', 'province', 'detailLocation']
          },
          {
            model: db.user,
            as: 'transferredByData',
            attributes: ['id', 'userName', 'fullName']
          }
        ]
      })

      if (!transfer) {
        return res
          .status(404)
          .json({ success: false, message: 'Stock transfer not found' })
      }

      return res
        .status(200)
        .json({ success: true, message: 'Success', data: transfer })
    } catch (error) {
      console.error('Error =>', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  // Stock adjustment
  async adjust(req, res) {
    try {
      const store = resolveStoreId(req)
      let {
        productId,
        qty,
        sign,
        value,
        reason,
        referenceType = 'adjustment',
        storeId
      } = req.body

      if (qty === undefined && value === undefined) {
        return res.status(400).json({
          success: false,
          message: 'productId and qty (or sign+value) are required'
        })
      }

      // ponytail: support both signed qty and explicit sign+value
      if (qty === undefined) {
        qty = sign === '-' ? -Math.abs(Number(value)) : Math.abs(Number(value))
      }

      if (!productId || !qty) {
        return res.status(400).json({
          success: false,
          message: 'productId and qty are required'
        })
      }

      const adjStore = storeId || store || req.storeId

      // KF-NEW-07: read and write under one row lock so the recorded
      // before/after chain can never be built from a stale pre-transaction
      // read, and derive ONE floored delta shared by the global stock, the
      // per-store stock, the stock_history row, the audit entry and the
      // response — the old code floored only the SQL update while the
      // history kept the raw fractional qty (e.g. 2.7).
      const result = await db.sequelize.transaction(async (t) => {
        const product = await db.product.findByPk(productId, {
          transaction: t,
          lock: t.LOCK.UPDATE
        })
        if (!product) return { notFound: true }

        const oldStock = Number(product.stock) || 0
        const delta = Math.floor(Number(qty)) || 0
        const newStock = oldStock + delta

        if (newStock < 0) return { insufficient: true }

        await db.product.update(
          {
            stock: db.sequelize.literal(`GREATEST(stock + ${delta}, 0)`)
          },
          { where: { id: productId }, transaction: t }
        )

        // Update per-store stock — ponytail: atomic upsert + adjust
        if (adjStore) {
          await db.sequelize.query(
            `INSERT INTO product_store_stock (product, store, stock, "createdAt", "updatedAt")
             VALUES ($1, $2, 0, NOW(), NOW())
             ON CONFLICT (product, store) DO NOTHING`,
            { bind: [productId, adjStore], transaction: t }
          )
          await db.product_store_stock.update(
            {
              stock: db.sequelize.literal(`GREATEST(stock + ${delta}, 0)`)
            },
            { where: { product: productId, store: adjStore }, transaction: t }
          )
        }

        await db.stock_history.create(
          {
            product: productId,
            store: adjStore,
            referenceType,
            quantityBefore: oldStock,
            quantityChange: delta,
            quantityAfter: newStock,
            unit: product.unit || 'pcs',
            notes: reason || 'Stock adjustment',
            createdBy: req.user?.id || null
          },
          { transaction: t }
        )

        await redactAndAudit(req, {
          action: AUDIT_ACTIONS.UPDATE,
          entity: 'stock_adjustment',
          entityId: productId,
          description: reason || 'Stock adjustment',
          oldValues: { stock: oldStock },
          newValues: { stock: newStock, qty: delta, reason },
          transaction: t
        })

        product.set('stock', newStock)
        return { product, adjustment: { oldStock, newStock, qty: delta, reason } }
      })

      if (result.notFound) {
        return res.status(404).json({
          success: false,
          message: 'Product not found'
        })
      }
      if (result.insufficient) {
        return res.status(400).json({
          success: false,
          message: 'Insufficient stock for adjustment'
        })
      }

      return res.status(200).json({
        success: true,
        message: 'Stock adjusted successfully',
        data: result
      })
    } catch (error) {
      console.error('Error =>', error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  // Purchase order return — delegates to purchaseReturn controller
  async returnPurchaseOrder(req, res) {
    req.body.purchaseOrder = req.params.id
    const purchaseReturnController = require('./purchaseReturn')
    return purchaseReturnController.create(req, res)
  },

  // Sales order return — create request (pending)
  async returnSalesOrder(req, res) {
    try {
      const { id } = req.params
      const { items, reason, returnedBy, refundMethod, idempotencyKey } = req.body

      if (!items || items.length === 0) {
        return res.status(422).json({
          success: false,
          message: 'At least one item is required'
        })
      }

      if (!reason || reason.trim() === '') {
        return res.status(422).json({
          success: false,
          message: 'Return reason is required'
        })
      }

      const oAttrs = await orderAttrs()
      const order = await db.order.findOne({
        where: scalarStoreScope(req, { id }),
        include: [{ model: db.order_item, as: 'items' }],
        attributes: oAttrs ? oAttrs : undefined
      })

      if (!order) {
        return res
          .status(404)
          .json({ success: false, message: 'Order not found' })
      }

      // F4 discrepancy note: the pre-existing gate here was
      // `paymentStatus !== 'paid'`. approve()'s recompute (unchanged)
      // sets 'partial' the moment any refund — even a small one — is
      // approved, since it derives status from SUM(transaction.amount)
      // vs totalPrice. That gate therefore made a second, legitimate
      // partial return on an already-partially-refunded order
      // impossible, which directly contradicts the required "cumulative
      // refunds reaching exactly the collected amount" scenario (a
      // ledger-based remainingRefundable check is pointless if a
      // status-based gate blocks the second request before it's ever
      // evaluated). 'partial' is included here for that reason; the
      // authoritative amount/quantity checks below remain the real
      // safety mechanism regardless of which of these two statuses the
      // order is in.
      if (!['paid', 'partial'].includes(order.paymentStatus)) {
        return res.status(409).json({
          success: false,
          message: 'Only paid or partially-refunded orders can be returned'
        })
      }

      // Fast-path idempotency check, outside the transaction — mirrors
      // order.create/cashMovement.createMovement/parkedCart.create. Same
      // key + identical payload replays the original; same key +
      // different payload is a 409, never silently returns stale/wrong
      // data. Scoped (order, idempotencyKey), not (store, ...): a return
      // is always about exactly one order.
      // Resolved to the SAME effective values create() itself persists
      // (both refundMethod and returnedBy fall back to a default when
      // omitted) — comparing against the raw, possibly-undefined request
      // fields would false-positive as "different" the moment a client
      // legitimately omits either one, since the persisted row always
      // has the resolved value, never undefined.
      const effectiveReturnedBy = returnedBy || req.user?.id || null
      const effectiveRefundMethod = refundMethod || order.paymentMethod || 'cash'

      if (idempotencyKey) {
        const existing = await db.sales_return.findOne({
          where: { order: id, idempotencyKey },
          include: [{ model: db.sales_return_item, as: 'items' }]
        })
        if (existing) {
          if (
            salesReturnPayloadMatches(existing, existing.items, {
              reason,
              refundMethod: effectiveRefundMethod,
              returnedBy: effectiveReturnedBy,
              items
            })
          ) {
            return res.status(200).json({
              success: true,
              message: 'Sales return request already recorded',
              data: existing
            })
          }
          return res.status(409).json({
            success: false,
            message: 'idempotencyKey already used with a different payload'
          })
        }
      }

      let result
      try {
        result = await withDeadlockRetry(() =>
          db.sequelize.transaction(async (t) => {
          // Bare-column lock only — no `include` — same Postgres
          // FOR-UPDATE-vs-outer-join constraint F2/F3 hit elsewhere. This
          // lock is what serializes the cumulative quantity/amount
          // validation below against any other concurrent create() call
          // for the same order (the previous code computed this from an
          // unlocked read taken before the transaction even opened — a
          // classic check-then-insert race). order_item rows are
          // immutable once created, so re-reading them unlocked below is
          // safe; only the order's own mutable state (paymentStatus) and
          // the set of sibling sales_return rows need the lock.
          const lockedOrder = await db.order.findByPk(id, {
            lock: t.LOCK.UPDATE,
            transaction: t
          })
          if (!lockedOrder || !['paid', 'partial'].includes(lockedOrder.paymentStatus)) {
            const e = new Error('Only paid or partially-refunded orders can be returned')
            e.statusCode = 409
            throw e
          }
          // DR-23 (BA §35.10): 'partial' now also carries PARTIALLY_PAID.
          // Returns require a fully settled order (outstanding = 0), judged
          // on ledger aggregates under this lock — never on the cache alone.
          const fin = await computeOrderFinancials(lockedOrder, t)
          if (fin.O > 0) {
            const e = new Error('Only fully settled orders can be returned; this order still has an outstanding balance')
            e.statusCode = 409
            throw e
          }

          const existingReturns = await db.sales_return.findAll({
            where: { order: id, status: { [Op.ne]: 'rejected' } },
            include: [{ model: db.sales_return_item, as: 'items' }],
            transaction: t
          })

          const returnedQtyMap = {}
          let pendingReservedAmount = 0
          existingReturns.forEach((ret) => {
            ret.items.forEach((item) => {
              if (item.orderItem) {
                returnedQtyMap[item.orderItem] =
                  (returnedQtyMap[item.orderItem] || 0) + Number(item.qty)
              }
            })
            if (ret.status === 'pending') {
              pendingReservedAmount += Number(ret.refundAmount) || 0
            }
          })

          // Authoritative amount invariant, computed from the payment
          // ledger — never order.totalPrice. totalCollected/totalRefunded
          // already cover split tender, cash, non-cash, and both
          // refund-producing mechanisms in this codebase (this flow and
          // order cancellation), since every transaction row represents
          // real, completed money movement. Other PENDING returns on this
          // order haven't hit the ledger yet, so their requested amount
          // is reserved separately (pendingReservedAmount) — otherwise
          // two pending requests could each look individually valid
          // against the same untouched remaining balance.
          const ledgerRows = await db.transaction.findAll({
            where: { order: id },
            attributes: ['amount'],
            transaction: t
          })
          const totalCollected = ledgerRows
            .filter((r) => Number(r.amount) > 0)
            .reduce((sum, r) => sum + Number(r.amount), 0)
          const totalAlreadyRefunded = ledgerRows
            .filter((r) => Number(r.amount) < 0)
            .reduce((sum, r) => sum + Math.abs(Number(r.amount)), 0)
          const remainingRefundable =
            totalCollected - totalAlreadyRefunded - pendingReservedAmount

          // Pass 1: validate every requested line and compute its raw
          // (pre-order-discount/tax/service-charge) return base. Deferred
          // rounding to pass 2 so the whole return's rounding reconciles
          // exactly instead of drifting line by line.
          const rawLines = []
          for (const reqItem of items) {
            const qty = Number(reqItem.qty)
            if (!qty || qty <= 0) {
              const e = new Error(`Invalid quantity for product ${reqItem.productId}`)
              e.statusCode = 422
              throw e
            }
            // Return quantities are integer selling units (sales_return_item
            // .qty is INTEGER, mirroring order_item.quantity). A fractional
            // qty would die at persistence or be silently truncated at
            // approval — reject it here with a clear contract error.
            if (!Number.isInteger(qty)) {
              const e = new Error(
                `Quantity must be an integer for product ${reqItem.productId}`
              )
              e.statusCode = 422
              throw e
            }

            // order_item rows are immutable once created, so the
            // outer, unlocked `order.items` (loaded before the
            // transaction) is safe to reuse here — only the order's own
            // mutable state and its sibling sales_return rows need the
            // fresh, locked read above.
            const matchedItem = order.items.find(
              (oi) =>
                oi.product === reqItem.productId || oi.id === reqItem.orderItemId
            )
            if (!matchedItem) {
              const e = new Error(
                `Product ${reqItem.productId} not found in original order`
              )
              e.statusCode = 422
              throw e
            }

            const product = await db.product.findByPk(reqItem.productId, {
              transaction: t
            })
            if (!product) {
              const e = new Error(`Product ${reqItem.productId} does not exist`)
              e.statusCode = 422
              throw e
            }

            const alreadyReturned = returnedQtyMap[matchedItem.id] || 0
            if (alreadyReturned + qty > matchedItem.quantity) {
              const e = new Error(
                `Cumulative return quantity for ${matchedItem.productName} (${alreadyReturned + qty}) exceeds original quantity (${matchedItem.quantity})`
              )
              e.statusCode = 409
              throw e
            }

            const rawReturnBase =
              (Number(matchedItem.totalPrice) / Number(matchedItem.quantity)) * qty

            rawLines.push({ reqItem, matchedItem, qty, rawReturnBase })
          }

          // Pass 2: allocate the order-level discount/tax/service-charge
          // proportionally via a single collection-ratio correction
          // (order.totalPrice / order.subTotal), then round deterministically
          // — every line rounds normally except the last (sorted by
          // orderItem id ascending), which absorbs the residual so the
          // sum of line refunds always equals the return's total exactly.
          const rawTotal = rawLines.reduce((s, l) => s + l.rawReturnBase, 0)
          const subTotal = Number(order.subTotal) || 0
          const collectionRatio = subTotal > 0 ? Number(order.totalPrice) / subTotal : 0
          const targetTotal = subTotal > 0 ? Math.round(rawTotal * collectionRatio) : 0

          const sortedLines = [...rawLines].sort(
            (a, b) => a.matchedItem.id - b.matchedItem.id
          )
          let roundedSum = 0
          sortedLines.forEach((line, idx) => {
            if (idx === sortedLines.length - 1) {
              line.refundAmount = targetTotal - roundedSum
            } else {
              line.refundAmount =
                subTotal > 0 ? Math.round(line.rawReturnBase * collectionRatio) : 0
              roundedSum += line.refundAmount
            }
          })

          const totalRefund = targetTotal

          if (totalRefund > remainingRefundable) {
            const e = new Error(
              `Refund amount (${totalRefund}) exceeds the remaining refundable amount (${remainingRefundable})`
            )
            e.statusCode = 409
            throw e
          }

          const returnItemsData = rawLines.map((line) => ({
            product: line.reqItem.productId,
            orderItem: line.matchedItem.id,
            qty: line.qty,
            price: line.qty > 0 ? Math.round(line.refundAmount / line.qty) : 0,
            unit: line.reqItem.unit || line.matchedItem.unit || 'pcs',
            conversionToBase: line.reqItem.conversionToBase || 1,
            notes: line.reqItem.notes || null
          }))

          let returnOrder
          try {
            returnOrder = await db.sales_return.create(
              {
                order: id,
                store: order.store,
                reason: reason.trim(),
                returnNumber: `SR-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`,
                status: 'pending',
                refundAmount: totalRefund,
                refundMethod: refundMethod || order.paymentMethod || 'cash',
                returnedBy: returnedBy || req.user?.id || null,
                createdBy: req.user?.id || null,
                idempotencyKey: idempotencyKey || null
              },
              { transaction: t }
            )
          } catch (createError) {
            if (
              createError.name === 'SequelizeUniqueConstraintError' &&
              idempotencyKey
            ) {
              const raceError = new Error('IDEMPOTENCY_RACE')
              raceError.isIdempotencyRace = true
              throw raceError
            }
            throw createError
          }

          const finalItems = returnItemsData.map((item) => ({
            ...item,
            salesReturn: returnOrder.id
          }))

          await db.sales_return_item.bulkCreate(finalItems, { transaction: t })

          await db.stock_history.create(
            {
              store: order.store,
              referenceType: 'sale_return',
              referenceId: returnOrder.id,
              quantityBefore: 0,
              quantityChange: 0,
              quantityAfter: 0,
              notes: `Sales return request: ${returnOrder.returnNumber} (pending approval)`,
              createdBy: req.user?.id || null
            },
            { transaction: t }
          )

          return returnOrder
        })
      )
    } catch (txError) {
        if (txError.isIdempotencyRace) {
          const existing = await db.sales_return.findOne({
            where: { order: id, idempotencyKey },
            include: [{ model: db.sales_return_item, as: 'items' }]
          })
          if (existing) {
            if (
              salesReturnPayloadMatches(existing, existing.items, {
                reason,
                refundMethod: effectiveRefundMethod,
                returnedBy: effectiveReturnedBy,
                items
              })
            ) {
              return res.status(200).json({
                success: true,
                message: 'Sales return request already recorded',
                data: existing
              })
            }
            return res.status(409).json({
              success: false,
              message: 'idempotencyKey already used with a different payload'
            })
          }
        }
        throw txError
      }

      return res.status(201).json({
        success: true,
        message: 'Sales return request created (Pending approval)',
        data: result
      })
    } catch (error) {
      console.error('Error =>', error)
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Internal server error'
      })
    }
  },

  // Loyalty points - add points to member

  // Loyalty points - get point history
  async getPointHistory(req, res) {
    try {
      const { id } = req.params
      const { page = 1, limit = 20 } = req.query

      const member = await db.member.findByPk(id)
      if (!member) {
        return res.status(404).json({
          success: false,
          message: 'Member not found'
        })
      }

      const offset = (parseInt(page) - 1) * parseInt(limit)

      const { count, rows } = await db.member_point_history.findAndCountAll({
        where: { member: id },
        include: [
          {
            model: db.member,
            as: 'memberData',
            attributes: ['id', 'name', 'phoneNumber']
          }
        ],
        order: [['createdAt', 'DESC']],
        limit: parseInt(limit),
        offset
      })

      return res.status(200).json({
        success: true,
        message: 'Success',
        data: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / parseInt(limit))
        }
      })
    } catch (error) {
      console.error('Error =>', error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  // Dashboard summary
  async getDashboardSummary(req, res) {
    try {
      const store = resolveStoreId(req)
      let { startDate, endDate, filter, page, pageSize } = req.query
      page = Math.max(parseInt(page) || 1, 1)
      pageSize = Math.min(Math.max(parseInt(pageSize) || 5, 1), 50)

      // Auto-compute date range based on filter preset
      if (filter && !startDate && !endDate) {
        const now = new Date()
        const todayStart = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate()
        )

        if (filter === 'daily') {
          startDate = todayStart.toISOString()
          endDate = new Date(todayStart.getTime() + 86400000 - 1).toISOString()
        } else if (filter === 'monthly') {
          const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
          const monthEnd = new Date(
            now.getFullYear(),
            now.getMonth() + 1,
            0,
            23,
            59,
            59,
            999
          )
          startDate = monthStart.toISOString()
          endDate = monthEnd.toISOString()
        } else {
          // weekly — Mon to Sun of current week
          const daysSinceMonday = (now.getDay() + 6) % 7
          const monday = new Date(todayStart)
          monday.setDate(todayStart.getDate() - daysSinceMonday)
          startDate = monday.toISOString()
          endDate = new Date(monday.getTime() + 7 * 86400000 - 1).toISOString()
        }
      }

      const orderWhere = { paymentStatus: 'paid' }
      if (store) orderWhere.store = store
      if (startDate || endDate) {
        orderWhere.createdAt = {}
        if (startDate) orderWhere.createdAt[Op.gte] = new Date(startDate)
        if (endDate) orderWhere.createdAt[Op.lte] = new Date(endDate)
      }

      const productWhere = { status: 'active' }

      // Determine chart grouping based on filter
      let chartGroupBy, chartLimit
      if (filter === 'daily') {
        chartGroupBy = `DATE_TRUNC('hour', "createdAt")`
        chartLimit = 24
      } else if (filter === 'monthly') {
        chartGroupBy = `DATE("createdAt")`
        chartLimit = 31
      } else {
        chartGroupBy = `DATE("createdAt")`
        chartLimit = 7
      }

      const chartReplacements = Object.assign(
        {},
        startDate && { startDate },
        endDate && { endDate },
        store && { store }
      )

      const [
        totalSales,
        totalOrders,
        totalProducts,
        totalMembers,
        salesChart,
        bestSellers,
        recentOrders,
        paymentMethods
      ] = await Promise.all([
        db.order.sum('totalPrice', { where: orderWhere }),
        db.order.count({ where: orderWhere }),
        db.product.count({ where: productWhere }),
        db.member.count(),
        db.sequelize.query(
          `
          SELECT ${chartGroupBy} as date, SUM("totalPrice") as sales
          FROM "order"
          WHERE "paymentStatus" = 'paid'
          ${startDate && endDate ? 'AND "createdAt" >= :startDate AND "createdAt" <= :endDate' : ''}
          ${store ? 'AND "store" = :store' : ''}
          GROUP BY date
          ORDER BY date ASC
          LIMIT ${chartLimit}
        `,
          {
            replacements: chartReplacements,
            type: db.sequelize.QueryTypes.SELECT
          }
        ),
        db.sequelize.query(
          `
          SELECT "productId", "nameProduct" as "productName", "image", SUM("totalSelling") as quantity
          FROM "best_selling"
          WHERE 1=1
          ${store ? 'AND "store" = :store' : ''}
          GROUP BY "productId", "nameProduct", "image"
          ORDER BY quantity DESC
          LIMIT 5
        `,
          {
            replacements: store ? { store } : {},
            type: db.sequelize.QueryTypes.SELECT
          }
        ),
        db.order
          .findAndCountAll({
            where: {
              ...(store ? { store } : {}),
              ...(startDate || endDate
                ? { createdAt: orderWhere.createdAt }
                : {})
            },
order: [['updatedAt', 'DESC']],
            limit: pageSize,
            offset: (page - 1) * pageSize,
            distinct: true,
            include: [
              {
                model: db.order_item,
                as: 'items',
                attributes: ['id', 'productName', 'quantity', 'totalPrice']
              },
              { model: db.table, as: 'table', attributes: ['name'] }
            ],
            ...((await orderAttrs()) ? { attributes: await orderAttrs() } : {})
          })
          .then(({ count, rows }) => ({
            total: count,
            page,
            pageSize,
            rows: rows.map((o) => {
              const json = o.toJSON()
              return {
                ...json,
                tableName: json.table?.name || null,
                table: json.table?.name || null
              }
            })
          })),
        db.sequelize.query(
          `
          SELECT COALESCE("paymentMethod", 'cash') AS method,
                 COUNT(*)::int AS orders,
                 SUM("totalPrice") AS sales
          FROM "order"
          WHERE "paymentStatus" = 'paid'
          ${startDate && endDate ? 'AND "createdAt" >= :startDate AND "createdAt" <= :endDate' : ''}
          ${store ? 'AND "store" = :store' : ''}
          GROUP BY 1
          ORDER BY sales DESC
        `,
          {
            replacements: chartReplacements,
            type: db.sequelize.QueryTypes.SELECT
          }
        )
      ])

      // F21-01: unlike the ingredient count directly below, this query had
      // no store scope at all — Product has no `store` column of its own
      // (it's assigned to stores via the product_store join table), so the
      // fix mirrors the same EXISTS-against-product_store scoping the
      // already-correct low-stock detail list uses (stockHistory.js
      // getLowStockAll), not a bare `AND store = :store`.
      let lowStockProductQuery = `SELECT COUNT(*)::int as count FROM "product" p WHERE p.status = 'active' AND p."deletedAt" IS NULL AND p."minStock" > 0 AND p."stock" <= p."minStock"`
      const productReplacements = {}
      if (store) {
        lowStockProductQuery += ` AND EXISTS (SELECT 1 FROM "product_store" ps WHERE ps.product = p.id AND ps.store = :store)`
        productReplacements.store = store
      }
      const [lowStockProductCount] = await db.sequelize.query(
        lowStockProductQuery,
        { replacements: productReplacements, type: db.sequelize.QueryTypes.SELECT }
      )
      let lowStockIngQuery = `SELECT COUNT(*)::int as count FROM "ingredient" WHERE status = 'active' AND "deletedAt" IS NULL AND "stock" <= "minStock"`
      const ingReplacements = {}
      if (store) {
        lowStockIngQuery += ` AND store = :store`
        ingReplacements.store = store
      }
      const [lowStockIngredientCount] = await db.sequelize.query(
        lowStockIngQuery,
        { replacements: ingReplacements, type: db.sequelize.QueryTypes.SELECT }
      )
      const lowStock =
        parseInt(lowStockProductCount?.count || 0) +
        parseInt(lowStockIngredientCount?.count || 0)

      const expenseWhere = { status: 'approved', isActive: true }
      if (store) expenseWhere.store = store
      if (startDate || endDate) {
        expenseWhere.date = {}
        if (startDate) expenseWhere.date[Op.gte] = new Date(startDate)
        if (endDate) expenseWhere.date[Op.lte] = new Date(endDate)
      }

      const [totalExpense, recentExpenseRows] = await Promise.all([
        db.expense.sum('amount', { where: expenseWhere }),
        db.expense.findAll({
          where: expenseWhere,
          attributes: [
            'id',
            'expenseNumber',
            'description',
            'amount',
            'date',
            'store'
          ],
          include: [
            {
              model: db.expense_category,
              as: 'categoryData',
              attributes: ['id', 'name']
            }
          ],
          order: [
            ['date', 'DESC'],
            ['createdAt', 'DESC']
          ],
          limit: 5
        })
      ])

      const expStoreIds = [
        ...new Set(recentExpenseRows.map((e) => e.store).filter(Boolean))
      ]
      const expStoreMap = {}
      if (expStoreIds.length > 0) {
        const locs = await db.location.findAll({
          where: { id: expStoreIds },
          attributes: ['id', 'name']
        })
        locs.forEach((l) => {
          expStoreMap[l.id] = l.name
        })
      }
      const recentExpenses = recentExpenseRows.map((e) => {
        const j = e.toJSON()
        return {
          id: j.id,
          expenseNumber: j.expenseNumber,
          description: j.description,
          amount: j.amount,
          date: j.date,
          store: j.store,
          storeName: expStoreMap[j.store] || null,
          categoryName: j.categoryData?.name || null
        }
      })

      let storeInfo = null
      let dailyTarget = 0
      if (store) {
        const loc = await db.location.findByPk(store, {
          attributes: [
            'id',
            'name',
            'city',
            'address',
            'status',
            'dailyTarget'
          ]
        })
        if (loc) {
          storeInfo = {
            id: loc.id,
            name: loc.name,
            city: loc.city,
            address: loc.address,
            status: loc.status
          }
          dailyTarget = loc.dailyTarget || 0
        }
      } else {
        try {
          dailyTarget =
            (await db.location.sum('dailyTarget', {
              where: { status: 'active' }
            })) || 0
        } catch {
          dailyTarget = 0
        }
      }

      return res.status(200).json({
        success: true,
        message: 'Success',
        data: {
          totalSales: totalSales || 0,
          dailyTarget,
          averageOrderValue:
            totalOrders > 0
              ? Math.round((totalSales || 0) / totalOrders)
              : 0,
          netSales: (totalSales || 0) - (totalExpense || 0),
          paymentMethods: paymentMethods || [],
          storeInfo,
          totalOrders: totalOrders || 0,
          totalProducts: totalProducts || 0,
          totalMembers: totalMembers || 0,
          salesChart: salesChart || [],
          bestSellers: bestSellers || [],
          recentOrders: recentOrders || [],
          totalExpense: totalExpense || 0,
          recentExpenses: recentExpenses || [],
          lowStock,
          filter: filter || 'weekly'
        }
      })
    } catch (error) {
      console.error('Error =>', error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  // Super Admin global dashboard — multi-store, payments, finance, operations, customers, activity
  async getSuperAdminDashboard(req, res) {
    try {
      const userRole = req.user?.roleType
      if (userRole !== 'super_admin') {
        return res.status(403).json({ success: false, message: 'Forbidden' })
      }

      const store = req.storeId || null
      let { startDate, endDate } = req.query

      // Default: current month
      const now = new Date()
      if (!startDate) {
        startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
      }
      if (!endDate) {
        endDate = new Date(
          now.getFullYear(),
          now.getMonth() + 1,
          0,
          23,
          59,
          59,
          999
        ).toISOString()
      }

      const storeCond = store ? ' AND "store" = :store' : ''
      const storeCondAlias = store ? ' AND o."store" = :store' : ''
      const storeCondPP = store ? ' AND pp."store" = :store' : ''
      const storeCondE = store ? ' AND e."store" = :store' : ''
      const replacements = { startDate, endDate }
      if (store) replacements.store = store

      const startDay = startDate.slice(0, 10)
      const endDay = endDate.slice(0, 10)
      const today = new Date()
      const todayStr = today.toISOString().slice(0, 10)

      const stores = await db.location.findAll({
        where: { status: 'active' },
        attributes: [
          'id',
          'name',
          'city',
          'province',
          'dailyTarget',
          'managerName',
          'status'
        ],
        order: [['name', 'ASC']]
      })
      const storeList = stores.map((s) => s.toJSON())
      const storeNameMap = {}
      storeList.forEach((s) => {
        storeNameMap[s.id] = s.name
      })

      const [
        kpiRow,
        storeSalesRows,
        dailySalesRows,
        paymentMethodRows,
        dailyInflowRows,
        expenseRows,
        expenseCatRows,
        dailyExpenseRows,
        totalExpenseRow,
        apPaymentsRow,
        apOutstandingRows,
        apOutstandingTotals,
        arRows,
        arByCustomer,
        memberRow,
        tierRows,
        topMembers,
        lowStockProducts,
        lowStockIngredients,
        stockValueRows,
        productionRows,
        cashRegisterRows,
        queueRow,
        reservationRow,
        recentOrders,
        recentInPayments,
        recentOutPayments,
        recentAudit,
        prevSalesRow
      ] = await Promise.all([
        // 1. KPI aggregate (paid orders in range)
        db.sequelize.query(
          `SELECT
             COALESCE(SUM("totalPrice"),0)::int as revenue,
             COUNT(*)::int as orders,
             COALESCE(SUM("totalQuantity"),0)::int as "itemsSold",
             COALESCE(SUM("discountAmount"),0)::int as discount,
             COALESCE(SUM("taxAmount"),0)::int as tax,
             COALESCE(SUM("serviceChargeAmount"),0)::int as "serviceCharge"
           FROM "order"
           WHERE "paymentStatus" = 'paid'
             AND "deletedAt" IS NULL
             AND "createdAt" >= :startDate AND "createdAt" <= :endDate
             ${storeCond}`,
          { replacements, type: db.sequelize.QueryTypes.SELECT }
        ),
        // 2. Per-store sales aggregation
        db.sequelize.query(
          `SELECT o."store" as "storeId",
             COALESCE(SUM(o."totalPrice"),0)::int as revenue,
             COUNT(DISTINCT o.id)::int as orders,
             COALESCE(SUM(o."totalQuantity"),0)::int as "itemsSold",
             COALESCE(SUM(o."discountAmount"),0)::int as discount,
             COALESCE(SUM(o."taxAmount"),0)::int as tax
           FROM "order" o
           WHERE o."paymentStatus" = 'paid'
             AND o."deletedAt" IS NULL
             AND o."createdAt" >= :startDate AND o."createdAt" <= :endDate
             ${storeCondAlias}
           GROUP BY o."store"`,
          { replacements, type: db.sequelize.QueryTypes.SELECT }
        ),
        // 3. Daily sales trend
        db.sequelize.query(
          `SELECT DATE(o."createdAt") as date,
             COALESCE(SUM(o."totalPrice"),0)::int as revenue,
             COUNT(DISTINCT o.id)::int as orders,
             COALESCE(SUM(o."totalQuantity"),0)::int as "itemsSold"
           FROM "order" o
           WHERE o."paymentStatus" = 'paid'
             AND o."deletedAt" IS NULL
             AND o."createdAt" >= :startDate AND o."createdAt" <= :endDate
             ${storeCondAlias}
           GROUP BY DATE(o."createdAt")
           ORDER BY date ASC`,
          { replacements, type: db.sequelize.QueryTypes.SELECT }
        ),
        // 4. Payment method breakdown (from transaction records)
        db.sequelize.query(
          `SELECT t."typePayment" as method,
             COUNT(*)::int as count,
             COALESCE(SUM(t.amount),0)::int as amount
           FROM "transaction" t
           JOIN "order" o ON o.id = t."order"
           WHERE o."paymentStatus" = 'paid'
             AND o."deletedAt" IS NULL
             AND t."deletedAt" IS NULL
             AND o."createdAt" >= :startDate AND o."createdAt" <= :endDate
             ${storeCondAlias}
           GROUP BY t."typePayment"
           ORDER BY amount DESC`,
          { replacements, type: db.sequelize.QueryTypes.SELECT }
        ),
        // 5. Daily incoming payment (cashflow inflow)
        db.sequelize.query(
          `SELECT DATE(o."createdAt") as date,
             COALESCE(SUM(t.amount),0)::int as inflow
           FROM "transaction" t
           JOIN "order" o ON o.id = t."order"
           WHERE o."paymentStatus" = 'paid'
             AND o."deletedAt" IS NULL
             AND t."deletedAt" IS NULL
             AND o."createdAt" >= :startDate AND o."createdAt" <= :endDate
             ${storeCondAlias}
           GROUP BY DATE(o."createdAt")`,
          { replacements, type: db.sequelize.QueryTypes.SELECT }
        ),
        // 6. Expense per store
        db.sequelize.query(
          `SELECT e."store" as "storeId",
             COALESCE(SUM(e.amount),0)::int as expense,
             COUNT(*)::int as count
           FROM "expense" e
           WHERE e.status = 'approved'
             AND e."deletedAt" IS NULL
             AND e."date" >= :startDate AND e."date" <= :endDate
             ${storeCond}
           GROUP BY e."store"`,
          { replacements, type: db.sequelize.QueryTypes.SELECT }
        ),
        // 7. Expense by category
        db.sequelize.query(
          `SELECT COALESCE(ec.name, 'Lainnya') as category,
             COALESCE(SUM(e.amount),0)::int as amount,
             COUNT(*)::int as count
           FROM "expense" e
           LEFT JOIN "expense_category" ec ON ec.id = e.category
           WHERE e.status = 'approved'
             AND e."deletedAt" IS NULL
             AND e."date" >= :startDate AND e."date" <= :endDate
             ${storeCondE}
           GROUP BY ec.name
           ORDER BY amount DESC`,
          { replacements, type: db.sequelize.QueryTypes.SELECT }
        ),
        // 8. Daily expense (cashflow outflow)
        db.sequelize.query(
          `SELECT DATE(e."date") as date,
             COALESCE(SUM(e.amount),0)::int as outflow
           FROM "expense" e
           WHERE e.status = 'approved'
             AND e."deletedAt" IS NULL
             AND e."date" >= :startDate AND e."date" <= :endDate
             ${storeCond}
           GROUP BY DATE(e."date")`,
          { replacements, type: db.sequelize.QueryTypes.SELECT }
        ),
        // 9. Total expense
        db.sequelize.query(
          `SELECT COALESCE(SUM(amount),0)::int as amount
           FROM "expense"
           WHERE status = 'approved'
             AND "deletedAt" IS NULL
             AND "date" >= :startDate AND "date" <= :endDate
             ${storeCond}`,
          { replacements, type: db.sequelize.QueryTypes.SELECT }
        ),
        // 10. AP payments (outflow) in range — grouped by day
        db.sequelize.query(
          `SELECT "paymentDate" as date,
             COALESCE(SUM(amount),0)::int as amount,
             COUNT(*)::int as count
           FROM "purchase_payment"
           WHERE "deletedAt" IS NULL
             AND "paymentDate" >= :startDay AND "paymentDate" <= :endDay
             ${storeCond}
           GROUP BY "paymentDate"
           ORDER BY date ASC`,
          {
            replacements: { ...replacements, startDay, endDay },
            type: db.sequelize.QueryTypes.SELECT
          }
        ),
        // 11. Outstanding AP by PO
        db.sequelize.query(
          `SELECT po.id, po."orderNumber", po.store, po."finalAmount",
             po."dueDate", po.status,
             COALESCE(SUM(pp.amount),0)::int as paid
           FROM "purchase_order" po
           LEFT JOIN "purchase_payment" pp
             ON pp."purchaseOrder" = po.id AND pp."deletedAt" IS NULL
           WHERE po.status NOT IN ('cancelled','draft')
             AND po."deletedAt" IS NULL
             ${store ? ' AND po."store" = :store' : ''}
           GROUP BY po.id
           HAVING po."finalAmount" > COALESCE(SUM(pp.amount),0)
           ORDER BY (po."finalAmount" - COALESCE(SUM(pp.amount),0)) DESC`,
          {
            replacements: store ? { store } : {},
            type: db.sequelize.QueryTypes.SELECT
          }
        ),
        // 12. AP total summary
        db.sequelize.query(
          `SELECT COUNT(*)::int as count,
             COALESCE(SUM(po."finalAmount" - COALESCE((SELECT SUM(pp2.amount) FROM "purchase_payment" pp2 WHERE pp2."purchaseOrder" = po.id AND pp2."deletedAt" IS NULL),0)),0)::int as outstanding,
             COALESCE(SUM((SELECT COALESCE(SUM(pp3.amount),0) FROM "purchase_payment" pp3 WHERE pp3."purchaseOrder" = po.id AND pp3."deletedAt" IS NULL)),0)::int as paid
           FROM "purchase_order" po
           WHERE po.status NOT IN ('cancelled','draft')
             AND po."deletedAt" IS NULL
             ${store ? ' AND po."store" = :store' : ''}
           HAVING SUM(po."finalAmount" - COALESCE((SELECT SUM(pp2.amount) FROM "purchase_payment" pp2 WHERE pp2."purchaseOrder" = po.id AND pp2."deletedAt" IS NULL),0)) > 0`,
          {
            replacements: store ? { store } : {},
            type: db.sequelize.QueryTypes.SELECT
          }
        ),
        // 13. AR outstanding summary
        db.sequelize.query(
          `SELECT COALESCE(SUM("outstandingAmount"),0)::int as outstanding,
             COUNT(*)::int as count
           FROM "accounts_receivable"
           WHERE status NOT IN ('PAID','CANCELLED')
             AND "deletedAt" IS NULL
             ${storeCond}`,
          { replacements, type: db.sequelize.QueryTypes.SELECT }
        ),
        // 14. AR by customer
        db.sequelize.query(
          `SELECT "customerName" as customer,
             COALESCE(SUM("outstandingAmount"),0)::int as outstanding,
             COUNT(*)::int as count
           FROM "accounts_receivable"
           WHERE status NOT IN ('PAID','CANCELLED')
             AND "deletedAt" IS NULL
             ${storeCond}
           GROUP BY "customerName"
           ORDER BY outstanding DESC
           LIMIT 8`,
          { replacements, type: db.sequelize.QueryTypes.SELECT }
        ),
        // 15. Member totals
        db.sequelize.query(
          `SELECT COUNT(*)::int as total,
             COALESCE(COUNT(*) FILTER (WHERE "createdAt" >= :startDate AND "createdAt" <= :endDate),0)::int as "newMembers"
           FROM "member"
           WHERE "deletedAt" IS NULL
             ${storeCond}`,
          { replacements, type: db.sequelize.QueryTypes.SELECT }
        ),
        // 16. Member tier distribution
        db.sequelize.query(
          `SELECT COALESCE(mt.name, 'Tanpa Tier') as tier,
             COUNT(m.id)::int as count
           FROM "member" m
           LEFT JOIN "member_tier" mt ON mt.id = m.tier
           WHERE m."deletedAt" IS NULL
             ${store ? ' AND m."store" = :store' : ''}
           GROUP BY mt.name
           ORDER BY count DESC`,
          {
            replacements: store ? { store } : {},
            type: db.sequelize.QueryTypes.SELECT
          }
        ),
        // 17. Top members by spend
        db.sequelize.query(
          `SELECT o."customerId" as id, m.name, m."phoneNumber",
             COALESCE(SUM(o."totalPrice"),0)::int as "totalSpend",
             COUNT(DISTINCT o.id)::int as "orderCount"
           FROM "order" o
           JOIN "member" m ON m.id = o."customerId" AND m."deletedAt" IS NULL
           WHERE o."paymentStatus" = 'paid'
             AND o."deletedAt" IS NULL
             AND o."customerId" IS NOT NULL
             AND o."createdAt" >= :startDate AND o."createdAt" <= :endDate
             ${storeCondAlias}
           GROUP BY o."customerId", m.name, m."phoneNumber"
           ORDER BY "totalSpend" DESC
           LIMIT 5`,
          { replacements, type: db.sequelize.QueryTypes.SELECT }
        ),
        // 18. Low stock products
        db.sequelize.query(
          `SELECT 'product' as type, p.id, p."nameProduct" as name,
             NULL as store, p.stock, p."minStock", p.unit
           FROM "product" p
           WHERE p.status = 'active'
             AND p."deletedAt" IS NULL
             AND p."minStock" > 0
             AND p."stock" <= p."minStock"
           ORDER BY (p."minStock" - p.stock) DESC
           LIMIT 10`,
          { type: db.sequelize.QueryTypes.SELECT }
        ),
        // 19. Low stock ingredients
        // F21-06: this was the one ingredient low-stock query in the
        // codebase requiring minStock > 0 — every other implementation
        // (ingredient.js getAll, stockHistory.js getLowStock/getLowStockAll/
        // autoGeneratePO, this file's own getDashboardSummary ingredient
        // count) uses the unguarded `stock <= minStock`. An ingredient with
        // stock=0, minStock=0 counted everywhere except here, so this
        // dashboard's low-stock detail list silently disagreed with its own
        // ingredient list page. Dropped the guard to match every other site
        // rather than add it elsewhere, since the unguarded definition is
        // the one demonstrably used almost everywhere already.
        db.sequelize.query(
          `SELECT 'ingredient' as type, i.id, i.name,
             i.store, i.stock, i."minStock", i.unit
           FROM "ingredient" i
           WHERE i.status = 'active'
             AND i."deletedAt" IS NULL
             AND i."stock" <= i."minStock"
             ${store ? ' AND i."store" = :store' : ''}
           ORDER BY (i."minStock" - i.stock) DESC
           LIMIT 10`,
          {
            replacements: store ? { store } : {},
            type: db.sequelize.QueryTypes.SELECT
          }
        ),
        // 20. Stock value (products + ingredients)
        db.sequelize.query(
          `SELECT
             (SELECT COALESCE(SUM(stock * "costPrice"),0)::int FROM "product" WHERE status='active' AND "deletedAt" IS NULL) as "productValue",
             (SELECT COALESCE(SUM(stock * "costPrice"),0)::int FROM "ingredient" WHERE status='active' AND "deletedAt" IS NULL ${store ? ' AND "store" = :store' : ''}) as "ingredientValue"`,
          {
            replacements: store ? { store } : {},
            type: db.sequelize.QueryTypes.SELECT
          }
        ),
        // 21. Production status counts
        db.sequelize.query(
          `SELECT status, COUNT(*)::int as count
           FROM "production_order"
           WHERE "deletedAt" IS NULL
             ${storeCond}
           GROUP BY status`,
          { replacements, type: db.sequelize.QueryTypes.SELECT }
        ),
        // 22. Cash register status
        db.sequelize.query(
          `SELECT status, COUNT(*)::int as count,
             COALESCE(SUM("totalSales"),0)::int as "totalSales"
           FROM "cash_register"
           WHERE "deletedAt" IS NULL
             ${storeCond}
           GROUP BY status`,
          { replacements, type: db.sequelize.QueryTypes.SELECT }
        ),
        // 23. Queue waiting (global)
        db.sequelize.query(
          `SELECT COUNT(*)::int as count
           FROM "queue"
           WHERE status IN ('waiting','seated')
             AND "deletedAt" IS NULL
             AND "checkedInAt" >= :startDate`,
          { replacements, type: db.sequelize.QueryTypes.SELECT }
        ),
        // 24. Reservation today
        db.sequelize.query(
          `SELECT COUNT(*)::int as count
           FROM "reservation"
           WHERE "reservationDate" = :todayStr
             AND status NOT IN ('cancelled','no_show')
             AND "deletedAt" IS NULL
             ${storeCond}`,
          {
            replacements: { ...replacements, todayStr },
            type: db.sequelize.QueryTypes.SELECT
          }
        ),
        // 25. Recent orders
        db.sequelize.query(
          `SELECT o.id, o."orderNumber", o.store, o."cashierName",
             o."totalPrice", o.status, o."paymentMethod", o."createdAt",
             l.name as "storeName"
           FROM "order" o
           LEFT JOIN "location" l ON l.id = o.store
           WHERE o."deletedAt" IS NULL
             ${storeCondAlias}
           ORDER BY o."createdAt" DESC
           LIMIT 8`,
          { replacements, type: db.sequelize.QueryTypes.SELECT }
        ),
        // 26. Recent incoming payments (checkout transactions)
        db.sequelize.query(
          `SELECT t.id, 'in' as type, o."orderNumber" as ref,
             t.amount, t."typePayment" as method, o."createdAt" as date,
             o.store, COALESCE(o."customerName", o."cashierName", '-') as party, o."cashierName"
           FROM "transaction" t
           JOIN "order" o ON o.id = t."order"
           WHERE t."deletedAt" IS NULL
             AND o."deletedAt" IS NULL
             ${storeCondAlias}
           ORDER BY t."createdAt" DESC
           LIMIT 6`,
          { replacements, type: db.sequelize.QueryTypes.SELECT }
        ),
        // 27. Recent outgoing payments (AP payments)
        db.sequelize.query(
          `SELECT pp.id, 'out' as type, po."orderNumber" as ref,
             pp.amount, pp."paymentMethod" as method, pp."paymentDate" as date,
             pp.store, COALESCE(s.name, '-') as party, NULL as "cashierName"
           FROM "purchase_payment" pp
           LEFT JOIN "purchase_order" po ON po.id = pp."purchaseOrder"
           LEFT JOIN "supplier" s ON s.id = pp."supplier"
           WHERE pp."deletedAt" IS NULL
             ${storeCondPP}
           ORDER BY pp."createdAt" DESC
           LIMIT 6`,
          { replacements, type: db.sequelize.QueryTypes.SELECT }
        ),
        // 28. Recent audit log
        db.sequelize.query(
          `SELECT id, action, entity, "entityId", description, "userName", store, "createdAt"
           FROM "auditLog"
           ${store ? 'WHERE store = :store' : ''}
           ORDER BY "createdAt" DESC
           LIMIT 8`,
          {
            replacements: store ? { store } : {},
            type: db.sequelize.QueryTypes.SELECT
          }
        ),
        // 29-32. Previous period comparisons
        (async () => {
          const rangeMs =
            new Date(endDate).getTime() - new Date(startDate).getTime()
          const prevEnd = new Date(new Date(startDate).getTime() - 1)
          const prevStart = new Date(prevEnd.getTime() - rangeMs)
          const prevRepl = {
            ...replacements,
            pStart: prevStart.toISOString(),
            pEnd: prevEnd.toISOString()
          }
          const [sales, orders, expense, members] = await Promise.all([
            db.sequelize.query(
              `SELECT COALESCE(SUM("totalPrice"),0)::int as revenue
               FROM "order" WHERE "paymentStatus"='paid' AND "deletedAt" IS NULL
                 AND "createdAt" >= :pStart AND "createdAt" <= :pEnd ${storeCond}`,
              { replacements: prevRepl, type: db.sequelize.QueryTypes.SELECT }
            ),
            db.sequelize.query(
              `SELECT COUNT(*)::int as orders
               FROM "order" WHERE "paymentStatus"='paid' AND "deletedAt" IS NULL
                 AND "createdAt" >= :pStart AND "createdAt" <= :pEnd ${storeCond}`,
              { replacements: prevRepl, type: db.sequelize.QueryTypes.SELECT }
            ),
            db.sequelize.query(
              `SELECT COALESCE(SUM(amount),0)::int as amount
               FROM "expense" WHERE status='approved' AND "deletedAt" IS NULL
                 AND "date" >= :pStart AND "date" <= :pEnd ${storeCond}`,
              { replacements: prevRepl, type: db.sequelize.QueryTypes.SELECT }
            ),
            db.sequelize.query(
              `SELECT COUNT(*)::int as total
               FROM "member" WHERE "deletedAt" IS NULL
                 AND "createdAt" >= :pStart AND "createdAt" <= :pEnd ${storeCond}`,
              { replacements: prevRepl, type: db.sequelize.QueryTypes.SELECT }
            )
          ])
          return {
            prevRevenue: sales[0]?.revenue || 0,
            prevOrders: orders[0]?.orders || 0,
            prevExpense: expense[0]?.amount || 0,
            prevNewMembers: members[0]?.total || 0
          }
        })()
      ])

      // ---- Assemble ----
      const kpi = kpiRow[0] || {}
      const revenue = Number(kpi.revenue || 0)
      const orders = Number(kpi.orders || 0)
      const totalExpense = Number(totalExpenseRow[0]?.amount || 0)
      const totalMembers = Number(memberRow[0]?.total || 0)
      const newMembers = Number(memberRow[0]?.newMembers || 0)

      const storeSalesMap = {}
      storeSalesRows.forEach((r) => {
        storeSalesMap[r.storeId] = r
      })
      const expenseStoreMap = {}
      expenseRows.forEach((r) => {
        expenseStoreMap[r.storeId] = {
          expense: Number(r.expense || 0),
          count: r.count
        }
      })

      const storePerformance = storeList
        .map((s) => {
          const sales = storeSalesMap[s.id] || {}
          const exp = expenseStoreMap[s.id] || { expense: 0, count: 0 }
          const storeRevenue = Number(sales.revenue || 0)
          const storeOrders = Number(sales.orders || 0)
          const storeExpense = Number(exp.expense || 0)
          const target = Number(s.dailyTarget || 0)
          return {
            storeId: s.id,
            storeName: s.name,
            city: s.city || null,
            province: s.province || null,
            managerName: s.managerName || null,
            revenue: storeRevenue,
            orders: storeOrders,
            avgOrderValue:
              storeOrders > 0 ? Math.round(storeRevenue / storeOrders) : 0,
            itemsSold: Number(sales.itemsSold || 0),
            discount: Number(sales.discount || 0),
            tax: Number(sales.tax || 0),
            expense: storeExpense,
            net: storeRevenue - storeExpense,
            members: null,
            lowStock: null,
            target,
            targetPercent:
              target > 0
                ? Math.min(Math.round((storeRevenue / target) * 100), 999)
                : null,
            sharePercent:
              revenue > 0 ? Math.round((storeRevenue / revenue) * 1000) / 10 : 0
          }
        })
        .sort((a, b) => b.revenue - a.revenue)

      // Canonical reporting bucket per stored tender (+ UNRECONCILED).
      const byMethod = (paymentMethodRows || []).map((r) => ({
        method: r.method,
        count: r.count,
        amount: Number(r.amount || 0),
        bucket: reportingBucket(r.method)
      }))
      const byTypeMap = {}
      byMethod.forEach((r) => {
        byTypeMap[r.bucket] = byTypeMap[r.bucket] || {
          type: r.bucket,
          count: 0,
          amount: 0
        }
        byTypeMap[r.bucket].count += r.count
        byTypeMap[r.bucket].amount += r.amount
      })
      // Deterministic: amount desc, canonical method order on ties.
      const byType = Object.values(byTypeMap).sort(
        (a, b) =>
          b.amount - a.amount ||
          CANONICAL_METHOD_ORDER[a.type] - CANONICAL_METHOD_ORDER[b.type]
      )

      // Build daily timeline with revenue/expense/inflow/outflow
      const dateMap = {}
      dailySalesRows.forEach((r) => {
        const key = new Date(r.date).toISOString().slice(0, 10)
        dateMap[key] = {
          date: key,
          revenue: Number(r.revenue || 0),
          orders: r.orders,
          itemsSold: Number(r.itemsSold || 0),
          expense: 0,
          inflow: 0,
          outflow: 0
        }
      })
      dailyExpenseRows.forEach((r) => {
        const key = new Date(r.date).toISOString().slice(0, 10)
        dateMap[key] = dateMap[key] || {
          date: key,
          revenue: 0,
          orders: 0,
          itemsSold: 0,
          expense: 0,
          inflow: 0,
          outflow: 0
        }
        dateMap[key].expense = Number(r.outflow || 0)
        dateMap[key].outflow += Number(r.outflow || 0)
      })
      dailyInflowRows.forEach((r) => {
        const key = new Date(r.date).toISOString().slice(0, 10)
        dateMap[key] = dateMap[key] || {
          date: key,
          revenue: 0,
          orders: 0,
          itemsSold: 0,
          expense: 0,
          inflow: 0,
          outflow: 0
        }
        dateMap[key].inflow = Number(r.inflow || 0)
      })
      const apPaymentsInRange = apPaymentsRow.reduce(
        (s, r) => s + Number(r.amount || 0),
        0
      )
      apPaymentsRow.forEach((r) => {
        const key = new Date(r.date).toISOString().slice(0, 10)
        dateMap[key] = dateMap[key] || {
          date: key,
          revenue: 0,
          orders: 0,
          itemsSold: 0,
          expense: 0,
          inflow: 0,
          outflow: 0
        }
        dateMap[key].outflow += Number(r.amount || 0)
      })
      const kpiTrend = Object.values(dateMap).sort((a, b) =>
        a.date < b.date ? -1 : 1
      )

      const apOutstanding = Number(apOutstandingTotals[0]?.outstanding || 0)
      const arOutstanding = Number(arRows[0]?.outstanding || 0)
      const stockVal = stockValueRows[0] || {}
      const production = {}
      productionRows.forEach((r) => {
        production[r.status] = r.count
      })
      const cashRegister = { open: 0, closed: 0, totalSales: 0 }
      cashRegisterRows.forEach((r) => {
        if (r.status === 'open') cashRegister.open = r.count
        else cashRegister.closed = r.count
        cashRegister.totalSales += Number(r.totalSales || 0)
      })

      const growth = (curr, prev) =>
        prev > 0 ? Math.round(((curr - prev) / prev) * 100) : curr > 0 ? 100 : 0

      const lowStockItems = [
        ...(lowStockProducts || []),
        ...(lowStockIngredients || [])
      ].map((r) => ({
        type: r.type,
        id: r.id,
        name: r.name,
        stock: r.stock,
        minStock: r.minStock,
        unit: r.unit,
        store: r.store,
        storeName: storeNameMap[r.store] || 'Semua Toko'
      }))
      const lowStockCount = lowStockProducts.length + lowStockIngredients.length

      const recentPayments = [
        ...(recentInPayments || []),
        ...(recentOutPayments || [])
      ]
        .map((r) => ({
          ...r,
          storeName: storeNameMap[r.store] || null,
          amount: Number(r.amount || 0)
        }))
        .sort(
          (a, b) =>
            new Date(b.date || b.createdAt || 0) -
            new Date(a.date || a.createdAt || 0)
        )
        .slice(0, 10)

      const prevData = prevSalesRow

      return res.status(200).json({
        success: true,
        message: 'Success',
        data: {
          meta: {
            storeId: store || null,
            startDate,
            endDate,
            storeCount: storeList.length
          },
          summary: {
            revenue,
            orders,
            avgOrderValue: orders > 0 ? Math.round(revenue / orders) : 0,
            itemsSold: Number(kpi.itemsSold || 0),
            discount: Number(kpi.discount || 0),
            tax: Number(kpi.tax || 0),
            serviceCharge: Number(kpi.serviceCharge || 0),
            totalExpense,
            netRevenue: revenue - totalExpense,
            netMargin:
              revenue > 0
                ? Math.round(((revenue - totalExpense) / revenue) * 1000) / 10
                : 0,
            totalMembers,
            newMembers,
            activeProducts: 0,
            lowStockCount,
            apOutstanding,
            arOutstanding,
            pendingOrders: 0,
            growth: {
              revenue: growth(revenue, prevData?.prevRevenue),
              orders: growth(orders, prevData?.prevOrders),
              expense: growth(totalExpense, prevData?.prevExpense),
              newMembers: growth(newMembers, prevData?.prevNewMembers)
            }
          },
          kpiTrend,
          storePerformance,
          paymentBreakdown: {
            byMethod,
            byType,
            totalPayments: byMethod.reduce((s, r) => s + r.amount, 0)
          },
          finance: {
            revenue,
            totalExpense,
            netRevenue: revenue - totalExpense,
            netMargin:
              revenue > 0
                ? Math.round(((revenue - totalExpense) / revenue) * 1000) / 10
                : 0,
            discount: Number(kpi.discount || 0),
            tax: Number(kpi.tax || 0),
            ap: {
              outstanding: apOutstanding,
              count: Number(apOutstandingTotals[0]?.count || 0),
              paidInRange: apPaymentsInRange
            },
            ar: {
              outstanding: arOutstanding,
              count: Number(arRows[0]?.count || 0)
            },
            expenseByCategory: (expenseCatRows || []).map((r) => ({
              category: r.category,
              amount: Number(r.amount || 0),
              count: r.count
            })),
            arByCustomer: (arByCustomer || []).map((r) => ({
              customer: r.customer,
              outstanding: Number(r.outstanding || 0),
              count: r.count
            })),
            apOutstandingPOs: (apOutstandingRows || [])
              .slice(0, 10)
              .map((r) => ({
                id: r.id,
                orderNumber: r.orderNumber,
                store: r.store,
                storeName: storeNameMap[r.store] || null,
                finalAmount: Number(r.finalAmount || 0),
                paid: Number(r.paid || 0),
                outstanding: Number(r.finalAmount - r.paid || 0),
                dueDate: r.dueDate
              })),
            cashFlow: kpiTrend.map((d) => ({
              date: d.date,
              inflow: d.inflow + d.revenue,
              outflow: d.outflow + d.expense,
              net: d.inflow + d.revenue - d.outflow - d.expense
            }))
          },
          operations: {
            lowStockCount,
            lowStockItems,
            stockValue:
              Number(stockVal.productValue || 0) +
              Number(stockVal.ingredientValue || 0),
            productStockValue: Number(stockVal.productValue || 0),
            ingredientStockValue: Number(stockVal.ingredientValue || 0),
            production,
            cashRegister,
            queueWaiting: Number(queueRow[0]?.count || 0),
            reservationsToday: Number(reservationRow[0]?.count || 0)
          },
          customers: {
            totalMembers,
            newMembers,
            memberGrowth: growth(newMembers, prevData?.prevNewMembers),
            tierDistribution: (tierRows || []).map((r) => ({
              tier: r.tier,
              count: r.count
            })),
            topMembers: (topMembers || []).map((r) => ({
              id: r.id,
              name: r.name,
              phoneNumber: r.phoneNumber,
              totalSpend: Number(r.totalSpend || 0),
              orderCount: r.orderCount
            }))
          },
          activity: {
            recentOrders: (recentOrders || []).map((r) => ({
              id: r.id,
              orderNumber: r.orderNumber,
              store: r.store,
              storeName: r.storeName || storeNameMap[r.store] || null,
              cashierName: r.cashierName || null,
              totalPrice: Number(r.totalPrice || 0),
              status: r.status,
              paymentMethod: r.paymentMethod,
              createdAt: r.createdAt
            })),
            recentPayments,
            recentAudit: (recentAudit || []).map((r) => ({
              id: r.id,
              action: r.action,
              entity: r.entity,
              entityId: r.entityId,
              description: r.description,
              userName: r.userName,
              storeName: storeNameMap[r.store] || null,
              createdAt: r.createdAt
            }))
          },
          stores: storeList,
          storesWithSales: storePerformance
        }
      })
    } catch (error) {
      console.error('Error super admin dashboard =>', error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  // Product price by store
  async getPriceByStore(req, res) {
    try {
      const { productId } = req.query
      // N-2 (security): tenant store selection. For non-super-admin, the
      // authoritative tenant is req.storeId (pinned by validateStoreAccess);
      // a client-supplied ?storeIds= is never trusted as tenant authority and
      // can, at most, be intersected with the caller's own store.
      let storeIds = req.query.storeIds ? req.query.storeIds.split(',') : []
      if (!isSuperAdmin(req)) {
        const own = Number(req.storeId)
        if (!Number.isFinite(own)) {
          storeIds = []
        } else {
          storeIds = storeIds
            .map((s) => Number(s))
            .filter((s) => Number.isFinite(s) && s === own)
          if (storeIds.length === 0) storeIds = [own]
        }
      }

      if (!productId) {
        return res.status(400).json({
          success: false,
          message: 'productId is required'
        })
      }

      const product = await db.product.findByPk(productId, {
        attributes: ['id', 'nameProduct', 'price']
      })

      if (!product) {
        return res.status(404).json({
          success: false,
          message: 'Product not found'
        })
      }

      const rawPrices =
        storeIds.length > 0
          ? await db.product_store_price.findAll({
              where: {
                product: productId,
                store: storeIds
              },
              include: [
                { model: db.location, as: 'storeData', attributes: ['id', 'name'] }
              ]
            })
          : []

      const storePrices = rawPrices.map((row) => ({
        id: row.id,
        product: row.product,
        store: row.store,
        storeId: row.store,
        storeName: row.storeData?.name ?? null,
        price: row.price
      }))

      return res.status(200).json({
        success: true,
        message: 'Success',
        data: {
          product,
          storePrices
        }
      })
    } catch (error) {
      console.error('Error =>', error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  // Update product price by store
  async updatePriceByStore(req, res) {
    try {
      let { productId, storePrices } = req.body

      if (
        !productId ||
        !storePrices ||
        !Array.isArray(storePrices) ||
        storePrices.length === 0
      ) {
        return res.status(400).json({
          success: false,
          message: 'productId and storePrices array are required'
        })
      }

      // N-2 (security): for non-super-admin, store selection must come from
      // the authoritative req.storeId. Any client-supplied storeId that is
      // not the caller's own store is rejected before any write.
      //
      // C-11: the 'base' sentinel writes the SHARED product.price, which is the
      // fallback checkout price for every store without its own outlet row
      // (W3-1/DR-11: a configured product_store_price row wins at checkout;
      // base applies only when no outlet row exists). A tenant admin
      // therefore must NOT be able to rewrite it — that silently re-prices
      // products at other stores. Restrict base-price writes to super_admin
      // (global scope); tenant admins may only update their own store's
      // product_store_price rows.
      if (!isSuperAdmin(req)) {
        const own = Number(req.storeId)
        const hasBase = storePrices.some((sp) => sp.storeId === 'base')
        const foreign = storePrices.some(
          (sp) => sp.storeId !== 'base' && Number(sp.storeId) !== own
        )
        if (!Number.isFinite(own) || hasBase || foreign) {
          return res.status(403).json({
            success: false,
            message: 'Anda hanya dapat mengakses harga di toko Anda'
          })
        }
      }

      const product = await db.product.findByPk(productId)
      if (!product) {
        return res.status(404).json({
          success: false,
          message: 'Product not found'
        })
      }

      for (const sp of storePrices) {
        if (!Number.isInteger(sp.price) || sp.price < 0 || sp.price > 2147483647 || !Number.isSafeInteger(sp.price)) {
          return res.status(400).json({
            success: false,
            message: 'price must be an integer between 0 and 2147483647'
          })
        }
      }

      const result = await db.sequelize.transaction(async (t) => {
        const priorStorePrices = []
        const baseRow = storePrices.find((sp) => sp.storeId === 'base')
        if (baseRow) {
          priorStorePrices.push({ storeId: 'base', price: product.price })
          await product.update({ price: baseRow.price }, { transaction: t })
        }

        for (const sp of storePrices) {
          if (sp.storeId !== 'base') {
            const existing = await db.product_store_price.findOne({
              where: { product: productId, store: sp.storeId },
              transaction: t
            })
            priorStorePrices.push({
              storeId: sp.storeId,
              price: existing ? existing.price : null
            })
            await db.product_store_price.upsert(
              {
                product: productId,
                store: sp.storeId,
                price: sp.price
              },
              { transaction: t }
            )
          }
        }

        await redactAndAudit(req, {
          action: AUDIT_ACTIONS.UPDATE,
          entity: 'product_price',
          entityId: productId,
          description: 'Updated per-store pricing',
          oldValues: { storePrices: priorStorePrices },
          newValues: { storePrices },
          transaction: t
        })

        return product
      })

      return res.status(200).json({
        success: true,
        message: 'Product prices updated',
        data: result
      })
    } catch (error) {
      console.error('Error =>', error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  // The receipt as WhatsApp text, without sending anything: the FE opens
  // it through wa.me on the cashier's own WhatsApp (app on phone/iPad,
  // Desktop or Web).
  async getInvoiceWhatsAppText(req, res) {
    try {
      const orderId = Number(req.params.orderId)
      if (!Number.isInteger(orderId) || orderId <= 0) {
        return res
          .status(400)
          .json({ success: false, code: 'VALIDATION_ERROR', message: 'Invalid orderId' })
      }
      const loaded = await loadOrderReceiptText(req, orderId)
      if (!loaded) {
        return res
          .status(404)
          .json({ success: false, code: 'ORDER_NOT_FOUND', message: 'Order not found' })
      }
      return res.status(200).json({
        success: true,
        message: 'Success get invoice WhatsApp text',
        data: { orderId, text: loaded.text }
      })
    } catch (error) {
      console.error('Error =>', error)
      return res.status(500).json({
        success: false,
        code: 'INTERNAL_ERROR',
        message: 'Gagal menyiapkan pesan WhatsApp'
      })
    }
  },

  // Send invoice via email
  async sendInvoiceEmail(req, res) {
    try {
      const { orderId, email } = req.body

      if (!orderId || !email) {
        return res.status(400).json({
          success: false,
          message: 'orderId and email are required'
        })
      }

      const emailAttrs = await orderAttrs()
      // N-1 (security): tenant-scoped order load — a foreign order is
      // rejected before any response can leak its details.
      const order = await db.order.findOne({
        where: { id: orderId, ...scalarStoreScope(req) },
        include: [
          { model: db.order_item, as: 'items' },
          { model: db.table, as: 'table' }
        ],
        ...(emailAttrs ? { attributes: emailAttrs } : {})
      })

      if (!order) {
        return res.status(404).json({
          success: false,
          message: 'Order not found'
        })
      }

      // TODO: Implement email service integration
      // For now, return success
      return res.status(200).json({
        success: true,
        message: 'Invoice sent via email',
        data: { orderId, email }
      })
    } catch (error) {
      console.error('Error =>', error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  // Add product batch/expiry
  async addBatch(req, res) {
    try {
      const { productId, batchCode, expiryDate, qty, store } = req.body
      const effectiveStore = store || req.storeId

      if (!productId || !batchCode || !expiryDate || !qty) {
        return res.status(400).json({
          success: false,
          message: 'productId, batchCode, expiryDate, and qty are required'
        })
      }

      const product = await db.product.findByPk(productId)
      if (!product) {
        return res.status(404).json({
          success: false,
          message: 'Product not found'
        })
      }

      // Tenant integrity: a non-super-admin may only add a batch/stock for a
      // product actually assigned to their own store. Without this, a store-a
      // admin could inflate the shared stock of a product that only other
      // stores sell, recording a store-a batch/stock_history for a foreign
      // product. super_admin (global ops) is exempt.
      if (req.user?.roleType !== 'super_admin') {
        const membership = await db.product_store.findOne({
          where: { product: productId, store: effectiveStore },
          paranoid: false
        })
        if (!membership) {
          return res.status(403).json({
            success: false,
            message: 'Product is not assigned to your store'
          })
        }
      }

      const oldStock = Number(product.stock) || 0
      const newStock = oldStock + Number(qty)

      const result = await db.sequelize.transaction(async (t) => {
        await product.update(
          {
            stock: db.sequelize.literal(
              `stock + ${Math.floor(Number(qty)) || 0}`
            )
          },
          { transaction: t }
        )

        const batch = await batchService.addBatchStock({
          productId,
          store: effectiveStore,
          qty,
          batchCode,
          expiryDate,
          supplier: null,
          transaction: t
        })

        await db.stock_history.create(
          {
            product: productId,
            store: effectiveStore,
            referenceType: 'purchase',
            quantityBefore: oldStock,
            quantityChange: qty,
            quantityAfter: newStock,
            unit: product.unit || 'pcs',
            notes: `Batch ${batchCode} added`,
            createdBy: req.user?.id || null
          },
          { transaction: t }
        )

        return {
          product,
          batch: { batchCode, expiryDate, qty, newStock, id: batch?.id }
        }
      })

      return res.status(201).json({
        success: true,
        message: 'Batch added successfully',
        data: result
      })
    } catch (error) {
      console.error('Error =>', error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  // Get product batches
  async getBatches(req, res) {
    try {
      const { productId, store } = req.query

      if (!productId) {
        return res.status(400).json({
          success: false,
          message: 'productId is required'
        })
      }

      const where = { product: productId }
      if (store) {
        where.store = store
      }

      const batches = await db.product_batch.findAll({
        where,
        order: [['expiryDate', 'ASC']]
      })

      return res.status(200).json({
        success: true,
        message: 'Success',
        data: batches
      })
    } catch (error) {
      console.error('Error =>', error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

}

module.exports = posController
