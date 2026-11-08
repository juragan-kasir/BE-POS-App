'use strict'

process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const db = require('../../../db/models')
const { describeSegment } = require('../helpers/segment')

describeSegment({
  title: 'Segment 01 — Single outlet F&B (owner + 6 karyawan)',
  spec: {
    prefix: 'S01',
    merchants: 1,
    outlets: 1,
    employees: 6,
    ownerMode: 'store_admin'
  },
  extraTests: ({ getWorld, getOwnerApi, flows }) => {
    // Regression for FINDINGS.md E2E-01: a category whose `accountCode` is
    // not one of accountingService.DEFAULT_ACCOUNTS (e.g. 6500/6400, both
    // settable through /expense-category) must still post its journal.
    test('custom-coded expense posts its accounting journal', async () => {
      const world = getWorld()
      const ownerApi = getOwnerApi()
      const outlet = world.firstOutlet

      const create = await ownerApi.post('/expense/add', {
        store: outlet.location.id,
        categoryId: outlet.categories.operasional.id,
        amount: 12000,
        date: flows.localDateTime(),
        paymentMethod: 'cash',
        description: `Bukti bug jurnal ${world.suffix}`,
        status: 'approved'
      })
      expect(create.status).toBe(201)

      const entry = await db.journal_entry.findOne({
        where: {
          store: outlet.location.id,
          sourceType: 'expense',
          referenceId: create.body.data.id
        }
      })
      expect(entry).not.toBeNull()
    })

    test('store-bound owner cannot read another outlet', async () => {
      const world = getWorld()
      const ownerApi = getOwnerApi()
      const other = await db.location.create({
        name: `S01 Other Outlet ${world.suffix}`,
        tenantId: world.firstOutlet.tenant.id,
        status: 'active'
      })
      const res = await ownerApi.get(`/expense/get-all?store=${other.id}`)
      expect(res.status).toBe(403)
    })
  }
})
