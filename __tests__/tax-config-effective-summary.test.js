process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// P1: read-only effective-tax summary. Reports the active configuration
// applying to a requested outlet using the same resolution as checkout,
// without changing checkout behavior. Findings are factual observations
// (multiplicity, scope interaction). D3 decided 2026-10-16: PPN never
// stacks — one applied row per checkout (outlet overrides global).
let storeA = null
let storeB = null
let adminAToken = null
let superToken = null

async function makeTax(overrides) {
  return db.taxConfig.create({
    name: 'T4_ROW',
    rate: 11,
    type: 'ppn',
    status: 'active',
    store: null,
    ...overrides
  })
}

function quote(path, token) {
  const r = request(app).get(path)
  if (token) r.set('Authorization', `Bearer ${token}`)
  return r
}

beforeAll(async () => {
  storeA = await db.location.create({ name: 'T4_STORE_A', status: 'active' })
  storeB = await db.location.create({ name: 'T4_STORE_B', status: 'active' })
  await db.user.create({
    id: 9941,
    userName: 't4_admin_a',
    email: 'p1-9941-t4@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: storeA.id,
    status: 'active',
    fullName: 't4_admin_a'
  })
  await db.user.create({
    id: 9943,
    userName: 't4_super',
    email: 'p1-9943-t4@test.com',
    roleType: 'super_admin',
    userType: 'admin',
    store: null,
    status: 'active',
    fullName: 't4_super'
  })
  adminAToken = await signSessionToken(
    { id: 9941, userName: 't4_admin_a', roleType: 'admin', store: storeA.id },
    JWT_SECRET
  )
  superToken = await signSessionToken(
    { id: 9943, userName: 't4_super', roleType: 'super_admin', store: null },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.taxConfig.destroy({ where: {}, force: true })
  await db.user.destroy({ where: { id: [9941, 9943] }, force: true })
  await db.location.destroy({
    where: { id: [storeA?.id, storeB?.id].filter(Boolean) },
    force: true
  })
})

async function clearTax() {
  await db.taxConfig.destroy({ where: {}, force: true })
}

describe('P1 effective-tax summary', () => {
  test('single global PPN: rate matches checkout, row marked global', async () => {
    await clearTax()
    const row = await makeTax({ name: 'T4_G1', rate: 11 })
    const res = await quote(`/tax-config/effective?store=${storeA.id}`, adminAToken)
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.store).toBe(storeA.id)
    expect(res.body.data.ppn.status).toBe('configured')
    expect(res.body.data.ppn.rate).toBe(11)
    expect(res.body.data.ppn.rows).toEqual([
      { id: row.id, name: 'T4_G1', rate: 11, scope: 'global', applied: true }
    ])
  })

  test('two global 11% rows: 11% applied (never 22%) with a multiplicity finding, D3 decided', async () => {
    await clearTax()
    await makeTax({ name: 'T4_GA', rate: 11 })
    await makeTax({ name: 'T4_GB', rate: 11 })
    const res = await quote(`/tax-config/effective?store=${storeA.id}`, adminAToken)
    expect(res.status).toBe(200)
    expect(res.body.data.ppn.rate).toBe(11)
    expect(res.body.data.ppn.rows).toHaveLength(2)
    expect(res.body.data.ppn.rows.filter((r) => r.applied)).toHaveLength(1)
    const finding = res.body.data.findings.find(
      (f) => f.code === 'MULTIPLE_ACTIVE_SAME_SCOPE'
    )
    expect(finding).toBeDefined()
    expect(finding.severity).toBe('warning')
    expect(finding.policyRef).toBe('D3')
    expect(finding.decision).toBe('decided')
    expect(JSON.stringify(res.body)).not.toMatch(/invalid/i)
  })

  test('multiple outlet rows: the latest applied row is charged, outlet scope kept', async () => {
    await clearTax()
    await makeTax({ name: 'T4_O1', rate: 10, store: storeA.id })
    const latest = await makeTax({ name: 'T4_O2', rate: 5, store: storeA.id })
    const res = await quote(`/tax-config/effective?store=${storeA.id}`, adminAToken)
    expect(res.status).toBe(200)
    expect(res.body.data.ppn.rate).toBe(5)
    expect(res.body.data.ppn.rows.find((r) => r.applied).id).toBe(latest.id)
    expect(res.body.data.ppn.rows.every((r) => r.scope === 'outlet')).toBe(true)
  })

  test('an outlet row overrides the global row exactly as checkout, D3 decided', async () => {
    await clearTax()
    await makeTax({ name: 'T4_GC', rate: 11 })
    await makeTax({ name: 'T4_OC', rate: 5, store: storeA.id })
    const res = await quote(`/tax-config/effective?store=${storeA.id}`, adminAToken)
    expect(res.status).toBe(200)
    expect(res.body.data.ppn.rate).toBe(5)
    const finding = res.body.data.findings.find(
      (f) => f.code === 'GLOBAL_AND_OUTLET_COMBINED'
    )
    expect(finding).toBeDefined()
    expect(finding.policyRef).toBe('D3')
    expect(finding.decision).toBe('decided')
  })

  test('inactive, draft, and soft-deleted rows are excluded', async () => {
    await clearTax()
    await makeTax({ name: 'T4_BASE', rate: 11 })
    const gone = await makeTax({ name: 'T4_GONE', rate: 50 })
    await gone.destroy()
    await makeTax({ name: 'T4_INACTIVE', rate: 50, status: 'inactive' })
    await makeTax({ name: 'T4_DRAFT', rate: 50, status: 'draft' })
    const res = await quote(`/tax-config/effective?store=${storeA.id}`, adminAToken)
    expect(res.status).toBe(200)
    expect(res.body.data.ppn.rate).toBe(11)
    expect(res.body.data.ppn.rows).toHaveLength(1)
    expect(res.body.data.ppn.rows[0].name).toBe('T4_BASE')
  })

  test('missing PPN fails closed like checkout, never silent zero', async () => {
    await clearTax()
    const res = await quote(`/tax-config/effective?store=${storeA.id}`, adminAToken)
    expect(res.status).toBe(400)
    expect(res.body.success).toBe(false)
    expect(res.body.code).toBe('PPN_MISSING')
    expect(res.body.message).toMatch(/missing/i)
    expect(res.body.data).toBeUndefined()
  })

  test('invalid store is INVALID_STORE, not PPN_MISSING', async () => {
    await clearTax()
    await makeTax({ name: 'T4_GS', rate: 11 })
    // Outlet admins never reach the controller with a foreign/garbage
    // store (middleware denies with 403); a super_admin does, and the
    // controller must classify it as INVALID_STORE.
    const res = await quote('/tax-config/effective?store=abc', superToken)
    expect(res.status).toBe(400)
    expect(res.body.success).toBe(false)
    expect(res.body.code).toBe('INVALID_STORE')
  })

  test('invalid channel is INVALID_CHANNEL, not PPN_MISSING', async () => {
    await clearTax()
    await makeTax({ name: 'T4_GC', rate: 11 })
    const res = await quote(
      `/tax-config/effective?store=${storeA.id}&channel=bogus`,
      adminAToken
    )
    expect(res.status).toBe(400)
    expect(res.body.success).toBe(false)
    expect(res.body.code).toBe('INVALID_CHANNEL')
  })

  test('read failure is a server error, never PPN_MISSING', async () => {
    await clearTax()
    await makeTax({ name: 'T4_GF', rate: 11 })
    const spy = jest
      .spyOn(db.taxConfig, 'findAll')
      .mockRejectedValueOnce(new Error('db down'))
    try {
      const res = await quote(`/tax-config/effective?store=${storeA.id}`, adminAToken)
      expect(res.status).toBe(500)
      expect(res.body.success).toBe(false)
      expect(res.body.code).not.toBe('PPN_MISSING')
    } finally {
      spy.mockRestore()
    }
  })

  test('explicit 0% is configured, distinct from missing', async () => {
    await clearTax()
    await makeTax({ name: 'T4_ZERO', rate: 0 })
    const res = await quote(`/tax-config/effective?store=${storeA.id}`, adminAToken)
    expect(res.status).toBe(200)
    expect(res.body.data.ppn.status).toBe('configured')
    expect(res.body.data.ppn.rate).toBe(0)
    const finding = res.body.data.findings.find((f) => f.code === 'PPN_ZERO_CONFIGURED')
    expect(finding).toBeDefined()
  })

  test('service charge follows checkout semantics; qr marks it not applicable', async () => {
    await clearTax()
    await makeTax({ name: 'T4_PPN', rate: 11 })
    await makeTax({ name: 'T4_SC', rate: 5, type: 'service_charge' })
    const counter = await quote(
      `/tax-config/effective?store=${storeA.id}&channel=counter`,
      adminAToken
    )
    expect(counter.status).toBe(200)
    expect(counter.body.data.serviceCharge.status).toBe('configured')
    expect(counter.body.data.serviceCharge.rate).toBe(5)
    const qr = await quote(
      `/tax-config/effective?store=${storeA.id}&channel=qr`,
      adminAToken
    )
    expect(qr.status).toBe(200)
    expect(qr.body.data.ppn.rate).toBe(11)
    expect(qr.body.data.serviceCharge.status).toBe('not_applicable')
    expect(qr.body.data.serviceCharge.rate).toBeNull()
    expect(qr.body.data.serviceCharge.rows).toEqual([])
  })

  test('unauthenticated callers get the authentication error', async () => {
    const res = await quote(`/tax-config/effective?store=${storeA.id}`)
    expect(res.status).toBe(401)
  })

  test('outlet admin cannot inspect another outlet', async () => {
    await clearTax()
    await makeTax({ name: 'T4_GX', rate: 11 })
    const res = await quote(`/tax-config/effective?store=${storeB.id}`, adminAToken)
    expect(res.status).toBe(403)
  })

  test('super-admin without store sees the permitted global scope only', async () => {
    await clearTax()
    await makeTax({ name: 'T4_GY', rate: 11 })
    await makeTax({ name: 'T4_OY', rate: 5, store: storeA.id })
    const res = await quote('/tax-config/effective', superToken)
    expect(res.status).toBe(200)
    expect(res.body.data.store).toBeNull()
    expect(res.body.data.ppn.rows.every((r) => r.scope === 'global')).toBe(true)
    expect(
      res.body.data.ppn.rows.some((r) => r.name === 'T4_OY')
    ).toBe(false)
  })

  test('summary rate equals customer-tax-rate for identical scope', async () => {
    await clearTax()
    await makeTax({ name: 'T4_PZ', rate: 11 })
    await makeTax({ name: 'T4_OZ', rate: 5, store: storeA.id })
    const summary = await quote(
      `/tax-config/effective?store=${storeA.id}&channel=qr`,
      superToken
    )
    const live = await quote(
      `/order/customer-tax-rate?store=${storeA.id}&channel=qr`,
      superToken
    )
    expect(summary.status).toBe(200)
    expect(live.status).toBe(200)
    expect(summary.body.data.ppn.rate).toBe(live.body.data.rate)
  })
})
