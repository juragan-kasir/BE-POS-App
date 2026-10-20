process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// N-1 regression: pos sendInvoiceWhatsApp / sendInvoiceEmail loaded the order
// by findByPk(orderId) with NO tenant scoping, letting a store A user disclose
// and exfiltrate a store B order via WhatsApp/email. Both must now scope the
// order load to req.storeId / the caller's store and reject foreign orders
// before any external send is attempted.

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let store1 = null
let store2 = null
let category = null
let order1 = null
let order2 = null
let userAdmin1 = null
let userSuper = null
let admin1Token = null
let superToken = null

beforeAll(async () => {
  store1 = await db.location.create({ name: 'N1_STORE_A', status: 'active' })
  store2 = await db.location.create({ name: 'N1_STORE_B', status: 'active' })
  category = await db.category.create({ name: 'N1_CAT', status: 'active' })

  const suffix = Date.now()
  userAdmin1 = await db.user.create({
    id: 9701,
    userName: `n1_admin_a_${suffix}`,
    roleType: 'admin',
    store: store1.id,
    password: 'x'
  })
  userSuper = await db.user.create({
    id: 9700,
    userName: `n1_super_${suffix}`,
    roleType: 'super_admin',
    password: 'x'
  })

  admin1Token = await signSessionToken(
    {
      id: userAdmin1.id,
      userName: userAdmin1.userName,
      roleType: 'admin',
      store: store1.id
    },
    JWT_SECRET
  )
  superToken = await signSessionToken(
    { id: userSuper.id, userName: userSuper.userName, roleType: 'super_admin' },
    JWT_SECRET
  )

  order1 = await db.order.create({
    orderNumber: `N1-ORD-${suffix}-A`,
    store: store1.id,
    status: 'pending',
    paymentStatus: 'paid',
    totalPrice: 25000,
    subTotal: 25000,
    customerName: 'N1 Customer A'
  })
  order2 = await db.order.create({
    orderNumber: `N1-ORD-${suffix}-B`,
    store: store2.id,
    status: 'pending',
    paymentStatus: 'paid',
    totalPrice: 99999,
    subTotal: 99999,
    customerName: 'N1 LEAKED Customer B'
  })
})

afterAll(async () => {
  await db.order_item.destroy({
    where: { order: [order1?.id, order2?.id].filter(Boolean) },
    force: true
  })
  await db.order.destroy({
    where: { id: [order1?.id, order2?.id].filter(Boolean) },
    force: true
  })
  await db.auditLog.destroy({
    where: { userId: [userAdmin1?.id, userSuper?.id].filter(Boolean) },
    force: true,
    __auditMaintenance: true
  })
  await db.user.destroy({
    where: { id: [userAdmin1?.id, userSuper?.id].filter(Boolean) },
    force: true
  })
  await db.category.destroy({ where: { id: category?.id }, force: true })
  await db.location.destroy({
    where: { id: [store1?.id, store2?.id].filter(Boolean) },
    force: true
  })
})

describe('N-1 POS invoice send/read tenant isolation', () => {
  // The WhatsApp receipt is now the wa.me text (GET /pos/invoice/wa-text);
  // the gateway send endpoint is gone (Fonnte removed).
  const waText = (token, id) =>
    request(app)
      .get(`/pos/invoice/wa-text/${id}`)
      .set('Authorization', `Bearer ${token}`)

  test('store A admin reading store B order WhatsApp text is rejected without leaking details', async () => {
    const res = await waText(admin1Token, order2.id)

    expect([403, 404]).toContain(res.status)
    // response must not reveal store B order fields
    expect(JSON.stringify(res.body)).not.toContain('N1 LEAKED Customer B')
    expect(JSON.stringify(res.body)).not.toContain(String(order2.totalPrice))
  })

  test('store A admin reading their OWN order WhatsApp text still works', async () => {
    const res = await waText(admin1Token, order1.id)

    expect(res.status).toBe(200)
    expect(res.body.data.text).toContain(order1.orderNumber)
  })

  test('store A admin sending store B order via email is rejected without leaking details', async () => {
    const res = await request(app)
      .post('/pos/invoice/send-email')
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({ orderId: order2.id, email: 'attacker@example.com' })

    expect([403, 404]).toContain(res.status)
    expect(JSON.stringify(res.body)).not.toContain('N1 LEAKED Customer B')
  })

  test('store A admin sending their OWN order via email still works', async () => {
    const res = await request(app)
      .post('/pos/invoice/send-email')
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({ orderId: order1.id, email: 'own@example.com' })

    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
  })

  test('super_admin reading a store B order WhatsApp text still works (intentional)', async () => {
    const res = await waText(superToken, order2.id)

    expect(res.status).toBe(200)
    expect(res.body.data.text).toContain(order2.orderNumber)
  })

  test('rejected foreign order does not mutate database state', async () => {
    const before = await db.order.findByPk(order2.id)
    await waText(admin1Token, order2.id)
    const after = await db.order.findByPk(order2.id)
    expect(after.orderNumber).toBe(before.orderNumber)
    expect(after.totalPrice).toBe(before.totalPrice)
  })

  test('the removed WhatsApp gateway endpoints no longer exist', async () => {
    const send = await request(app)
      .post('/pos/invoice/send-wa')
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({ orderId: order1.id, phone: '6281234567890' })
    expect(send.status).toBe(404)
    for (const [method, path] of [
      ['get', '/pos/whatsapp/status'],
      ['post', '/pos/whatsapp/logout'],
      ['post', '/pos/whatsapp/restart']
    ]) {
      const res = await request(app)
        [method](path)
        .set('Authorization', `Bearer ${superToken}`)
      expect(res.status).toBe(404)
    }
  })
})
