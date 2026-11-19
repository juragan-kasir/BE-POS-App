process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// F1: sequence-authoritative Location.id allocation.
//
// - addNewLocation must NOT compute MAX(id)+1 and must NOT honor a supplied
//   locationId: PostgreSQL location_id_seq is the sole allocator.
// - the legacy store mirror must equal the generated id on every app-created
//   row (single INSERT, so the pair is atomic from readers' perspective).
// - a supplied locationId (unused / live / soft-deleted / malformed) is
//   inert: creation succeeds and the sequence value is authoritative.
// - an explicit-id fixture above the sequence (the historical drift shape)
//   must not divert or collide with a normal create.
// - concurrent creates must all succeed with distinct ids and zero
//   allocation-related 500s (sequence nextval is the concurrency primitive).

let superAdminUser = null
let superAdminToken = null
const createdLocIds = []
const createdUserIds = []

const stamp = () => `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`

const basePayload = (overrides = {}) => ({
  name: `F1SEQ_${stamp()}`,
  phoneNumber: '081234567890',
  email: `f1seq_${stamp()}@test.com`,
  status: 'draft',
  ...overrides
})

const seqLastValue = async () => {
  const [rows] = await db.sequelize.query(
    'SELECT last_value FROM location_id_seq'
  )
  return Number(rows?.[0]?.last_value)
}

const locIdString = (id) => `loc-${String(id).padStart(3, '0')}`

const createStore = async (overrides = {}) => {
  const res = await request(app)
    .post('/location/add-new-location')
    .set('Authorization', `Bearer ${superAdminToken}`)
    .send(basePayload(overrides))
  return res
}

const trackRow = async (id) => {
  createdLocIds.push(id)
  return db.location.findByPk(id, { paranoid: false })
}

beforeAll(async () => {
  superAdminUser = await db.user.create({
    userName: `superadmin_f1seq_${stamp()}`,
    email: `superadmin_f1seq_${stamp()}@test.com`,
    roleType: 'super_admin',
    userType: 'admin',
    status: 'active'
  })
  createdUserIds.push(superAdminUser.id)
  superAdminToken = await signSessionToken(
    { id: superAdminUser.id, userName: superAdminUser.userName, roleType: 'super_admin' },
    JWT_SECRET
  )
})

afterAll(async () => {
  // Best-effort audit cleanup for the fire-and-forget createAudit() writes;
  // location/user cleanup follows the user.store -> location.id FK order.
  await db.auditLog
    .destroy({ where: { entity: 'location', entityId: createdLocIds }, force: true })
    .catch(() => {})
  await db.user.destroy({ where: { id: createdUserIds }, force: true }).catch(() => {})
  await db.location.destroy({ where: { id: createdLocIds }, force: true }).catch(() => {})
})

describe('F1 sequence-authoritative location id allocation', () => {
  test('sequence supplies the id and store mirrors it', async () => {
    const seqBefore = await seqLastValue()
    const res = await createStore()
    expect(res.status).toBe(201)

    const { id, store, locationId, storeId } = res.body.data
    // The issued id is exactly the sequence's next value — not MAX(id)+1.
    expect(Number(id)).toBe(seqBefore + 1)
    expect(Number(store)).toBe(Number(id))
    expect(locationId).toBe(locIdString(id))
    expect(storeId).toBe(`ST-${String(id).padStart(3, '0')}`)

    const row = await trackRow(id)
    expect(Number(row.store)).toBe(Number(row.id))
  })

  test('unused locationId is inert', async () => {
    const seqBefore = await seqLastValue()
    const res = await createStore({ locationId: 'loc-881001' })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.id)).toBe(seqBefore + 1)
    expect(Number(res.body.data.id)).not.toBe(881001)
    expect(Number(res.body.data.store)).toBe(Number(res.body.data.id))
    await trackRow(res.body.data.id)
  })

  test('live locationId is inert (no 403)', async () => {
    const first = await createStore()
    expect(first.status).toBe(201)
    await trackRow(first.body.data.id)

    const seqBefore = await seqLastValue()
    const res = await createStore({ locationId: locIdString(first.body.data.id) })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.id)).toBe(seqBefore + 1)
    expect(Number(res.body.data.id)).not.toBe(Number(first.body.data.id))
    await trackRow(res.body.data.id)
  })

  test('soft-deleted locationId is inert (no reuse, no fallback)', async () => {
    const victim = await createStore()
    expect(victim.status).toBe(201)
    await trackRow(victim.body.data.id)
    await db.location.destroy({ where: { id: victim.body.data.id } })

    const seqBefore = await seqLastValue()
    const res = await createStore({ locationId: locIdString(victim.body.data.id) })
    expect(res.status).toBe(201)
    expect(Number(res.body.data.id)).toBe(seqBefore + 1)
    expect(Number(res.body.data.id)).not.toBe(Number(victim.body.data.id))
    await trackRow(res.body.data.id)
  })

  test('malformed locationId values are inert (no 500)', async () => {
    for (const bad of ['loc-abc', 'garbage-no-prefix', 'loc-', 'NaN']) {
      const seqBefore = await seqLastValue()
      const res = await createStore({ locationId: bad })
      expect(res.status).toBe(201)
      expect(Number(res.body.data.id)).toBe(seqBefore + 1)
      expect(Number(res.body.data.store)).toBe(Number(res.body.data.id))
      await trackRow(res.body.data.id)
    }
  })

  test('explicit-id fixture above the sequence neither diverts nor collides', async () => {
    const seqBefore = await seqLastValue()
    // Historical drift shape: an explicit id far above the sequence.
    // Under MAX(id)+1 this would have diverted the next create to
    // explicitId + 1; under the sequence it must be ignored entirely.
    const explicitId = seqBefore + 100000
    const planted = await db.location.create(await withTestTenant({
      id: explicitId,
      store: explicitId,
      name: `F1SEQ_PLANTED_${stamp()}`,
      status: 'draft',
      createdBy: superAdminUser.id
    }))
    createdLocIds.push(planted.id)

    const res = await createStore()
    expect(res.status).toBe(201)
    expect(Number(res.body.data.id)).toBe(seqBefore + 1)
    expect(Number(res.body.data.id)).not.toBe(explicitId + 1)
    expect(Number(res.body.data.store)).toBe(Number(res.body.data.id))
    await trackRow(res.body.data.id)

    // Planted row untouched.
    const stillThere = await db.location.findByPk(explicitId)
    expect(stillThere).not.toBeNull()
  })

  test('concurrent creates all succeed with distinct ids', async () => {
    const count = 8
    const results = await Promise.all(
      Array.from({ length: count }, () => createStore())
    )
    for (const res of results) {
      expect(res.status).toBe(201)
    }
    const ids = results.map((res) => Number(res.body.data.id))
    expect(new Set(ids).size).toBe(count)
    for (const res of results) {
      expect(Number(res.body.data.store)).toBe(Number(res.body.data.id))
      await trackRow(res.body.data.id)
    }
  })
})
