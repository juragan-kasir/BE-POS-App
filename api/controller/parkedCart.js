const db = require('../../db/models')
const { Op } = require('sequelize')
const { redactAndAudit, AUDIT_ACTIONS } = require('../../utils/auditLog')
const { withDeadlockRetry } = require('../../utils/deadlockRetry')
const { scalarStoreScope } = require('../../utils/tenantScope')

const DEFAULT_MAX_ACTIVE_PARKED_CARTS = 20
const DEFAULT_PARKED_CART_TTL_MINUTES = 120
const MAX_PARKED_CART_TTL_MINUTES = 1440

// NOTE: the former cookie-fallback getStore helper was removed — store scope
// comes from middleware-resolved req.storeId only, so a stale activeStore
// cookie can never silently scope or relocate parked carts.
function resolveCap(location) {
  const raw = location?.maxActiveParkedCarts
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_ACTIVE_PARKED_CARTS
}

function resolveTtlMinutes(location) {
  const raw = location?.parkedCartTtlMinutes
  const ttl = Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_PARKED_CART_TTL_MINUTES
  return Math.min(ttl, MAX_PARKED_CART_TTL_MINUTES)
}

// Canonical expiration definition: NOW() >= expiresAt. The physical
// `status` column is allowed to remain 'active' past this point
// indefinitely (lazy expiration, no scheduler dependency) — every
// API-facing response instead exposes this computed value, never a
// passthrough of the raw column.
function computeEffectiveStatus(row, now) {
  if (row.status === 'active' && new Date(row.expiresAt) <= now) return 'expired'
  return row.status
}

function serializeParkedCart(row, now) {
  const plain = typeof row.toJSON === 'function' ? row.toJSON() : row
  return { ...plain, status: computeEffectiveStatus(plain, now) }
}

function computeDisplayTotals(items, orderDiscount = 0) {
  const displayTotalItems = items.reduce((sum, item) => sum + (Number(item?.count) || 0), 0)
  const linesTotal = items.reduce((sum, item) => sum + (Number(item?.totalPrice) || 0), 0)
  // An order-level discount (retail) lowers the shown total, never below 0.
  const displayTotalPrice = Math.max(0, linesTotal - (Number(orderDiscount) || 0))
  return { displayTotalItems, displayTotalPrice }
}

// Same-key idempotent-replay check — used by both the fast path (before
// the transaction) and the unique-constraint-race catch block, so a
// genuinely concurrent duplicate-payload retry and a sequential one
// resolve identically.
// Postgres JSONB does not preserve key insertion order — a value read
// back from the `cartPayload` column can have different key ordering
// than the freshly-parsed request body even when every field is
// identical, so a plain JSON.stringify comparison would false-positive
// as "different". Sorting keys recursively before stringifying makes the
// comparison order-independent without any hashing/deep-equal
// dependency.
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

function payloadMatches(existing, incoming) {
  return (
    (existing.tableId ?? null) === (incoming.tableId ?? null) &&
    (existing.customerId ?? null) === (incoming.customerId ?? null) &&
    (existing.discountId ?? null) === (incoming.discountId ?? null) &&
    (existing.promoCode ?? null) === (incoming.promoCode ?? null) &&
    canonicalJSON(existing.cartPayload) === canonicalJSON(incoming.cart)
  )
}

