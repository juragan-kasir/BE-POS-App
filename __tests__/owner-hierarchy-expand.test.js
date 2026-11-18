'use strict'

process.env.NODE_ENV = 'test'

const db = require('../db/models')

const P = 'OWNER_V2_SCHEMA_'
let userId
let tenantId

afterAll(async () => {
  if (tenantId) await db.tenant.destroy({ where: { id: tenantId }, force: true })
  if (userId) await db.user.destroy({ where: { id: userId }, force: true })
  await db.sequelize.close()
})

test('tenant carries ownerId and businessType', async () => {
  const user = await db.user.create({
    userName: `${P}owner`,
    email: `${P}owner@test.com`,
    roleType: 'user',
    status: 'active',
    password: 'Test12345'
  })
  userId = user.id

  const tenant = await db.tenant.create({
    code: `${P}TENANT`,
    name: `${P}Tenant`,
    ownerId: user.id,
    businessType: 'laundry'
  })
  tenantId = tenant.id

  expect(tenant.ownerId).toBe(user.id)
  expect(tenant.businessType).toBe('laundry')
})

test('platform_admin is unique per user', async () => {
  const grant = await db.platformAdmin.create({ userId, status: 'ACTIVE' })
  await expect(db.platformAdmin.create({ userId, status: 'ACTIVE' })).rejects.toThrow()
  await grant.destroy({ force: true })
})

test('unknown businessType is rejected by the model', async () => {
  await expect(
    db.tenant.create({
      code: `${P}BAD`,
      name: `${P}Bad`,
      ownerId: userId,
      businessType: 'salon_spa'
    })
  ).rejects.toThrow()
})
