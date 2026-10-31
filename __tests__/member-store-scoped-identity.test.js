process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

describe('member phone and email are unique per store, not across every business', () => {
  let token = null
  let admin = null
  let tenantX = null
  let tenantY = null
  let storeX = null
  let storeY = null
  const locIds = []
  const memberIds = []
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  const suffix = String(Date.now()).slice(-7)
  const phone = `0813${suffix}`
  const phoneE164 = `+62813${suffix}`
  const email = `rina_${stamp}@example.test`

  const nextLocationId = async () => {
    const [rows] = await db.sequelize.query("SELECT nextval('location_id_seq') AS id")
    return Number(rows?.[0]?.id)
  }

  const makeStore = async (label, tenantId) => {
    const row = await db.location.create({
      id: await nextLocationId(),
      name: `MSI_${label}_${stamp}`,
      status: 'active',
      phoneNumber: '081234567890',
      email: `msi_${label.toLowerCase()}_${stamp}@test.com`,
      tenantId,
      createdBy: admin.id
    })
    locIds.push(row.id)
    return row
  }

  const addMember = async (store, name, extra = {}) => {
    const res = await request(app)
      .post('/member/add-new-member')
      .set('Authorization', `Bearer ${token}`)
      .send({ store, nameMember: name, phoneNumber: phone, status: 'active', ...extra })
    if (res.body?.data?.id) memberIds.push(res.body.data.id)
    return res
  }

  beforeAll(async () => {
    tenantX = await db.tenant.create({ code: `msix-${stamp}`, name: 'MSI Tenant X' })
    tenantY = await db.tenant.create({ code: `msiy-${stamp}`, name: 'MSI Tenant Y' })
    admin = await db.user.create({
      userName: `msi_admin_${stamp}`,
      email: `msi_admin_${stamp}@test.com`,
      roleType: 'super_admin',
      userType: 'admin',
      store: null,
      status: 'active'
    })
    token = await signSessionToken(
      { id: admin.id, userName: admin.userName, roleType: 'super_admin', store: null },
      JWT_SECRET
    )
    storeX = await makeStore('X', tenantX.id)
    storeY = await makeStore('Y', tenantY.id)
  })

  afterAll(async () => {
    await db.member_point_history.destroy({ where: { member: memberIds }, force: true }).catch(() => {})
    await db.member.destroy({ where: { id: memberIds }, force: true }).catch(() => {})
    await db.location.destroy({ where: { id: locIds }, force: true }).catch(() => {})
    await db.tenant.destroy({ where: { id: [tenantX?.id, tenantY?.id] }, force: true }).catch(() => {})
    await db.user.destroy({ where: { id: admin?.id }, force: true }).catch(() => {})
  })

  test('the same phone and email can join another business', async () => {
    const first = await addMember(storeX.id, `Rina X ${stamp}`, { email })
    expect([200, 201]).toContain(first.status)
    const second = await addMember(storeY.id, `Rina Y ${stamp}`, { email })
    expect([200, 201]).toContain(second.status)
    const rows = await db.member.findAll({ where: { phoneNumber: phoneE164 }, raw: true })
    expect(rows.map((r) => r.store).sort()).toEqual([storeX.id, storeY.id].sort())
  })

  test('within one store the phone is still unique', async () => {
    const res = await addMember(storeX.id, `Rina X dup ${stamp}`)
    expect(res.status).toBe(409)
    expect(res.body.message).toBe('Nomor telepon sudah terdaftar')
  })

  test('within one store the email is still unique', async () => {
    const res = await addMember(storeX.id, `Other X ${stamp}`, {
      phoneNumber: `0812${suffix}`,
      email
    })
    expect(res.status).toBe(409)
    expect(res.body.message).toBe('Email sudah terdaftar')
  })

  test('an update checks the phone inside the member own store only', async () => {
    const created = await addMember(storeY.id, `Budi Y ${stamp}`, { phoneNumber: `0811${suffix}` })
    expect([200, 201]).toContain(created.status)
    const takenElsewhere = await addMember(storeX.id, `Budi X ${stamp}`, {
      phoneNumber: `0815${suffix}`
    })
    expect([200, 201]).toContain(takenElsewhere.status)

    const res = await request(app)
      .put(`/member/edit-member/${created.body.data.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ phoneNumber: `0815${suffix}` })
    expect(res.status).toBe(200)
  })

  test('changing points by phone without a store refuses an ambiguous phone', async () => {
    const res = await request(app)
      .put(`/member/edit-point-member/${phone}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ points: 10 })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('MEMBER_STORE_REQUIRED')
    const rows = await db.member.findAll({ where: { phoneNumber: phoneE164 }, raw: true })
    expect(rows.every((r) => Number(r.totalPoints) === 0)).toBe(true)
  })

  test('changing points by phone with a store updates that store member', async () => {
    const res = await request(app)
      .put(`/member/edit-point-member/${phone}`)
      .query({ store: storeY.id })
      .set('Authorization', `Bearer ${token}`)
      .send({ points: 10 })
    expect(res.status).toBe(200)
    const y = await db.member.findOne({ where: { phoneNumber: phoneE164, store: storeY.id } })
    const x = await db.member.findOne({ where: { phoneNumber: phoneE164, store: storeX.id } })
    expect(Number(y.totalPoints)).toBe(10)
    expect(Number(x.totalPoints)).toBe(0)
  })

  test('the database enforces the same rule', async () => {
    const extra = await db.member.create({
      store: storeY.id,
      name: `Direct Y ${stamp}`,
      phoneNumber: `+62819${suffix}`,
      status: 'active'
    })
    memberIds.push(extra.id)
    const otherStore = await db.member.create({
      store: storeX.id,
      name: `Direct X ${stamp}`,
      phoneNumber: `+62819${suffix}`,
      status: 'active'
    })
    memberIds.push(otherStore.id)
    await expect(
      db.member.create({
        store: storeX.id,
        name: `Direct X2 ${stamp}`,
        phoneNumber: `+62819${suffix}`,
        status: 'active'
      })
    ).rejects.toThrow()
  })
})
