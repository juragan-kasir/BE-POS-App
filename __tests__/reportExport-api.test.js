require('dotenv').config()

const request = require('supertest')
const express = require('express')
const jwt = require('jsonwebtoken')

jest.mock('../db/models', () => {
  const locationFindOne = jest.fn(() =>
    Promise.resolve({
      name: 'Bisa Nota', address: 'Jl. Raya No.1', city: 'Bandung',
      province: 'Jabar', postalCode: '40111', phoneNumber: '0812',
      email: 'h@b.id', image: null
    })
  )
  return {
    // AUTH-1 P2: canonical authentication loads the session joined with its
    // account in one query; the account row (not the JWT) is the authority.
    authorizationContextSession: {
      findOne: jest.fn(({ where }) =>
        Promise.resolve(
          where.sessionId === 'a'.repeat(64)
            ? {
                sessionId: where.sessionId,
                userId: 9999,
                revokedAt: null,
                expiresAt: new Date(Date.now() + 3600000),
                user: { id: 9999, roleType: 'super_admin', store: null, disabledAt: null, deletedAt: null }
              }
            : null
        )
      )
    },
    // #345 report menu gate: the account row decides whether a menu applies.
    user: {
      findByPk: jest.fn(() =>
        Promise.resolve({ id: 9999, roleType: 'super_admin', accessMenu: null, roleId: null })
      )
    },
    location: { findOne: locationFindOne },
    reportConfig: { findOne: jest.fn(() => Promise.resolve(null)) },
    sequelize: { query: jest.fn(() => Promise.resolve([])), QueryTypes: { SELECT: 'SELECT' } }
  }
})

const reportExportRoutes = require('../api/routes/reportExport')
const secret = process.env.JWT_SECRET_KEY || 'secret-key-user'
const token = jwt.sign({ id: 9999, sessionId: 'a'.repeat(64), userName: 'superadmin', roleType: 'super_admin' }, secret)

const app = express()
app.use(express.json())
app.use('/report', reportExportRoutes)

describe('GET /report/export/:key', () => {
  test('returns 404 for unknown key', async () => {
    const res = await request(app)
      .get('/report/export/bogus?format=csv')
      .set('Authorization', `Bearer ${token}`)
      .expect(404)
    expect(res.body.success).toBe(false)
  })

  test('returns 400 for unknown format', async () => {
    const res = await request(app)
      .get('/report/export/daily?format=docx')
      .set('Authorization', `Bearer ${token}`)
      .expect(400)
    expect(res.body.success).toBe(false)
  })

  test('exports a CSV for known key', async () => {
    const res = await request(app)
      .get('/report/export/daily?format=csv')
      .set('Authorization', `Bearer ${token}`)
      .expect('Content-Type', /text\/csv/)
    expect(res.headers['content-disposition']).toContain('laporan-harian.csv')
    expect(res.text).toContain('Tanggal')
  })

  test('exports an Excel workbook for known key', async () => {
    const res = await request(app)
      .get('/report/export/daily?format=excel')
      .set('Authorization', `Bearer ${token}`)
      .expect('Content-Type', /spreadsheetml/)
    expect(res.headers['content-disposition']).toContain('xlsx')
    expect(res.text.length).toBeGreaterThan(100)
  })
})
