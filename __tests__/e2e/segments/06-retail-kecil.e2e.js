'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const { describeSegment } = require('../helpers/segment')

describeSegment({
  title: 'Segment 06 — Retail kecil / eceran (owner + 4 karyawan)',
  spec: {
    prefix: 'S06',
    merchants: 1,
    outlets: 1,
    employees: 4,
    ownerMode: 'store_admin'
  },
  extraTests: ({ getWorld, getOwnerApi, flows }) => {
    test('many small daily cash-outs are captured in one daily total', async () => {
      const world = getWorld()
      const ownerApi = getOwnerApi()
      const outlet = world.firstOutlet

      const items = Array.from({ length: 5 }, (_, i) => ({
        categoryId: outlet.categories.operasional.id,
        amount: 20000,
        date: flows.localDateTime(),
        paymentMethod: 'cash',
        description: `Belanja eceran ${i + 1} ${world.suffix}`,
        status: 'approved'
      }))

      const bulk = await ownerApi.post('/expense/bulk-create', {
        store: outlet.location.id,
        items
      })
      expect(bulk.status).toBe(201)
      expect(bulk.body.count).toBe(5)

      const summary = await ownerApi.get(
        `/expense/get-summary?store=${outlet.location.id}`
      )
      expect(summary.status).toBe(200)
      expect(Number(summary.body.data.periods.daily)).toBeGreaterThanOrEqual(225000)
    })
  }
})
