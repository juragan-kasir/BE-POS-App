'use strict'

// Real-world fixture factory for the E2E suite.
//
// Every segment gets its own tenant(s), outlet(s), owner account(s) and a
// roster of employees with salaries. Data is created through the Sequelize
// models (master-data setup), while the flows under test always go through
// the HTTP API. A unique suffix keeps concurrently-run suites from colliding
// even though they share the one test database.

process.env.NODE_ENV = process.env.NODE_ENV || 'test'
const db = require('../../../db/models')

const PASSWORD = 'Passw0rd!'
const TIMEZONE = 'Asia/Jakarta'
const BASE_LAT = -6.2088
const BASE_LNG = 106.8456

let counter = 0
const makeSuffix = (prefix) => {
  counter += 1
  const stamp = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 6)
  return `${prefix || 'E2E'}${stamp}${counter}${rand}`.replace(/[^A-Za-z0-9]/g, '')
}

const createTenant = async (suffix, index) =>
  db.tenant.create({
    code: `${suffix}T${index}`,
    name: `Merchant ${index + 1} ${suffix}`,
    status: 'active'
  })

const createLocation = async (suffix, tenant, merchantIndex, outletIndex) => {
  const offset = merchantIndex * 0.01 + outletIndex * 0.001
  return db.location.create({
    name: `Outlet ${merchantIndex + 1}.${outletIndex + 1} ${suffix}`,
    tenantId: tenant.id,
    timezone: TIMEZONE,
    latitude: BASE_LAT + offset,
    longitude: BASE_LNG + offset,
    status: 'active'
  })
}

const createUser = async ({ suffix, role, userName, fullName, store, monthlySalary, dailySalary }) =>
  db.user.create({
    userName: String(userName).toLowerCase(),
    fullName,
    userType: role === 'employee' ? 'user' : 'admin',
    roleType: role === 'employee' ? 'user' : role,
    store: store ?? null,
    password: PASSWORD,
    status: 'active',
    employeeID: `EMP-${suffix}-${userName}`.slice(0, 50),
    monthlySalary: monthlySalary ?? 5_000_000,
    dailySalary: dailySalary ?? 200_000
  })

const attachTenancy = async ({ user, tenant, stores, role }) => {
  await db.tenantMembership.create({
    userId: user.id,
    tenantId: tenant.id,
    role,
    status: 'ACTIVE'
  })
  for (const location of stores) {
    await db.storeAssignment.create({
      userId: user.id,
      tenantId: tenant.id,
      storeId: location.id
    })
  }
}

const createCategories = async ({ suffix, location }) => {
  const specs = [
    { key: 'operasional', name: `Operasional ${suffix}`, accountCode: '6500' },
    { key: 'sewa', name: `Sewa ${suffix}`, accountCode: '6400' },
    { key: 'gaji', name: `Gaji ${suffix}`, accountCode: '6100' }
  ]
  const created = {}
  for (const spec of specs) {
    created[spec.key] = await db.expense_category.create({
      store: location.id,
      name: spec.name,
      description: spec.name,
      accountCode: spec.accountCode,
      status: 'active'
    })
  }
  return created
}

/**
 * Build a complete business world.
 *
 * @param {object} spec
 * @param {string} spec.prefix        short segment code used in names
 * @param {number} [spec.merchants]   number of tenants (default 1)
 * @param {number} [spec.outlets]     outlets per tenant (default 1)
 * @param {number} [spec.employees]   employees per outlet (default 4)
 * @param {string} [spec.ownerMode]   'store_admin' (default) or 'platform'
 */
async function createWorld(spec = {}) {
  const suffix = makeSuffix(spec.prefix)
  const merchantCount = spec.merchants ?? 1
  const outletCount = spec.outlets ?? 1
  const employeesPerOutlet = spec.employees ?? 4

  const world = {
    suffix,
    password: PASSWORD,
    merchants: [],
    outlets: [],
    employees: [],
    merchantAdmins: [],
    owner: null,
    platformOwner: null
  }

  const addEmployee = async (outlet, options = {}) => {
    const index = outlet.employees.length + 1
    const user = await createUser({
      suffix,
      role: 'employee',
      userName: `e${suffix}${outlet.uniqueIndex}${index}`,
      fullName: `${options.fullName || 'Karyawan'} ${outlet.uniqueIndex}-${index} ${suffix}`,
      store: outlet.location.id,
      monthlySalary: options.monthlySalary,
      dailySalary: options.dailySalary
    })
    await attachTenancy({
      user,
      tenant: outlet.tenant,
      stores: [outlet.location],
      role: 'staff'
    })
    outlet.employees.push(user)
    world.employees.push(user)
    return user
  }

  for (let m = 0; m < merchantCount; m += 1) {
    const tenant = await createTenant(suffix, m)
    const merchant = { tenant, outlets: [] }

    for (let o = 0; o < outletCount; o += 1) {
      const uniqueIndex = `${m}${o}`
      const location = await createLocation(suffix, tenant, m, o)
      const outlet = {
        uniqueIndex,
        merchantIndex: m,
        outletIndex: o,
        tenant,
        location,
        categories: null,
        employees: []
      }
      outlet.categories = await createCategories({ suffix, location })
      merchant.outlets.push(outlet)
      world.outlets.push(outlet)
    }

    const merchantAdmin = await createUser({
      suffix,
      role: 'admin',
      userName: `a${suffix}${m}`,
      fullName: `Owner Merchant ${m + 1} ${suffix}`,
      store: merchant.outlets[0].location.id
    })
    await attachTenancy({
      user: merchantAdmin,
      tenant,
      stores: [merchant.outlets[0].location],
      role: 'store_admin'
    })
    merchant.admin = merchantAdmin
    world.merchantAdmins.push(merchantAdmin)

    world.merchants.push(merchant)
  }

  // One platform owner (global super_admin) can operate every merchant/outlet
  // via an explicit ?store= / body.store, matching the legacy controllers'
  // cross-store support.
  world.platformOwner = await createUser({
    suffix,
    role: 'super_admin',
    userName: `p${suffix}`,
    fullName: `Platform Owner ${suffix}`,
    store: null
  })

  world.owner = spec.ownerMode === 'platform' ? world.platformOwner : world.merchantAdmins[0]

  // Seed the employee roster after all outlets exist.
  for (const outlet of world.outlets) {
    for (let i = 0; i < employeesPerOutlet; i += 1) {
      await addEmployee(outlet)
    }
  }

  world.addEmployee = addEmployee
  world.firstOutlet = world.outlets[0]
  return world
}

module.exports = {
  createWorld,
  PASSWORD,
  TIMEZONE,
  BASE_LAT,
  BASE_LNG
}
