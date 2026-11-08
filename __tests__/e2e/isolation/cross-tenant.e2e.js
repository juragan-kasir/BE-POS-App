'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const { createWorld } = require('../helpers/world')
const { as } = require('../helpers/auth')
const flows = require('../helpers/flows')

describe('Cross-tenant / cross-outlet isolation', () => {
  let world
  let adminA
  let adminB
  let platform
  let expenseB
  let swapB

  beforeAll(async () => {
    world = await createWorld({
      prefix: 'ISO',
      merchants: 2,
      outlets: 1,
      employees: 4,
      ownerMode: 'platform'
    })
    adminA = await as(world.merchantAdmins[0])
    adminB = await as(world.merchantAdmins[1])
    platform = await as(world.platformOwner)

    const outletA = world.outlets[0]
    const outletB = world.outlets[1]

    const created = await platform.post('/expense/add', {
      store: outletB.location.id,
      categoryId: outletB.categories.operasional.id,
      amount: 66000,
      date: flows.localDateTime(),
      paymentMethod: 'cash',
      description: `Rahasia merchant B ${world.suffix}`,
      status: 'approved'
    })
    expect(created.status).toBe(201)
    expenseB = created.body.data

    // A pending shift swap inside merchant B, for cross-tenant approval test.
    const from = flows.localDateOffset(5)
    const requester = outletB.employees[0]
    const target = outletB.employees[1]
    const shiftA = await flows.createShift(adminB, outletB, [requester], {
      name: `Iso Pagi ${world.suffix}`,
      start: '08:00',
      end: '16:00',
      from,
      to: from
    })
    const shiftB = await flows.createShift(adminB, outletB, [target], {
      name: `Iso Siang ${world.suffix}`,
      start: '16:00',
      end: '23:00',
      from,
      to: from
    })
    const requesterApi = await as(requester)
    const request = await requesterApi.post('/shift-swap/create-swap', {
      store: outletB.location.id,
      targetId: target.id,
      requesterShiftId: shiftA.id,
      targetShiftId: shiftB.id,
      tanggal_mulai: from,
      tanggal_selesai: from,
      note: `Isolasi ${world.suffix}`
    })
    expect([200, 201]).toContain(request.status)
    swapB = request.body.data

    expect(outletA).toBeTruthy()
  })

  test('admin A cannot list merchant B expenses by store id', async () => {
    const res = await adminA.get(
      `/expense/get-all?store=${world.outlets[1].location.id}`
    )
    expect(res.status).toBe(403)
  })

  test('admin A cannot read merchant B expense by id (404, no existence leak)', async () => {
    const res = await adminA.get(`/expense/get-by-id/${expenseB.id}`)
    expect(res.status).toBe(404)
  })

  test('admin A cannot edit or delete merchant B expense', async () => {
    const edit = await adminA.put(`/expense/edit/${expenseB.id}`, {
      amount: 1
    })
    expect(edit.status).toBe(404)

    const remove = await adminA.del(`/expense/delete/${expenseB.id}`)
    expect(remove.status).toBe(404)
  })

  test('admin A cannot approve merchant B shift swap', async () => {
    const res = await adminA.put(
      `/shift-swap/update-swap-status/${swapB.id}`,
      { status: 'approved' }
    )
    expect(res.status).toBe(404)
  })

  test('platform owner can still read merchant B expense', async () => {
    const res = await platform.get(
      `/expense/get-by-id/${expenseB.id}?store=${world.outlets[1].location.id}`
    )
    expect(res.status).toBe(200)
    expect(Number(res.body.data.id)).toBe(Number(expenseB.id))
  })
})
