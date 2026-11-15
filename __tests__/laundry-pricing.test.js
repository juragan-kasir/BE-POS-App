const { billableQty, lineTotal, surchargeFor, roundQty, ceilQty, normalizeLaundrySettings } = require('../api/service/laundryPricing')

describe('laundryPricing', () => {
  test('kiloan applies minimum and rounding', () => {
    expect(billableQty({ pricingType: 'kiloan', minQty: 3, rounding: 0.1 }, 2.24)).toBe(3)
    expect(roundQty(2.24, 0.1)).toBe(2.2)
  })

  test('kiloan weight rounds UP to the next step (S-1)', () => {
    const cfg = { pricingType: 'kiloan', minQty: 3, rounding: 0.5 }
    expect(billableQty(cfg, 2.0)).toBe(3)
    expect(billableQty(cfg, 3.2)).toBe(3.5)
    expect(billableQty(cfg, 4.7)).toBe(5)
    expect(billableQty(cfg, 5.0)).toBe(5)
    expect(billableQty({ pricingType: 'kiloan', minQty: 0.1, rounding: 0.1 }, 0.3)).toBe(0.3)
    expect(ceilQty(4.01, 0.1)).toBe(4.1)
    expect(billableQty({ pricingType: 'satuan' }, 2)).toBe(2)
  })

  test('line total uses billed qty and component HPP', () => {
    const line = lineTotal(
      { price: 8000, unit: 'kg', serviceConfig: { pricingType: 'kiloan', minQty: 3, rounding: 0.1, costComponents: [{ kind: 'chemical', amount: 1000 }], channel: 'full', pricingMode: 'unit', requiresIroning: true } },
      2.2
    )
    expect(line.billQty).toBe(3)
    expect(line.subtotal).toBe(24000)
    expect(line.hppTotal).toBe(3000)
    expect(line.minimumApplied).toBe(true)
  })

  test('surcharge percent and fixed', () => {
    expect(surchargeFor(100000, { surchargeType: 'percent', surchargeValue: 10 })).toBe(10000)
    expect(surchargeFor(100000, { surchargeType: 'fixed', surchargeValue: 5000 })).toBe(5000)
    expect(surchargeFor(100000, null)).toBe(0)
  })

  test('normalizeLaundrySettings preserves serviceModel', () => {
    expect(normalizeLaundrySettings({ serviceModel: 'self', storageDays: 7 })).toEqual({
      serviceModel: 'self',
      storageDays: 7,
      minDpPercent: 0,
      reminderDays: 0,
      terms: '',
      conditionTags: [],
      ownerPinHash: null
    })
    expect(normalizeLaundrySettings({ serviceModel: 'invalid' }).serviceModel).toBe('full')
    expect(normalizeLaundrySettings(null)).toBeNull()
  })
})
