'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// Sweep stage 2 (2026-11-08). Stage 1 (tenant-by-id-sweep) proved path ids;
// it left two gaps: ids sent in the BODY/QUERY were never tried, and 64
// writes were refused by validation (400) before any scope check ran.
//
// Here every route is called by tenant A's owner (store-bound super_admin +
// tenant_admin) and admin with a body built FROM THE ROUTE'S OWN ZOD SCHEMA,
// so it passes validation, where every resource-id key points at a tenant B
// row and every store key at tenant A's own outlet (so validateStoreAccess
// lets it through). A leak is:
//   - changed: any tenant B victim row changed or disappeared;
//   - used:    a new row now references a tenant B victim through a foreign
//              key (an order line with B's product, a payment on B's PO, …);
//   - read:    a GET answered 2xx with tenant B's marker text.
const { z } = require('zod')

jest.mock('../api/middleware/validate', () => {
  const actual = jest.requireActual('../api/middleware/validate')
  return {
    ...actual,
    validate: (schema, source = 'body') => {
      const mw = actual.validate(schema, source)
      mw.__schema = schema
      mw.__source = source
      return mw
    }
  }
})

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const RUN =
  Date.now().toString(36).slice(-5) +
  Math.floor(Math.random() * 1e4).toString(36)
const MARK = `VB${RUN}`
let seq = 0
const mark = () => `${MARK}${(seq++).toString(36)}`

