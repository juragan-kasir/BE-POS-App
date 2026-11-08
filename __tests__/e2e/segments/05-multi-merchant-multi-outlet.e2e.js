'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const { describeSegment } = require('../helpers/segment')
const { as } = require('../helpers/auth')

describeSegment({
  title: 'Segment 05 — Multi merchant + multi outlet (2 merchant × 2 outlet)',
  spec: {
    prefix: 'S05',
    merchants: 2,
    outlets: 2,
    employees: 4,
    ownerMode: 'platform'
  },
  extraTests: ({ getWorld, getOwnerApi, flows }) => {
    test('merchant A admin cannot read merchant B anywhere', async () => {
      const world = getWorld()
      const merchantAAdmin = await as(world.merchantAdmins[0])
      const merchantBOutlet = world.outlets[2]

      const expense = await merchantAAdmin.get(
        `/expense/get-all?store=${merchantBOutlet.location.id}`
      )
      expect(expense.status).toBe(403)

      const attendance = await merchantAAdmin.get(
        `/attendance/today?store=${merchantBOutlet.location.id}`
      )
      expect(attendance.status).toBe(403)
    })

    test('platform owner keeps merchant 2 outlet 2 data separate from merchant 1', async () => {
      const world = getWorld()
      const ownerApi = getOwnerApi()
      const merchant1Outlet0 = world.outlets[0]
      const merchant2Outlet1 = world.outlets[3]

      const create = await ownerApi.post('/expense/add', {
        store: merchant2Outlet1.location.id,
        categoryId: merchant2Outlet1.categories.operasional.id,
        amount: 91000,
        date: flows.localDateTime(),
        paymentMethod: 'bank',
        description: `Belanja lintas merchant ${world.suffix}`,
        status: 'approved'
      })
      expect(create.status).toBe(201)
      const expenseId = create.body.data.id

      const merchant2View = await ownerApi.get(
        `/expense/get-all?store=${merchant2Outlet1.location.id}&limit=100`
      )
      expect(merchant2View.status).toBe(200)
      expect(merchant2View.body.data.map((r) => Number(r.id))).toContain(
        Number(expenseId)
      )

      const merchant1View = await ownerApi.get(
        `/expense/get-all?store=${merchant1Outlet0.location.id}&limit=100`
      )
      expect(merchant1View.status).toBe(200)
      expect(merchant1View.body.data.map((r) => Number(r.id))).not.toContain(
        Number(expenseId)
      )
    })
  }
})
