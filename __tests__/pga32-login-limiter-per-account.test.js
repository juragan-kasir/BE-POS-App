process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// PGA-32 (product-grade audit 2026-11-02): the login limiter bucketed only by
// client IP, so staff terminals sharing one shop NAT throttled each other.

const request = require('supertest')
const app = require('../api/index')

const attempt = (userName) => request(app).post('/auth/login').send({ userName, password: 'Rahasia123!' })

describe('PGA-32: login rate limit is per account, not per shared NAT IP', () => {
  test('a different account on the same IP is not locked out by the first account', async () => {
    const accountA = `pga32_a_${Date.now()}@test.com`
    const accountB = `pga32_b_${Date.now()}@test.com`

    for (let i = 0; i < 30; i += 1) {
      const res = await attempt(accountA)
      expect(res.status).not.toBe(429)
    }

    const blocked = await attempt(accountA)
    expect(blocked.status).toBe(429)

    const other = await attempt(accountB)
    expect(other.status).not.toBe(429)
  })
})
