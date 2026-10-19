process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// Client request: send the invoice to the member/customer over WhatsApp.
// The message mirrors the printed receipt (same sections and invoice-setting
// switches) and every refusal is coded, carrying the message text so the FE
// can fall back to wa.me when the gateway cannot send.
jest.mock('../utils/whatsappClient', () => {
  const actual = jest.requireActual('../utils/whatsappClient')
  return {
    ...actual,
    getConnectionStatus: jest.fn(async () => ({ ready: true, error: null })),
    sendDocument: jest.fn(async () => {})
  }
})

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const whatsapp = require('../utils/whatsappClient')
const { buildReceiptText } = require('../utils/receiptText')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const ADMIN = 9781
const KASIR = 9782

let store = null
let order = null
let setting = null
let category = null
let product = null
let adminToken = null
let kasirToken = null

const send = (token, body) =>
  request(app)
    .post('/pos/invoice/send-wa')
    .set('Authorization', `Bearer ${token}`)
    .send(body)

describe('buildReceiptText — same content and switches as the printed receipt', () => {
  const base = {
    order: {
      orderNumber: 'INV-1',
      createdAt: '2026-10-19T07:30:00Z',
      cashierName: 'Sari',
      paymentMethod: 'cash',
      subTotal: 55000,
      discountValue: 5000,
      taxRate: 11,
      taxAmount: 5500,
      redeemedPoints: 0,
      totalPrice: 55500
    },
    items: [
      {
        productName: 'Bakso Urat',
        quantity: 2,
        price: 25000,
        totalPrice: 50000,
        options: [{ name: 'Pedas' }]
      },
      { productName: 'Es Teh', quantity: 1, price: 5000, totalPrice: 5000 }
    ],
    store: {
      name: 'Warung Pak Kumis',
      address: 'Jl. Melati 5',
      phoneNumber: '0812',
      socialMedia: [
        { platform: 'Instagram', account: '@pk' },
        { platform: 'TikTok', account: '@pk.tt' }
      ]
    },
    regionNames: { city: 'Bandung', province: 'Jawa Barat' },
    tableName: '7',
    member: { name: 'Budi', tierName: 'Gold', totalPoints: 2450 },
    tender: { cashReceived: 60000, changeGiven: 4500 }
  }

  test('carries header, meta, member, items, totals, tender and footer in receipt order', () => {
    const text = buildReceiptText(base)
    const order = [
      '*WARUNG PAK KUMIS*',
      'Jl. Melati 5',
      'Bandung, Jawa Barat',
      'Telp 0812',
      'No. Invoice: INV-1',
      'Tanggal: 19 Okt 2026',
      'Kasir: Sari',
      'Meja: 7',
      'Pembayaran: cash',
      '*INFO MEMBER*',
      'Tier: Gold',
      'Bakso Urat',
      '  – Pedas',
      '  2 x Rp25.000 = Rp50.000',
      'Subtotal: Rp55.000',
      'Diskon: -Rp5.000',
      'Pajak (11%): Rp5.500',
      '*TOTAL: Rp55.500*',
      'Tunai: Rp60.000',
      'Kembali: Rp4.500',
      '_Terima kasih atas kunjungan Anda_',
      'Instagram: @pk'
    ]
    let at = -1
    for (const piece of order) {
      const next = text.indexOf(piece, at + 1)
      expect({ piece, found: next > at }).toEqual({ piece, found: true })
      at = next
    }
  })

  test('honours the invoice-page switches (store name, address fields, member fields, social by position, footer)', () => {
    const text = buildReceiptText({
      ...base,
      settings: {
        showStoreName: false,
        addressFieldsVisibility: { phone: false },
        memberFieldsVisibility: JSON.stringify({ tier: false }),
        socialMediaVisibility: { 0: false },
        footer: 'Makasih ya'
      }
    })
    expect(text).not.toContain('WARUNG PAK KUMIS')
    expect(text).toContain('Jl. Melati 5')
    expect(text).not.toContain('Telp 0812')
    expect(text).toContain('Nama: Budi')
    expect(text).not.toContain('Gold')
    expect(text).not.toContain('Instagram')
    expect(text).toContain('TikTok: @pk.tt')
    expect(text).toContain('_Makasih ya_')
  })

  test('hiding address and member info drops those blocks entirely', () => {
    const text = buildReceiptText({
      ...base,
      settings: { showAddress: false, showMemberInfo: false }
    })
    expect(text).not.toContain('Jl. Melati')
    expect(text).not.toContain('INFO MEMBER')
    expect(text).toContain('*WARUNG PAK KUMIS*')
  })

  test('no tender lines for a non-cash sale, no table line without a table', () => {
    const text = buildReceiptText({ ...base, tender: null, tableName: null })
    expect(text).not.toContain('Tunai:')
    expect(text).not.toContain('Meja:')
  })
})

