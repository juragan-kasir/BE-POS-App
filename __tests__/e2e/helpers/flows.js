'use strict'

// Shared real-world flows exercised by every business segment. Each helper
// asserts the business outcome through the HTTP API (or persisted state for
// atomic shift-swap relocation) and returns the created handles so segment
// specs can add segment-specific assertions.

const db = require('../../../db/models')
const { generateDueRecurringExpenses } = require('../../../api/service/expenseScheduler')
const { as } = require('./auth')

const pad = (n) => String(n).padStart(2, '0')
const localDate = (date = new Date()) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const localDateOffset = (days) => {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return localDate(d)
}
const localDateTime = (date = new Date()) => `${localDate(date)}T12:00:00`

async function ensureEmployees(world, outlet, count) {
  const pool = outlet.employees
  while (pool.length < count) {
    await world.addEmployee(outlet)
  }
  return pool
}

async function createShift(ownerApi, outlet, employees, options = {}) {
  const body = {
    store: outlet.location.id,
    nama_shift: options.name,
    tipe_shift: options.type || 'harian',
    jam_mulai: options.start || '08:00',
    jam_selesai: options.end || '16:00',
    tanggal_mulai: options.from || null,
    tanggal_selesai: options.to || null,
    karyawan: employees.map((e) => e.id),
    status: 'active'
  }
  const res = await ownerApi.post('/shift/add-new-shift', body)
  expect(res.status).toBe(200)
  const data = Array.isArray(res.body.data) ? res.body.data[0] : res.body.data
  expect(data && data.id).toBeTruthy()
  return data
}

async function runExpenseDaily({ ownerApi, outlet, tag }) {
  const store = outlet.location.id
  const categoryId = outlet.categories.operasional.id
  const date = localDateTime()

  const approvedCreate = await ownerApi.post('/expense/add', {
    store,
    categoryId,
    amount: 125000,
    date,
    paymentMethod: 'cash',
    description: `Belanja harian ${tag}`,
    status: 'pending'
  })
  expect(approvedCreate.status).toBe(201)
  const approvedId = approvedCreate.body.data.id

  const rejectedCreate = await ownerApi.post('/expense/add', {
    store,
    categoryId,
    amount: 75000,
    date,
    paymentMethod: 'bank',
    description: `Belanja ditolak ${tag}`,
    status: 'pending'
  })
  expect(rejectedCreate.status).toBe(201)
  const rejectedId = rejectedCreate.body.data.id

  const reject = await ownerApi.put(`/expense/reject/${rejectedId}`, {})
  expect(reject.status).toBe(200)

  const approve = await ownerApi.put(`/expense/approve/${approvedId}`, {})
  expect(approve.status).toBe(200)

  // Approving twice is not a silent no-op — the second call is a conflict.
  const duplicateApprove = await ownerApi.put(`/expense/approve/${approvedId}`, {})
  expect(duplicateApprove.status).toBe(400)

  const paid = await ownerApi.put(`/expense/mark-paid/${approvedId}`, {
    paymentDate: localDate(),
    paymentMethod: 'cash',
    note: 'dibayar pada E2E'
  })
  expect(paid.status).toBe(200)

  const summary = await ownerApi.get(`/expense/get-summary?store=${store}`)
  expect(summary.status).toBe(200)
  expect(Number(summary.body.data.periods.daily)).toBeGreaterThanOrEqual(125000)

  const list = await ownerApi.get(
    `/expense/get-all?store=${store}&startDate=${localDate()}&endDate=${localDate()}&limit=100`
  )
  expect(list.status).toBe(200)
  const listedIds = list.body.data.map((row) => Number(row.id))
  expect(listedIds).toContain(Number(approvedId))
  expect(listedIds).toContain(Number(rejectedId))

  return { approvedId, rejectedId }
}

