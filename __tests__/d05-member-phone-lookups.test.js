process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'
process.env.FONNTE_TOKEN = 'test-token'

// D-05 phone identity lookups (locked contract): every phone identity
// comparison canonicalizes to E.164 first.
// - invoice member join: order.customerPhone stays historical/raw, is
//   canonicalized at comparison time, matches only canonical
//   member.phoneNumber; unparseable values (incl. GUEST-*) never join
// - points adjustment (/member/edit-point-member/:phoneNumber): canonical
//   lookup of national/international input
// - admin/POS phone search: national input still finds E.164-stored members
//
// Phone range 0815000002xx and D05L_* names are unique to this file.
jest.mock('../utils/whatsappClient', () => {
  const actual = jest.requireActual('../utils/whatsappClient')
  return {
    ...actual,
    getConnectionStatus: jest.fn(async () => ({ ready: true, hasQR: false, qrBase64: null, error: null })),
    sendDocument: jest.fn(async () => {})
  }
})

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const whatsapp = require('../utils/whatsappClient')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let store = null
let adminToken = null
const orderIds = []

beforeAll(async () => {
  store = await db.location.create({ name: 'D05L_STORE', status: 'active' })
  await db.user.create({
    id: 9301,
    userName: 'd05l_admin',
    email: 'p14-9301-d05l@test.com',
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active',
    fullName: 'd05l_admin'
  })
  adminToken = await signSessionToken(
    { id: 9301, userName: 'd05l_admin', roleType: 'admin', store: store.id },
    JWT_SECRET
  )
})

afterAll(async () => {
  const members = await db.member.findAll({ where: { store: store?.id }, paranoid: false, raw: true })
  await db.member_point_history.destroy({ where: { member: members.map((m) => m.id) }, force: true })
  await db.order_item.destroy({ where: { order: orderIds }, force: true })
  await db.order.destroy({ where: { id: orderIds }, force: true })
  await db.member.destroy({ where: { store: store?.id }, force: true })
  await db.auditLog.destroy({ where: { userId: 9301 }, force: true, __auditMaintenance: true })
  await db.user.destroy({ where: { id: 9301 }, force: true })
  await db.location.destroy({ where: { id: store?.id }, force: true })
})

beforeEach(() => {
  whatsapp.sendDocument.mockClear()
})