describe('POST /pos/invoice/send-wa', () => {
  beforeAll(async () => {
    store = await db.location.create({
      name: 'WA Receipt Store',
      status: 'active',
      address: 'Jl. Kenanga 1',
      socialMedia: [{ platform: 'Instagram', account: '@wa.store' }]
    })
    // As /invoice-page saves it: every switch explicit (the column defaults
    // for showStoreName/showAddress are false).
    setting = await db.invoice_setting.create({
      store: store.id,
      footer: 'Sampai jumpa lagi',
      showStoreName: true,
      showAddress: true,
      showMemberInfo: true,
      showSocialMedia: true
    })
    await db.user.bulkCreate([
      {
        id: ADMIN,
        userName: `wa_admin_${Date.now()}`,
        roleType: 'admin',
        store: store.id,
        password: 'x'
      },
      {
        id: KASIR,
        userName: `wa_kasir_${Date.now()}`,
        roleType: 'kasir',
        store: store.id,
        password: 'x'
      }
    ])
    adminToken = await signSessionToken(
      { id: ADMIN, userName: 'wa_admin', roleType: 'admin', store: store.id },
      JWT_SECRET
    )
    kasirToken = await signSessionToken(
      { id: KASIR, userName: 'wa_kasir', roleType: 'kasir', store: store.id },
      JWT_SECRET
    )
    order = await db.order.create({
      orderNumber: `WA-${Date.now()}`,
      store: store.id,
      status: 'pending',
      paymentStatus: 'paid',
      paymentMethod: 'cash',
      cashierName: 'Sari',
      subTotal: 20000,
      totalPrice: 20000
    })
    category = await db.category.create({
      name: `WA_CAT_${Date.now()}`,
      status: 'active'
    })
    product = await db.product.create({
      nameProduct: 'Mie Ayam',
      category: category.id,
      price: 20000,
      stock: 0
    })
    await db.order_item.create({
      order: order.id,
      product: product.id,
      productName: 'Mie Ayam',
      quantity: 1,
      price: 20000,
      totalPrice: 20000
    })
  })

  afterAll(async () => {
    if (order) {
      await db.order_item.destroy({ where: { order: order.id }, force: true })
      await db.order.destroy({ where: { id: order.id }, force: true })
    }
    if (setting)
      await db.invoice_setting.destroy({
        where: { id: setting.id },
        force: true
      })
    if (product)
      await db.product.destroy({ where: { id: product.id }, force: true })
    if (category)
      await db.category.destroy({ where: { id: category.id }, force: true })
    await db.auditLog.destroy({
      where: { userId: [ADMIN, KASIR] },
      force: true,
      __auditMaintenance: true
    })
    await db.user.destroy({ where: { id: [ADMIN, KASIR] }, force: true })
    await db.location.destroy({ where: { id: store?.id }, force: true })
  })

  beforeEach(() => {
    whatsapp.sendDocument.mockReset().mockResolvedValue()
    whatsapp.getConnectionStatus
      .mockReset()
      .mockResolvedValue({ ready: true, error: null })
  })

  test('sends the receipt text to the normalised number (national form accepted)', async () => {
    const res = await send(kasirToken, {
      orderId: order.id,
      phone: '0812-3456-7890'
    })
    expect(res.status).toBe(200)
    expect(res.body.data.phone).toBe('6281234567890')
    expect(whatsapp.sendDocument).toHaveBeenCalledTimes(1)
    const [to, file, text] = whatsapp.sendDocument.mock.calls[0]
    expect(to).toBe('6281234567890')
    expect(file).toBeNull()
    expect(text).toContain('*WA RECEIPT STORE*')
    expect(text).toContain('Jl. Kenanga 1')
    expect(text).toContain('  1 x Rp20.000 = Rp20.000')
    expect(text).toContain('*TOTAL: Rp20.000*')
    expect(text).toContain('_Sampai jumpa lagi_')
    expect(text).toContain('Instagram: @wa.store')
  })

  test('an invalid number is refused before anything is sent', async () => {
    const res = await send(adminToken, { orderId: order.id, phone: '12' })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('INVALID_PHONE')
    expect(whatsapp.sendDocument).not.toHaveBeenCalled()
  })

  test('gateway not configured → 422 WA_NOT_CONFIGURED with the text for a wa.me fallback', async () => {
    whatsapp.getConnectionStatus.mockResolvedValue({
      ready: false,
      error: 'FONNTE_TOKEN not set'
    })
    const res = await send(adminToken, {
      orderId: order.id,
      phone: '081234567890'
    })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('WA_NOT_CONFIGURED')
    expect(res.body.data.phone).toBe('6281234567890')
    expect(res.body.data.text).toContain('*TOTAL: Rp20.000*')
    expect(whatsapp.sendDocument).not.toHaveBeenCalled()
  })

  test('gateway failure → 502 WA_SEND_FAILED with the text, raw gateway error not leaked', async () => {
    whatsapp.sendDocument.mockRejectedValue(
      new Error('Fonnte: device disconnected token=abc')
    )
    const res = await send(adminToken, {
      orderId: order.id,
      phone: '081234567890'
    })
    expect(res.status).toBe(502)
    expect(res.body.code).toBe('WA_SEND_FAILED')
    expect(res.body.data.text).toContain('Mie Ayam')
    expect(JSON.stringify(res.body)).not.toContain('token=abc')
  })

  test('an unknown order is 404 and sends nothing', async () => {
    const res = await send(adminToken, {
      orderId: 999999999,
      phone: '081234567890'
    })
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('ORDER_NOT_FOUND')
    expect(whatsapp.sendDocument).not.toHaveBeenCalled()
  })

  describe('GET /pos/invoice/wa-text/:orderId (wa.me, no gateway)', () => {
    let otherStore = null
    let otherToken = null
    const OTHER = 9783

    beforeAll(async () => {
      otherStore = await db.location.create({
        name: 'WA Other Store',
        status: 'active'
      })
      await db.user.create({
        id: OTHER,
        userName: `wa_other_${Date.now()}`,
        roleType: 'admin',
        store: otherStore.id,
        password: 'x'
      })
      otherToken = await signSessionToken(
        {
          id: OTHER,
          userName: 'wa_other',
          roleType: 'admin',
          store: otherStore.id
        },
        JWT_SECRET
      )
    })

    afterAll(async () => {
      await db.auditLog.destroy({
        where: { userId: OTHER },
        force: true,
        __auditMaintenance: true
      })
      await db.user.destroy({ where: { id: OTHER }, force: true })
      if (otherStore)
        await db.location.destroy({ where: { id: otherStore.id }, force: true })
    })

    beforeEach(() => {
      whatsapp.sendDocument.mockReset().mockResolvedValue()
      whatsapp.getConnectionStatus
        .mockReset()
        .mockResolvedValue({ ready: false, error: 'not set' })
    })

    const getText = (token, id) =>
      request(app)
        .get(`/pos/invoice/wa-text/${id}`)
        .set('Authorization', `Bearer ${token}`)

    test('returns the same receipt text as the gateway path, sends nothing', async () => {
      const res = await getText(kasirToken, order.id)
      expect(res.status).toBe(200)
      expect(res.body.data.gatewayReady).toBe(false)
      expect(res.body.data.text).toContain('*WA RECEIPT STORE*')
      expect(res.body.data.text).toContain('*TOTAL: Rp20.000*')
      expect(whatsapp.sendDocument).not.toHaveBeenCalled()

      whatsapp.getConnectionStatus.mockResolvedValue({ ready: true })
      await send(kasirToken, { orderId: order.id, phone: '081234567890' })
      expect(whatsapp.sendDocument.mock.calls[0][2]).toBe(res.body.data.text)
    })

    test('reports gatewayReady when the store gateway is configured', async () => {
      whatsapp.getConnectionStatus.mockResolvedValue({ ready: true })
      const res = await getText(adminToken, order.id)
      expect(res.body.data.gatewayReady).toBe(true)
    })

    test("another store's order is 404 and its content is not disclosed", async () => {
      const res = await getText(otherToken, order.id)
      expect(res.status).toBe(404)
      expect(JSON.stringify(res.body)).not.toContain('Mie Ayam')
    })

    test('a non-numeric order id is refused', async () => {
      const res = await getText(adminToken, 'abc')
      expect(res.status).toBe(400)
    })
  })
})