const parkedCartController = {
  async create(req, res) {
    try {
      // Explicit selection only: a stale activeStore cookie must not
      // silently park the cart in the wrong store (used to bypass the 400).
      const store = req.storeId
      const {
        tableId,
        customerId,
        customerName,
        customerPhone,
        discountId,
        promoCode,
        notes,
        cart,
        idempotencyKey
      } = req.body

      if (!store) {
        return res.status(400).json({ success: false, message: 'Store not selected' })
      }

      // Semantic validation deliberately NOT expressed in the Zod schema
      // (see schemas.js comment) — every ZodError resolves to 400, but
      // an empty cart must be 422 per the F3 API contract.
      if (!Array.isArray(cart?.items) || cart.items.length === 0) {
        return res.status(422).json({ success: false, message: 'cart.items must not be empty' })
      }

      // Table/store integrity: no DB-level FK exists between table.store
      // and location — controller-level validation only, reusing the
      // same scoped-lookup shape as order.js's checkTableAvailable. A
      // failed check produces zero parked-cart side effects (this runs
      // before the transaction opens). table.status is never read/written.
      if (tableId) {
        const table = await db.table.findOne({ where: { id: tableId, store } })
        if (!table) {
          return res.status(404).json({ success: false, message: 'Table not found for this store' })
        }
      }

      const { displayTotalItems, displayTotalPrice } = computeDisplayTotals(cart.items, cart.orderDiscount)

      // Fast-path idempotency check, outside the transaction — mirrors
      // order.create/cashMovement.createMovement exactly. Same key +
      // identical payload replays the original; same key + different
      // payload is a 409, never silently returns stale/wrong data.
      if (idempotencyKey) {
        const existing = await db.parkedCart.findOne({ where: { store, idempotencyKey } })
        if (existing) {
          if (payloadMatches(existing, { tableId, customerId, discountId, promoCode, cart })) {
            return res.status(200).json({
              success: true,
              message: 'Parked cart already recorded',
              data: serializeParkedCart(existing, new Date())
            })
          }
          return res.status(409).json({
            success: false,
            message: 'idempotencyKey already used with a different payload'
          })
        }
      }

      let created
      try {
        created = await withDeadlockRetry(() =>
          db.sequelize.transaction(async (t) => {
            // Bare-column lock only — no `include` — same Postgres
            // FOR-UPDATE-vs-outer-join constraint F2 hit in close().
            // This lock is the sole enforcement mechanism for the cap,
            // not an optimization: it serializes every concurrent create
            // for this store so the count-then-insert decision can never
            // be interleaved.
            const location = await db.location.findByPk(store, {
              attributes: ['id', 'maxActiveParkedCarts', 'parkedCartTtlMinutes'],
              transaction: t,
              lock: t.LOCK.UPDATE
            })

            const now = new Date()
            const cap = resolveCap(location)
            const ttlMinutes = resolveTtlMinutes(location)

            // Canonical "active" predicate — identical in shape to
            // list()'s and the resume/cancel CAS's. Compared against
            // literal SQL NOW() (the database's own clock), not the app
            // server's Date.now() — this is a concurrency-safety decision
            // (it gates the cap), not a display concern, so it must not
            // depend on app-server/DB clock drift.
            const activeCount = await db.parkedCart.count({
              where: {
                store,
                status: 'active',
                expiresAt: { [Op.gt]: db.sequelize.literal('NOW()') }
              },
              transaction: t
            })
            if (activeCount >= cap) {
              const e = new Error('Active parked cart limit reached for this store')
              e.statusCode = 409
              throw e
            }

            const expiresAt = new Date(now.getTime() + ttlMinutes * 60000)

            const row = await db.parkedCart.create(
              {
                store,
                createdBy: req.user?.id || null,
                tableId: tableId || null,
                customerId: customerId || null,
                customerName: customerName || null,
                customerPhone: customerPhone || null,
                discountId: discountId || null,
                promoCode: promoCode || null,
                notes: notes || null,
                cartPayload: cart,
                displayTotalItems,
                displayTotalPrice,
                status: 'active',
                expiresAt,
                idempotencyKey: idempotencyKey || null
              },
              { transaction: t }
            )

            await redactAndAudit(req, {
              action: AUDIT_ACTIONS.CREATE,
              entity: 'parked_cart',
              entityId: row.id,
              description: `Parked cart for store ${store}`,
              newValues: row,
              transaction: t
            })

            return row
          })
        )
      } catch (error) {
        if (error.name === 'SequelizeUniqueConstraintError' && idempotencyKey) {
          const existing = await db.parkedCart.findOne({ where: { store, idempotencyKey } })
          if (existing) {
            if (payloadMatches(existing, { tableId, customerId, discountId, promoCode, cart })) {
              return res.status(200).json({
                success: true,
                message: 'Parked cart already recorded',
                data: serializeParkedCart(existing, new Date())
              })
            }
            return res.status(409).json({
              success: false,
              message: 'idempotencyKey already used with a different payload'
            })
          }
        }
        throw error
      }

      return res.status(201).json({
        success: true,
        message: 'Cart parked',
        data: serializeParkedCart(created, new Date())
      })
    } catch (error) {
      console.log(error)
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Internal server error'
      })
    }
  },

  async list(req, res) {
    try {
      // Same cookie rule as create(): global super_admin stays unscoped.
      const store = req.storeId
      const isSuperAdmin = req.user?.roleType === 'super_admin'

      if (!store && !isSuperAdmin) {
        return res.status(400).json({ success: false, message: 'Store not selected' })
      }

      const { status = 'active', page = 1, limit = 50 } = req.query
      const now = new Date()

      let statusWhere
      if (status === 'active') {
        statusWhere = { status: 'active', expiresAt: { [Op.gt]: now } }
      } else if (status === 'expired') {
        statusWhere = {
          [Op.or]: [
            { status: 'expired' },
            { status: 'active', expiresAt: { [Op.lte]: now } }
          ]
        }
      } else if (status === 'resumed' || status === 'cancelled') {
        statusWhere = { status }
      } else {
        return res.status(400).json({ success: false, message: 'Invalid status filter' })
      }

      const baseWhere = store ? { ...statusWhere, store } : statusWhere
      const where = scalarStoreScope(req, baseWhere)

      const offset = (parseInt(page) - 1) * parseInt(limit)
      const { count, rows } = await db.parkedCart.findAndCountAll({
        where,
        include: [{ model: db.table, as: 'table', attributes: ['id', 'name'] }],
        order: [['createdAt', 'DESC']],
        limit: parseInt(limit),
        offset
      })

      return res.status(200).json({
        success: true,
        message: 'Success get parked carts',
        data: rows.map((row) => serializeParkedCart(row, now)),
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / parseInt(limit))
        }
      })
    } catch (error) {
      console.log(error)
      return res.status(500).json({ success: false, message: 'Internal server error' })
    }
  },

  async getOne(req, res) {
    try {
      const { id } = req.params
      const now = new Date()

      const row = await db.parkedCart.findOne({
        where: scalarStoreScope(req, { id }),
        include: [{ model: db.table, as: 'table', attributes: ['id', 'name'] }]
      })
      if (!row) {
        return res.status(404).json({ success: false, message: 'Parked cart not found' })
      }

      return res.status(200).json({
        success: true,
        message: 'Success get parked cart',
        data: serializeParkedCart(row, now)
      })
    } catch (error) {
      console.log(error)
      return res.status(500).json({ success: false, message: 'Internal server error' })
    }
  },

  // POST /parked-cart/:id/resume
  //
  // Atomic CAS: UPDATE ... WHERE status='active' AND expiresAt>NOW() ...
  // RETURNING *. Postgres locks any row it is about to update for the
  // duration of the transaction — a second concurrent resume/cancel
  // targeting the same row blocks until the first commits, then
  // re-evaluates its own WHERE clause against the now-committed row and
  // matches zero rows. Only one transition can ever win. On zero rows, a
  // single read-only diagnostic SELECT (no status/expiry predicate)
  // distinguishes 404 (nonexistent/cross-store) from 409 (exists but no
  // longer eligible) — it performs no write and conditions no subsequent
  // write, so it cannot introduce a race; the CAS above already finalized
  // the outcome.
  async resume(req, res) {
    try {
      const { id } = req.params
      const now = new Date()

      const result = await withDeadlockRetry(() =>
        db.sequelize.transaction(async (t) => {
          const [affectedCount, affectedRows] = await db.parkedCart.update(
            { status: 'resumed', resumedBy: req.user?.id || null, resumedAt: now },
            {
              // Compared against literal SQL NOW(), not the app server's
              // clock — this predicate IS the concurrency decision (it's
              // what makes an expired-but-unswept row un-resumable), so
              // it must use the database's own notion of "now".
              where: scalarStoreScope(req, {
                id,
                status: 'active',
                expiresAt: { [Op.gt]: db.sequelize.literal('NOW()') }
              }),
              returning: true,
              transaction: t
            }
          )

          if (affectedCount === 0) {
            const existing = await db.parkedCart.findOne({
              where: scalarStoreScope(req, { id }),
              transaction: t
            })
            if (!existing) {
              const e = new Error('Parked cart not found')
              e.statusCode = 404
              throw e
            }
            const e = new Error('Parked cart is no longer active')
            e.statusCode = 409
            throw e
          }

          const resumed = affectedRows[0]

          await redactAndAudit(req, {
            action: AUDIT_ACTIONS.STATUS_CHANGE,
            entity: 'parked_cart',
            entityId: resumed.id,
            description: 'Parked cart resumed',
            oldValues: { status: 'active' },
            newValues: { status: 'resumed' },
            transaction: t
          })

          // Plain read, no lock — attaches the table name for the FE's
          // rehydration/display convenience. Safe to run after the CAS
          // already committed the transition inside this same
          // transaction; it changes no decision.
          return db.parkedCart.findByPk(resumed.id, {
            include: [{ model: db.table, as: 'table', attributes: ['id', 'name'] }],
            transaction: t
          })
        })
      )

      return res.status(200).json({
        success: true,
        message: 'Parked cart resumed',
        data: serializeParkedCart(result, now)
      })
    } catch (error) {
      console.log(error)
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Internal server error'
      })
    }
  },

  // POST /parked-cart/:id/cancel — same atomic-CAS/diagnostic-read shape
  // as resume(), targeting 'cancelled' instead.
  async cancel(req, res) {
    try {
      const { id } = req.params
      const now = new Date()

      const result = await withDeadlockRetry(() =>
        db.sequelize.transaction(async (t) => {
          const [affectedCount, affectedRows] = await db.parkedCart.update(
            { status: 'cancelled', cancelledBy: req.user?.id || null, cancelledAt: now },
            {
              // Same DB-NOW()-based predicate as resume() — this is the
              // concurrency decision, not a display concern.
              where: scalarStoreScope(req, {
                id,
                status: 'active',
                expiresAt: { [Op.gt]: db.sequelize.literal('NOW()') }
              }),
              returning: true,
              transaction: t
            }
          )

          if (affectedCount === 0) {
            const existing = await db.parkedCart.findOne({
              where: scalarStoreScope(req, { id }),
              transaction: t
            })
            if (!existing) {
              const e = new Error('Parked cart not found')
              e.statusCode = 404
              throw e
            }
            const e = new Error('Parked cart is no longer active')
            e.statusCode = 409
            throw e
          }

          const cancelled = affectedRows[0]

          await redactAndAudit(req, {
            action: AUDIT_ACTIONS.STATUS_CHANGE,
            entity: 'parked_cart',
            entityId: cancelled.id,
            description: 'Parked cart cancelled',
            oldValues: { status: 'active' },
            newValues: { status: 'cancelled' },
            transaction: t
          })

          return cancelled
        })
      )

      return res.status(200).json({
        success: true,
        message: 'Parked cart cancelled',
        data: serializeParkedCart(result, now)
      })
    } catch (error) {
      console.log(error)
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Internal server error'
      })
    }
  }
}

module.exports = parkedCartController
