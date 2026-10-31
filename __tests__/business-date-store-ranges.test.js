const {
  getStoreClock,
  toStoreRangeBound,
  getStorePeriodBounds,
  getStoreFilterRange
} = require('../utils/businessDate')

// 2026-11-01 01:30 in Jakarta (UTC+7) is still 2026-10-31 18:30 UTC: the
// store's Sunday morning is the server's Saturday evening.
const SUNDAY_EARLY_WIB = new Date('2026-10-31T18:30:00.000Z')
const TZ = 'Asia/Jakarta'

describe('store-calendar helpers', () => {
  test('the store clock reads the store wall time, not the server time', () => {
    expect(getStoreClock(TZ, SUNDAY_EARLY_WIB)).toEqual({ day: 0, time: '01:30:00' })
  })

  test('a plain date bound covers that whole store day', () => {
    expect(toStoreRangeBound('2026-11-01', TZ, 'start').toISOString()).toBe(
      '2026-10-31T17:00:00.000Z'
    )
    expect(toStoreRangeBound('2026-11-01', TZ, 'end').toISOString()).toBe(
      '2026-11-01T16:59:59.999Z'
    )
  })

  test('a full ISO bound is used as given', () => {
    expect(toStoreRangeBound('2026-11-01T05:00:00.000Z', TZ, 'start').toISOString()).toBe(
      '2026-11-01T05:00:00.000Z'
    )
    expect(toStoreRangeBound('', TZ, 'start')).toBeNull()
  })

  test('today, this week and this month follow the store calendar', () => {
    const iso = (r) => [r.start.toISOString(), r.end.toISOString()]
    expect(iso(getStorePeriodBounds('today', TZ, SUNDAY_EARLY_WIB))).toEqual([
      '2026-10-31T17:00:00.000Z',
      '2026-11-01T16:59:59.999Z'
    ])
    expect(iso(getStorePeriodBounds('week', TZ, SUNDAY_EARLY_WIB))).toEqual([
      '2026-10-25T17:00:00.000Z',
      '2026-11-01T16:59:59.999Z'
    ])
    expect(iso(getStorePeriodBounds('month', TZ, SUNDAY_EARLY_WIB))).toEqual([
      '2026-10-31T17:00:00.000Z',
      '2026-11-30T16:59:59.999Z'
    ])
  })

  test('report filters map to store periods, custom ranges to store days', () => {
    const daily = getStoreFilterRange({ filter: 'today' }, TZ, SUNDAY_EARLY_WIB)
    expect(daily.start.toISOString()).toBe('2026-10-31T17:00:00.000Z')
    const custom = getStoreFilterRange({ startDate: '2026-10-01', endDate: '2026-10-31' }, TZ)
    expect(custom.start.toISOString()).toBe('2026-09-30T17:00:00.000Z')
    expect(custom.end.toISOString()).toBe('2026-10-31T16:59:59.999Z')
    expect(getStoreFilterRange({}, TZ)).toBeNull()
  })
})
