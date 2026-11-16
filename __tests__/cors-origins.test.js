'use strict'

// Production origins that must reach the API from a browser. The laundry
// cashier (FE-LAUNDRY-App) logs real accounts in against this API.
const loadCheck = () => {
  jest.resetModules()
  return require('../api/utils/corsOptions').corsOriginCheck
}

const decide = (check, origin) =>
  new Promise((resolve) => check(origin, (_err, allowed) => resolve(allowed)))

describe('CORS allowed origins', () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, CORS_ORIGIN: process.env.CORS_ORIGIN }

  beforeEach(() => {
    process.env.NODE_ENV = 'production'
    delete process.env.CORS_ORIGIN
  })

  afterAll(() => {
    process.env.NODE_ENV = saved.NODE_ENV
    if (saved.CORS_ORIGIN === undefined) delete process.env.CORS_ORIGIN
    else process.env.CORS_ORIGIN = saved.CORS_ORIGIN
  })

  it.each([
    'https://bisa-nota-demo.vercel.app',
    'https://order-app-dun.vercel.app',
    'https://fe-laundry-app-dusky.vercel.app'
  ])('allows the production frontend %s', async (origin) => {
    expect(await decide(loadCheck(), origin)).toBe(true)
  })

  it('refuses an unknown origin in production', async () => {
    expect(await decide(loadCheck(), 'https://evil.example')).toBe(false)
  })
})
