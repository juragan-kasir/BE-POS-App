const express = require('express')
const request = require('supertest')
const { createUserEndpointLimiter } = require('../utils/rateLimiters')

test('endpoint limiter has an independent bucket per user', async () => {
  const app = express()
  app.use((req, res, next) => {
    req.user = { id: req.headers['x-user'] || 1 }
    next()
  })
  app.get(
    '/limited',
    createUserEndpointLimiter({ windowMs: 60000, max: 2 }),
    (req, res) => res.json({ ok: true })
  )

  for (let i = 0; i < 2; i++) {
    const res = await request(app).get('/limited').set('x-user', '10')
    expect(res.status).toBe(200)
  }
  const other = await request(app).get('/limited').set('x-user', '11')
  expect(other.status).toBe(200)
  const limited = await request(app).get('/limited').set('x-user', '10')
  expect(limited.status).toBe(429)
})
