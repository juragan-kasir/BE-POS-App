'use strict'
const ExcelJS = require('exceljs')
const style = require('../style')
const { formatValue } = require('../../formatters')

const buildExcelWorkbook = async (spec) => {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Laporan')
  const colCount = spec.columns.length // expect 2: keterangan, nominal
  const [, nominalCol] = spec.columns

  let rowIndex = 1

  // Brand header
  rowIndex = style.addBrandHeader(ws, spec, rowIndex)

  // Title block
  rowIndex = style.addTitleBlock(ws, spec, rowIndex)

  // Info block (generation date)
  rowIndex = style.addInfoBlock(ws, spec, rowIndex)
  const firstSectionHeaderRow = rowIndex

  // Group rows by flow
  const incomeRows = (spec.rows || []).filter(r => r.flow === 'in')
  const expenseRows = (spec.rows || []).filter(r => r.flow === 'out')

  const writeSection = (startRow, title, rows) => {
    if (!rows || rows.length === 0) return startRow
    // Section title
    ws.getCell(startRow, 1).value = title
    ws.getCell(startRow, 1).font = { bold: true, size: 11 }
    style.mergeWidth(ws, startRow, colCount)
    let r = startRow + 1

    // Table header
    const headerRow = ws.getRow(r)
    spec.columns.forEach((col, i) => {
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
    r++

    // Data rows + zebra
    rows.forEach((rowData, rowIdx) => {
      const excelRow = ws.getRow(r + rowIdx)
      spec.columns.forEach((col, i) => {
        const cell = excelRow.getCell(i + 1)
        if (col.key === 'keterangan') {
          cell.value = rowData.keterangan
        } else if (col.key === 'nominal') {
          cell.value = formatValue(rowData.nominal, col.type)
        }
        cell.alignment = { horizontal: col.align || 'left' }
        // Zebra on even data rows
        if ((r + rowIdx) % 2 === 1) { // even data row
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF1F5F9' }
          }
        }
      })
    })
    r += rows.length

    // Subtotal row
    const subTotal = rows.reduce((sum, r) => sum + Number(r.nominal || 0), 0)
    const totalRow = ws.getRow(r)
    spec.columns.forEach((col, i) => {
      const cell = totalRow.getCell(i + 1)
      if (col.key === 'keterangan') {
        cell.value = `${title.toUpperCase()} SUBTOTAL`
        cell.font = { bold: true }
        cell.alignment = { horizontal: 'right' }
      } else if (col.key === 'nominal') {
        cell.value = formatValue(subTotal, col.type)
        cell.font = { bold: true }
      }
    })
    // Top border on subtotal row
    spec.columns.forEach((_, i) => {
      const cell = totalRow.getCell(i + 1)
      cell.border = { top: { style: 'medium', color: { argb: 'FF0F172A' } } }
    })
    r++
    return r // return next row after subtotal
  }

  // Write PENERIMAAN section
  rowIndex = writeSection(rowIndex, 'PENERIMAAN', incomeRows)
  // Write PENGELUARAN section
  rowIndex = writeSection(rowIndex, 'PENGELUARAN', expenseRows)

  // Saldo block (net = income - out)
  const totalIncome = incomeRows.reduce((sum, r) => sum + Number(r.nominal || 0), 0)
  const totalExpense = expenseRows.reduce((sum, r) => sum + Number(r.nominal || 0), 0)
  const saldo = totalIncome - totalExpense
  const saldoRow = ws.getRow(rowIndex)
  // Left cell: label
  saldoRow.getCell(1).value = 'SALDO'
  saldoRow.getCell(1).font = { bold: true, size: 12 }
  // Right cell: value
  saldoRow.getCell(2).value = formatValue(saldo, nominalCol.type)
  saldoRow.getCell(2).font = { bold: true, size: 12 }
  // Fill background with accent
  saldoRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } }
  saldoRow.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } }
  // Add top border
  saldoRow.getCell(1).border = { top: { style: 'medium', color: { argb: 'FF0F172A' } } }
  saldoRow.getCell(2).border = { top: { style: 'medium', color: { argb: 'FF0F172A' } } }
  rowIndex++

  // Signature block
  rowIndex = style.addSignatureBlock(ws, spec, rowIndex)

  // Footer
  rowIndex = style.addFooter(ws, spec, rowIndex)

  // Freeze above the first section header (brand + title + info stay visible).
  ws.views = [{ state: 'frozen', ySplit: firstSectionHeaderRow, xSplit: 0 }]

  return wb
}

module.exports = { buildExcelWorkbook }