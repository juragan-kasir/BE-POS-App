'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'
// Test-only configuration: shrink the global window so this suite stays fast.
// Production keeps the 500 requests / 15 minutes defaults. The previous
// values are restored afterwards because Jest shares process.env between
// test files in the same worker; leaving a 3-request limit behind would
// throttle unrelated suites.
const PREVIOUS_RATE_LIMIT_MAX = process.env.GLOBAL_RATE_LIMIT_MAX
const PREVIOUS_RATE_LIMIT_WINDOW_MS = process.env.GLOBAL_RATE_LIMIT_WINDOW_MS
process.env.GLOBAL_RATE_LIMIT_MAX = '3'
process.env.GLOBAL_RATE_LIMIT_WINDOW_MS = '60000'

const request = require('supertest')
const jwt = require('jsonwebtoken')
const app = require('../api/index')

const SECRET = process.env.JWT_SECRET_KEY
const LIMIT = Number(process.env.GLOBAL_RATE_LIMIT_MAX)

afterAll(() => {
  if (PREVIOUS_RATE_LIMIT_MAX === undefined) {
    delete process.env.GLOBAL_RATE_LIMIT_MAX
  } else {
    process.env.GLOBAL_RATE_LIMIT_MAX = PREVIOUS_RATE_LIMIT_MAX
  }
  if (PREVIOUS_RATE_LIMIT_WINDOW_MS === undefined) {
    delete process.env.GLOBAL_RATE_LIMIT_WINDOW_MS
  } else {
    process.env.GLOBAL_RATE_LIMIT_WINDOW_MS = PREVIOUS_RATE_LIMIT_WINDOW_MS
  }
})

// RFC 5737 TEST-NET-3 addresses: one bucket per scenario.
const IP_FORGED = '203.0.113.41'
const IP_WRONG_SECRET = '203.0.113.42'
const IP_EXPIRED = '203.0.113.43'
const IP_VALID = '203.0.113.44'

const hit = (ip, authorization) => {
  let req = request(app).get('/').set('X-Forwarded-For', ip)
  if (authorization) req = req.set('Authorization', authorization)
  return req
}

const exhaust = async (ip, authorization) => {
  for (let i = 0; i < LIMIT; i++) {
    const res = await hit(ip, authorization)
    expect(res.status).toBe(200)
  }
  return hit(ip, authorization)
}

describe('global rate limiter — only verified credentials bypass', () => {
  test('a forged Bearer token is still throttled', async () => {
    const blocked = await exhaust(IP_FORGED, 'Bearer definitely-not-a-jwt')
    expect(blocked.status).toBe(429)
  })

  test('a JWT signed with the wrong secret is still throttled', async () => {
    const token = jwt.sign({ id: 1, sessionId: 'a'.repeat(32) }, 'wrong-secret')
    const blocked = await exhaust(IP_WRONG_SECRET, `Bearer ${token}`)
    expect(blocked.status).toBe(429)
  })

  test('an expired JWT is still throttled', async () => {
    const token = jwt.sign(
      {
        id: 1,
        sessionId: 'b'.repeat(32),
        exp: Math.floor(Date.now() / 1000) - 60
      },
      SECRET
    )
    const blocked = await exhaust(IP_EXPIRED, `Bearer ${token}`)
    expect(blocked.status).toBe(429)
  })

  test('a cryptographically valid JWT remains exempt', async () => {
    // Signature + expiry are the limiter's contract; session liveness is
    // enforced later by canonical authorization on protected routes.
    const token = jwt.sign({ id: 1, sessionId: 'c'.repeat(32) }, SECRET)
    for (let i = 0; i < LIMIT + 2; i++) {
      const res = await hit(IP_VALID, `Bearer ${token}`)
      expect(res.status).toBe(200)
    }
  })
})
