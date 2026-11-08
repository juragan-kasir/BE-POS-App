'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const { describeSegment } = require('../helpers/segment')
const flows = require('../helpers/flows')

describeSegment({
  title: 'Segment 02 — F&B + QR order (owner + 8 karyawan, rush hour)',
  spec: {
    prefix: 'S02',
    merchants: 1,
    outlets: 1,
    employees: 8,
    ownerMode: 'store_admin'
  },
  extraTests: ({ getWorld, getOwnerApi }) => {
    test('rush-hour bulk expense entry is atomic and lands in the daily summary', async () => {
      const world = getWorld()
      const ownerApi = getOwnerApi()
      const outlet = world.firstOutlet
      const { localDateTime } = flows

      const items = [1, 2, 3].map((n) => ({
        categoryId: outlet.categories.operasional.id,
        amount: 40000,
        date: localDateTime(),
        paymentMethod: 'cash',
        description: `Rush hour ${n} ${world.suffix}`,
        status: 'approved'
      }))

      const bulk = await ownerApi.post('/expense/bulk-create', {
        store: outlet.location.id,
        items
      })
      expect(bulk.status).toBe(201)
      expect(bulk.body.count).toBe(3)

      const summary = await ownerApi.get(
        `/expense/get-summary?store=${outlet.location.id}`
      )
      expect(summary.status).toBe(200)
      expect(Number(summary.body.data.periods.daily)).toBeGreaterThanOrEqual(120000)
    })
  }
})
