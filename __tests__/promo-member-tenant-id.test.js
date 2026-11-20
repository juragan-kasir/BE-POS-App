'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// W3-3 (BE audit S-04/S-05, migration 20261119000003 / batch B21): discount,
// member and member_tier carry the tenant of their outlet (utils/storeTenant,
// re-derived on every write), and discount codes are unique per tenant.
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const migration = require('../db/migrations/20261119000003-promo-member-tenant-id')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const uniq = (k) => `pmt_${k}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
const ids = { tenants: [], stores: [], users: [] }
const f = {}

const mkOwner = async (tenant, store) => {
  const user = await db.user.create({
    userName: uniq('owner'), email: `${uniq('owner')}@test.com`, roleType: 'super_admin', userType: 'admin',
    status: 'active', store: store.id
  })
  ids.users.push(user.id)
  await db.tenantMembership.create({ userId: user.id, tenantId: tenant.id, role: 'tenant_admin', status: 'ACTIVE' })
  const token = await signSessionToken({ id: user.id, userName: user.userName, roleType: 'super_admin', store: store.id }, JWT_SECRET)
  return { user, token, store, tenant }
}

const addDiscount = (owner, body) =>
  request(app)
    .post(`/discount/add-new-discount?store=${owner.store.id}`)
    .set('Authorization', `Bearer ${owner.token}`)
    .send({ name: uniq('disc'), type: 'percent', value: 10, store: owner.store.id, status: 'active', ...body })

const phone = () => `0812${Math.floor(Math.random() * 1e8).toString().padStart(8, '0')}`

beforeAll(async () => {
  f.tA = await db.tenant.create({ code: uniq('a').replace(/_/g, '-'), name: uniq('TA') })
  f.tB = await db.tenant.create({ code: uniq('b').replace(/_/g, '-'), name: uniq('TB') })
  ids.tenants.push(f.tA.id, f.tB.id)
  f.a1 = await db.location.create({ name: uniq('A1'), status: 'active', tenantId: f.tA.id })
  f.a2 = await db.location.create({ name: uniq('A2'), status: 'active', tenantId: f.tA.id })
  f.b1 = await db.location.create({ name: uniq('B1'), status: 'active', tenantId: f.tB.id })
  f.free = await db.location.create({ tenantId: null, name: uniq('F'), status: 'active' })
  ids.stores.push(f.a1.id, f.a2.id, f.b1.id, f.free.id)
  f.ownerA = await mkOwner(f.tA, f.a1)
  f.ownerB = await mkOwner(f.tB, f.b1)
})

afterAll(async () => {
  await db.discount.destroy({ where: { store: ids.stores }, force: true })
  await db.discount.destroy({ where: { name: { [db.Sequelize.Op.like]: 'pmt_%' } }, force: true })
  await db.member.destroy({ where: { name: { [db.Sequelize.Op.like]: 'pmt_%' } }, force: true })
  await db.member_tier.destroy({ where: { name: { [db.Sequelize.Op.like]: 'pmt_%' } }, force: true })
  await db.tenantMembership.destroy({ where: { userId: ids.users }, force: true })
  await db.authorizationContextSession.destroy({ where: { userId: ids.users } })
  await db.user.update({ store: null }, { where: { id: ids.users } })
  await db.user.destroy({ where: { id: ids.users }, force: true })
  await db.location.destroy({ where: { id: ids.stores }, force: true })
  await db.tenant.destroy({ where: { id: ids.tenants }, force: true })
  await db.sequelize.close()
})

test('the three tables carry tenantId + index; the global discount code unique is gone', async () => {
  const [cols] = await db.sequelize.query(
    `SELECT table_name FROM information_schema.columns
      WHERE column_name = 'tenantId' AND table_name IN ('discount', 'member', 'member_tier') ORDER BY 1`
  )
  expect(cols.map((c) => c.table_name)).toEqual(['discount', 'member', 'member_tier'])
  const [idx] = await db.sequelize.query(
    `SELECT indexname FROM pg_indexes WHERE tablename IN ('discount', 'member', 'member_tier')
      AND indexname IN ('ix_discount_tenant', 'ix_member_tenant', 'ix_member_tier_tenant', 'discount_code_key',
                        'uq_discount_tenant_code', 'uq_discount_tenantless_code') ORDER BY 1`
  )
  expect(idx.map((r) => r.indexname)).toEqual([
    'ix_discount_tenant', 'ix_member_tenant', 'ix_member_tier_tenant', 'uq_discount_tenant_code', 'uq_discount_tenantless_code'
  ])
})

describe('tenant follows the outlet on every write path', () => {
  test('create (API and model), bulkCreate, instance update and static update', async () => {
    const res = await addDiscount(f.ownerA, {})
    expect(res.status).toBe(200)
    expect((await db.discount.findByPk(res.body.data.id)).tenantId).toBe(f.tA.id)

    const member = await db.member.create({ name: uniq('m'), phoneNumber: phone(), store: f.a1.id })
    expect(member.tenantId).toBe(f.tA.id)

    const [t1, t2] = await db.member_tier.bulkCreate([
      { name: uniq('t1'), store: f.a1.id },
      { name: uniq('t2'), store: f.b1.id }
    ])
    expect([t1.tenantId, t2.tenantId]).toEqual([f.tA.id, f.tB.id])
    // W3-z / Z2: a batch with a row on an outlet without a tenant is refused.
    await expect(db.member_tier.bulkCreate([{ name: uniq('t3'), store: f.free.id }])).rejects.toMatchObject({
      code: 'STORE_TENANT_REQUIRED'
    })

    await member.update({ store: f.b1.id })
    expect((await db.member.findByPk(member.id)).tenantId).toBe(f.tB.id)

    await db.member.update({ store: f.a2.id }, { where: { id: member.id } })
    expect((await db.member.findByPk(member.id)).tenantId).toBe(f.tA.id)
  })

  test('a caller-supplied tenantId never overrides the outlet\'s tenant', async () => {
    const member = await db.member.create({ name: uniq('m'), phoneNumber: phone(), store: f.a1.id, tenantId: f.tB.id })
    expect((await db.member.findByPk(member.id)).tenantId).toBe(f.tA.id)
  })

  test('a row without an outlet keeps the tenant it was given (shared rows, W3-y)', async () => {
    const shared = await db.member_tier.create({ name: uniq('shared'), store: null })
    expect(shared.tenantId ?? null).toBeNull()
  })
})

describe('discount codes are per tenant', () => {
  test('two tenants may use the same code; inside one tenant it is a 409, not a 500', async () => {
    const code = uniq('C').toUpperCase().slice(0, 40)
    expect((await addDiscount(f.ownerA, { code })).status).toBe(200)
    const other = await addDiscount(f.ownerB, { code })
    expect(other.status).toBe(200)

    const again = await addDiscount(f.ownerA, { code })
    expect(again.status).toBe(409)
    expect(again.body.code).toBe('CODE_TAKEN')
    expect(await db.discount.count({ where: { code } })).toBe(2)
  })

  test('editing into a code the tenant already uses is a 409; keeping its own code is fine', async () => {
    const code = uniq('E').toUpperCase().slice(0, 40)
    await addDiscount(f.ownerA, { code })
    const mine = await addDiscount(f.ownerA, { code: uniq('M').toUpperCase().slice(0, 40) })
    const edit = (body) =>
      request(app)
        .put(`/discount/edit-discount/${mine.body.data.id}?store=${f.a1.id}`)
        .set('Authorization', `Bearer ${f.ownerA.token}`)
        .send({ name: mine.body.data.name, store: f.a1.id, ...body })
    expect((await edit({ code })).status).toBe(409)
    expect((await edit({ code: mine.body.data.code })).status).toBe(200)
  })

  test('the public lookup needs an outlet and only sees that outlet\'s promo', async () => {
    const code = uniq('L').toUpperCase().slice(0, 40)
    await addDiscount(f.ownerA, { code, name: uniq('promoA'), value: 11 })
    await addDiscount(f.ownerB, { code, name: uniq('promoB'), value: 22 })

    expect((await request(app).get(`/discount/lookup-by-code/${code}`)).status).toBe(400)
    const b = await request(app).get(`/discount/lookup-by-code/${code}`).query({ store: f.b1.id })
    expect(b.status).toBe(200)
    expect(b.body.data.value).toBe(22)
  })
})

test('the backfill takes the outlet\'s tenant, leaves shared / tenant-less rows NULL, and is replay-safe', async () => {
  const insert = (table, store, extra = '') =>
    db.sequelize.query(
      `INSERT INTO "${table}" (name, store${extra ? ', "phoneNumber"' : ''}, "createdAt", "updatedAt")
       VALUES ('${uniq('raw')}', ${store ?? 'NULL'}${extra ? `, '${extra}'` : ''}, NOW(), NOW()) RETURNING id`,
      { type: db.sequelize.QueryTypes.SELECT }
    )
  const [[mA], [mShared], [tB], [tFree]] = await Promise.all([
    insert('member', f.a1.id, phone()),
    insert('member', null, phone()),
    insert('member_tier', f.b1.id),
    insert('member_tier', f.free.id)
  ])
  const [[dA]] = await Promise.all([
    db.sequelize.query(
      `INSERT INTO discount (name, type, value, store, "createdAt", "updatedAt")
       VALUES ('${uniq('raw')}', 'percent', 5, ${f.a2.id}, NOW(), NOW()) RETURNING id`,
      { type: db.sequelize.QueryTypes.SELECT }
    )
  ])

  await migration.up(db.sequelize.getQueryInterface(), db.Sequelize)
  await migration.up(db.sequelize.getQueryInterface(), db.Sequelize)

  const tenantOf = async (model, id) => (await db[model].findByPk(id)).tenantId ?? null
  expect(await tenantOf('member', mA.id)).toBe(f.tA.id)
  expect(await tenantOf('member', mShared.id)).toBeNull()
  expect(await tenantOf('member_tier', tB.id)).toBe(f.tB.id)
  expect(await tenantOf('member_tier', tFree.id)).toBeNull()
  expect(await tenantOf('discount', dA.id)).toBe(f.tA.id)
})
