process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const {
  getStoreLocalDate,
  getStoreDayBounds,
  getTimezoneOffset,
  getTimezoneOffsetMs
} = require('../utils/businessDate')

test('the offset comes from the zone, not from a lookup table', () => {
  expect(
    getTimezoneOffsetMs(
      'Australia/Adelaide',
      new Date('2026-01-15T00:00:00Z')
    )
  ).toBe(10.5 * 3600 * 1000)
  expect(
    getTimezoneOffsetMs(
      'Australia/Adelaide',
      new Date('2026-07-15T00:00:00Z')
    )
  ).toBe(9.5 * 3600 * 1000)
  expect(
    getTimezoneOffsetMs('Asia/Tokyo', new Date('2026-01-15T00:00:00Z'))
  ).toBe(9 * 3600 * 1000)
})

test('getTimezoneOffset still returns a string offset', () => {
  expect(getTimezoneOffset('Asia/Jayapura')).toBe('+09:00')
  expect(getTimezoneOffset('Asia/Tokyo')).toBe('+09:00')
})

test('the day bounds agree with the local date for a DST zone', () => {
  const bounds = getStoreDayBounds('2026-01-15', 'Australia/Adelaide')
  expect(getStoreLocalDate('Australia/Adelaide', bounds.start)).toBe(
    '2026-01-15'
  )
  expect(getStoreLocalDate('Australia/Adelaide', bounds.end)).toBe(
    '2026-01-15'
  )
})

test('the day bounds agree with the local date for a WIT store', () => {
  const bounds = getStoreDayBounds('2026-01-15', 'Asia/Jayapura')
  expect(getStoreLocalDate('Asia/Jayapura', bounds.start)).toBe('2026-01-15')
  expect(getStoreLocalDate('Asia/Jayapura', bounds.end)).toBe('2026-01-15')
})

test('a DST transition day keeps its 25-hour bounds on the same local date', () => {
  const bounds = getStoreDayBounds('2026-04-05', 'Australia/Adelaide')
  expect(getStoreLocalDate('Australia/Adelaide', bounds.start)).toBe(
    '2026-04-05'
  )
  expect(getStoreLocalDate('Australia/Adelaide', bounds.end)).toBe(
    '2026-04-05'
  )
  expect(bounds.end.getTime() - bounds.start.getTime() + 1).toBe(
    25 * 3600 * 1000
  )
})

const db = require('../db/models')
const { autoExpireShifts } = require('../api/controller/shift')

describe('shift auto-expiry uses the store local date', () => {
  let location
  let shift

  beforeAll(async () => {
    location = await db.location.create({
      name: 'WIT_SHIFT_STORE',
      status: 'active',
      timezone: 'Asia/Jayapura'
    })
    shift = await db.shift.create({
      store: location.id,
      name: 'WIT Shift',
      startTime: '08:00:00',
      endTime: '16:00:00',
      tanggal_mulai: '2026-01-15',
      tanggal_selesai: '2026-01-15',
      status: 'active'
    })
  })

  afterAll(async () => {
    await db.shift.destroy({ where: { id: shift.id }, force: true })
    await db.location.destroy({ where: { id: location.id }, force: true })
  })

  test('expires on the store date even when the server date is still earlier', async () => {
    const now = new Date('2026-01-15T16:30:00Z')
    const count = await autoExpireShifts(location.id, now)
    const row = await db.shift.findByPk(shift.id)

    expect(count).toBe(1)
    expect(row.status).toBe('inactive')
  })
})
