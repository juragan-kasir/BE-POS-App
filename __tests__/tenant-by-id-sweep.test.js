'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// Wave 4 (product-grade audit 2026-11-02, MULTI-TENANT-SECURITY-REPORT
// acceptance #2/#3): every route that takes a resource id in its path is
// called by tenant A's owner (store-bound super_admin + tenant_admin) and
// tenant A's admin with an id that belongs to tenant B. A GET must not
// return tenant B's row; a write must not change or delete it.
//
// Routes are read from the live Express router, so a new by-id route is
// swept automatically. A route whose id cannot be mapped to a model is
// listed as uncovered (see the coverage test), never silently passed.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const RUN =
  Date.now().toString(36).slice(-5) +
  Math.floor(Math.random() * 1e4).toString(36)
const MARK = `VX${RUN}`
let seq = 0
const mark = () => `${MARK}${(seq++).toString(36)}`

// ---------------------------------------------------------------------------
// Route inventory
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
        for (const method of Object.keys(l.route.methods))
          out.push({ method, path: prefix + l.route.path })
      } else if (l.name === 'router' && l.handle.stack)
        walk(l.handle.stack, prefix + mountOf(l))
    }
  }
  walk(app._router.stack, '')
  return out.filter((r) => r.path.includes('/:'))
}

// ---------------------------------------------------------------------------
// Which model a path id points at
// ---------------------------------------------------------------------------
const norm = (s) => s.toLowerCase().replace(/[-_]/g, '')
const MODELS = Object.keys(db).filter((k) => db[k] && db[k].rawAttributes)
const BY_NORM = Object.fromEntries(MODELS.map((m) => [norm(m), m]))

