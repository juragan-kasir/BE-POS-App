'use strict'

const { assertFullyPaidForFulfillment } = require('../api/service/bakeryFulfillment')

const refusal = (fn) => {
  try {
    fn()
  } catch (e) {
    return e
  }
  throw new Error('expected a refusal')
}

describe('bakery fulfillment payment gate', () => {
  test('blocks pickup when outstanding remains', () => {
    const err = refusal(() => assertFullyPaidForFulfillment('PICKED_UP', 10000, 50000))
    expect(err.statusCode).toBe(409)
    expect(err.code).toBe('PAYMENT_REQUIRED')
  })

  test('blocks delivery when outstanding remains', () => {
    const err = refusal(() => assertFullyPaidForFulfillment('DELIVERED', 0, 50000))
    expect(err.statusCode).toBe(409)
    expect(err.code).toBe('PAYMENT_REQUIRED')
  })

  test('allows pickup when fully paid', () => {
    expect(() => assertFullyPaidForFulfillment('PICKED_UP', 50000, 50000)).not.toThrow()
  })

  test('allows delivery when fully paid', () => {
    expect(() => assertFullyPaidForFulfillment('DELIVERED', 60000, 50000)).not.toThrow()
  })

  test('does not gate other statuses', () => {
    expect(() => assertFullyPaidForFulfillment('READY', 0, 50000)).not.toThrow()
    expect(() => assertFullyPaidForFulfillment('CONFIRMED', 0, 50000)).not.toThrow()
  })

  test('allows zero-total orders', () => {
    expect(() => assertFullyPaidForFulfillment('PICKED_UP', 0, 0)).not.toThrow()
  })
})
