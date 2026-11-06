'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

// PGA-05 (harness recheck 2026-11-06/07): the global afterFind hook that
// fills createdByUser/modifiedByUser looked users up OUTSIDE the find's
// transaction. Every find inside a transaction (FOR UPDATE locks included)
// therefore took a second pool connection; 40 parallel sales of one SKU
// held all 20 connections waiting for that second one and half of them
// failed after the 30 s acquire timeout (HTTP 500). With the lookup on the
// same transaction, 90 parallel sales all succeed in about a second.
const db = require('../db/models')

const unique = (p) => `${p}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

describe('afterFind audit-field enrichment uses the find transaction', () => {
  let user
  let category

  beforeAll(async () => {
    user = await db.user.create({
      userName: unique('pga05'),
      email: `${unique('pga05')}@test.com`,
      roleType: 'admin',
      userType: 'admin',
      status: 'active',
      fullName: 'PGA05 Owner'
    })
    category = await db.category.create({
      name: unique('PGA05_CAT'),
      createdBy: user.id
    })
  })

  afterAll(async () => {
    await db.category.destroy({ where: { id: category?.id }, force: true })
    await db.user.destroy({ where: { id: user?.id }, force: true })
  })

  test('the user lookup inside a transaction carries that transaction', async () => {
    const spy = jest.spyOn(db.user, 'findAll')
    try {
      await db.sequelize.transaction(async (t) => {
        const row = await db.category.findOne({
          where: { id: category.id },
          transaction: t,
          lock: t.LOCK.UPDATE
        })
        expect(row.dataValues.createdByUser).toMatchObject({
          id: user.id,
          fullName: 'PGA05 Owner'
        })
        const lookups = spy.mock.calls.filter(([opts]) =>
          opts?.attributes?.includes?.('fullName')
        )
        expect(lookups.length).toBeGreaterThan(0)
        for (const [opts] of lookups) expect(opts.transaction).toBe(t)
      })
    } finally {
      spy.mockRestore()
    }
  })

  test('outside a transaction the lookup still works without one', async () => {
    const row = await db.category.findOne({ where: { id: category.id } })
    expect(row.dataValues.createdByUser).toMatchObject({
      id: user.id,
      fullName: 'PGA05 Owner'
    })
  })
})
