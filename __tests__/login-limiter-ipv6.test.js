'use strict'

process.env.NODE_ENV = 'test'

// BE audit 2026-11-18 (S-08 / H7): the login limiter keyed on the raw
// req.ip, which express-rate-limit flags as ERR_ERL_KEY_GEN_IPV6 — an IPv6
// client could rotate addresses inside its own prefix and never hit the
// limit. The key now goes through ipKeyGenerator (IPv6 → /56 subnet).
const rateLimit = require('express-rate-limit')

afterAll(async () => {
  await require('../db/models').sequelize.close()
})

test('creating the auth routes raises no IPv6 key-generator validation error', () => {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
  jest.isolateModules(() => {
    require('../api/routes/auth')
  })
  const ipv6Errors = spy.mock.calls.filter((args) =>
    args.some((a) => a && (a.code === 'ERR_ERL_KEY_GEN_IPV6' || String(a).includes('ERR_ERL_KEY_GEN_IPV6')))
  )
  spy.mockRestore()
  expect(ipv6Errors).toEqual([])
})

test('two IPv6 addresses in the same /56 share one limiter key', () => {
  const { ipKeyGenerator } = rateLimit
  expect(ipKeyGenerator('2001:db8:abcd:12aa::1')).toBe(ipKeyGenerator('2001:db8:abcd:12ff::9'))
  expect(ipKeyGenerator('2001:db8:abcd:1200::1')).not.toBe(ipKeyGenerator('2001:db8:abcd:1300::1'))
})
