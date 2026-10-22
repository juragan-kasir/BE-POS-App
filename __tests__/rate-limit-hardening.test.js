process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'
process.env.GLOBAL_RATE_LIMIT_WINDOW_MS = '60000'
process.env.GLOBAL_RATE_LIMIT_MAX = '2'
process.env.AUTH_RATE_LIMIT_WINDOW_MS = '60000'
process.env.AUTH_RATE_LIMIT_MAX = '3'

const request = require('supertest')
const jwt = require('jsonwebtoken')
const app = require('../api/index')

const token = jwt.sign(
  { id: 987654, sessionId: 'a'.repeat(64) },
  process.env.JWT_SECRET_KEY || 'secret-key-user'
)

describe('rate limiting', () => {
  test('authenticated requests are bounded per user', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .get('/faq/faq?limit=1')
        .set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
    }

    const limited = await request(app)
      .get('/faq/faq?limit=1')
      .set('Authorization', `Bearer ${token}`)
    expect(limited.status).toBe(429)
  })

  test('forged credentials do not get the authenticated bucket', async () => {
    for (let i = 0; i < 2; i++) {
      const res = await request(app)
        .get('/faq/faq?limit=1')
        .set('Authorization', 'Bearer not-a-valid-jwt')
      expect(res.status).toBe(200)
    }

    const limited = await request(app)
      .get('/faq/faq?limit=1')
      .set('Authorization', 'Bearer not-a-valid-jwt')
    expect(limited.status).toBe(429)
  })
})