const createOrder = async (customerPhone) => {
  const order = await db.order.create({
    orderNumber: `D05L-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    store: store.id,
    status: 'pending',
    paymentStatus: 'paid',
    totalPrice: 10000,
    subTotal: 10000,
    customerName: 'D05L Customer',
    customerPhone
  })
  orderIds.push(order.id)
  return order
}

const sendInvoice = (orderId) =>
  request(app)
    .post('/pos/invoice/send-wa')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ orderId, phone: '6281234567890' })

const captionOfLastSend = () => {
  expect(whatsapp.sendDocument).toHaveBeenCalledTimes(1)
  return whatsapp.sendDocument.mock.calls[0][2]
}

describe('D-05 invoice member join (canonical E.164 on both sides)', () => {
  beforeAll(async () => {
    await db.member.create({
      store: store.id,
      name: 'D05L Canonical Member',
      phoneNumber: '+6281500000201',
      totalPoints: 150
    })
  })

  test('historical national-form order phone joins the canonical member', async () => {
    const order = await createOrder('081500000201')
    const res = await sendInvoice(order.id)
    expect(res.status).toBe(200)
    const caption = captionOfLastSend()
    expect(caption).toContain('INFO MEMBER')
    expect(caption).toContain('D05L Canonical Member')
  })

  test('historical international/formatted order phone joins the same member', async () => {
    const order = await createOrder('+62 815-0000-0201')
    const res = await sendInvoice(order.id)
    expect(res.status).toBe(200)
    const caption = captionOfLastSend()
    expect(caption).toContain('INFO MEMBER')
    expect(caption).toContain('D05L Canonical Member')
  })

  test('order.customerPhone is never rewritten by the join', async () => {
    const order = await createOrder('0815-0000-0201')
    await sendInvoice(order.id)
    const fresh = await db.order.findByPk(order.id, { raw: true })
    expect(fresh.customerPhone).toBe('0815-0000-0201')
  })

  test('unparseable historical order phone never joins (even on a raw-equal row)', async () => {
    // A legacy unparseable member value that equals the order value byte for
    // byte: the removed raw fallback would have joined these.
    await db.member.create({
      store: store.id,
      name: 'D05L Legacy Raw Member',
      phoneNumber: '12345678',
      totalPoints: 99
    })
    const order = await createOrder('12345678')
    const res = await sendInvoice(order.id)
    expect(res.status).toBe(200)
    const caption = captionOfLastSend()
    expect(caption).not.toContain('INFO MEMBER')
    expect(caption).not.toContain('D05L Legacy Raw Member')
  })

  test('guest-like order phone never joins a guest member', async () => {
    const guestPhone = 'GUEST-d05l-0000-guest'
    await db.member.create({
      store: store.id,
      name: 'D05L Guest Member',
      phoneNumber: guestPhone,
      totalPoints: 42
    })
    const order = await createOrder(guestPhone)
    const res = await sendInvoice(order.id)
    expect(res.status).toBe(200)
    const caption = captionOfLastSend()
    expect(caption).not.toContain('INFO MEMBER')
    expect(caption).not.toContain('D05L Guest Member')
  })
})

describe('D-05 points adjustment lookup (canonical phone)', () => {
  let member = null

  beforeAll(async () => {
    member = await db.member.create({
      store: store.id,
      name: 'D05L Points Member',
      phoneNumber: '+6281500000211',
      totalPoints: 10,
      lifetimePoints: 10
    })
  })

  const adjust = (phonePath, points) =>
    request(app)
      .put(`/member/edit-point-member/${encodeURIComponent(phonePath)}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ points })

  test('national-form path finds the E.164-stored member', async () => {
    const res = await adjust('081500000211', 5)
    expect(res.status).toBe(200)
    const fresh = await db.member.findByPk(member.id, { raw: true })
    expect(fresh.totalPoints).toBe(15)
  })

  test('international-form path finds the same member', async () => {
    const res = await adjust('+6281500000211', 5)
    expect(res.status).toBe(200)
    const fresh = await db.member.findByPk(member.id, { raw: true })
    expect(fresh.totalPoints).toBe(20)
  })

  test('numeric member id lookup keeps working', async () => {
    const res = await adjust(String(member.id), 1)
    expect(res.status).toBe(200)
    const fresh = await db.member.findByPk(member.id, { raw: true })
    expect(fresh.totalPoints).toBe(21)
  })

  test('an unknown phone does not match', async () => {
    const res = await adjust('081500000299', 5)
    expect(res.status).toBe(403)
  })

  test('an unparseable value never matches by raw phone', async () => {
    const legacy = await db.member.create({
      store: store.id,
      name: 'D05L Legacy Points Member',
      phoneNumber: 'legacy-raw-phone',
      totalPoints: 5,
      lifetimePoints: 5
    })
    const res = await adjust('legacy-raw-phone', 5)
    expect(res.status).toBe(403)
    const fresh = await db.member.findByPk(legacy.id, { raw: true })
    expect(fresh.totalPoints).toBe(5)
  })

  test("a guest member's own server-generated GUEST-* value matches exactly", async () => {
    const guestPhone = 'GUEST-d05l-points-guest'
    const guest = await db.member.create({
      store: store.id,
      name: 'D05L Points Guest',
      phoneNumber: guestPhone,
      totalPoints: 7,
      lifetimePoints: 7
    })
    const res = await adjust(guestPhone, 3)
    expect(res.status).toBe(200)
    const fresh = await db.member.findByPk(guest.id, { raw: true })
    expect(fresh.totalPoints).toBe(10)
  })
})

describe('D-05 admin/POS phone search', () => {
  beforeAll(async () => {
    await db.member.create({
      store: store.id,
      name: 'D05L Search Member',
      phoneNumber: '+6281500000221'
    })
  })

  const search = (query) =>
    request(app)
      .get('/member/get-member')
      .query({ ...query, page: 1, limit: 10 })
      .set('Authorization', `Bearer ${adminToken}`)

  const names = (res) => (res.body.data || []).map((m) => m.name)

  test('national-form search finds the E.164-stored member', async () => {
    const res = await search({ phoneNumber: '081500000221' })
    expect(res.status).toBe(200)
    expect(names(res)).toContain('D05L Search Member')
  })

  test('partial national-form search finds it by canonical prefix', async () => {
    const res = await search({ phoneNumber: '08150000022' })
    expect(res.status).toBe(200)
    expect(names(res)).toContain('D05L Search Member')
  })

  test('canonical +62 search finds it', async () => {
    const res = await search({ phoneNumber: '+6281500000221' })
    expect(res.status).toBe(200)
    expect(names(res)).toContain('D05L Search Member')
  })

  test('formatted international search finds it', async () => {
    const res = await search({ phoneNumber: '+62 815-0000-0221' })
    expect(res.status).toBe(200)
    expect(names(res)).toContain('D05L Search Member')
  })

  test('raw substring search is preserved', async () => {
    const res = await search({ phoneNumber: '00000221' })
    expect(res.status).toBe(200)
    expect(names(res)).toContain('D05L Search Member')
  })

  test('non-phone text is not parsed as a phone and matches nothing', async () => {
    const res = await search({ phoneNumber: 'D05L Search' })
    expect(res.status).toBe(200)
    expect(names(res)).not.toContain('D05L Search Member')
  })

  test('name search is unchanged', async () => {
    const res = await search({ nameMember: 'D05L Search' })
    expect(res.status).toBe(200)
    expect(names(res)).toContain('D05L Search Member')
  })
})
