'use strict'

// Authenticates through the real login endpoint (bcrypt verification + DB
// session + JWT), exactly like the POS clients do. No token minting helpers:
// if login is broken for a role, the E2E flow must fail.

process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const app = require('../../../api/index')
const { PASSWORD } = require('./world')

const tokenCache = new Map()

async function login(user) {
  if (!user) throw new Error('login(user): user is required')
  if (tokenCache.has(user.id)) return tokenCache.get(user.id)

  const res = await request(app)
    .post('/auth/login')
    .send({ userName: user.userName, password: PASSWORD })

  if (res.status !== 200 || !res.body.token) {
    throw new Error(
      `login failed for ${user.userName}: status=${res.status} body=${JSON.stringify(res.body)}`
    )
  }
  tokenCache.set(user.id, res.body.token)
  return res.body.token
}

const apiFor = (token) => {
  const withAuth = (req) => req.set('Authorization', `Bearer ${token}`)
  return {
    get: (path) => withAuth(request(app).get(path)),
    post: (path, body = {}) => withAuth(request(app).post(path)).send(body),
    put: (path, body = {}) => withAuth(request(app).put(path)).send(body),
    patch: (path, body = {}) => withAuth(request(app).patch(path)).send(body),
    del: (path) => withAuth(request(app).delete(path))
  }
}

const as = async (user) => apiFor(await login(user))

module.exports = { app, login, as, apiFor, PASSWORD }
