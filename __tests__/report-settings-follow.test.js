require('dotenv').config()

// /report/settings drives every report: the on-screen table (GET
// /report/data/:key) and every export (PDF/Excel/CSV) use the same columns,
// order, accent colour and branding switches, and the export header shows
// the store the report is for.

const { PassThrough } = require('stream')
const request = require('supertest')
const express = require('express')
const jwt = require('jsonwebtoken')
const PDFDocument = require('pdfkit')

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

jest.mock('../db/models', () => {
  const store = (id, name) => ({
    id,
    name,
    address: `Jl. ${name} No.1`,
    city: '3273',
    province: '32',
    postalCode: '40111',
    phoneNumber: '0812',
    email: `${name.toLowerCase()}@toko.id`,
    timezone: 'Asia/Jakarta',
    image: null
  })
  return {
    authorizationContextSession: {
      findOne: jest.fn(({ where }) =>
        Promise.resolve(
          where.sessionId === 'a'.repeat(64)
            ? {
                sessionId: where.sessionId,
                userId: 9999,
                revokedAt: null,
                expiresAt: new Date(Date.now() + 3600000),
                user: { id: 9999, roleType: 'super_admin', store: null, disabledAt: null, deletedAt: null }
              }
            : null
        )
      )
    },
    location: {
      findByPk: jest.fn((id) => Promise.resolve(id === 7 ? store(7, 'Cabang') : null)),
      findOne: jest.fn(() => Promise.resolve(store(1, 'Pusat')))
    },
    region: {
      findAll: jest.fn(() =>
        Promise.resolve([
          { code: '3273', name: 'Kota Bandung' },
          { code: '32', name: 'Jawa Barat' }
        ])
      )
    },
    reportConfig: { findOne: jest.fn(() => Promise.resolve(null)) }
  }
})

jest.mock('../api/service/reportDefs', () => ({
  sales: {
    label: 'Ringkasan Penjualan',
    defaultColumns: [
      { key: 'name', label: 'Toko', type: 'string', width: 18, align: 'left' },
      { key: 'city', label: 'Kota', type: 'string', width: 14, align: 'left' },
      { key: 'sales', label: 'Total Penjualan', type: 'currency', width: 20, align: 'right' },
      { key: 'transactions', label: 'Transaksi', type: 'number', width: 14, align: 'right' }
    ],
    totals: ['sales', 'transactions'],
    filename: () => 'ringkasan-penjualan',
    getData: jest.fn(() =>
      Promise.resolve({
        title: 'Ringkasan Penjualan',
        subtitle: 'Periode: Hari ini',
        rows: [
          { name: 'Cabang', city: 'Kota Bandung', sales: 150000, transactions: 3 },
          { name: 'Pusat', city: 'Kota Bandung', sales: 50000, transactions: 1 }
        ]
      })
    )
  }
}))

const db = require('../db/models')
const reportDefs = require('../api/service/reportDefs')
const { reportData, buildSpecFromDef, loadBrand } = require('../api/controller/reportExport')
const { validateConfig, DEFAULT_BRANDING } = require('../api/controller/reportConfig')
const { loadLogoImage } = require('../api/service/reportExporter/logoImage')
const { renderPdf } = require('../api/service/reportExporter/pdf')
const { buildExcelWorkbook } = require('../api/service/reportExporter/excel')
const reportExportRoutes = require('../api/routes/reportExport')

const secret = process.env.JWT_SECRET_KEY || 'secret-key-user'
const superToken = jwt.sign(
  { id: 9999, sessionId: 'a'.repeat(64), userName: 'superadmin', roleType: 'super_admin' },
  secret
)
const app = express()
app.use('/report', reportExportRoutes)

const mockRes = () => {
  const res = {}
  res.status = jest.fn(() => res)
  res.json = jest.fn(() => res)
  return res
}
const storeReq = (store) => ({
  params: { key: 'sales' },
  query: {},
  user: { id: 5, roleType: 'admin', store },
  storeId: store
})
const useConfig = (config) => db.reportConfig.findOne.mockResolvedValue(config ? { config } : null)

afterEach(() => {
  useConfig(null)
})

