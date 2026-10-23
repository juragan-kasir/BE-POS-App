process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process')
  return { ...actual, execSync: jest.fn(() => 'Printed') }
})

const request = require('supertest')
const { execSync } = require('child_process')
const app = require('../api/index')
const db = require('../db/models')
const { createAuthenticatedTestSession } = require('../test-helpers/authSession')

const PREFIX = `print_hardening_${Date.now()}`
let store = null
let kasir = null
const createdUserIds = []

const bearer = (token) => ({ Authorization: `Bearer ${token}` })

const withHops = async (hops, fn) => {
  const previous = process.env.TRUST_PROXY_HOPS
  if (hops == null) delete process.env.TRUST_PROXY_HOPS
  else process.env.TRUST_PROXY_HOPS = String(hops)
  try {
    return await fn()
  } finally {
    if (previous == null) delete process.env.TRUST_PROXY_HOPS
    else process.env.TRUST_PROXY_HOPS = previous
  }
}

const post = (data, { forwardedFor, extra } = {}) => {
  let req = request(app)
    .post('/print-thermal')
    .set(bearer(kasir.token))
  if (forwardedFor) req = req.set('X-Forwarded-For', forwardedFor)
  return req.send(extra ? { data, ...extra } : { data })
}

beforeAll(async () => {
  store = await db.location.create({ name: `${PREFIX}_STORE`, status: 'active' })
  kasir = await createAuthenticatedTestSession({
    userName: `${PREFIX}_kasir`,
    email: `${PREFIX}_kasir@test.com`,
    password: 'Test12345!',
    fullName: `${PREFIX} Kasir`,
    userType: 'kasir',
    roleType: 'kasir',
    status: 'active',
    store: store.id
  })
  createdUserIds.push(kasir.user.id)
})

afterAll(async () => {
  if (createdUserIds.length) {
    await db.authorizationContextSession
      .destroy({ where: { userId: createdUserIds }, force: true })
      .catch(() => {})
    await db.user
      .destroy({ where: { id: createdUserIds }, force: true })
      .catch(() => {})
  }
  await db.location.destroy({ where: { id: store?.id }, force: true }).catch(() => {})
})

beforeEach(() => {
  execSync.mockClear()
})

describe('POST /print-thermal — network boundary', () => {
  test('rejects a forged private X-Forwarded-For when no proxy is declared', async () => {
    const res = await withHops(null, () =>
      post({ orderNumber: 'INV-1' }, { forwardedFor: '192.168.1.5' })
    )
    expect(res.status).toBe(403)
    expect(execSync).not.toHaveBeenCalled()
  })

  test('rejects a public client when one proxy is declared', async () => {
    const res = await withHops(1, () =>
      post({ orderNumber: 'INV-1' }, { forwardedFor: '8.8.8.8' })
    )
    expect(res.status).toBe(403)
    expect(execSync).not.toHaveBeenCalled()
  })

  test('accepts a private client behind one declared proxy', async () => {
    const res = await withHops(1, () =>
      post({ orderNumber: 'INV-1' }, { forwardedFor: '192.168.1.10' })
    )
    expect(res.status).toBe(200)
    expect(execSync).toHaveBeenCalledTimes(1)
  })
})

describe('POST /print-thermal — payload allowlist', () => {
  test('drops receipt keys the printer never reads', async () => {
    const res = await post({
      storeName: 'TOKO ANDA',
      orderNumber: 'INV-1',
      items: [{ name: 'Bakso', qty: 2, price: 18000, total: 36000 }],
      total: 36000,
      paymentMethodLabel: 'Tunai',
      table: 'Meja 1',
      showTender: true
    })
    expect(res.status).toBe(200)
    const printed = execSync.mock.calls[0][1].input
    expect(printed).toContain('TOKO ANDA')
    expect(printed).toContain('Bakso')
    expect(printed).not.toContain('Tunai')
    expect(printed).not.toContain('Meja 1')
  })

  test('strips ESC control bytes from user-supplied text', async () => {
    const res = await post({
      storeName: 'TOKO\x1b@HACK',
      orderNumber: 'INV-1'
    })
    expect(res.status).toBe(200)
    const printed = execSync.mock.calls[0][1].input
    expect(printed).not.toContain('TOKO\x1b@HACK')
    expect(printed).toContain('TOKO@HACK')
  })

  test('accepts null optional amounts from the receipt model', async () => {
    const res = await post({
      orderNumber: 'INV-1',
      memberPoints: null,
      discount: null,
      serviceCharge: null,
      tax: null
    })
    expect(res.status).toBe(200)
    expect(execSync).toHaveBeenCalledTimes(1)
  })

  test('rejects a negative amount', async () => {
    const res = await post({ orderNumber: 'INV-1', total: -1 })
    expect(res.status).toBe(400)
    expect(execSync).not.toHaveBeenCalled()
  })

  test('rejects an unknown top-level envelope key', async () => {
    const res = await post({ orderNumber: 'INV-1' }, { extra: { extra: 'nope' } })
    expect(res.status).toBe(400)
    expect(execSync).not.toHaveBeenCalled()
  })

  test('rejects a body larger than 64 KiB before printing', async () => {
    const res = await post({
      orderNumber: 'INV-1',
      junk: 'x'.repeat(70 * 1024)
    })
    expect(res.status).toBe(413)
    expect(execSync).not.toHaveBeenCalled()
  })
})

describe('POST /print-thermal — rate limit', () => {
  test('stops answering after 30 requests from one public client', async () => {
    await withHops(1, async () => {
      const send = () =>
        request(app)
          .post('/print-thermal')
          .set('X-Forwarded-For', '198.51.100.7')
          .send({ data: { orderNumber: 'INV-1' } })

      for (let i = 0; i < 30; i += 1) {
        const res = await send()
        expect(res.status).toBe(401)
      }

      const limited = await send()
      expect(limited.status).toBe(429)
      expect(execSync).not.toHaveBeenCalled()
    })
  })
})
