'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const { describeSegment } = require('../helpers/segment')
const { as } = require('../helpers/auth')

describeSegment({
  title: 'Segment 03 — Multi outlet, 1 merchant (owner + 3 outlet)',
  spec: {
    prefix: 'S03',
    merchants: 1,
    outlets: 3,
    employees: 4,
    ownerMode: 'platform'
  },
  extraTests: ({ getWorld, getOwnerApi, flows }) => {
    test('per-outlet expense scoping: owner sees outlet 2, outlet-1 admin cannot', async () => {
      const world = getWorld()
      const ownerApi = getOwnerApi()
      const outlet0 = world.outlets[0]
      const outlet1 = world.outlets[1]

      const create = await ownerApi.post('/expense/add', {
        store: outlet1.location.id,
        categoryId: outlet1.categories.operasional.id,
        amount: 88000,
        date: flows.localDateTime(),
        paymentMethod: 'cash',
        description: `Belanja outlet 2 ${world.suffix}`,
        status: 'approved'
      })
      expect(create.status).toBe(201)
      const expenseId = create.body.data.id

      const ownerView = await ownerApi.get(
        `/expense/get-all?store=${outlet1.location.id}&limit=100`
      )
      expect(ownerView.status).toBe(200)
      expect(ownerView.body.data.map((r) => Number(r.id))).toContain(
        Number(expenseId)
      )

      const otherOutletView = await ownerApi.get(
        `/expense/get-all?store=${outlet0.location.id}&limit=100`
      )
      expect(otherOutletView.status).toBe(200)
      expect(otherOutletView.body.data.map((r) => Number(r.id))).not.toContain(
        Number(expenseId)
      )

      const outletAdmin = await as(world.merchantAdmins[0])
      const forbidden = await outletAdmin.get(
        `/expense/get-all?store=${outlet1.location.id}`
      )
      expect(forbidden.status).toBe(403)
    })
  }
})
