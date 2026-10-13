'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const { validateStoreAccess, parseStoreCandidates } = require('../utils/storeValidation')

const mockRes = () => {
  const res = {}
  res.statusCode = null
  res.body = null
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (body) => { res.body = body; return res }
  return res
}

describe('KF-NEW-06/07: location parameter bypass in store isolation', () => {
  test('parseStoreCandidates treats query.location as a store candidate', () => {
    const parsed = parseStoreCandidates({ query: { location: '22' }, body: {}, cookies: {} })
    expect(parsed.candidates).toEqual([22])
  })

  test('parseStoreCandidates treats body.location as a store candidate', () => {
    const parsed = parseStoreCandidates({ query: {}, body: { location: '33' }, cookies: {} })
    expect(parsed.candidates).toEqual([33])
  })

  test('legacy validateStoreAccess rejects non-super-admin foreign query.location', () => {
    const req = { authSession: { userId: 1 }, user: { id: 1, roleType: 'admin', store: 10 }, query: { location: '11' }, body: {}, cookies: {} }
    const res = mockRes()
    let next = false
    validateStoreAccess(req, res, () => { next = true })
    expect(next).toBe(false)
    expect(res.statusCode).toBe(403)
  })

  test('legacy validateStoreAccess allows non-super-admin own query.location', () => {
    const req = { authSession: { userId: 1 }, user: { id: 1, roleType: 'admin', store: 10 }, query: { location: '10' }, body: {}, cookies: {} }
    const res = mockRes()
    let next = false
    validateStoreAccess(req, res, () => { next = true })
    expect(next).toBe(true)
    expect(req.storeId).toBe(10)
  })

  test('conflicting query store and location fails closed', () => {
    const req = { authSession: { userId: 1 }, user: { id: 1, roleType: 'admin', store: 10 }, query: { store: '10', location: '11' }, body: {}, cookies: {} }
    const res = mockRes()
    let next = false
    validateStoreAccess(req, res, () => { next = true })
    expect(next).toBe(false)
    expect(res.statusCode).toBe(403)
  })
})
