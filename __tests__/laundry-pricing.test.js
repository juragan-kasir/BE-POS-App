const { billableQty, lineTotal, surchargeFor, roundQty, ceilQty, dueAtFrom, manualDiscountCap, normalizeLaundrySettings } = require('../api/service/laundryPricing')

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

  test('dueAtFrom reads array and compact {open,close,closedDays} hours alike', () => {
    const local = (d) => new Date(d.getTime() + 7 * 36e5).toISOString().slice(0, 16)
    const at = new Date('2026-11-16T18:30:00+07:00')
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
    const arr = days.map((day) => ({ day, open: '07:00', close: '22:00' }))
    expect(local(dueAtFrom(at, 6, arr, 'Asia/Jakarta'))).toBe('2026-11-17T09:30')
    expect(local(dueAtFrom(at, 6, { open: '07:00', close: '22:00', closedDays: [] }, 'Asia/Jakarta'))).toBe('2026-11-17T09:30')
    // Friday 10:00 + 48 h lands on a closed Sunday → next open Monday 08:00
    const fri = new Date('2026-11-20T10:00:00+07:00')
    expect(local(dueAtFrom(fri, 48, { open: '08:00', close: '20:00', closedDays: [0] }, 'Asia/Jakarta'))).toBe('2026-11-23T08:00')
    expect(local(dueAtFrom(at, 6, { open: 'x' }, 'Asia/Jakarta'))).toBe('2026-11-17T00:30')
  })

  test('manual discount cap: configured, else 20% of subtotal, ≤ subtotal', () => {
    expect(manualDiscountCap(null, 100000)).toBe(20000)
    expect(manualDiscountCap({ maxManualDiscount: 50000 }, 100000)).toBe(50000)
    expect(manualDiscountCap({ maxManualDiscount: 50000 }, 30000)).toBe(30000)
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
      maxManualDiscount: 0,
      reminderDays: 0,
      terms: '',
      conditionTags: [],
      ownerPinHash: null
    })
    expect(normalizeLaundrySettings({ serviceModel: 'invalid' }).serviceModel).toBe('full')
    expect(normalizeLaundrySettings(null)).toBeNull()
  })
})