describe('validateConfig (PUT /report-config/:key)', () => {
  const def = reportDefs.sales

  test('accepts a known, ordered column selection, hex colour and branding switches', () => {
    expect(
      validateConfig(def, {
        selectedColumns: ['sales', 'name'],
        accentColor: '#1d4ed8',
        branding: { showLogo: false, showEmail: true }
      })
    ).toBeNull()
    expect(validateConfig(def, { selectedColumns: null })).toBeNull()
  })

  test.each([
    [[], 'Pilih minimal satu kolom'],
    [['name', 'bogus'], 'Kolom tidak dikenal: bogus'],
    [['name', 'name'], 'Kolom tidak boleh duplikat'],
    ['name', 'Pilih minimal satu kolom']
  ])('rejects selectedColumns %p', (selectedColumns, message) => {
    expect(validateConfig(def, { selectedColumns })).toBe(message)
  })

  test('rejects a non-hex accent colour and unknown / non-boolean branding', () => {
    expect(validateConfig(def, { accentColor: 'red' })).toMatch(/#RRGGBB/)
    expect(validateConfig(def, { branding: { showQr: true } })).toMatch(/tidak dikenal: showQr/)
    expect(validateConfig(def, { branding: { showLogo: 'no' } })).toMatch(/showLogo harus true\/false/)
    expect(validateConfig(def, [])).toMatch(/objek/)
  })

  test('every branding switch defaults on, including email', () => {
    expect(DEFAULT_BRANDING).toEqual({ showLogo: true, showAddress: true, showPhone: true, showEmail: true })
  })
})

describe('buildSpecFromDef', () => {
  const def = reportDefs.sales
  const data = { rows: [], title: 't', subtitle: 's' }

  test('uses the saved columns in the saved order', () => {
    const spec = buildSpecFromDef(def, data, { selectedColumns: ['transactions', 'name'] }, null)
    expect(spec.columns.map((c) => c.key)).toEqual(['transactions', 'name'])
  })

  test('drops columns the report no longer has; falls back to defaults if none remain', () => {
    expect(buildSpecFromDef(def, data, { selectedColumns: ['gone', 'sales'] }, null).columns.map((c) => c.key)).toEqual([
      'sales'
    ])
    expect(buildSpecFromDef(def, data, { selectedColumns: ['gone'] }, null).columns).toHaveLength(4)
  })

  test('merges partial branding with the defaults', () => {
    const spec = buildSpecFromDef(def, data, { branding: { showPhone: false } }, null)
    expect(spec.branding).toEqual({ showLogo: true, showAddress: true, showPhone: false, showEmail: true })
  })
})

describe('GET /report/data/:key', () => {
  test('returns the settings columns (order + labels), rows and totals of visible columns only', async () => {
    useConfig({ selectedColumns: ['sales', 'name'], accentColor: '#1d4ed8' })
    const res = mockRes()
    await reportData(storeReq(7), res)
    expect(res.status).toHaveBeenCalledWith(200)
    const body = res.json.mock.calls[0][0]
    expect(body.success).toBe(true)
    expect(body.data.columns).toEqual([
      { key: 'sales', label: 'Total Penjualan', type: 'currency', align: 'right' },
      { key: 'name', label: 'Toko', type: 'string', align: 'left' }
    ])
    expect(body.data.accentColor).toBe('#1d4ed8')
    expect(body.data.rows).toHaveLength(2)
    expect(body.data.totals).toEqual({ sales: 200000 })
    expect(body.data.subtitle).toBe('Periode: Hari ini')
  })

  test('without a saved config it returns every default column', async () => {
    const res = mockRes()
    await reportData(storeReq(7), res)
    const body = res.json.mock.calls[0][0]
    expect(body.data.columns.map((c) => c.key)).toEqual(['name', 'city', 'sales', 'transactions'])
    expect(body.data.totals).toEqual({ sales: 200000, transactions: 4 })
    expect(body.data.accentColor).toBe('#0f172a')
  })

  test('refuses a store-less non-super-admin', async () => {
    const res = mockRes()
    await reportData({ ...storeReq(null), storeId: undefined }, res)
    expect(res.status).toHaveBeenCalledWith(403)
  })

  test('route: 404 for an unknown report, 200 JSON for a known one', async () => {
    await request(app).get('/report/data/bogus').set('Authorization', `Bearer ${superToken}`).expect(404)
    const res = await request(app)
      .get('/report/data/sales')
      .set('Authorization', `Bearer ${superToken}`)
      .expect(200)
    expect(res.body.data.columns.map((c) => c.key)).toEqual(['name', 'city', 'sales', 'transactions'])
  })

  test('route: requires authentication', async () => {
    const res = await request(app).get('/report/data/sales')
    expect([401, 403]).toContain(res.status)
  })
})

describe('export header = the store the report is for', () => {
  test("a store user's export shows their own store, with region names", async () => {
    const brand = await loadBrand(storeReq(7), { withLogo: false })
    expect(db.location.findByPk).toHaveBeenCalledWith(7)
    expect(brand).toMatchObject({
      name: 'Cabang',
      city: 'Kota Bandung',
      province: 'Jawa Barat',
      email: 'cabang@toko.id',
      logoImage: null
    })
  })

  test('a super admin exporting all stores falls back to the main branch', async () => {
    const brand = await loadBrand({ user: { roleType: 'super_admin' }, query: {} }, { withLogo: false })
    expect(brand.name).toBe('Pusat')
  })
})

describe('loadLogoImage', () => {
  test('reads a PNG data URI', async () => {
    const logo = await loadLogoImage(`data:image/png;base64,${PNG_1X1}`)
    expect(logo.extension).toBe('png')
    expect(logo.buffer.length).toBeGreaterThan(0)
  })

  test('ignores unsupported or unsafe sources', async () => {
    expect(await loadLogoImage(null)).toBeNull()
    expect(await loadLogoImage('data:image/gif;base64,R0lGODlhAQABAAAAACw=')).toBeNull()
    expect(await loadLogoImage('file:///etc/passwd')).toBeNull()
  })

  test('only fetches HTTPS Cloudinary URLs (no SSRF to internal addresses)', async () => {
    const originalFetch = global.fetch
    global.fetch = jest.fn()
    try {
      for (const url of [
        'http://169.254.169.254/latest/meta-data/',
        'https://localhost/logo.png',
        'http://res.cloudinary.com/demo/logo.png',
        'https://res.cloudinary.com.evil.example/logo.png'
      ]) {
        expect(await loadLogoImage(url)).toBeNull()
      }
      expect(global.fetch).not.toHaveBeenCalled()
    } finally {
      global.fetch = originalFetch
    }
  })

  test('fetches an http logo and gives up on a failed response', async () => {
    const buffer = Buffer.from(PNG_1X1, 'base64')
    const originalFetch = global.fetch
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: (h) => (h === 'content-type' ? 'image/png' : null) },
        arrayBuffer: () => Promise.resolve(buffer)
      })
      .mockResolvedValueOnce({ ok: false, headers: { get: () => null } })
    try {
      expect((await loadLogoImage('https://res.cloudinary.com/demo/image/upload/logo.png')).extension).toBe('png')
      expect(await loadLogoImage('https://res.cloudinary.com/demo/image/upload/missing.png')).toBeNull()
    } finally {
      global.fetch = originalFetch
    }
  })
})

