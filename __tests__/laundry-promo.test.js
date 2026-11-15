const { amountFor, chooseDiscounts } = require('../api/service/laundryPromo')

const cand = (id, rule, eligible, { priority = 1, isCombinable = false } = {}) => {
  const base = eligible.reduce((s, l) => s + l.subtotal, 0)
  return { campaign: { id, priority, isCombinable }, rule, eligible, amount: amountFor(rule, base) }
}
const A = { productId: 1, subtotal: 60000 }
const B = { productId: 2, subtotal: 40000 }

describe('laundryPromo (mirrors FE laundry-promos)', () => {
  test('percent with cap, fixed capped at base', () => {
    expect(amountFor({ kind: 'percent', value: 10, cap: 10000 }, 120000)).toBe(10000)
    expect(amountFor({ kind: 'fixed', value: 50000, cap: 0 }, 30000)).toBe(30000)
    expect(amountFor({ kind: 'percent', value: 10, cap: 50000 }, 205000)).toBe(20500)
  })

  test('non-stackable → single best by amount, then priority, then id', () => {
    const picked = chooseDiscounts([
      cand(11, { kind: 'fixed', value: 7000 }, [A, B], { priority: 2 }),
      cand(12, { kind: 'percent', value: 10 }, [A, B], { priority: 1 }),
      cand(13, { kind: 'fixed', value: 3000 }, [A, B], { isCombinable: true })
    ])
    expect(picked.map((d) => [d.campaign.id, d.amount])).toEqual([[12, 10000]])
    expect(picked[0].allocations).toEqual([{ productId: 1, amount: 6000 }, { productId: 2, amount: 4000 }])
  })

  test('all stackable → priority order on what is left, exact allocation', () => {
    const picked = chooseDiscounts([
      cand(22, { kind: 'fixed', value: 5000 }, [A, B], { priority: 2, isCombinable: true }),
      cand(21, { kind: 'percent', value: 10 }, [A, B], { priority: 1, isCombinable: true })
    ])
    expect(picked.map((d) => [d.campaign.id, d.amount])).toEqual([[21, 10000], [22, 5000]])
    expect(picked[1].allocations).toEqual([{ productId: 1, amount: 3000 }, { productId: 2, amount: 2000 }])
  })

  test('service scope limits base', () => {
    const picked = chooseDiscounts([cand(31, { kind: 'percent', value: 20 }, [{ productId: 1, subtotal: 50000 }])])
    expect(picked[0].amount).toBe(10000)
  })
})
