process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { Op } = require('sequelize')
const app = require('../api/index')
const db = require('../db/models')

// DR-24 D-08: public self-registration is closed in production — staff
// accounts are created by the owner. /auth/register answers only when an
// operator sets PUBLIC_REGISTRATION_ENABLED to exactly "true".

const PREFIX = `d08_${Date.now()}`
let seq = 0
const register = () => {
  const userName = `${PREFIX}_${++seq}`
  return request(app)
    .post('/auth/register')
    .send({
      userName,
      email: `${userName}@test.com`,
      password: 'Rahasia123!',
      confirmPassword: 'Rahasia123!',
      fullName: userName
    })
    .then((res) => ({ res, userName }))
}

afterEach(() => {
  delete process.env.PUBLIC_REGISTRATION_ENABLED
})

afterAll(async () => {
  await db.user.destroy({ where: { userName: { [Op.like]: `${PREFIX}%` } }, force: true })
})

describe('D-08 public self-registration', () => {
  test.each([
    ['unset', undefined],
    ['empty', ''],
    ['"false"', 'false'],
    ['"1"', '1'],
    ['"TRUE"', 'TRUE']
  ])('is closed when the switch is %s: 403 REGISTRATION_CLOSED, no account', async (_label, value) => {
    if (value !== undefined) process.env.PUBLIC_REGISTRATION_ENABLED = value
    const { res, userName } = await register()
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('REGISTRATION_CLOSED')
    expect(await db.user.count({ where: { userName }, paranoid: false })).toBe(0)
  })

  test('opens only for exactly "true"', async () => {
    process.env.PUBLIC_REGISTRATION_ENABLED = 'true'
    const { res, userName } = await register()
    expect(res.status).toBe(200)
    const user = await db.user.findOne({ where: { userName } })
    expect(user).not.toBeNull()
    expect(user.roleType).toBe('user')
    expect(user.store).toBeNull()
  })

  test('the closed answer is the same for a malformed body (no field validation leaks)', async () => {
    const res = await request(app).post('/auth/register').send({})
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('REGISTRATION_CLOSED')
  })
})