// Longest prefix wins. Values are model names, or null = deliberately not swept.
const PREFIX_MODEL = {
  '/memberships/': 'tenantMembership',
  '/employee/': 'user',
  '/pos/transfer/': 'stock_transfer',
  '/pos/purchase-order/': 'purchase_order',
  '/pos/order/': 'order',
  '/pos/member/': 'member',
  '/pos/tables/': 'table',
  '/pos/invoice/wa-text/': 'order',
  '/receipt/order/': 'order',
  '/bom/': 'bom_header',
  '/delivery/orders/': 'order',
  '/delivery/drivers/': 'driver',
  '/promo/campaigns/': 'promo_campaign',
  '/inventory/batch/': 'product_batch',
  '/backup/': 'db_backup',
  '/accounting/accounts/': 'account',
  '/accounting/journals/': 'journal_entry',
  '/location/': 'location',
  '/assistant/stores/': 'location'
}
const PARAM_MODEL = {
  supplierId: 'supplier',
  poId: 'purchase_order',
  productId: 'product',
  orderId: 'order',
  storeId: 'location',
  locationId: 'location',
  employeeID: 'user',
  departmentId: 'department'
}
// Not an id of a tenant row, or not safe to fire at a shared test DB.
const SKIP = [
  [/^post \/backup\/restore\//, 'restores a database backup'],
  [/\/:token\b/, 'public capability token, not a row id'],
  [/\/:key\b/, 'report key, not a row id'],
  [/\/:code\b/, 'code lookup, not a row id'],
  [/\/:entity\b/, 'audit entity name, not a row id'],
  [
    /\/:phoneNumber\b/,
    'phone-number lookup (member scope covered by member routes)'
  ]
]

const modelFor = (route, param) => {
  if (PARAM_MODEL[param]) return PARAM_MODEL[param]
  const prefix = Object.keys(PREFIX_MODEL)
    .filter((p) => route.path.startsWith(p))
    .sort((a, b) => b.length - a.length)[0]
  if (prefix) return PREFIX_MODEL[prefix]
  const mount = route.path.split('/')[1]
  return BY_NORM[norm(mount)] || BY_NORM[norm(mount).replace(/s$/, '')] || null
}

// ---------------------------------------------------------------------------
// Generic victim seeding in tenant B
// ---------------------------------------------------------------------------
const SCOPE_COLS = ['store', 'storeId', 'location', 'tenantId']
const ARRAY_STORE_MODELS = ['supplier', 'driver']
const TABLE_MODEL = Object.fromEntries(
  MODELS.map((m) => {
    const t = db[m].getTableName()
    return [typeof t === 'string' ? t : t.tableName, m]
  })
)
const created = [] // [model, id] in creation order
const victims = {} // model -> row
const seedErrors = {}
let victimTenant
let victimStore
let victimUser

const valueFor = (name, attr) => {
  const key = attr.type && (attr.type.key || attr.type.constructor?.key)
  if (attr.validate && attr.validate.isEmail)
    return `${mark().toLowerCase()}@sweep.test`
  const isIn = attr.validate && attr.validate.isIn
  if (Array.isArray(isIn) && Array.isArray(isIn[0])) {
    // Prefer an ordinary tenant role over a platform-wide one.
    return isIn[0].find((v) => v === 'staff') ?? isIn[0][0]
  }
  switch (key) {
    case 'STRING':
    case 'CHAR':
    case 'CITEXT': {
      const len = attr.type.options?.length || attr.type._length || 255
      return mark().slice(0, len)
    }
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
  const attrs = db[model].rawAttributes
  const values = {}
  for (const [name, attr] of Object.entries(attrs)) {
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
      // supplier and driver keep `store` as a JSONB array of outlet ids
      // (see nullableArrayStoreScope); every other model stores a scalar.
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
      ) {
        values[name] = (await seed(refModel, depth + 1)).id
      }
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
  if (model === 'product') {
    const ps = await db.product_store.create({
      product: row.id,
      store: victimStore.id
    })
    created.push(['product_store', ps.id])
  }
  if (model === 'category' && db.category_store) {
    const cs = await db.category_store.create({
      category: row.id,
      store: victimStore.id
    })
    created.push(['category_store', cs.id])
  }
  return row
}

const snapshot = async (model, id) => {
  const row = await db[model].findByPk(id, { paranoid: false })
  return row ? JSON.stringify(row.get({ plain: true })) : null
}

// After a leaking write the row may now look like the attacker's own (moved
// store, renamed); seed a fresh victim so the next attacker or route is
// tested against an untouched tenant B row.
const discardVictim = (model) => {
  delete victims[model]
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
    name: `SWEEP-AT-${RUN}`
  })
  victimStore = await db.location.create({
    name: `${MARK}-VS`,
    status: 'active',
    tenantId: victimTenant.id
  })
  attackerStore = await db.location.create({
    name: `SWEEP-AS-${RUN}`,
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
    userName: `sweep_owner_${RUN}`,
    email: `sweep_owner_${RUN}@sweep.test`,
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
    userName: `sweep_admin_${RUN}`,
    email: `sweep_admin_${RUN}@sweep.test`,
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
}, 60000)

afterAll(async () => {
  for (const [model, id] of [...created].reverse()) {
    try {
      await db[model].destroy({ where: { id }, force: true, hooks: false })
    } catch {
      // best effort: a dependent row created by the app itself may hold it
    }
  }
  await db.tenantMembership.destroy({
    where: { userId: attackerUsers },
    force: true
  })
  await db.authorizationContextSession.destroy({
    where: { userId: attackerUsers }
  })
  await db.user.destroy({
    where: { id: [...attackerUsers, victimUser?.id].filter(Boolean) },
    force: true
  })
  await db.location.destroy({
    where: { id: [victimStore?.id, attackerStore?.id].filter(Boolean) },
    force: true
  })
  await db.tenant.destroy({
    where: { id: [victimTenant?.id, attackerTenant?.id].filter(Boolean) },
    force: true
  })
}, 60000)

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------
const WRITE_BODY = {
  name: 'SWEEP_HACKED',
  notes: 'SWEEP_HACKED',
  status: 'inactive',
  reason: 'sweep',
  isActive: false
}

const containsVictim = (body, model, id) => {
  const text = JSON.stringify(body ?? null)
  if (text.includes(MARK)) return true
  // A row without marker-bearing text: the victim id echoed back as data.
  const data =
    body && typeof body === 'object' ? (body.data ?? body.result ?? null) : null
  if (data == null) return false
  if (Array.isArray(data))
    return data.some((r) => r && Number(r.id) === Number(id))
  return typeof data === 'object' && Number(data.id) === Number(id)
}

// Leaks found by the first run of this sweep (2026-11-05). Each fix PR
// removes its entries; the test fails on any leak NOT listed here and on
// any listed entry that no longer leaks, so the list can only shrink.
const KNOWN_LEAKS = new Set([
  // delivery
  'delete /delivery/drivers/:id owner',
  'get /delivery/drivers/:id owner',
  'put /delivery/drivers/:id owner',
  'put /delivery/drivers/:id/status owner',
  // product-bundle
  'delete /product-bundle/delete/:id owner',
  'get /product-bundle/get-by-id/:id owner',
  'patch /product-bundle/status/:id owner',
  'put /product-bundle/update/:id owner',
  // queue
  'delete /queue/:id owner',
  'get /queue/:id owner',
  'put /queue/:id owner',
  // reservation
  'get /reservation/:id owner',
  // type-payment
  'get /type-payment/get-by-id/:id owner',
  'put /type-payment/edit-type-payment/:id owner',
  // notification
  'put /notification/:id/read owner',
  // overtime
  'put /overtime/cancel/:id owner'
])

const results = []
const uncovered = []

describe('tenant by-id sweep', () => {
  test("no by-id route lets tenant A read or change tenant B's row", async () => {
    for (const route of listRoutes()) {
      const key = `${route.method} ${route.path}`
      const skip = SKIP.find(([re]) => re.test(key))
      if (skip) {
        uncovered.push({ route: key, why: skip[1] })
        continue
      }
      const resolve = async () => {
        let url = route.path
        let target = null
        for (const p of [...route.path.matchAll(/:([A-Za-z]+)/g)].map(
          (m) => m[1]
        )) {
          const model = modelFor(route, p)
          if (!model || !db[model]) return { failed: `no model for :${p}` }
          let row
          try {
            row = await seed(model)
          } catch (e) {
            seedErrors[model] = String(e.message || e).slice(0, 160)
            return { failed: `cannot seed ${model}` }
          }
          url = url.replace(`:${p}`, String(row.id))
          if (!target) target = { model, id: row.id }
        }
        return { url, target }
      }
      const first = await resolve()
      if (first.failed) {
        uncovered.push({ route: key, why: first.failed })
        continue
      }

      for (const [who, token] of Object.entries(attackers)) {
        const { url, target } = await resolve()
        const before = await snapshot(target.model, target.id)
        let req = request(app)
          [route.method](url)
          .set('Authorization', `Bearer ${token}`)
        if (route.method !== 'get') req = req.send(WRITE_BODY)
        const res = await req
        const after = await snapshot(target.model, target.id)
        const ok2xx = res.status >= 200 && res.status < 300
        let leak = null
        if (route.method === 'get') {
          if (ok2xx && containsVictim(res.body, target.model, target.id))
            leak = 'read'
        } else if (before !== after) {
          leak = after === null ? 'deleted' : 'changed'
          discardVictim(target.model)
        }
        results.push({
          route: key,
          who,
          status: res.status,
          leak,
          model: target.model
        })
      }
    }

    const leaks = results.filter((r) => r.leak)
    if (process.env.SWEEP_REPORT) {
      require('fs').writeFileSync(
        process.env.SWEEP_REPORT,
        JSON.stringify(
          {
            leaks,
            uncovered,
            seedErrors,
            swept: results.length,
            statuses: results
          },
          null,
          2
        )
      )
    }
    const seen = new Set(leaks.map((l) => `${l.route} ${l.who}`))
    const newLeaks = leaks.filter(
      (l) => !KNOWN_LEAKS.has(`${l.route} ${l.who}`)
    )
    const nowFixed = [...KNOWN_LEAKS].filter((k) => !seen.has(k))
    expect(newLeaks).toEqual([])
    expect(nowFixed).toEqual([])
    // Every by-id route is either swept or skipped for a stated reason.
    expect(
      uncovered.filter((u) => !SKIP.some(([, why]) => why === u.why))
    ).toEqual([])
  }, 600000)
})
