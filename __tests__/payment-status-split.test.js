process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const { legacyPaymentStatusFor } = require('../api/service/orderFinancials')
const { completedSaleSql, unsettledSaleSql } = require('../utils/completedSaleSql')

// P3 (product-grade audit 2026-11-02): 'partial' used to mean both
// PARTIALLY_PAID (an open bill with a deposit) and PARTIALLY_REFUNDED (a
// settled sale with an approved return). Reports and the FE had to inspect
// `status` to tell them apart. The persisted enum now carries both states,
// while 'partial' remains readable for legacy rows.
describe('paymentStatus split', () => {
  test.each([
    ['UNPAID', 'unpaid'],
    ['PARTIALLY_PAID', 'partially_paid'],
    ['PAID', 'paid'],
    ['PARTIALLY_REFUNDED', 'partially_refunded'],
    ['REFUNDED', 'refunded']
  ])('legacyPaymentStatusFor(%s) = %s', (state, expected) => {
    expect(legacyPaymentStatusFor(state)).toBe(expected)
  })

  test('INVALID has no persisted mapping', () => {
    expect(legacyPaymentStatusFor('INVALID')).toBeNull()
  })

  test('completed sales include new partially_refunded rows and legacy partial+return', () => {
    const sql = completedSaleSql()
    expect(sql).toContain("'partially_refunded'")
    expect(sql).toContain("'partial'")
    expect(sql).toContain('sales_return')
    expect(sql).toContain("'approved'")
  })

  test('unsettled sales include partially_paid and legacy partial without a return', () => {
    const sql = unsettledSaleSql()
    expect(sql).toContain("'partially_paid'")
    expect(sql).toContain("'partial'")
    expect(sql).toContain('NOT EXISTS')
  })
})
