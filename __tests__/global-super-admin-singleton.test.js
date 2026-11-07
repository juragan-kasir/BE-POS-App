process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const db = require('../db/models')
const {
  consolidateGlobalSuperAdmins
} = require('../api/service/globalSuperAdminService')

const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

let store = null
const keepName = `super_admin_${SUFFIX}`
const otherNames = [`sa_other_a_${SUFFIX}`, `sa_other_b_${SUFFIX}`]

beforeAll(async () => {
  store = await db.location.create({
    name: `GLOBAL_SA_STORE_${SUFFIX}`,
    status: 'active'
  })
})

afterAll(async () => {
  if (store) {
    await db.user.destroy({
      where: {
        userName: [keepName, ...otherNames, `sa_store_bound_${SUFFIX}`]
      },
      force: true
    })
    await db.location.destroy({ where: { id: store.id }, force: true })
  }
})

describe('one global super admin', () => {
  test('retires every other global super_admin and leaves store-bound ones alone', async () => {
    for (const userName of [keepName, ...otherNames]) {
      await db.user.create({
        userName,
        fullName: userName,
        email: `${userName}@test.com`,
        roleType: 'super_admin',
        userType: 'super_admin',
        store: null,
        status: 'active'
      })
    }
    const storeBound = await db.user.create({
      userName: `sa_store_bound_${SUFFIX}`,
      fullName: 'Store-bound SA',
      email: `sa_store_bound_${SUFFIX}@test.com`,
      roleType: 'super_admin',
      userType: 'super_admin',
      store: store.id,
      status: 'active'
    })

    const result = await consolidateGlobalSuperAdmins(db.sequelize, {
      keepUserName: keepName
    })

    expect(result.kept.userName).toBe(keepName)
    expect(result.retired).toHaveLength(2)

    const globalRows = await db.user.findAll({
      where: {
        userName: { [require('sequelize').Op.in]: [keepName, ...otherNames] }
      },
      paranoid: false
    })
    const byName = new Map(globalRows.map((row) => [row.userName, row]))
    expect(byName.get(keepName).status).toBe('active')
    expect(byName.get(keepName).deletedAt).toBeNull()
    for (const name of otherNames) {
      expect(byName.get(name).status).toBe('inactive')
      expect(byName.get(name).deletedAt).not.toBeNull()
    }

    const freshBound = await db.user.findByPk(storeBound.id)
    expect(freshBound).not.toBeNull()
    expect(freshBound.status).toBe('active')
    expect(freshBound.deletedAt).toBeNull()
  })
})
