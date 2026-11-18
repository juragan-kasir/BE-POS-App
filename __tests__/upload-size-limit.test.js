'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// BE audit 2026-11-18 (S-14 / H6): every in-memory Excel uploader carries a
// 5 MB cap, and an oversize file answers 413 FILE_TOO_LARGE instead of
// buffering the whole body (memory DoS) or failing with a 500.
const fs = require('fs')
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`
let user
let auth

beforeAll(async () => {
  user = await db.user.create({
    userName: `upl_sa_${RUN}`,
    email: `upl_sa_${RUN}@t.test`,
    roleType: 'super_admin',
    userType: 'super_admin',
    status: 'active'
  })
  auth = `Bearer ${await signSessionToken({ id: user.id, userName: user.userName, roleType: 'super_admin' }, JWT_SECRET)}`
})

afterAll(async () => {
  await db.authorizationContextSession.destroy({ where: { userId: user.id } })
  await db.user.destroy({ where: { id: user.id }, force: true })
  await db.sequelize.close()
})

test('every memoryStorage uploader declares a fileSize limit', () => {
  for (const file of fs.readdirSync('api/routes')) {
    const src = fs.readFileSync(`api/routes/${file}`, 'utf8')
    expect([file, /multer\(\{\s*storage:\s*multer\.memoryStorage\(\)\s*\}\)/.test(src)]).toEqual([file, false])
  }
})

test('an oversize Excel import is refused with 413 FILE_TOO_LARGE', async () => {
  const big = Buffer.alloc(6 * 1024 * 1024, 0x41)
  const res = await request(app)
    .post('/type-payment/import')
    .set('Authorization', auth)
    .attach('file', big, 'big.xlsx')
  expect(res.status).toBe(413)
  expect(res.body.code).toBe('FILE_TOO_LARGE')
})
