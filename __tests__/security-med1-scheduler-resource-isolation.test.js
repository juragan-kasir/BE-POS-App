process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const db = require('../db/models')
const { Op } = require('sequelize')
const { generateDueRecurringExpenses } = require('../api/service/expenseScheduler')
const { expirePendingSwaps } = require('../api/service/shiftSwapScheduler')

let storeA, storeB

describe('MED-1 scheduler resource isolation (bounded, fair batches)', () => {
  beforeAll(async () => {
    storeA = await db.location.create({ name: 'MED1_STORE_A', status: 'active' })
    storeB = await db.location.create({ name: 'MED1_STORE_B', status: 'active' })
  })

  afterAll(async () => {
    await db.location.destroy({ where: { id: [storeA.id, storeB.id] }, force: true })
  })

  describe('expenseScheduler.generateDueRecurringExpenses', () => {
    const TOTAL_TEMPLATES = 25 // > MAX_TEMPLATES_PER_TICK (20)
    let templateIds = []

    beforeEach(async () => {
      templateIds = []
      const now = Date.now()
      for (let i = 0; i < TOTAL_TEMPLATES; i++) {
        const store = i % 2 === 0 ? storeA.id : storeB.id
        const tpl = await db.expense.create({
          store,
          expenseNumber: `MED1-TPL-${now}-${i}`,
          amount: 1000,
          date: new Date(now - (TOTAL_TEMPLATES - i) * 1000),
          frequency: 'monthly',
          // stagger nextDueDate so ordering is deterministic and every row
          // is already due (in the past)
          nextDueDate: new Date(now - (TOTAL_TEMPLATES - i) * 60000),
          status: 'approved',
          isActive: true
        })
        templateIds.push(tpl.id)
      }
    })

    afterEach(async () => {
      await db.expense.destroy({
        where: { [Op.or]: [{ id: templateIds }, { parentId: templateIds }] },
        force: true
      })
    })

    test('one tick processes a bounded batch and reports how many it generated', async () => {
      const generatedByTick = await generateDueRecurringExpenses()

      const generatedCount = await db.expense.count({
        where: { parentId: templateIds }
      })

      expect(generatedByTick).toBe(generatedCount)
      expect(generatedCount).toBeGreaterThan(0)
      expect(generatedCount).toBeLessThan(TOTAL_TEMPLATES)
    })

    test('repeated ticks eventually process every eligible template exactly once, both stores represented, no duplicates', async () => {
      // Run enough ticks to drain the whole backlog.
      for (let i = 0; i < 3; i++) {
        await generateDueRecurringExpenses()
      }

      const generated = await db.expense.findAll({
        where: { parentId: templateIds },
        attributes: ['id', 'parentId', 'store']
      })

      // exactly one generated expense per template — no duplicate processing,
      // no skipped template.
      expect(generated.length).toBe(TOTAL_TEMPLATES)
      const parentIdsSeen = new Set(generated.map((g) => g.parentId))
      expect(parentIdsSeen.size).toBe(TOTAL_TEMPLATES)

      const storesRepresented = new Set(generated.map((g) => g.store))
      expect(storesRepresented.has(storeA.id)).toBe(true)
      expect(storesRepresented.has(storeB.id)).toBe(true)
    })
  })

  describe('shiftSwapScheduler.expirePendingSwaps', () => {
    const TOTAL_SWAPS = 55 // > MAX_SWAPS_PER_TICK (50)
    let swapIds = []

    beforeEach(async () => {
      swapIds = []
      const past = new Date(Date.now() - 60 * 60 * 1000)
      for (let i = 0; i < TOTAL_SWAPS; i++) {
        const store = i % 2 === 0 ? storeA.id : storeB.id
        const swap = await db.shift_swap.create({
          store,
          requesterId: 90000 + i,
          targetId: 91000 + i,
          requesterShiftId: 1,
          targetShiftId: 2,
          status: 'pending',
          expires_at: past,
          status_history: []
        })
        swapIds.push(swap.id)
      }
    })

    afterEach(async () => {
      await db.shift_swap.destroy({ where: { id: swapIds }, force: true })
    })

    test('one tick expires a bounded batch, not the entire cross-tenant backlog', async () => {
      await expirePendingSwaps()

      const expiredCount = await db.shift_swap.count({
        where: { id: swapIds, status: 'expired' }
      })

      expect(expiredCount).toBeGreaterThan(0)
      expect(expiredCount).toBeLessThan(TOTAL_SWAPS)
    })

    test('repeated ticks eventually expire every eligible swap exactly once, both stores represented', async () => {
      for (let i = 0; i < 3; i++) {
        await expirePendingSwaps()
      }

      const expired = await db.shift_swap.findAll({
        where: { id: swapIds, status: 'expired' },
        attributes: ['id', 'store']
      })

      expect(expired.length).toBe(TOTAL_SWAPS)
      const storesRepresented = new Set(expired.map((s) => s.store))
      expect(storesRepresented.has(storeA.id)).toBe(true)
      expect(storesRepresented.has(storeB.id)).toBe(true)
    })
  })
})