// ---------------------------------------------------------------------------
// Route inventory with each route's validation schema
// ---------------------------------------------------------------------------
const mountOf = (layer) => {
  const m =
    layer.regexp &&
    layer.regexp.source.match(/^\^\\\/(.*?)\\\/\?\(\?=\\\/\|\$\)/)
  return m ? '/' + m[1].replace(/\\\//g, '/').replace(/\\-/g, '-') : ''
}
const listRoutes = () => {
  const out = []
  const walk = (stack, prefix) => {
    for (const l of stack) {
      if (l.route) {
        const v = l.route.stack
          .map((s) => s.handle)
          .find((h) => h && h.__schema)
        for (const method of Object.keys(l.route.methods)) {
          out.push({
            method,
            path: prefix + l.route.path,
            schema: v?.__schema || null,
            source: v?.__source || null
          })
        }
      } else if (l.name === 'router' && l.handle.stack)
        walk(l.handle.stack, prefix + mountOf(l))
    }
  }
  walk(app._router.stack, '')
  return out
}

// Not a tenant resource, unsafe on a shared test DB, or ends the attacker's
// own session (which would make every later call 401).
const SKIP = [
  [/^\w+ \/auth\//, 'authentication/session'],
  [/^\w+ \/backup\//, 'database backup/restore'],
  [/^\w+ \/internal\//, 'internal cron endpoints'],
  [/^\w+ \/assistant\//, 'assistant (503 in tests)'],
  [
    /^\w+ \/memberships\b/,
    'membership administration (covered by membership tests)'
  ],
  [/^\w+ \/tenants\b/, 'tenant administration (covered by tenant tests)'],
  [/^\w+ \/export\//, 'bulk export'],
  [/\/:token\b/, 'public capability token']
]

// ---------------------------------------------------------------------------
// Resource keys → model
// ---------------------------------------------------------------------------
const STORE_KEYS = new Set([
  'store',
  'storeId',
  'location',
  'locationId',
  'stores',
  'storeIds',
  'fromStore',
  'toStore'
])
const KEY_MODEL = {
  order: 'order',
  orderId: 'order',
  product: 'product',
  productId: 'product',
  productItemId: 'product',
  member: 'member',
  memberId: 'member',
  customerId: 'member',
  supplier: 'supplier',
  supplierId: 'supplier',
  table: 'table',
  tableId: 'table',
  ingredient: 'ingredient',
  ingredientId: 'ingredient',
  category: 'category',
  categoryId: 'category',
  purchaseOrder: 'purchase_order',
  purchaseOrderId: 'purchase_order',
  poId: 'purchase_order',
  itemId: 'order_item',
  orderItemId: 'order_item',
  cashRegisterId: 'cashRegister',
  registerId: 'cashRegister',
  bundleId: 'product_bundle',
  campaignId: 'promo_campaign',
  promoCampaignId: 'promo_campaign',
  employeeId: 'user',
  userId: 'user',
  cashierId: 'user',
  departmentId: 'department',
  positionId: 'position',
  driverId: 'driver',
  shiftId: 'shift',
  salesReturnId: 'sales_return',
  goodsReceiptId: 'goodsReceipt',
  splitBillId: 'split_bill',
  expenseCategoryId: 'expense_category',
  accountId: 'account',
  taxConfigId: 'taxConfig',
  typePaymentId: 'type_payment'
}
const norm = (s) => s.toLowerCase().replace(/[-_]/g, '')
const MODELS = Object.keys(db).filter((k) => db[k] && db[k].rawAttributes)
const BY_NORM = Object.fromEntries(MODELS.map((m) => [norm(m), m]))
const PREFIX_MODEL = {
  '/employee/': 'user',
  '/pos/transfer/': 'stock_transfer',
  '/bom/': 'bom_header',
  '/delivery/drivers/': 'driver',
  '/promo/': 'promo_campaign',
  '/inventory/batch/': 'product_batch',
  '/accounting/accounts/': 'account',
  '/accounting/journals/': 'journal_entry',
  '/location/': 'location',
  '/split-bill/': 'split_bill',
  '/parked-cart/': 'parkedCart',
  '/reservation/': 'reservation'
}
const mountModel = (path) => {
  const prefix = Object.keys(PREFIX_MODEL)
    .filter((p) => path.startsWith(p))
    .sort((a, b) => b.length - a.length)[0]
  if (prefix) return PREFIX_MODEL[prefix]
  const mount = path.split('/')[1] || ''
  return BY_NORM[norm(mount)] || BY_NORM[norm(mount).replace(/s$/, '')] || null
}

// ---------------------------------------------------------------------------
// Victim seeding in tenant B (same generic approach as the stage-1 sweep)
// ---------------------------------------------------------------------------
const SCOPE_COLS = ['store', 'storeId', 'location', 'tenantId']
const ARRAY_STORE_MODELS = ['supplier', 'driver']
const TABLE_MODEL = Object.fromEntries(
  MODELS.map((m) => {
    const t = db[m].getTableName()
    return [typeof t === 'string' ? t : t.tableName, m]
  })
)
const tableOf = (m) => {
  const t = db[m].getTableName()
  return typeof t === 'string' ? t : t.tableName
}
const created = []
const victims = {}
const seedErrors = {}
let victimTenant
let victimStore
let victimUser

const valueFor = (name, attr) => {
  const key = attr.type && (attr.type.key || attr.type.constructor?.key)
  if (attr.validate && attr.validate.isEmail)
    return `${mark().toLowerCase()}@sweep.test`
  const isIn = attr.validate && attr.validate.isIn
  if (Array.isArray(isIn) && Array.isArray(isIn[0]))
    return isIn[0].find((v) => v === 'staff') ?? isIn[0][0]
  switch (key) {
    case 'STRING':
    case 'CHAR':
    case 'CITEXT':
      return mark().slice(
        0,
        attr.type.options?.length || attr.type._length || 255
      )
    case 'TEXT':
      return mark()
    case 'INTEGER':
    case 'BIGINT':
    case 'SMALLINT':
    case 'DECIMAL':
    case 'FLOAT':
    case 'DOUBLE':
    case 'REAL':
    case 'NUMBER':
      return 1
    case 'BOOLEAN':
      return false
    case 'TIME':
      return '08:00:00'
    case 'DATE':
    case 'DATEONLY':
      return new Date()
    case 'ENUM':
      return attr.values ? attr.values[0] : attr.type.values?.[0]
    case 'JSON':
    case 'JSONB':
      return {}
    case 'ARRAY':
      return []
    case 'UUID':
      return require('crypto').randomUUID()
    default:
      return undefined
  }
}

async function seed(model, depth = 0) {
  if (victims[model]) return victims[model]
  if (model === 'location') return victimStore
  if (model === 'tenant') return victimTenant
  if (model === 'user') return victimUser
  if (depth > 4) throw new Error(`FK chain too deep at ${model}`)
  const values = {}
  for (const [name, attr] of Object.entries(db[model].rawAttributes)) {
    if (
      attr.primaryKey &&
      (attr.autoIncrement || attr.defaultValue !== undefined)
    )
      continue
    if (['createdAt', 'updatedAt', 'deletedAt'].includes(name)) continue
    if (name === 'tenantId') {
      values[name] = victimTenant.id
      continue
    }
    if (SCOPE_COLS.includes(name)) {
      values[name] = ARRAY_STORE_MODELS.includes(model)
        ? [victimStore.id]
        : victimStore.id
      continue
    }
    const required = attr.allowNull === false && attr.defaultValue === undefined
    if (attr.references) {
      const refTable =
        typeof attr.references.model === 'string'
          ? attr.references.model
          : attr.references.model?.tableName
      const refModel = TABLE_MODEL[refTable]
      if (refModel === 'location') values[name] = victimStore.id
      else if (refModel === 'tenant') values[name] = victimTenant.id
      else if (refModel === 'user') values[name] = victimUser.id
      else if (
        refModel &&
        (required ||
          ['order', 'product', 'supplier', 'member'].includes(refModel))
      )
        values[name] = (await seed(refModel, depth + 1)).id
      continue
    }
    if (required) values[name] = valueFor(name, attr)
    else if (
      /^(name|nameProduct|title|description|notes|fullName|productName|customerName)$/.test(
        name
      )
    ) {
      const v = valueFor(name, attr)
      if (typeof v === 'string') values[name] = v
    }
  }
  const row = await db[model].create(values, { hooks: false })
  created.push([model, row.id])
  victims[model] = row
  if (model === 'product')
    created.push([
      'product_store',
      (
        await db.product_store.create({
          product: row.id,
          store: victimStore.id
        })
      ).id
    ])
  if (model === 'category' && db.category_store)
    created.push([
      'category_store',
      (
        await db.category_store.create({
          category: row.id,
          store: victimStore.id
        })
      ).id
    ])
  return row
}

const trySeed = async (model) => {
  if (!model || !db[model]) return null
  try {
    return await seed(model)
  } catch (e) {
    seedErrors[model] = String(e.message || e).slice(0, 160)
    return null
  }
}

// One query: a hash of every victim row (changed/deleted detection).
const victimState = async () => {
  const parts = Object.entries(victims).map(
    ([m, row]) =>
      `SELECT '${m}' AS m, (SELECT md5(row_to_json(t)::text) FROM "${tableOf(m)}" t WHERE t.id = ${Number(row.id)}) AS h`
  )
  if (!parts.length) return {}
  const [rows] = await db.sequelize.query(parts.join(' UNION ALL '))
  return Object.fromEntries(rows.map((r) => [r.m, r.h]))
}

// Foreign keys (in any table) that can point at a victim row.
let fkPairs = null
const buildFkPairs = () => {
  fkPairs = []
  for (const m of MODELS) {
    for (const [col, attr] of Object.entries(db[m].rawAttributes)) {
      if (!attr.references) continue
      const refTable =
        typeof attr.references.model === 'string'
          ? attr.references.model
          : attr.references.model?.tableName
      const refModel = TABLE_MODEL[refTable]
      if (!refModel || ['location', 'tenant', 'user'].includes(refModel))
        continue
      fkPairs.push({ table: tableOf(m), col: attr.field || col, refModel })
    }
  }
}
// One query: how many rows reference each victim through any foreign key.
const referenceState = async () => {
  const parts = fkPairs
    .filter((p) => victims[p.refModel])
    .map(
      (p) =>
        `SELECT '${p.table}.${p.col}' AS k, (SELECT COUNT(*)::int FROM "${p.table}" WHERE "${p.col}" = ${Number(victims[p.refModel].id)}) AS n`
    )
  if (!parts.length) return {}
  const [rows] = await db.sequelize.query(parts.join(' UNION ALL '))
  return Object.fromEntries(rows.map((r) => [r.k, r.n]))
}

// ---------------------------------------------------------------------------
// Body generation from the route's zod schema
// ---------------------------------------------------------------------------
const sampleFrom = (js, key, ctx) => {
  if (key && STORE_KEYS.has(key))
    return /s$/.test(key) && key !== 'store'
      ? [ctx.attackerStore]
      : ctx.attackerStore
  if (key && KEY_MODEL[key] && ctx.ids[KEY_MODEL[key]] != null)
    return ctx.ids[KEY_MODEL[key]]
  if (key === 'id' && ctx.idModel && ctx.ids[ctx.idModel] != null)
    return ctx.ids[ctx.idModel]
  if (!js || typeof js !== 'object') return 1
  if (js.enum) return js.enum[0]
  if (js.const !== undefined) return js.const
  const branch = js.anyOf || js.oneOf
  if (branch)
    return sampleFrom(
      branch.find((b) => b.type !== 'null') || branch[0],
      key,
      ctx
    )
  switch (js.type) {
    case 'object': {
      const o = {}
      for (const [k, v] of Object.entries(js.properties || {}))
        o[k] = sampleFrom(v, k, ctx)
      return o
    }
    case 'array':
      return Array.from({ length: Math.max(1, js.minItems || 1) }, () =>
        sampleFrom(js.items || {}, null, ctx)
      )
    case 'string':
      if (js.format === 'email') return `${mark().toLowerCase()}@sweep.test`
      if (js.format === 'date-time' || js.format === 'date')
        return new Date().toISOString().slice(0, js.format === 'date' ? 10 : 24)
      return ('SWEEP' + mark())
        .padEnd(js.minLength || 1, 'x')
        .slice(0, js.maxLength || 60)
    case 'number':
    case 'integer':
      return Math.max(1, js.minimum ?? js.exclusiveMinimum ?? 1)
    case 'boolean':
      return false
    default:
      return 1
  }
}
const bodyFor = (route, ctx) => {
  if (!route.schema)
    return {
      id: ctx.ids[ctx.idModel],
      name: 'SWEEP_HACKED',
      store: ctx.attackerStore
    }
  let js
  try {
    js = z.toJSONSchema(route.schema, { unrepresentable: 'any', io: 'input' })
  } catch {
    js = null
  }
  return sampleFrom(js, null, ctx)
}

// ---------------------------------------------------------------------------
// Attackers in tenant A
// ---------------------------------------------------------------------------
const attackers = {}
const attackerUsers = []
let attackerTenant
let attackerStore

beforeAll(async () => {
  victimTenant = await db.tenant.create({
    code: `V${RUN}`.toUpperCase(),
    name: `${MARK}-VT`
  })
  attackerTenant = await db.tenant.create({
    code: `A${RUN}`.toUpperCase(),
    name: `SWEEP2-AT-${RUN}`
  })
  victimStore = await db.location.create({
    name: `${MARK}-VS`,
    status: 'active',
    tenantId: victimTenant.id
  })
  attackerStore = await db.location.create({
    name: `SWEEP2-AS-${RUN}`,
    status: 'active',
    tenantId: attackerTenant.id
  })
  victimUser = await db.user.create({
    userName: `${MARK}vu`.toLowerCase(),
    email: `${MARK}vu@sweep.test`.toLowerCase(),
    roleType: 'admin',
    userType: 'admin',
    status: 'active',
    store: victimStore.id,
    fullName: `${MARK}-VU`
  })
  const owner = await db.user.create({
    userName: `sweep2_owner_${RUN}`,
    email: `sweep2_owner_${RUN}@sweep.test`,
    roleType: 'super_admin',
    userType: 'admin',
    status: 'active',
    store: attackerStore.id
  })
  await db.tenantMembership.create({
    userId: owner.id,
    tenantId: attackerTenant.id,
    role: 'tenant_admin',
    status: 'ACTIVE'
  })
  const admin = await db.user.create({
    userName: `sweep2_admin_${RUN}`,
    email: `sweep2_admin_${RUN}@sweep.test`,
    roleType: 'admin',
    userType: 'admin',
    status: 'active',
    store: attackerStore.id
  })
  attackerUsers.push(owner.id, admin.id)
  attackers.owner = await signSessionToken(
    {
      id: owner.id,
      userName: owner.userName,
      roleType: 'super_admin',
      store: attackerStore.id
    },
    JWT_SECRET
  )
  attackers.admin = await signSessionToken(
    {
      id: admin.id,
      userName: admin.userName,
      roleType: 'admin',
      store: attackerStore.id
    },
    JWT_SECRET
  )
  buildFkPairs()
}, 60000)

afterAll(async () => {
  // The generated bodies make the app create rows (registers, movements,
  // orders, …) in the attacker's and the victim's outlets; remove every row
  // tied to either outlet (two passes for FK order), then the seeded
  // victims, then users and outlets. Cleanup never fails the suite.
  const stores = [victimStore?.id, attackerStore?.id].filter(Boolean)
  const users = [...attackerUsers, victimUser?.id].filter(Boolean)
  const quiet = async (fn) => {
    try {
      await fn()
    } catch {}
  }
  const orderIds = (
    await db.order.findAll({
      where: { store: stores },
      attributes: ['id'],
      paranoid: false
    })
  ).map((o) => o.id)
  for (const [m, where] of [
    ['transaction', { order: orderIds }],
    ['order_item', { order: orderIds }],
    ['order_status', { order: orderIds }]
  ]) {
    await quiet(() => db[m].destroy({ where, force: true, hooks: false }))
  }
  for (let pass = 0; pass < 2; pass++) {
    for (const m of MODELS) {
      if (['location', 'tenant', 'user'].includes(m)) continue
      const attrs = db[m].rawAttributes
      const col = attrs.store ? 'store' : attrs.storeId ? 'storeId' : null
      if (col && !['JSONB', 'JSON'].includes(attrs[col].type.key))
        await quiet(() =>
          db[m].destroy({ where: { [col]: stores }, force: true, hooks: false })
        )
      for (const uc of ['userId', 'cashierId', 'openedBy', 'closedBy']) {
        if (attrs[uc]?.references)
          await quiet(() =>
            db[m].destroy({ where: { [uc]: users }, force: true, hooks: false })
          )
      }
    }
  }
  for (const [model, id] of [...created].reverse())
    await quiet(() =>
      db[model].destroy({ where: { id }, force: true, hooks: false })
    )
  await quiet(() =>
    db.tenantMembership.destroy({
      where: { userId: attackerUsers },
      force: true
    })
  )
  await quiet(() =>
    db.authorizationContextSession.destroy({ where: { userId: users } })
  )
  for (const u of users)
    await quiet(() => db.user.destroy({ where: { id: u }, force: true }))
  for (const st of stores)
    await quiet(() => db.location.destroy({ where: { id: st }, force: true }))
  await quiet(() =>
    db.tenant.destroy({
      where: { id: [victimTenant?.id, attackerTenant?.id].filter(Boolean) },
      force: true
    })
  )
}, 300000)

// Leaks found by the first run of this sweep. Each fix removes its entries;
// the test fails on any leak NOT listed and on any listed entry that no
// longer leaks.
const KNOWN_LEAKS = new Set([
  'get /audit-log/ owner',
  'get /inventory/expiring-soon admin',
  'get /inventory/expiring-soon owner',
  'get /inventory/valuation admin',
  'get /inventory/valuation owner',
  'get /location/get-location-public admin',
  'get /location/get-location-public owner',
  'get /pos/dashboard/super-admin owner',
  'get /pos/product/price-by-store admin',
  'get /pos/product/price-by-store owner',
  'get /pos/tables/status admin',
  'get /pos/tables/status owner',
  'get /purchase-order/get-all owner',
  'get /regions/regions admin',
  'get /regions/regions owner',
  'get /report-config/ admin',
  'get /report-config/ owner',
  'get /supplier-bank-account/supplier/:supplierId owner',
  'get /supplier-contact/supplier/:supplierId owner',
  'get /supplier/compare admin',
  'get /supplier/compare owner',
  'post /inventory/forecast/run owner'
])

const results = []
const uncovered = []

describe('tenant body/query-id sweep (stage 2)', () => {
  test("no route lets tenant A read, change or reference tenant B's rows through body or query ids", async () => {
    // Seed one victim per model that any body key or mount can point at.
    const wanted = new Set(Object.values(KEY_MODEL))
    for (const r of listRoutes()) {
      const m = mountModel(r.path)
      if (m) wanted.add(m)
    }
    for (const m of wanted) await trySeed(m)

    for (const route of listRoutes()) {
      const key = `${route.method} ${route.path}`
      const skip = SKIP.find(([re]) => re.test(key))
      if (skip) {
        uncovered.push({ route: key, why: skip[1] })
        continue
      }
      const idModel = mountModel(route.path)

      for (const [who, token] of Object.entries(attackers)) {
        // Re-seed anything an earlier leak consumed.
        for (const m of wanted) if (!victims[m]) await trySeed(m)
        const ids = Object.fromEntries(
          Object.entries(victims).map(([m, r]) => [m, r.id])
        )
        const ctx = { ids, idModel, attackerStore: attackerStore.id }
        let url = route.path.replace(/:([A-Za-z]+)/g, (_, p) =>
          String(ids[KEY_MODEL[p] || (p === 'id' ? idModel : null)] ?? 1)
        )
        const payload = bodyFor(route, ctx)

        const beforeRows = await victimState()
        const beforeRefs = await referenceState()
        let req = request(app)
          [route.method](url)
          .set('Authorization', `Bearer ${token}`)
        if (route.method === 'get') {
          const qs =
            route.source === 'query'
              ? payload
              : {
                  id: ids[idModel],
                  store: attackerStore.id,
                  ...Object.fromEntries(
                    Object.entries(KEY_MODEL)
                      .filter(([, m]) => ids[m] != null)
                      .map(([k, m]) => [k, ids[m]])
                  )
                }
          req = req.query(qs)
        } else req = req.send(payload)
        let res
        try {
          res = await req
        } catch (e) {
          res = { status: 0, body: { error: String(e.message || e) } }
        }
        const afterRows = await victimState()
        const afterRefs = await referenceState()

        const changed = Object.keys(beforeRows).filter(
          (m) => beforeRows[m] !== afterRows[m]
        )
        const used = Object.keys(afterRefs).filter(
          (k) => (afterRefs[k] || 0) > (beforeRefs[k] || 0)
        )
        const read =
          route.method === 'get' &&
          res.status >= 200 &&
          res.status < 300 &&
          JSON.stringify(res.body ?? null).includes(MARK)
        const leak = changed.length
          ? `changed:${changed.join(',')}`
          : used.length
            ? `used:${used.join(',')}`
            : read
              ? 'read'
              : null
        results.push({
          route: key,
          who,
          status: res.status,
          leak,
          validated: !!route.schema
        })
        for (const m of changed) delete victims[m]
      }
    }

    const leaks = results.filter((r) => r.leak)
    if (process.env.SWEEP_REPORT) {
      const statuses = {}
      for (const r of results)
        statuses[r.status] = (statuses[r.status] || 0) + 1
      require('fs').writeFileSync(
        process.env.SWEEP_REPORT,
        JSON.stringify(
          {
            leaks,
            uncovered,
            seedErrors,
            calls: results.length,
            statuses,
            results
          },
          null,
          2
        )
      )
    }
    const seen = new Set(leaks.map((l) => `${l.route} ${l.who}`))
    expect(
      leaks.filter((l) => !KNOWN_LEAKS.has(`${l.route} ${l.who}`))
    ).toEqual([])
    expect([...KNOWN_LEAKS].filter((k) => !seen.has(k))).toEqual([])
  }, 1800000)
})
