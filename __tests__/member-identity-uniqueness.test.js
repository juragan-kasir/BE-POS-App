process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// D-05 product-grade member identity (locked contract):
// - name: store-scoped (own store or global-null bucket), case-insensitive
// - phone: unique per store bucket on canonical E.164 (ID default region)
// - email: unique per store bucket, TRIM + lowercase, '' -> NULL
//   (phone and email were global until D-05 amendment A1, 2026-10-31)
// - soft-deleted rows excluded from every uniqueness object
// - guests (GUEST-*) exempt from phone uniqueness
// - DB violations map to 409 on create AND update
//
// Phone range 0815000xxxxx and D05_* names are unique to this file so the
// shared test database cannot collide with other suites.

let storeA = null
let storeB = null
let adminAToken = null
let adminBToken = null
let superAdminToken = null

beforeAll(async () => {
  storeA = await db.location.create({ name: 'D05_STORE_A', status: 'active' })
  storeB = await db.location.create({ name: 'D05_STORE_B', status: 'active' })

  for (const [id, userName, roleType, userType, store] of [
    [9201, 'd05_admin_a', 'admin', 'admin', storeA.id],
    [9202, 'd05_admin_b', 'admin', 'admin', storeB.id],
    [9203, 'd05_super_admin', 'super_admin', 'admin', null]
  ]) {
    await db.user.create({
      id,
      userName,
      email: `p14-${id}-d05@test.com`,
      roleType,
      userType,
      store,
      status: 'active',
      fullName: userName
    })
  }
  adminAToken = await signSessionToken(
    { id: 9201, userName: 'd05_admin_a', roleType: 'admin', store: storeA.id },
    JWT_SECRET
  )
  adminBToken = await signSessionToken(
    { id: 9202, userName: 'd05_admin_b', roleType: 'admin', store: storeB.id },
    JWT_SECRET
  )
  superAdminToken = await signSessionToken(
    { id: 9203, userName: 'd05_super_admin', roleType: 'super_admin', store: null },
    JWT_SECRET
  )
})

afterAll(async () => {
  await db.user.destroy({ where: { id: [9201, 9202, 9203] }, force: true })
  // All rows created here have names starting with D05 (any case), including
  // global (store-null) members and guest members. force:true removes
  // soft-deleted rows as well.
  await db.member.destroy({
    where: { name: { [db.Sequelize.Op.iLike]: 'D05%' } },
    force: true
  })
  await db.member.destroy({
    where: { store: [storeA?.id, storeB?.id].filter(Boolean) },
    force: true
  })
  await db.location.destroy({ where: { id: [storeA?.id, storeB?.id].filter(Boolean) }, force: true })
})

const addMember = (token, body) =>
  request(app)
    .post('/member/add-new-member')
    .set('Authorization', `Bearer ${token}`)
    .send(body)

const deleteMember = (token, id) =>
  request(app)
    .delete(`/member/delete-member/${id}`)
    .set('Authorization', `Bearer ${token}`)

