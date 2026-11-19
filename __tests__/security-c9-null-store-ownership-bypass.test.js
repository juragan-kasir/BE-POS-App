process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let storeA, tokenA, superToken

describe('C-9 null-store (global) record ownership bypass', () => {
  beforeAll(async () => {
    storeA = await db.location.create(await withTestTenant({ name: 'C9_STORE_A', status: 'active' }))

    // P1-4: central gate denies unknown caller identities; these rows give
    // the caller ids real identities. Assertions below are unchanged.
    for (const [id, userName, roleType, userType, store] of [
      [88901, 'c9_admin_a', 'admin', 'admin', storeA.id],
      [88902, 'c9_super', 'super_admin', 'admin', null]
    ]) {
      await db.user.create({
        id,
        userName,
        email: `p14-${id}-c9@test.com`,
        roleType,
        userType,
        store,
        status: 'active',
        fullName: userName
      })
    }
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
    tokenA = await signSessionToken(
      { id: 88901, userName: 'c9_admin_a', roleType: 'admin', store: storeA.id },
      JWT_SECRET
    )
    superToken = await signSessionToken(
      { id: 88902, userName: 'c9_super', roleType: 'super_admin', store: null },
      JWT_SECRET
    )
  })

  afterAll(async () => {
    await db.user.destroy({ where: { id: [88901, 88902] }, force: true })
    await db.location.destroy({ where: { id: storeA.id }, force: true })
  })

  describe('member.js', () => {
    let globalMember

    beforeEach(async () => {
      globalMember = await db.member.create({
        name: 'C9_GLOBAL_MEMBER',
        phoneNumber: `08${Date.now()}`.slice(0, 13),
        store: null,
        totalPoints: 0,
        status: 'active'
      })
    })

    afterEach(async () => {
      await db.member.destroy({ where: { id: globalMember.id }, force: true })
    })

    test('store A admin CANNOT edit a null-store (global) member', async () => {
      const res = await request(app)
        .put(`/member/edit-member/${globalMember.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ nameMember: 'PWNED' })

      expect(res.status).not.toBe(200)
      const fresh = await db.member.findByPk(globalMember.id)
      expect(fresh.name).toBe('C9_GLOBAL_MEMBER')
    })

    test('store A admin CANNOT delete a null-store (global) member', async () => {
      const res = await request(app)
        .delete(`/member/delete-member/${globalMember.id}`)
        .set('Authorization', `Bearer ${tokenA}`)

      expect(res.status).not.toBe(200)
      const fresh = await db.member.findByPk(globalMember.id)
      expect(fresh).not.toBeNull()
    })

    test('super_admin CAN edit a null-store (global) member', async () => {
      const res = await request(app)
        .put(`/member/edit-member/${globalMember.id}`)
        .set('Authorization', `Bearer ${superToken}`)
        .send({ nameMember: 'EDITED_BY_SUPER' })

      expect(res.status).toBe(200)
      const fresh = await db.member.findByPk(globalMember.id)
      expect(fresh.name).toBe('EDITED_BY_SUPER')
    })
  })

  describe('type-payment.js', () => {
    let globalTypePayment

    beforeEach(async () => {
      globalTypePayment = await db.type_payment.create({
        name: 'C9_GLOBAL_TYPE_PAYMENT',
        store: null,
        type: 'cash',
        status: 'active',
        isSystem: false
      })
    })

    afterEach(async () => {
      await db.type_payment.destroy({ where: { id: globalTypePayment.id }, force: true })
    })

    test('store A admin CANNOT edit a null-store (global) type_payment', async () => {
      const res = await request(app)
        .put(`/type-payment/edit-type-payment/${globalTypePayment.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'PWNED_TYPE_PAYMENT' })

      expect(res.status).not.toBe(200)
      const fresh = await db.type_payment.findByPk(globalTypePayment.id)
      expect(fresh.name).toBe('C9_GLOBAL_TYPE_PAYMENT')
    })

    test('super_admin CAN edit a null-store (global) type_payment', async () => {
      const res = await request(app)
        .put(`/type-payment/edit-type-payment/${globalTypePayment.id}`)
        .set('Authorization', `Bearer ${superToken}`)
        .send({ name: 'EDITED_BY_SUPER' })

      expect(res.status).toBe(200)
      const fresh = await db.type_payment.findByPk(globalTypePayment.id)
      expect(fresh.name).toBe('EDITED_BY_SUPER')
    })
  })

  describe('supplier.js', () => {
    let globalSupplier

    beforeEach(async () => {
      globalSupplier = await db.supplier.create({
        name: 'C9_GLOBAL_SUPPLIER',
        store: null,
        status: 'active'
      })
    })

    afterEach(async () => {
      await db.supplier.destroy({ where: { id: globalSupplier.id }, force: true })
    })

    test('store A admin CAN read a null-store (global) supplier — intentional, matches list-query semantics', async () => {
      const res = await request(app)
        .get(`/supplier/detail/${globalSupplier.id}`)
        .set('Authorization', `Bearer ${tokenA}`)

      // Global suppliers are already treated as visible to every store by
      // the existing list-query Op.or:[{store:null},{store:contains:[id]}]
      // convention — read access here is intentionally consistent with
      // that, not a bypass.
      expect(res.status).toBe(200)
    })

    test('store A admin CANNOT update (mutate) a null-store (global) supplier', async () => {
      const res = await request(app)
        .put(`/supplier/${globalSupplier.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: 'PWNED_SUPPLIER' })

      expect(res.status).not.toBe(200)
      const fresh = await db.supplier.findByPk(globalSupplier.id)
      expect(fresh.name).toBe('C9_GLOBAL_SUPPLIER')
    })

    test('super_admin CAN update a null-store (global) supplier', async () => {
      const res = await request(app)
        .put(`/supplier/${globalSupplier.id}`)
        .set('Authorization', `Bearer ${superToken}`)
        .send({ name: 'EDITED_BY_SUPER' })

      expect(res.status).toBe(200)
      const fresh = await db.supplier.findByPk(globalSupplier.id)
      expect(fresh.name).toBe('EDITED_BY_SUPER')
    })

    test('store A admin CANNOT delete a null-store (global) supplier', async () => {
      const res = await request(app)
        .delete(`/supplier/${globalSupplier.id}`)
        .set('Authorization', `Bearer ${tokenA}`)

      expect(res.status).not.toBe(200)
      const fresh = await db.supplier.findByPk(globalSupplier.id)
      expect(fresh).not.toBeNull()
    })

    test('super_admin CAN delete a null-store (global) supplier', async () => {
      const res = await request(app)
        .delete(`/supplier/${globalSupplier.id}`)
        .set('Authorization', `Bearer ${superToken}`)

      expect(res.status).toBe(200)
      const fresh = await db.supplier.findByPk(globalSupplier.id)
      expect(fresh).toBeNull()
    })
  })
})
