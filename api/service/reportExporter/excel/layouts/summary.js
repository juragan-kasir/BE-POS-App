'use strict'
const ExcelJS = require('exceljs')
const style = require('../style')

const buildExcelWorkbook = async (spec) => {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Laporan')

  let rowIndex = 1

  // Brand header (logo, name, address, phone, email)
  rowIndex = style.addBrandHeader(ws, spec, rowIndex)

  // Title block
  rowIndex = style.addTitleBlock(ws, spec, rowIndex)

  // Info block (generation date)
  rowIndex = style.addInfoBlock(ws, spec, rowIndex)

  // Table (header + data + zebra); the header row stays frozen while
  // scrolling. Its index depends on which brand lines/logo are shown.
  const tableHeaderRow = rowIndex
  rowIndex = style.addTable(ws, spec, rowIndex)

  // Totals row (if applicable)
  rowIndex = style.addTotalsRow(ws, spec, rowIndex)

  // Signature block
  rowIndex = style.addSignatureBlock(ws, spec, rowIndex)

  // Footer
  style.addFooter(ws, spec, rowIndex)

  ws.views = [{ state: 'frozen', ySplit: tableHeaderRow, xSplit: 0 }]

  return wb
}

module.exports = { buildExcelWorkbook }