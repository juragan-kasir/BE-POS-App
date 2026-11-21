process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// member.notes (TEXT) existed in the table and model, but createMemberSchema
// had no `notes` key, so zod stripped it and the laundry customer note was
// never saved. The member schemas and controller now carry it.
describe('member notes are saved, updated and cleared', () => {
  let token = null
  let admin = null
  let tenant = null
  let store = null
  const memberIds = []
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  const suffix = String(Date.now()).slice(-7)

  const addMember = async (extra = {}) => {
    const res = await request(app)
      .post('/member/add-new-member')
      .set('Authorization', `Bearer ${token}`)
      .send({ store: store.id, nameMember: `Notes ${stamp}`, phoneNumber: `0814${suffix}`, status: 'active', ...extra })
    if (res.body?.data?.id) memberIds.push(res.body.data.id)
    return res
  }
  const editMember = (id, body) =>
    request(app)
      .put(`/member/edit-member/${id}?store=${store.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ store: store.id, ...body })
  const storedNotes = async (id) => (await db.member.findByPk(id, { raw: true })).notes

  beforeAll(async () => {
    tenant = await db.tenant.create({ code: `mnotes-${stamp}`, name: 'Member Notes Tenant' })
    admin = await db.user.create({
      userName: `mnotes_admin_${stamp}`,
      email: `mnotes_admin_${stamp}@test.com`,
      roleType: 'super_admin',
      userType: 'admin',
      store: null,
      status: 'active'
    })
    token = await signSessionToken(
      { id: admin.id, userName: admin.userName, roleType: 'super_admin', store: null },
      JWT_SECRET
    )
    const [rows] = await db.sequelize.query("SELECT nextval('location_id_seq') AS id")
    store = await db.location.create({
      id: Number(rows?.[0]?.id),
      name: `MNOTES_${stamp}`,
      status: 'active',
      phoneNumber: '081234567890',
      email: `mnotes_${stamp}@test.com`,
      tenantId: tenant.id,
      createdBy: admin.id
    })
  })

  afterAll(async () => {
    await db.member_point_history.destroy({ where: { member: memberIds }, force: true }).catch(() => {})
    await db.member.destroy({ where: { id: memberIds }, force: true }).catch(() => {})
    await db.location.destroy({ where: { id: store?.id }, force: true }).catch(() => {})
    await db.tenant.destroy({ where: { id: tenant?.id }, force: true }).catch(() => {})
    await db.user.destroy({ where: { id: admin?.id }, force: true }).catch(() => {})
  })

  test('create stores the note and returns it', async () => {
    const res = await addMember({ notes: 'Jangan pakai pewangi' })
    expect(res.status).toBe(201)
    expect(await storedNotes(res.body.data.id)).toBe('Jangan pakai pewangi')
  })

  test('edit updates the note, leaves it when omitted, and clears it with ""', async () => {
    const id = memberIds[0]
    const updated = await editMember(id, { notes: 'Setrika lipat' })
    expect(updated.status).toBe(200)
    expect(await storedNotes(id)).toBe('Setrika lipat')

    const untouched = await editMember(id, { address: 'Jl. Melati 3' })
    expect(untouched.status).toBe(200)
    expect(await storedNotes(id)).toBe('Setrika lipat')

    const cleared = await editMember(id, { notes: '' })
    expect(cleared.status).toBe(200)
    expect(await storedNotes(id)).toBeNull()
  })

  test('a note over the TEXT limit is refused with 400', async () => {
    const res = await editMember(memberIds[0], { notes: 'x'.repeat(5001) })
    expect(res.status).toBe(400)
  })
})