describe('D-05 name identity (HTTP contract)', () => {
  test('same store + exact duplicate name -> 409', async () => {
    const first = await addMember(adminAToken, {
      nameMember: 'D05 Exact Dup',
      phoneNumber: '081500000001'
    })
    expect(first.status).toBe(201)

    const second = await addMember(adminAToken, {
      nameMember: 'D05 Exact Dup',
      phoneNumber: '081500000002'
    })
    expect(second.status).toBe(409)
    expect(second.body.message).toBe('Nama member sudah terdaftar')
  })

  test('same store + case-only duplicate name -> 409', async () => {
    const first = await addMember(adminAToken, {
      nameMember: 'D05 Case Name',
      phoneNumber: '081500000003'
    })
    expect(first.status).toBe(201)

    const second = await addMember(adminAToken, {
      nameMember: 'd05 cASE nAME',
      phoneNumber: '081500000004'
    })
    expect(second.status).toBe(409)
  })

  test('same store + whitespace-equivalent duplicate name -> 409', async () => {
    const first = await addMember(adminAToken, {
      nameMember: 'D05 Space Name',
      phoneNumber: '081500000005'
    })
    expect(first.status).toBe(201)

    const second = await addMember(adminAToken, {
      nameMember: '  D05 SPACE NAME  ',
      phoneNumber: '081500000006'
    })
    expect(second.status).toBe(409)
  })

  test('different stores + same name -> both succeed', async () => {
    const inA = await addMember(adminAToken, {
      nameMember: 'D05 Shared Name',
      phoneNumber: '081500000007'
    })
    expect(inA.status).toBe(201)

    const inB = await addMember(adminBToken, {
      nameMember: 'D05 Shared Name',
      phoneNumber: '081500000008'
    })
    expect(inB.status).toBe(201)
  })

  test('two global (store-null) members with same name -> 409', async () => {
    const first = await addMember(superAdminToken, {
      nameMember: 'D05_GLOBAL_Shared',
      phoneNumber: '081500000009'
    })
    expect(first.status).toBe(201)
    expect(first.body.data.store).toBeFalsy()

    const second = await addMember(superAdminToken, {
      nameMember: 'D05_GLOBAL_Shared',
      phoneNumber: '081500000010'
    })
    expect(second.status).toBe(409)
  })

  test('global and store buckets are disjoint for names', async () => {
    const global = await addMember(superAdminToken, {
      nameMember: 'D05_GLOBAL_Disjoint',
      phoneNumber: '081500000011'
    })
    expect(global.status).toBe(201)

    const scoped = await addMember(adminAToken, {
      nameMember: 'D05_GLOBAL_Disjoint',
      phoneNumber: '081500000012'
    })
    expect(scoped.status).toBe(201)
  })

  test('soft-deleted name is reusable in the same store', async () => {
    const created = await addMember(adminAToken, {
      nameMember: 'D05 Temp Name',
      phoneNumber: '081500000013'
    })
    expect(created.status).toBe(201)

    const removed = await deleteMember(adminAToken, created.body.data.id)
    expect(removed.status).toBe(200)

    const recreated = await addMember(adminAToken, {
      nameMember: 'D05 Temp Name',
      phoneNumber: '081500000014'
    })
    expect(recreated.status).toBe(201)
  })
})

describe('D-05 phone identity (HTTP contract)', () => {
  // D-05 amendment A1 (2026-10-31): phone is unique per store bucket.
  test('same phone in the same store -> 409; another store may reuse it', async () => {
    const inA = await addMember(adminAToken, {
      nameMember: 'D05 Phone A',
      phoneNumber: '081500000021'
    })
    expect(inA.status).toBe(201)

    const againA = await addMember(adminAToken, {
      nameMember: 'D05 Phone A2',
      phoneNumber: '081500000021'
    })
    expect(againA.status).toBe(409)
    expect(againA.body.message).toBe('Nomor telepon sudah terdaftar')

    const inB = await addMember(adminBToken, {
      nameMember: 'D05 Phone B',
      phoneNumber: '081500000021'
    })
    expect(inB.status).toBe(201)
  })

  test('national and international forms are the same identity', async () => {
    const national = await addMember(adminAToken, {
      nameMember: 'D05 Phone National',
      phoneNumber: '081500000022'
    })
    expect(national.status).toBe(201)
    expect(national.body.data.phoneNumber).toBe('+6281500000022')

    const intl = await addMember(adminAToken, {
      nameMember: 'D05 Phone Intl',
      phoneNumber: '+6281500000022'
    })
    expect(intl.status).toBe(409)
  })

  test('guest members are exempt from phone uniqueness', async () => {
    const first = await addMember(adminAToken, { nameMember: 'D05 Guest One' })
    expect(first.status).toBe(201)
    expect(first.body.data.phoneNumber).toMatch(/^GUEST-/)

    const second = await addMember(adminAToken, { nameMember: 'D05 Guest Two' })
    expect(second.status).toBe(201)
    expect(second.body.data.phoneNumber).toMatch(/^GUEST-/)
    expect(second.body.data.phoneNumber).not.toBe(first.body.data.phoneNumber)
  })

  test('concurrent guest creation never collides', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        addMember(adminAToken, { nameMember: `D05 Burst ${i}` })
      )
    )
    for (const res of results) expect(res.status).toBe(201)
    const phones = results.map((res) => res.body.data.phoneNumber)
    expect(new Set(phones).size).toBe(5)
  })

  test('guest identifier is UUID-based, never Date.now-based', async () => {
    const res = await addMember(adminAToken, { nameMember: 'D05 Guest UUID' })
    expect(res.status).toBe(201)
    expect(res.body.data.phoneNumber).toMatch(
      /^GUEST-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
    expect(res.body.data.phoneNumber).not.toMatch(/^GUEST-\d+$/)
  })

  test('invalid phone is rejected with 400', async () => {
    const res = await addMember(adminAToken, {
      nameMember: 'D05 Bad Phone',
      phoneNumber: 'not-a-phone'
    })
    expect(res.status).toBe(400)
  })

  test('soft-deleted phone is reusable', async () => {
    const created = await addMember(adminAToken, {
      nameMember: 'D05 Temp Phone',
      phoneNumber: '081500000023'
    })
    expect(created.status).toBe(201)

    const removed = await deleteMember(adminAToken, created.body.data.id)
    expect(removed.status).toBe(200)

    const recreated = await addMember(adminAToken, {
      nameMember: 'D05 Temp Phone Two',
      phoneNumber: '081500000023'
    })
    expect(recreated.status).toBe(201)
  })
})

