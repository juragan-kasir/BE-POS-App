const { getStoreOpenStatus } = require('../utils/storeHours')

const DAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday'
]

const hours = (open, close, extra = {}) =>
  DAYS.map((day) => ({
    day,
    open,
    close,
    is24Hours: false,
    ...extra
  }))

test('a store without opening hours is treated as open', () => {
  expect(
    getStoreOpenStatus(null, 'Asia/Jakarta', new Date('2026-10-26T03:00:00Z'))
  ).toEqual({ isOpen: true, nextOpenAt: null })
})

test('a store inside its local schedule is open', () => {
  const status = getStoreOpenStatus(
    hours('10:00', '18:00'),
    'Asia/Jakarta',
    new Date('2026-10-26T05:00:00Z')
  )
  expect(status).toEqual({ isOpen: true, nextOpenAt: null })
})

test('a closed store reports the next local opening instant', () => {
  const status = getStoreOpenStatus(
    hours('10:00', '18:00'),
    'Asia/Jakarta',
    new Date('2026-10-26T13:00:00Z')
  )
  expect(status.isOpen).toBe(false)
  expect(status.nextOpenAt.toISOString()).toBe('2026-10-27T03:00:00.000Z')
})

test('before opening the same day is the next opening instant', () => {
  const status = getStoreOpenStatus(
    hours('10:00', '18:00'),
    'Asia/Jakarta',
    new Date('2026-10-26T01:00:00Z')
  )
  expect(status.isOpen).toBe(false)
  expect(status.nextOpenAt.toISOString()).toBe('2026-10-26T03:00:00.000Z')
})

test('is24Hours is honored without inferring from open and close', () => {
  const status = getStoreOpenStatus(
    [{ day: 'monday', open: '00:00', close: '23:59', is24Hours: true }],
    'Asia/Jakarta',
    new Date('2026-10-26T05:00:00Z')
  )
  expect(status).toEqual({ isOpen: true, nextOpenAt: null })
})

test('an overnight schedule is open after midnight', () => {
  const status = getStoreOpenStatus(
    hours('22:00', '02:00'),
    'Asia/Jakarta',
    new Date('2026-10-26T18:00:00Z')
  )
  expect(status.isOpen).toBe(true)
})

test('an explicitly closed day is closed even when legacy times remain', () => {
  const openingHours = hours('10:00', '18:00').map((entry) =>
    entry.day === 'monday' ? { ...entry, isOpen: false } : entry
  )
  const status = getStoreOpenStatus(
    openingHours,
    'Asia/Jakarta',
    new Date('2026-10-26T05:00:00Z')
  )
  expect(status.isOpen).toBe(false)
  expect(status.nextOpenAt.toISOString()).toBe('2026-10-27T03:00:00.000Z')
})

test('an overnight carryover from an explicitly closed day is not open', () => {
  const openingHours = hours('22:00', '02:00').map((entry) =>
    entry.day === 'monday' ? { ...entry, isOpen: false } : entry
  )
  const status = getStoreOpenStatus(
    openingHours,
    'Asia/Jakarta',
    new Date('2026-10-26T17:30:00Z')
  )
  expect(status.isOpen).toBe(false)
  expect(status.nextOpenAt.toISOString()).toBe('2026-10-27T15:00:00.000Z')
})

test('the store timezone decides the day and wall-clock minute', () => {
  const openingHours = hours('08:00', '17:00')
  const now = new Date('2026-10-26T00:30:00Z')

  expect(getStoreOpenStatus(openingHours, 'Asia/Jakarta', now).isOpen).toBe(
    false
  )
  expect(getStoreOpenStatus(openingHours, 'Asia/Jayapura', now).isOpen).toBe(
    true
  )
})
