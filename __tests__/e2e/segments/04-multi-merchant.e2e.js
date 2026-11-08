'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const { describeSegment } = require('../helpers/segment')
const { as } = require('../helpers/auth')

describeSegment({
  title: 'Segment 04 — Multi merchant (platform owner + 3 merchant)',
  spec: {
    prefix: 'S04',
    merchants: 3,
    outlets: 1,
    employees: 4,
    ownerMode: 'platform'
  },
  extraTests: ({ getWorld, getOwnerApi, flows }) => {
    test('merchant A admin cannot read merchant B expenses or attendance', async () => {
      const world = getWorld()
      const merchantAAdmin = await as(world.merchantAdmins[0])
      const merchantBOutlet = world.outlets[1]

      const expense = await merchantAAdmin.get(
        `/expense/get-all?store=${merchantBOutlet.location.id}`
      )
      expect(expense.status).toBe(403)

      const attendance = await merchantAAdmin.get(
        `/attendance/today?store=${merchantBOutlet.location.id}`
      )
      expect(attendance.status).toBe(403)
    })

    test('platform owner can filter the roster with the same store query used elsewhere', async () => {
      const world = getWorld()
      const ownerApi = getOwnerApi()
      const outlet = world.outlets[1]

      const res = await ownerApi.get(
        `/employee/get-employee?store=${outlet.location.id}&limit=100`
      )
      expect(res.status).toBe(200)
      expect(res.body.data.length).toBe(outlet.employees.length)
      for (const row of res.body.data) {
        expect(Number(row.store)).toBe(Number(outlet.location.id))
      }
    })

    test('platform owner can run payroll for merchant B independently', async () => {
      const world = getWorld()
      const ownerApi = getOwnerApi()
      const merchantBOutlet = world.outlets[1]

      const rows = await flows.runSalary({
        ownerApi,
        outlet: merchantBOutlet,
        month: flows.localDate().slice(0, 7)
      })
      expect(rows.length).toBe(merchantBOutlet.employees.length)
      for (const row of rows) {
        expect(Number(row.store)).toBe(Number(merchantBOutlet.location.id))
      }
    })
  }
})