describe('D-05 email identity (HTTP contract)', () => {
  // D-05 amendment A1 (2026-10-31): email is unique per store bucket.
  test('case-only duplicate in the same store -> 409; another store may reuse it', async () => {
    const first = await addMember(adminAToken, {
      nameMember: 'D05 Email A',
      phoneNumber: '081500000031',
      email: 'D05.Case@Example.COM'
    })
    expect(first.status).toBe(201)

    const second = await addMember(adminAToken, {
      nameMember: 'D05 Email A2',
      phoneNumber: '081500000032',
      email: 'd05.case@example.com'
    })
    expect(second.status).toBe(409)
    expect(second.body.message).toBe('Email sudah terdaftar')

    const inB = await addMember(adminBToken, {
      nameMember: 'D05 Email B',
      phoneNumber: '081500000033',
      email: 'd05.case@example.com'
    })
    expect(inB.status).toBe(201)
  })

  // Note: the HTTP boundary validates email shape (zod email), so surrounding
  // whitespace never reaches the controller. Whitespace identity is therefore
  // proven at the DB level, where the expression index is the final arbiter.
  test('surrounding whitespace resolves to the same identity (DB level)', async () => {
    await db.member.create({
      name: 'D05 DB WS Holder',
      phoneNumber: '081500000051',
      email: 'd05dbws@example.com',
      store: storeA.id
    })

    await expect(
      db.member.create({
        name: 'D05 DB WS Clash',
        phoneNumber: '081500000052',
        email: '  D05DBWS@Example.COM  ',
        store: storeA.id
      })
    ).rejects.toThrow()
  })

  test('NULL emails are allowed for many members', async () => {
    const first = await addMember(adminAToken, {
      nameMember: 'D05 No Email One',
      phoneNumber: '081500000035'
    })
    expect(first.status).toBe(201)

    const second = await addMember(adminBToken, {
      nameMember: 'D05 No Email Two',
      phoneNumber: '081500000036'
    })
    expect(second.status).toBe(201)
  })

  test('empty string email is stored as NULL', async () => {
    const res = await addMember(adminAToken, {
      nameMember: 'D05 Empty Email',
      phoneNumber: '081500000037',
      email: ''
    })
    expect(res.status).toBe(201)
    expect(res.body.data.email).toBeNull()
  })

  test('soft-deleted email is reusable', async () => {
    const created = await addMember(adminAToken, {
      nameMember: 'D05 Temp Email',
      phoneNumber: '081500000038',
      email: 'd05temp@example.com'
    })
    expect(created.status).toBe(201)

    const removed = await deleteMember(adminAToken, created.body.data.id)
    expect(removed.status).toBe(200)

    const recreated = await addMember(adminAToken, {
      nameMember: 'D05 Temp Email Two',
      phoneNumber: '081500000039',
      email: 'd05temp@example.com'
    })
    expect(recreated.status).toBe(201)
  })
})

