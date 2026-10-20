require('dotenv').config()

const request = require('supertest')
const express = require('express')
const jwt = require('jsonwebtoken')
const reportConfigRoutes = require('../api/routes/reportConfig')

jest.mock('../db/models', () => ({
  // AUTH-1 P2: canonical authentication loads the session joined with its
  // account in one query; the account row (not the JWT) is the authority.
  authorizationContextSession: {
    findOne: jest.fn(({ where }) => {
      const account = (id, roleType) => ({ id, roleType, store: null, disabledAt: null, deletedAt: null })
      const sessions = {
        ['a'.repeat(64)]: { userId: 9999, user: account(9999, 'super_admin') },
        ['b'.repeat(64)]: { userId: 9998, user: account(9998, 'kasir') }
      }
      const s = sessions[where.sessionId]
      return Promise.resolve(
        s ? { ...s, sessionId: where.sessionId, revokedAt: null, expiresAt: new Date(Date.now() + 3600000) } : null
      )
    })
  },
  reportConfig: {
    findAll: jest.fn(() => Promise.resolve([])),
    findOne: jest.fn(() => Promise.resolve(null)),
    findOrCreate: jest.fn(({ defaults }) => Promise.resolve([{ ...defaults, save: jest.fn() }, true]))
  }
}))

const secret = process.env.JWT_SECRET_KEY || 'secret-key-user'
const token = jwt.sign({ id: 9999, sessionId: 'a'.repeat(64), userName: 'superadmin', roleType: 'super_admin' }, secret)
const kasirToken = jwt.sign({ id: 9998, sessionId: 'b'.repeat(64), userName: 'kasir', roleType: 'kasir' }, secret)

const app = express()
app.use(express.json())
app.use('/report-config', reportConfigRoutes)

describe('reportConfig routes', () => {
  test('GET /report-config returns list', async () => {
    const res = await request(app)
      .get('/report-config')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body.success).toBe(true)
    expect(Array.isArray(res.body.data)).toBe(true)
  })

  test('GET /report-config/meta returns column catalogs', async () => {
    const res = await request(app)
      .get('/report-config/meta')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body.success).toBe(true)
    const keys = res.body.data.map((d) => d.key)
    expect(keys).toContain('daily')
    expect(keys).toContain('sales')
  })

  test('GET /report-config/:key returns single config', async () => {
    const res = await request(app)
      .get('/report-config/daily')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.key).toBe('daily')
  })

  test('PUT /report-config/:key upserts and returns config', async () => {
    const res = await request(app)
      .put('/report-config/daily')
      .set('Authorization', `Bearer ${token}`)
      .send({ config: { selectedColumns: ['date', 'netProfit'], accentColor: '#123456' } })
      .expect(200)
    expect(res.body.data.key).toBe('daily')
    expect(res.body.data.config.accentColor).toBe('#123456')
  })

  test('PUT rejects unknown report key', async () => {
    const res = await request(app)
      .put('/report-config/bogus')
      .set('Authorization', `Bearer ${token}`)
      .send({ config: { selectedColumns: [] } })
    expect(res.status).toBe(404)
  })

  // report_config has no store column — it's shared globally across
  // every store/tenant. A low-privilege role must not be able to
  // overwrite that shared config for everyone; reads stay open.
  test('PUT /report-config/:key is refused for a non-admin role', async () => {
    const res = await request(app)
      .put('/report-config/daily')
      .set('Authorization', `Bearer ${kasirToken}`)
      .send({ config: { selectedColumns: ['date'], accentColor: '#ff0000' } })
    expect(res.status).toBe(403)
  })

  test('GET /report-config/:key still works for a non-admin role', async () => {
    const res = await request(app)
      .get('/report-config/daily')
      .set('Authorization', `Bearer ${kasirToken}`)
    expect(res.status).toBe(200)
  })
})