async function runExpenseRecurring({ ownerApi, outlet, tag }) {
  const store = outlet.location.id
  const categoryId = outlet.categories.sewa.id
  const startedAt = localDateTime(new Date(new Date().setDate(new Date().getDate() - 400)))
  const recurringEndDate = localDateOffset(3)
  const amount = 500000

  const create = await ownerApi.post('/expense/add', {
    store,
    categoryId,
    amount,
    date: startedAt,
    frequency: 'monthly',
    recurringEndDate,
    status: 'approved',
    paymentMethod: 'bank',
    description: `Sewa bulanan ${tag}`
  })
  expect(create.status).toBe(201)
  const templateId = create.body.data.id
  expect(create.body.data.frequency).toBe('monthly')
  expect(create.body.data.nextDueDate).toBeTruthy()

  const firstTick = await generateDueRecurringExpenses()
  expect(firstTick).toBeGreaterThanOrEqual(0)

  const children = await db.expense.findAll({
    where: { parentId: templateId },
    order: [['id', 'ASC']]
  })
  expect(children.length).toBeGreaterThan(0)
  const now = new Date()
  for (const child of children) {
    expect(child.frequency).toBeNull()
    expect(child.status).toBe('approved')
    expect(Number(child.amount)).toBe(amount)
    expect(new Date(child.date).getTime()).toBeLessThanOrEqual(now.getTime())
  }

  // A second scheduler tick must never duplicate already-generated periods.
  await generateDueRecurringExpenses()
  const afterSecondTick = await db.expense.findAll({ where: { parentId: templateId } })
  expect(afterSecondTick.length).toBe(children.length)

  return { templateId, children }
}

async function runSalary({ ownerApi, outlet, month }) {
  const store = outlet.location.id
  const employees = outlet.employees
  const employeeIds = employees.map((e) => e.id)

  const first = await ownerApi.post('/expense/generate-salary', {
    store,
    month,
    paymentMethod: 'bank'
  })
  expect(first.status).toBe(201)
  expect(first.body.data.created).toBe(employeeIds.length)

  const second = await ownerApi.post('/expense/generate-salary', {
    store,
    month,
    paymentMethod: 'bank'
  })
  expect(second.status).toBe(201)
  expect(second.body.data.created).toBe(0)
  expect(second.body.data.skipped).toBe(employeeIds.length)

  const rows = await db.expense.findAll({
    where: { store, employeeId: employeeIds }
  })
  expect(rows.length).toBe(employeeIds.length)
  const byEmployee = new Map(rows.map((row) => [Number(row.employeeId), row]))
  for (const employee of employees) {
    const row = byEmployee.get(Number(employee.id))
    expect(row).toBeTruthy()
    expect(Number(row.amount)).toBe(Math.round(Number(employee.monthlySalary)))
    expect(row.status).toBe('approved')
  }

  return rows
}

async function runAttendance({ world, outlet, ownerApi, tag }) {
  const store = outlet.location.id
  const employees = await ensureEmployees(world, outlet, 4)
  const staffA = employees[0]
  const staffB = employees[1]
  const staffC = employees[2]

  const apiA = await as(staffA)
  const apiB = await as(staffB)
  const apiC = await as(staffC)

  const shift = await createShift(ownerApi, outlet, [staffA, staffB], {
    name: `Absensi ${tag}`,
    start: '08:00',
    end: '16:00',
    from: localDate(),
    to: localDate()
  })

  const coordinates = {
    latitude: outlet.location.latitude,
    longitude: outlet.location.longitude,
    accuracy: 12,
    shiftId: shift.id
  }

  const clockIn = await apiA.post('/attendance/clock', {
    type: 'check-in',
    ...coordinates
  })
  expect(clockIn.status).toBe(201)
  expect(clockIn.body.data.type).toBe('check-in')
  expect(clockIn.body.data.status).toBe('valid')
  expect(Number(clockIn.body.data.store)).toBe(Number(store))

  const duplicate = await apiA.post('/attendance/clock', {
    type: 'check-in',
    ...coordinates
  })
  expect(duplicate.status).toBe(409)

  const clockOut = await apiA.post('/attendance/clock', {
    type: 'check-out',
    ...coordinates
  })
  expect(clockOut.status).toBe(201)

  const mine = await apiA.get(`/attendance/my?date=${localDate()}`)
  expect(mine.status).toBe(200)
  expect(mine.body.data.length).toBe(2)

  const today = await ownerApi.get(`/attendance/today?store=${store}`)
  expect(today.status).toBe(200)
  const ownRows = today.body.data.filter(
    (row) => Number(row.userId) === Number(staffA.id)
  )
  expect(ownRows.length).toBe(2)

  const byShift = await ownerApi.get(
    `/attendance/by-shift?shiftId=${shift.id}&store=${store}`
  )
  expect(byShift.status).toBe(200)
  expect(
    byShift.body.data.some((row) => Number(row.userId) === Number(staffA.id))
  ).toBe(true)

  // Outside the store's geofence must be refused, not silently stored.
  const outside = await apiB.post('/attendance/clock', {
    type: 'check-in',
    latitude: outlet.location.latitude + 1,
    longitude: outlet.location.longitude + 1,
    accuracy: 10,
    shiftId: shift.id
  })
  expect(outside.status).toBe(400)

  // A spoofed/implausible GPS accuracy is stored but flagged untrusted.
  const untrusted = await apiC.post('/attendance/clock', {
    type: 'check-in',
    latitude: outlet.location.latitude,
    longitude: outlet.location.longitude,
    accuracy: 999,
    shiftId: shift.id
  })
  expect(untrusted.status).toBe(201)
  expect(untrusted.body.data.status).toBe('untrusted')

  return { shift }
}