describe('D-05 update path and DB race boundary', () => {
  test('update to a duplicate name keeps the 409 vocabulary', async () => {
    const a = await addMember(adminAToken, {
      nameMember: 'D05 Update Alpha',
      phoneNumber: '081500000041'
    })
    expect(a.status).toBe(201)
    const b = await addMember(adminAToken, {
      nameMember: 'D05 Update Beta',
      phoneNumber: '081500000042'
    })
    expect(b.status).toBe(201)

    const res = await request(app)
      .put(`/member/edit-member/${b.body.data.id}`)
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({ nameMember: 'd05 UPDATE alpha' })
    expect(res.status).toBe(409)
    expect(res.body.message).toBe('Nama member sudah terdaftar')
  })

  test('concurrent create collision resolves through DB uniqueness with 409', async () => {
    const payload = (i) => ({
      nameMember: 'D05 Race Create',
      phoneNumber: '081500000043',
      email: `d05race${i}@example.com`
    })
    const results = await Promise.all([
      addMember(adminAToken, payload(1)),
      addMember(adminAToken, payload(2))
    ])
    const statuses = results.map((r) => r.status).sort()
    expect(statuses).toEqual([201, 409])
  })

  test('concurrent update collision never leaves duplicate identity (DB is final arbiter)', async () => {
    const a = await addMember(adminAToken, {
      nameMember: 'D05 Race Swap A',
      phoneNumber: '081500000044'
    })
    expect(a.status).toBe(201)
    const b = await addMember(adminAToken, {
      nameMember: 'D05 Race Swap B',
      phoneNumber: '081500000045'
    })
    expect(b.status).toBe(201)

    // Depending on interleaving this resolves as 200+409 (sequential or
    // loser-aborts) or 409+409 (both prechecks observe the old state) — or,
    // if the swap serializes cleanly, 200+200. Every outcome is safe as long
    // as no response is a 500 and the DB holds no duplicate identity.
    const put = (id, phone) =>
      request(app)
        .put(`/member/edit-member/${id}`)
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ phoneNumber: phone })
    const results = await Promise.all([
      put(a.body.data.id, '081500000045'),
      put(b.body.data.id, '081500000044')
    ])
    for (const r of results) expect([200, 409]).toContain(r.status)

    const holders = await db.member.findAll({
      where: {
        phoneNumber: ['+6281500000044', '+6281500000045'],
        deletedAt: null
      },
      raw: true
    })
    expect(holders).toHaveLength(2)
    expect(new Set(holders.map((m) => m.phoneNumber)).size).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// DB race boundary (deterministic): the controller's raw prechecks are
// bypassed (findOne with raw:true returns null) so the write genuinely
// reaches the D-05 unique index; findByPk and every other read are untouched.
// ---------------------------------------------------------------------------
const bypassPrechecks = () => {
  const original = db.member.findOne
  return jest.spyOn(db.member, 'findOne').mockImplementation(function (options) {
    if (options && options.raw === true) return Promise.resolve(null)
    return original.call(this, options)
  })
}

const editMember = (token, id, body) =>
  request(app)
    .put(`/member/edit-member/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send(body)

const withBypassedPrechecks = async (fn) => {
  const spy = bypassPrechecks()
  try {
    const res = await fn()
    // the prechecks really ran (and were forced to miss)
    expect(spy.mock.calls.some(([o]) => o && o.raw === true)).toBe(true)
    return res
  } finally {
    spy.mockRestore()
  }
}

describe('D-05 DB unique race -> 409 with existing vocabulary (create)', () => {
  test('store-scoped name race -> 409 "Nama member sudah terdaftar"', async () => {
    const first = await addMember(adminAToken, {
      nameMember: 'D05 RaceC Name',
      phoneNumber: '081500000101'
    })
    expect(first.status).toBe(201)

    const res = await withBypassedPrechecks(() =>
      addMember(adminAToken, {
        nameMember: '  d05 racec NAME ',
        phoneNumber: '081500000102'
      })
    )
    expect(res.status).toBe(409)
    expect(res.body.message).toBe('Nama member sudah terdaftar')
    expect(res.body.message).not.toMatch(/store|lower|trim/i)
  })

  test('global-bucket name race -> 409 "Nama member sudah terdaftar"', async () => {
    const first = await addMember(superAdminToken, {
      nameMember: 'D05_GLOBAL_RaceC',
      phoneNumber: '081500000103'
    })
    expect(first.status).toBe(201)

    const res = await withBypassedPrechecks(() =>
      addMember(superAdminToken, {
        nameMember: 'd05_global_racec',
        phoneNumber: '081500000104'
      })
    )
    expect(res.status).toBe(409)
    expect(res.body.message).toBe('Nama member sudah terdaftar')
  })

  test('phone race -> 409 "Nomor telepon sudah terdaftar"', async () => {
    const first = await addMember(adminAToken, {
      nameMember: 'D05 RaceC Phone A',
      phoneNumber: '081500000105'
    })
    expect(first.status).toBe(201)

    const res = await withBypassedPrechecks(() =>
      addMember(adminAToken, {
        nameMember: 'D05 RaceC Phone B',
        phoneNumber: '+6281500000105'
      })
    )
    expect(res.status).toBe(409)
    expect(res.body.message).toBe('Nomor telepon sudah terdaftar')
  })

  test('email race -> 409 "Email sudah terdaftar"', async () => {
    const first = await addMember(adminAToken, {
      nameMember: 'D05 RaceC Email A',
      phoneNumber: '081500000106',
      email: 'd05.racec@example.com'
    })
    expect(first.status).toBe(201)

    const res = await withBypassedPrechecks(() =>
      addMember(adminAToken, {
        nameMember: 'D05 RaceC Email B',
        phoneNumber: '081500000107',
        email: 'D05.RaceC@Example.com'
      })
    )
    expect(res.status).toBe(409)
    expect(res.body.message).toBe('Email sudah terdaftar')
    expect(res.body.message).not.toMatch(/lower|trim/i)
  })
})

describe('D-05 DB unique race -> 409 with existing vocabulary (update)', () => {
  let alpha = null
  let beta = null

  beforeAll(async () => {
    const a = await addMember(adminAToken, {
      nameMember: 'D05 RaceU Alpha',
      phoneNumber: '081500000111',
      email: 'd05.raceu.alpha@example.com'
    })
    const b = await addMember(adminAToken, {
      nameMember: 'D05 RaceU Beta',
      phoneNumber: '081500000112',
      email: 'd05.raceu.beta@example.com'
    })
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    alpha = a.body.data
    beta = b.body.data
  })

  test('name race -> 409 "Nama member sudah terdaftar"', async () => {
    const res = await withBypassedPrechecks(() =>
      editMember(adminAToken, beta.id, { nameMember: 'd05 RACEU alpha' })
    )
    expect(res.status).toBe(409)
    expect(res.body.message).toBe('Nama member sudah terdaftar')
  })

  test('phone race -> 409 "Nomor telepon sudah terdaftar"', async () => {
    const res = await withBypassedPrechecks(() =>
      editMember(adminAToken, beta.id, { phoneNumber: '0815-0000-0111' })
    )
    expect(res.status).toBe(409)
    expect(res.body.message).toBe('Nomor telepon sudah terdaftar')
  })

  test('email race -> 409 "Email sudah terdaftar"', async () => {
    const res = await withBypassedPrechecks(() =>
      editMember(adminAToken, beta.id, { email: 'D05.RaceU.Alpha@example.com' })
    )
    expect(res.status).toBe(409)
    expect(res.body.message).toBe('Email sudah terdaftar')
  })

  test('the losing writes left the target member unchanged', async () => {
    const fresh = await db.member.findByPk(beta.id, { raw: true })
    expect(fresh.name).toBe('D05 RaceU Beta')
    expect(fresh.phoneNumber).toBe('+6281500000112')
    expect(fresh.email).toBe('d05.raceu.beta@example.com')
    expect(alpha.phoneNumber).toBe('+6281500000111')
  })
})

describe('D-05 update path validation and self-exclusion', () => {
  test('self-update with own identity in another spelling -> 200', async () => {
    const created = await addMember(adminAToken, {
      nameMember: 'D05 Self Update',
      phoneNumber: '081500000121',
      email: 'd05.self@example.com'
    })
    expect(created.status).toBe(201)

    const res = await editMember(adminAToken, created.body.data.id, {
      nameMember: 'd05 SELF update',
      phoneNumber: '+62 815-0000-0121',
      email: 'D05.Self@example.com'
    })
    expect(res.status).toBe(200)
    expect(res.body.data.phoneNumber).toBe('+6281500000121')
  })

  test('update with an invalid phone -> 400', async () => {
    const created = await addMember(adminAToken, {
      nameMember: 'D05 Invalid Update',
      phoneNumber: '081500000122'
    })
    expect(created.status).toBe(201)

    const res = await editMember(adminAToken, created.body.data.id, {
      phoneNumber: 'not-a-phone'
    })
    expect(res.status).toBe(400)
    const fresh = await db.member.findByPk(created.body.data.id, { raw: true })
    expect(fresh.phoneNumber).toBe('+6281500000122')
  })

  test('update to a duplicate phone (precheck) -> 409', async () => {
    const a = await addMember(adminAToken, {
      nameMember: 'D05 Dup Phone Holder',
      phoneNumber: '081500000123'
    })
    const b = await addMember(adminAToken, {
      nameMember: 'D05 Dup Phone Mover',
      phoneNumber: '081500000124'
    })
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)

    const res = await editMember(adminAToken, b.body.data.id, {
      phoneNumber: '+6281500000123'
    })
    expect(res.status).toBe(409)
    expect(res.body.message).toBe('Nomor telepon sudah terdaftar')
  })

  test('update to a duplicate email in the same store (precheck) -> 409', async () => {
    const a = await addMember(adminAToken, {
      nameMember: 'D05 Dup Email Holder',
      phoneNumber: '081500000125',
      email: 'd05.dupemail@example.com'
    })
    const b = await addMember(adminAToken, {
      nameMember: 'D05 Dup Email Mover',
      phoneNumber: '081500000126'
    })
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)

    const res = await editMember(adminAToken, b.body.data.id, {
      email: 'D05.DupEmail@Example.com'
    })
    expect(res.status).toBe(409)
    expect(res.body.message).toBe('Email sudah terdaftar')
  })
})

describe('D-05 guest identity is server-generated only', () => {
  test('create with a client-supplied GUEST-* phone -> 400', async () => {
    const res = await addMember(adminAToken, {
      nameMember: 'D05 Guest Spoof',
      phoneNumber: 'GUEST-123'
    })
    expect(res.status).toBe(400)
    const rows = await db.member.findAll({ where: { name: 'D05 Guest Spoof' }, raw: true })
    expect(rows).toHaveLength(0)
  })

  test('create with a whitespace-only phone -> server-generated guest', async () => {
    const res = await addMember(adminAToken, {
      nameMember: 'D05 Whitespace Phone',
      phoneNumber: '   '
    })
    expect(res.status).toBe(201)
    expect(res.body.data.phoneNumber).toMatch(
      /^GUEST-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })

  test('update a normal member to an arbitrary GUEST-* -> 400', async () => {
    const created = await addMember(adminAToken, {
      nameMember: 'D05 Guest Hijack',
      phoneNumber: '081500000131'
    })
    expect(created.status).toBe(201)

    const res = await editMember(adminAToken, created.body.data.id, {
      phoneNumber: 'GUEST-00000000-0000-0000-0000-000000000000'
    })
    expect(res.status).toBe(400)
    const fresh = await db.member.findByPk(created.body.data.id, { raw: true })
    expect(fresh.phoneNumber).toBe('+6281500000131')
  })

  test('update a guest member to a different GUEST-* -> 400', async () => {
    const created = await addMember(adminAToken, { nameMember: 'D05 Guest Swap' })
    expect(created.status).toBe(201)

    const res = await editMember(adminAToken, created.body.data.id, {
      phoneNumber: 'GUEST-someone-else'
    })
    expect(res.status).toBe(400)
  })

  test('update a guest member with its own unchanged GUEST-* -> 200 (no-op)', async () => {
    const created = await addMember(adminAToken, { nameMember: 'D05 Guest Keep' })
    expect(created.status).toBe(201)
    const guestPhone = created.body.data.phoneNumber

    const res = await editMember(adminAToken, created.body.data.id, {
      nameMember: 'D05 Guest Keep Renamed',
      phoneNumber: guestPhone
    })
    expect(res.status).toBe(200)
    const fresh = await db.member.findByPk(created.body.data.id, { raw: true })
    expect(fresh.phoneNumber).toBe(guestPhone)
    expect(fresh.name).toBe('D05 Guest Keep Renamed')
  })

  test('guest values stay excluded from phone uniqueness at the DB level', async () => {
    const shared = 'GUEST-d05-db-level-shared'
    await db.member.create({ name: 'D05 DB Guest One', phoneNumber: shared, store: storeA.id })
    await expect(
      db.member.create({ name: 'D05 DB Guest Two', phoneNumber: shared, store: storeB.id })
    ).resolves.toBeTruthy()
  })

  test('the guest generator never uses Date.now()', () => {
    const src = require('fs').readFileSync(require.resolve('../utils/memberIdentity'), 'utf8')
    expect(src).toMatch(/crypto\.randomUUID\(\)/)
    expect(src).not.toMatch(/Date\.now\(\)/)
    const controller = require('fs').readFileSync(require.resolve('../api/controller/member'), 'utf8')
    expect(controller).not.toMatch(/GUEST-\$\{Date\.now\(\)\}/)
  })
})
