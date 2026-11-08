'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const db = require('../../../db/models')
const { describeSegment } = require('../helpers/segment')

describeSegment({
  title: 'Segment 07 — Retail besar / grosir (owner + 3 outlet × 8 karyawan)',
  spec: {
    prefix: 'S07',
    merchants: 1,
    outlets: 3,
    employees: 8,
    ownerMode: 'platform'
  },
  extraTests: ({ getWorld, getOwnerApi }) => {
    test('payroll for outlet 1 does not leak to outlet 2/3 employees', async () => {
      const world = getWorld()
      const outlet1 = world.outlets[0]
      const outlet2 = world.outlets[1]
      const outlet3 = world.outlets[2]

      const outlet1Salary = await db.expense.findAll({
        where: {
          store: outlet1.location.id,
          employeeId: outlet1.employees.map((e) => e.id)
        }
      })
      expect(outlet1Salary.length).toBe(outlet1.employees.length)

      for (const otherOutlet of [outlet2, outlet3]) {
        const leaked = await db.expense.findAll({
          where: {
            store: otherOutlet.location.id,
            employeeId: otherOutlet.employees.map((e) => e.id)
          }
        })
        expect(leaked.length).toBe(0)
      }
    })

    test('attendance from outlet 1 does not appear in outlet 2 today view', async () => {
      const world = getWorld()
      const ownerApi = getOwnerApi()
      const outlet1 = world.outlets[0]
      const outlet2 = world.outlets[1]

      const view = await ownerApi.get(
        `/attendance/today?store=${outlet2.location.id}`
      )
      expect(view.status).toBe(200)
      const outlet1Ids = new Set(outlet1.employees.map((e) => Number(e.id)))
      const leaked = (view.body.data || []).filter((row) =>
        outlet1Ids.has(Number(row.userId))
      )
      expect(leaked.length).toBe(0)
    })
  }
})
