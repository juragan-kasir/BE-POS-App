'use strict'
const ExcelJS = require('exceljs')
const style = require('../style')
const { formatValue } = require('../../formatters')

const buildExcelWorkbook = async (spec) => {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Laporan')

  // Determine value column for ranking
  const valueKey = spec.layout?.valueKey
  let valueColIdx = -1
  if (valueKey) {
    valueColIdx = spec.columns.findIndex(c => c.key === valueKey)
  }
  const hasValue = valueColIdx >= 0

  // Build augmented columns: [rank] + original columns + [share%] (if valueKey exists)
  const augColumns = []
  // Rank column
  augColumns.push({ key: '__rank', label: '#', type: 'number', width: 4, align: 'center' })
  // Original columns
  augColumns.push(...spec.columns)
  // Share column
  if (hasValue) {
    augColumns.push({ key: '__share', label: 'Porsi', type: 'percent', width: 10, align: 'right' })
  }

  // Build augmented rows: prepend rank (1-based), append share (value/total)
  const augRows = []
  let totalValue = 0
  if (hasValue && spec.rows) {
    totalValue = spec.rows.reduce((sum, r) => sum + Number(r[valueKey] || 0), 0)
  }
  spec.rows?.forEach((row, idx) => {
    const newRow = { __rank: idx + 1 }
    Object.assign(newRow, row)
    if (hasValue) {
      const val = Number(row[valueKey] || 0)
      const share = totalValue === 0 ? 0 : val / totalValue
      newRow.__share = share * 100 // whole-number percent, like report columns
    }
    augRows.push(newRow)
  })

  let rowIndex = 1

  // Brand header
  rowIndex = style.addBrandHeader(ws, spec, rowIndex)

  // Title block
  rowIndex = style.addTitleBlock(ws, spec, rowIndex)

  // Info block (generation date)
  rowIndex = style.addInfoBlock(ws, spec, rowIndex)

  // Table header (using augColumns). Its row index depends on which brand
  // lines/logo are shown, so it is tracked rather than recomputed.
  const tableHeaderRow = rowIndex
  const headerRow = ws.getRow(rowIndex)
  augColumns.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1)
    cell.value = col.label
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: style.accentToArgb(spec.accentColor || '#0f172a') }
    }
    cell.alignment = { horizontal: col.align || 'left', vertical: 'middle' }
  })
  headerRow.height = 22
  rowIndex++

  // Apply column widths (augColumns)
  augColumns.forEach((col, i) => {
    ws.getColumn(i + 1).width = col.width || 16
  })

  // Data rows + zebra (using augRows)
  spec.rows?.forEach((rowData, rowIdx) => {
    const excelRow = ws.getRow(rowIndex + rowIdx)
    augColumns.forEach((col, i) => {
      const cell = excelRow.getCell(i + 1)
      if (col.key === '__rank') {
        cell.value = rowData.__rank
        cell.alignment = { horizontal: 'center' }
      } else if (col.key === '__share') {
        const shareVal = rowData.__share
        cell.value = formatValue(shareVal, 'percent')
        cell.alignment = { horizontal: 'right' }
      } else {
        // original column
        const origCol = spec.columns.find(c => c.key === col.key) || { type: 'string' }
        cell.value = formatValue(rowData[col.key], origCol.type)
        cell.alignment = { horizontal: origCol.align || 'left' }
      }
      // Zebra on even data rows (header row is rowIndex-1)
      if ((rowIndex + rowIdx) % 2 === 1) { // even data row -> zebra
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF1F5F9' }
        }
      }
    })
  })
  rowIndex += augRows.length

  // Totals row: we show a count row instead of sum
  const totalRow = ws.getRow(rowIndex)
  augColumns.forEach((col, i) => {
    const cell = totalRow.getCell(i + 1)
    if (col.key === '__rank') {
      cell.value = 'Total'
      cell.font = { bold: true }
    } else if (col.key === '__share') {
      cell.value = '' // empty
    } else if (i === 0) {
      // first original column after rank: we could put count here
      cell.value = `${augRows.length} item`
      cell.font = { bold: true }
    } else {
      cell.value = ''
    }
  })
  // Top border on totals row
  augColumns.forEach((_, i) => {
    const cell = totalRow.getCell(i + 1)
    cell.border = { top: { style: 'medium', color: { argb: 'FF0F172A' } } }
  })
  rowIndex++

  // Data bar on value column (if valueKey exists)
  if (hasValue && spec.rows && spec.rows.length > 0) {
    // value column index in augColumns: after rank (1) + original columns up to valueColIdx
    // augColumns: [rank] + orig[0..valueColIdx] + [valueCol] + orig[valueColIdx+1..] + [share]
    // So value column position = 1 (rank) + valueColIdx (original index) + 1 = valueColIdx + 2
    const valueColPos = valueColIdx + 2 // 1-based column index in augColumns
    const firstDataRow = tableHeaderRow + 1
    const endRow = firstDataRow + augRows.length - 1
    style.addDataBar(ws, spec, firstDataRow, endRow, valueColPos)
  }

  // Signature block
  rowIndex = style.addSignatureBlock(ws, spec, rowIndex)

  // Footer
  rowIndex = style.addFooter(ws, spec, rowIndex)

  // Freeze header row (table header)
  ws.views = [{ state: 'frozen', ySplit: tableHeaderRow, xSplit: 0 }]

  return wb
}

module.exports = { buildExcelWorkbook }