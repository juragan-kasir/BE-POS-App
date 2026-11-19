process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const excelJS = require('exceljs')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let storeA, storeB, tokenA, tokenB, superToken, unassignedToken

const mkToken = (roleType, store, id) =>
  signSessionToken({ id, userName: `so_tok_${roleType}_${id}`, roleType, store }, JWT_SECRET)

// Builds a valid "Stock Opname" xlsx buffer matching uploadExcel's EXPECTED
// header contract exactly.
const buildOpnameExcel = ({ lokasiName = null } = {}) => {
  const workbook = new excelJS.Workbook()
  const worksheet = workbook.addWorksheet('Stock Opname')
  worksheet.addRow([
    'No.',
    'Kode Barang',
    'Nama Barang',
    'Satuan',
    'Lokasi',
    'Stok Awal',
    'Barang Masuk',
    'Barang Keluar',
    'Stok Akhir',
    'Stok Fisik',
    'Selisih',
    'Keterangan'
  ])
  worksheet.addRow([
    1,
    'SKU-SO-1',
    'SO_TEST_PRODUCT',
    'pcs',
    lokasiName,
    100,
    0,
    0,
    100,
    95,
    -5,
    'test'
  ])
  return workbook.xlsx.writeBuffer()
}

describe('SO-01/02/03 stockOpname.js cookie-based tenant-isolation bypass', () => {
  beforeAll(async () => {
    storeA = await db.location.create(await withTestTenant({ name: 'SO_STORE_A', status: 'active' }))
    storeB = await db.location.create(await withTestTenant({ name: 'SO_STORE_B', status: 'active' }))


    // P1-4: central gate denies unknown caller identities; these rows give
    // the caller ids real identities with matching assigned/unassigned
    // semantics (store null preserves unassigned). Assertions unchanged.
    for (const [id, userName, roleType, userType, store] of [
      [79101, 'so_admin_a', 'admin', 'admin', storeA.id],
      [79102, 'so_admin_b', 'admin', 'admin', storeB.id],
      [79103, 'so_super', 'super_admin', 'admin', null],
      [79104, 'so_unassigned', 'admin', 'admin', null]
    ]) {
      await db.user.create({
        id,
        userName,
        email: `p14-${id}-sostock@test.com`,
        roleType,
        userType,
        store,
        status: 'active',
        fullName: userName
      })
    }
  // AUTH-1 P2: sessions need their user rows (FK), so mint tokens after them.
    tokenA = await mkToken('admin', storeA.id, 79101)
    tokenB = await mkToken('admin', storeB.id, 79102)
    superToken = await mkToken('super_admin', null, 79103)
    unassignedToken = await mkToken('admin', null, 79104)
  })

  afterAll(async () => {
    const leftover = await db.stockOpname.findAll({
      where: { store: [storeA.id, storeB.id] },
      attributes: ['id']
    })
    const leftoverIds = leftover.map((o) => o.id)
    if (leftoverIds.length > 0) {
      await db.stockOpnameItem.destroy({
        where: { stockOpname: leftoverIds },
        force: true
      })
    }
    await db.stockOpname.destroy({ where: { store: [storeA.id, storeB.id] }, force: true })
    await db.user.destroy({ where: { id: [79101, 79102, 79103, 79104] }, force: true })
    await db.location.destroy({ where: { id: [storeA.id, storeB.id] }, force: true })
  })

  // ================== SO-01 uploadExcel ==================
  describe('SO-01 uploadExcel', () => {
    afterEach(async () => {
      // Clean up any opname the test itself created, scoped by opnameNumber
      // pattern isn't available — clean by store + recent notes marker instead.
      await db.stockOpname.destroy({
        where: { store: [storeA.id, storeB.id] },
        force: true
      })
    })

    test('store A admin uploading with NO forged cookie creates the opname under store A only', async () => {
      const buf = await buildOpnameExcel()
      const res = await request(app)
        .post('/stock-opname/upload-excel')
        .set('Authorization', `Bearer ${tokenA}`)
        .attach('file', buf, 'opname.xlsx')

      expect(res.status).toBe(201)

      const rows = await db.stockOpname.findAll({ where: { store: storeA.id } })
      expect(rows.length).toBe(1)
      const foreignRows = await db.stockOpname.findAll({ where: { store: storeB.id } })
      expect(foreignRows.length).toBe(0)
    })

    test('store A admin uploading with Cookie: store=B MUST NOT create a stock_opname for store B', async () => {
      const buf = await buildOpnameExcel()
      const res = await request(app)
        .post('/stock-opname/upload-excel')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('Cookie', [`store=${storeB.id}`])
        .attach('file', buf, 'opname.xlsx')

      // Never 200/201 attributing the write to store B — either it succeeds
      // scoped to the caller's own store, or it is rejected. It must NEVER
      // create a store B row.
      const foreignRows = await db.stockOpname.findAll({ where: { store: storeB.id } })
      expect(foreignRows.length).toBe(0)

      if (res.status === 201) {
        // If the request succeeded, it MUST have been attributed to the
        // caller's real (JWT) store, never the forged cookie's store.
        const ownRows = await db.stockOpname.findAll({ where: { store: storeA.id } })
        expect(ownRows.length).toBe(1)
      } else {
        expect([400, 403]).toContain(res.status)
      }
    })

    test('store A admin uploading with a nonexistent cookie store (999999) still never leaks into store 999999', async () => {
      const buf = await buildOpnameExcel()
      await request(app)
        .post('/stock-opname/upload-excel')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('Cookie', ['store=999999'])
        .attach('file', buf, 'opname.xlsx')

      const bogus = await db.stockOpname.findAll({ where: { store: 999999 } })
      expect(bogus.length).toBe(0)
    })

    test('Excel row naming store B as the "Lokasi" text does not redirect the write to store B (store A caller)', async () => {
      const buf = await buildOpnameExcel({ lokasiName: 'SO_STORE_B' })
      const res = await request(app)
        .post('/stock-opname/upload-excel')
        .set('Authorization', `Bearer ${tokenA}`)
        .attach('file', buf, 'opname.xlsx')

      expect(res.status).toBe(201)
      const foreignRows = await db.stockOpname.findAll({ where: { store: storeB.id } })
      expect(foreignRows.length).toBe(0)
      const ownRows = await db.stockOpname.findAll({ where: { store: storeA.id } })
      expect(ownRows.length).toBe(1)
    })

    test('unassigned admin (no store claim) is rejected before any write', async () => {
      const buf = await buildOpnameExcel()
      const res = await request(app)
        .post('/stock-opname/upload-excel')
        .set('Authorization', `Bearer ${unassignedToken}`)
        .attach('file', buf, 'opname.xlsx')

      expect(res.status).toBe(403)
    })

    test('super_admin can still upload (explicit store) and it is attributed correctly', async () => {
      const buf = await buildOpnameExcel()
      const res = await request(app)
        .post(`/stock-opname/upload-excel?store=${storeA.id}`)
        .set('Authorization', `Bearer ${superToken}`)
        .attach('file', buf, 'opname.xlsx')

      expect(res.status).toBe(201)
      const rows = await db.stockOpname.findAll({ where: { store: storeA.id } })
      expect(rows.length).toBe(1)
    })
  })

  // ================== SO-02 checkExists ==================
  describe('SO-02 checkExists', () => {
    let completedB

    beforeAll(async () => {
      completedB = await db.stockOpname.create({
        store: storeB.id,
        opnameNumber: `SO-CANARY-B-${Date.now()}`,
        date: new Date(),
        status: 'completed',
        totalAdjustment: 0
      })
    })

    afterAll(async () => {
      await db.stockOpname.destroy({ where: { id: completedB.id }, force: true })
    })

    test('store A user with own ?store= sees correct (false) result for store A', async () => {
      const res = await request(app)
        .get('/stock-opname/check-exists')
        .query({ store: storeA.id })
        .set('Authorization', `Bearer ${tokenA}`)

      expect(res.status).toBe(200)
      expect(res.body.data.exists).toBe(false)
    })

    test('store A user requesting ?store=B explicitly is rejected (validateStoreAccess)', async () => {
      const res = await request(app)
        .get('/stock-opname/check-exists')
        .query({ store: storeB.id })
        .set('Authorization', `Bearer ${tokenA}`)

      expect(res.status).toBe(403)
    })

    test('store A user omitting ?store= but sending Cookie: store=B MUST NOT disclose store B state', async () => {
      const res = await request(app)
        .get('/stock-opname/check-exists')
        .set('Cookie', [`store=${storeB.id}`])
        .set('Authorization', `Bearer ${tokenA}`)

      // Must never report store B's true state (exists:true, count:1).
      if (res.status === 200) {
        expect(res.body.data.exists).toBe(false)
      } else {
        expect([400, 403]).toContain(res.status)
      }
    })

    test('store A user omitting both ?store= and cookie resolves to own store (or fails closed)', async () => {
      const res = await request(app)
        .get('/stock-opname/check-exists')
        .set('Authorization', `Bearer ${tokenA}`)

      if (res.status === 200) {
        expect(res.body.data.exists).toBe(false)
      } else {
        expect(res.status).toBe(400)
      }
    })

    test('store B user with own store correctly sees exists:true', async () => {
      const res = await request(app)
        .get('/stock-opname/check-exists')
        .query({ store: storeB.id })
        .set('Authorization', `Bearer ${tokenB}`)

      expect(res.status).toBe(200)
      expect(res.body.data.exists).toBe(true)
    })

    test('unassigned user fails closed', async () => {
      const res = await request(app)
        .get('/stock-opname/check-exists')
        .set('Authorization', `Bearer ${unassignedToken}`)

      expect(res.status).toBe(403)
    })

    test('super_admin with explicit ?store=B sees correct result', async () => {
      const res = await request(app)
        .get('/stock-opname/check-exists')
        .query({ store: storeB.id })
        .set('Authorization', `Bearer ${superToken}`)

      expect(res.status).toBe(200)
      expect(res.body.data.exists).toBe(true)
    })
  })

  // ================== SO-03 getCompositionItems ==================
  describe('SO-03 getCompositionItems', () => {
    let completedB, itemB

    beforeAll(async () => {
      completedB = await db.stockOpname.create({
        store: storeB.id,
        opnameNumber: `SO-COMP-B-${Date.now()}`,
        date: new Date(),
        status: 'completed',
        totalAdjustment: 0
      })
      itemB = await db.stockOpnameItem.create({
        stockOpname: completedB.id,
        namaBarang: 'SO_SECRET_STORE_B_ITEM',
        kodeBarang: 'SECRET-B',
        satuan: 'pcs',
        stokAwalJumlah: 10,
        barangMasukJumlah: 0,
        barangKeluarJumlah: 0,
        stokAkhirJumlah: 10,
        stokFisikJumlah: 10,
        selisihJumlah: 0
      })
    })

    afterAll(async () => {
      await db.stockOpnameItem.destroy({ where: { id: itemB.id }, force: true })
      await db.stockOpname.destroy({ where: { id: completedB.id }, force: true })
    })

    test('store A user requesting ?store=B explicitly is rejected', async () => {
      const res = await request(app)
        .get('/stock-opname/composition-items')
        .query({ store: storeB.id })
        .set('Authorization', `Bearer ${tokenA}`)

      expect(res.status).toBe(403)
    })

    test('store A user omitting ?store= but sending Cookie: store=B MUST NOT leak store B item data', async () => {
      const res = await request(app)
        .get('/stock-opname/composition-items')
        .set('Cookie', [`store=${storeB.id}`])
        .set('Authorization', `Bearer ${tokenA}`)

      const names = (res.body?.data || []).map((i) => i.name)
      expect(names).not.toContain('SO_SECRET_STORE_B_ITEM')
    })

    test('store B user correctly sees its own composition item', async () => {
      const res = await request(app)
        .get('/stock-opname/composition-items')
        .query({ store: storeB.id })
        .set('Authorization', `Bearer ${tokenB}`)

      expect(res.status).toBe(200)
      const names = res.body.data.map((i) => i.name)
      expect(names).toContain('SO_SECRET_STORE_B_ITEM')
    })

    test('unassigned user fails closed', async () => {
      const res = await request(app)
        .get('/stock-opname/composition-items')
        .set('Authorization', `Bearer ${unassignedToken}`)

      expect(res.status).toBe(403)
    })
  })

  // ================== Adversarial combinations ==================
  describe('adversarial store-source combinations', () => {
    let completedB

    beforeAll(async () => {
      completedB = await db.stockOpname.create({
        store: storeB.id,
        opnameNumber: `SO-ADV-B-${Date.now()}`,
        date: new Date(),
        status: 'completed',
        totalAdjustment: 0
      })
    })

    afterAll(async () => {
      await db.stockOpname.destroy({ where: { id: completedB.id }, force: true })
    })

    test('?store=A with Cookie: store=B resolves to A (query/validateStoreAccess wins, never the cookie)', async () => {
      const res = await request(app)
        .get('/stock-opname/check-exists')
        .query({ store: storeA.id })
        .set('Cookie', [`store=${storeB.id}`])
        .set('Authorization', `Bearer ${tokenA}`)

      expect(res.status).toBe(200)
      expect(res.body.data.exists).toBe(false)
    })

    test('?store=B with Cookie: store=A is rejected (explicit foreign query still wins the 403)', async () => {
      const res = await request(app)
        .get('/stock-opname/check-exists')
        .query({ store: storeB.id })
        .set('Cookie', [`store=${storeA.id}`])
        .set('Authorization', `Bearer ${tokenA}`)

      expect(res.status).toBe(403)
    })

    test('empty cookie value never leaks store B state', async () => {
      const res = await request(app)
        .get('/stock-opname/check-exists')
        .set('Cookie', ['store='])
        .set('Authorization', `Bearer ${tokenA}`)

      if (res.status === 200) expect(res.body.data.exists).toBe(false)
    })
  })
})
