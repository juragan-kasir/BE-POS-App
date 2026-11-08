'use strict'

// Registers the standard real-world scenario for one business segment:
// an owner with many employees, daily + monthly expenses, monthly payroll,
// attendance check-in/out and shift swaps. Segment files only describe their
// world shape and may add segment-specific assertions.

const { createWorld } = require('./world')
const { as } = require('./auth')
const flows = require('./flows')

function describeSegment({ title, spec, extraTests }) {
  describe(title, () => {
    let world
    let ownerApi

    beforeAll(async () => {
      world = await createWorld(spec)
      ownerApi = await as(world.owner)
    })

    test('owner sees the outlet employee roster (store-scoped)', async () => {
      const outlet = world.firstOutlet
      // The employee list filters by `location` (not `store`): a store-bound
      // owner is pinned to its own outlet, a platform owner filters explicitly.
      const res = await ownerApi.get(
        `/employee/get-employee?location=${outlet.location.id}&limit=100`
      )
      expect(res.status).toBe(200)
      expect(res.body.data.length).toBe(outlet.employees.length)
      for (const row of res.body.data) {
        const rowStore = row.store ?? row.storeData?.id
        expect(Number(rowStore)).toBe(Number(outlet.location.id))
      }
    })

    test('daily expense lifecycle: create → approve → pay → summary', async () => {
      await flows.runExpenseDaily({
        ownerApi,
        outlet: world.firstOutlet,
        tag: world.suffix
      })
    })

    test('monthly recurring expense: scheduler generates due periods once', async () => {
      await flows.runExpenseRecurring({
        ownerApi,
        outlet: world.firstOutlet,
        tag: world.suffix
      })
    })

    test('monthly payroll: one expense per employee, duplicates skipped', async () => {
      await flows.runSalary({
        ownerApi,
        outlet: world.firstOutlet,
        month: flows.localDate().slice(0, 7)
      })
    })

    test('attendance: check-in/out, duplicates, geofence, untrusted GPS', async () => {
      await flows.runAttendance({
        world,
        outlet: world.firstOutlet,
        ownerApi,
        tag: world.suffix
      })
    })

    test('shift swap: request → approve/reject, double-shift and cross-store guards', async () => {
      await flows.runShiftSwap({
        world,
        outlet: world.firstOutlet,
        ownerApi,
        tag: world.suffix
      })
    })

    if (typeof extraTests === 'function') {
      extraTests({ getWorld: () => world, getOwnerApi: () => ownerApi, flows })
    }
  })
}

module.exports = { describeSegment }