async function requestSwap({ requester, store, target, requesterShiftId, targetShiftId, from, to, note }) {
  const requesterApi = await as(requester)
  return requesterApi.post('/shift-swap/create-swap', {
    store,
    targetId: target.id,
    requesterShiftId,
    targetShiftId,
    tanggal_mulai: from,
    tanggal_selesai: to,
    note
  })
}

async function runShiftSwap({ world, outlet, ownerApi, tag }) {
  const store = outlet.location.id
  const employees = await ensureEmployees(world, outlet, 7)
  const from = localDateOffset(7)
  const to = localDateOffset(7)

  // --- Happy path: employee A and B swap, owner approves atomically. ---
  const requester = employees[0]
  const target = employees[1]
  const shiftA = await createShift(ownerApi, outlet, [requester], {
    name: `Pagi ${tag}`,
    start: '08:00',
    end: '16:00',
    from,
    to
  })
  const shiftB = await createShift(ownerApi, outlet, [target], {
    name: `Siang ${tag}`,
    start: '16:00',
    end: '23:00',
    from,
    to
  })

  const create = await requestSwap({
    requester,
    store,
    target,
    requesterShiftId: shiftA.id,
    targetShiftId: shiftB.id,
    from,
    to,
    note: `Tukar shift ${tag}`
  })
  expect([200, 201]).toContain(create.status)
  const swapId = create.body.data.id
  expect(create.body.data.status).toBe('pending')

  const approve = await ownerApi.put(
    `/shift-swap/update-swap-status/${swapId}`,
    { status: 'approved' }
  )
  expect(approve.status).toBe(200)

  const requesterAfter = await db.user.findByPk(requester.id)
  const targetAfter = await db.user.findByPk(target.id)
  expect(Number(requesterAfter.shift)).toBe(Number(shiftB.id))
  expect(Number(targetAfter.shift)).toBe(Number(shiftA.id))

  const shiftAAfter = await db.shift.findByPk(shiftA.id)
  const shiftBAfter = await db.shift.findByPk(shiftB.id)
  const aMembers = (shiftAAfter.karyawan || []).map(Number)
  const bMembers = (shiftBAfter.karyawan || []).map(Number)
  expect(aMembers).toContain(Number(target.id))
  expect(aMembers).not.toContain(Number(requester.id))
  expect(bMembers).toContain(Number(requester.id))
  expect(bMembers).not.toContain(Number(target.id))

  // Re-approving the same request is refused (already decided).
  const reApprove = await ownerApi.put(
    `/shift-swap/update-swap-status/${swapId}`,
    { status: 'approved' }
  )
  expect(reApprove.status).toBe(400)

  // --- Rejection path: no roster movement. ---
  const rejectRequester = employees[5]
  const rejectTarget = employees[6]
  const rejectShiftA = await createShift(ownerApi, outlet, [rejectRequester], {
    name: `Reject Pagi ${tag}`,
    start: '08:00',
    end: '16:00',
    from,
    to
  })
  const rejectShiftB = await createShift(ownerApi, outlet, [rejectTarget], {
    name: `Reject Siang ${tag}`,
    start: '16:00',
    end: '23:00',
    from,
    to
  })
  const rejectRequest = await requestSwap({
    requester: rejectRequester,
    store,
    target: rejectTarget,
    requesterShiftId: rejectShiftA.id,
    targetShiftId: rejectShiftB.id,
    from,
    to,
    note: `Reject swap ${tag}`
  })
  expect([200, 201]).toContain(rejectRequest.status)
  const rejectId = rejectRequest.body.data.id
  const reject = await ownerApi.put(
    `/shift-swap/update-swap-status/${rejectId}`,
    { status: 'rejected' }
  )
  expect(reject.status).toBe(200)

  const rejectShiftAAfter = await db.shift.findByPk(rejectShiftA.id)
  const rejectShiftBAfter = await db.shift.findByPk(rejectShiftB.id)
  expect((rejectShiftAAfter.karyawan || []).map(Number)).toContain(
    Number(rejectRequester.id)
  )
  expect((rejectShiftBAfter.karyawan || []).map(Number)).toContain(
    Number(rejectTarget.id)
  )

  // --- Double-shift guard: target already clocked in on the swap date. ---
  const dblRequester = employees[2]
  const dblTarget = employees[3]
  const dblShiftA = await createShift(ownerApi, outlet, [dblRequester], {
    name: `Dobel Pagi ${tag}`,
    start: '08:00',
    end: '16:00',
    from,
    to
  })
  const dblShiftB = await createShift(ownerApi, outlet, [dblTarget], {
    name: `Dobel Siang ${tag}`,
    start: '16:00',
    end: '23:00',
    from,
    to
  })
  // A real conflict that the create API cannot undo: the target is already
  // present (attendance) on the requested date.
  await db.attendance.create({
    userId: dblTarget.id,
    store,
    type: 'check-in',
    absenAt: new Date(`${from}T09:00:00`),
    latitude: outlet.location.latitude,
    longitude: outlet.location.longitude,
    accuracy: 10,
    status: 'valid',
    note: `Dobel konflik ${tag}`
  })
  const doubleShift = await requestSwap({
    requester: dblRequester,
    store,
    target: dblTarget,
    requesterShiftId: dblShiftA.id,
    targetShiftId: dblShiftB.id,
    from,
    to,
    note: `Dobel ${tag}`
  })
  expect(doubleShift.status).toBe(409)

  // --- Cross-store guard (only meaningful when the world has >1 outlet). ---
  let crossStoreStatus = null
  if (world.outlets.length > 1) {
    const otherOutlet = world.outlets[1]
    const outsider = (await ensureEmployees(world, otherOutlet, 2))[0]
    const outsiderShift = await createShift(ownerApi, otherOutlet, [outsider], {
      name: `Luar ${tag}`,
      start: '08:00',
      end: '16:00',
      from,
      to
    })
    const requesterShift = await createShift(
      ownerApi,
      outlet,
      [employees[2]],
      {
        name: `Luar Asal ${tag}`,
        start: '08:00',
        end: '16:00',
        from,
        to
      }
    )
    const cross = await requestSwap({
      requester: employees[2],
      target: outsider,
      requesterShiftId: requesterShift.id,
      targetShiftId: outsiderShift.id,
      from,
      to,
      note: `Lintas toko ${tag}`
    })
    crossStoreStatus = cross.status
    expect([400, 403]).toContain(cross.status)
  }

  return { swapId, crossStoreStatus }
}

module.exports = {
  localDate,
  localDateOffset,
  localDateTime,
  ensureEmployees,
  createShift,
  runExpenseDaily,
  runExpenseRecurring,
  runSalary,
  runAttendance,
  runShiftSwap
}
