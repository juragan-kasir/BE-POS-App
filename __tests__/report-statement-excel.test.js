'use strict'

// BE audit 2026-11-18: the statement layout (Cash Flow report) referenced an
// undefined `argb` when filling the SALDO row, so every Cash Flow Excel export
// threw a ReferenceError. no-undef is now part of the lint gate.
const { buildExcelWorkbook } = require('../api/service/reportExporter/excel/layouts/statement')

test('Cash Flow statement workbook builds with the SALDO row on the accent fill', async () => {
  const workbook = await buildExcelWorkbook({
    title: 'Arus Kas',
    subtitle: 'Hari ini',
    accentColor: '#0f172a',
    columns: [
      { key: 'keterangan', label: 'Keterangan', type: 'text' },
      { key: 'nominal', label: 'Nominal', type: 'currency' }
    ],
    rows: [
      { keterangan: 'Penerimaan Tunai', nominal: 150000, flow: 'in' },
      { keterangan: 'Beban Operasional', nominal: 40000, flow: 'out' }
    ]
  })
  const ws = workbook.worksheets[0]
  let saldo = null
  ws.eachRow((row) => {
    if (row.getCell(1).value === 'SALDO') saldo = row
  })
  expect(saldo).not.toBeNull()
  expect(saldo.getCell(1).fill.fgColor.argb).toBe('FF0F172A')
  expect(saldo.getCell(1).font.color.argb).toBe('FFFFFFFF')
})