describe('PDF and Excel follow the branding switches', () => {
  const brand = {
    name: 'Cabang',
    address: 'Jl. Cabang No.1',
    city: 'Kota Bandung',
    phoneNumber: '0812',
    email: 'cabang@toko.id',
    logoImage: { buffer: Buffer.from(PNG_1X1, 'base64'), extension: 'png' }
  }
  const baseSpec = {
    title: 'Ringkasan Penjualan',
    subtitle: 'Periode: Hari ini',
    brand,
    columns: reportDefs.sales.defaultColumns,
    rows: [{ name: 'Cabang', city: 'Kota Bandung', sales: 150000, transactions: 3 }],
    totals: ['sales'],
    accentColor: '#1d4ed8'
  }

  const pdfText = async (spec) => {
    const texts = []
    const imageSpy = jest.spyOn(PDFDocument.prototype, 'image')
    const realText = PDFDocument.prototype.text
    const spy = jest.spyOn(PDFDocument.prototype, 'text').mockImplementation(function (text, ...rest) {
      texts.push(String(text))
      return realText.call(this, text, ...rest)
    })
    const sink = new PassThrough()
    sink.resume()
    await renderPdf(spec, sink)
    const images = imageSpy.mock.calls.length
    spy.mockRestore()
    imageSpy.mockRestore()
    return { texts, images }
  }

  test('PDF: everything on by default, with the logo image', async () => {
    const { texts, images } = await pdfText(baseSpec)
    expect(texts).toEqual(expect.arrayContaining(['Cabang', 'Jl. Cabang No.1', 'Kota Bandung', 'Telp: 0812', 'cabang@toko.id']))
    expect(images).toBe(1)
  })

  test('PDF: hidden logo/address/phone/email are left out', async () => {
    const { texts, images } = await pdfText({
      ...baseSpec,
      branding: { showLogo: false, showAddress: false, showPhone: false, showEmail: false }
    })
    // the header is everything printed before the report title
    const header = texts.slice(0, texts.indexOf('Ringkasan Penjualan'))
    expect(header).toEqual(['Cabang'])
    expect(images).toBe(0)
  })

  const excelCells = (wb) => {
    const cells = []
    wb.worksheets[0].eachRow((row) => row.eachCell((cell) => cells.push(String(cell.value ?? ''))))
    return cells
  }

  test('Excel: embeds the real logo (no placeholder) and freezes the table header row', async () => {
    const wb = await buildExcelWorkbook(baseSpec)
    const ws = wb.worksheets[0]
    expect(ws.getImages()).toHaveLength(1)
    expect(excelCells(wb).join('|')).not.toContain('[LOGO]')
    const headerRow = ws.views[0].ySplit
    expect(ws.getRow(headerRow).getCell(1).value).toBe('Toko')
  })

  test('Excel: hidden address/phone/email are left out', async () => {
    const wb = await buildExcelWorkbook({
      ...baseSpec,
      branding: { showLogo: false, showAddress: false, showPhone: false, showEmail: false }
    })
    expect(wb.worksheets[0].getImages()).toHaveLength(0)
    const text = excelCells(wb).join('|')
    expect(text).toContain('Cabang')
    expect(text).not.toMatch(/Jl\. Cabang|Telp: 0812|cabang@toko\.id/)
    const headerRow = wb.worksheets[0].views[0].ySplit
    expect(wb.worksheets[0].getRow(headerRow).getCell(1).value).toBe('Toko')
  })
})
