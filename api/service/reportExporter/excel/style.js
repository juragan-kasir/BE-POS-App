'use strict'
const { formatValue } = require('../formatters')

const accentToArgb = (hex) => {
  if (!hex) return 'FF0F172A'
  const h = hex.replace('#', '')
  return 'FF' + h.toUpperCase()
}

const mergeWidth = (ws, rowIdx, colCount) => {
  if (colCount > 0) {
    ws.mergeCells(rowIdx, 1, rowIdx, colCount)
  }
}

const applyColumnWidths = (ws, columns) => {
  columns.forEach((col, i) => {
    ws.getColumn(i + 1).width = col.width || 16
  })
}

const addBrandHeader = (ws, spec, startRow) => {
  const brand = spec.brand || {}
  const branding = { showLogo: true, showAddress: true, showPhone: true, showEmail: true, ...(spec.branding || {}) }
  let r = startRow
  const colCount = spec.columns.length

  // Logo: embedded image on its own row (loaded once by the export
  // controller — see logoImage.js); skipped when off or unavailable.
  if (branding.showLogo && brand.logoImage) {
    try {
      const imageId = ws.workbook.addImage({
        buffer: brand.logoImage.buffer,
        extension: brand.logoImage.extension
      })
      ws.getRow(r).height = 42
      ws.addImage(imageId, { tl: { col: 0, row: r - 1 }, ext: { width: 72, height: 54 } })
      r++
    } catch {
      // unreadable image: header without a logo
    }
  }

  // Brand name line
  if (brand.name) {
    ws.getCell(r, 1).value = brand.name
    ws.getCell(r, 1).font = { bold: true, size: 14 }
    ws.getCell(r, 1).alignment = { horizontal: 'left', vertical: 'bottom' }
    mergeWidth(ws, r, colCount)
    r++
  }

  // Address lines
  const lines = []
  if (branding.showAddress && brand.address) lines.push(brand.address)
  if (branding.showAddress) {
    const cityLine = [brand.city, brand.province, brand.postalCode].filter(Boolean).join(', ')
    if (cityLine) lines.push(cityLine)
  }
  if (branding.showPhone && brand.phoneNumber) lines.push(`Telp: ${brand.phoneNumber}`)
  if (branding.showEmail && brand.email) lines.push(brand.email)

  if (lines.length) {
    ws.getCell(r, 1).value = lines.join('\n')
    ws.getCell(r, 1).font = { size: 9, color: { argb: 'FF64748B' } }
    ws.getCell(r, 1).alignment = { wrapText: true, vertical: 'top' }
    mergeWidth(ws, r, colCount)
    r++
  }
  r++ // blank line after brand block
  return r
}

const addTitleBlock = (ws, spec, startRow) => {
  const colCount = spec.columns.length
  let r = startRow
  if (spec.title) {
    ws.getCell(r, 1).value = spec.title
    ws.getCell(r, 1).font = { bold: true, size: 12 }
    mergeWidth(ws, r, colCount)
    r++
  }
  if (spec.subtitle) {
    ws.getCell(r, 1).value = spec.subtitle
    ws.getCell(r, 1).font = { size: 9, color: { argb: 'FF64748B' } }
    mergeWidth(ws, r, colCount)
    r++
  }
  r++ // blank after title block
  return r
}

const addInfoBlock = (ws, spec, startRow) => {
  // Generic info block: could show generated date, etc.
  // For simplicity: show generation date/time
  const colCount = spec.columns.length
  let r = startRow
  // In the store's own time zone (the server runs in UTC).
  const genDate = new Date().toLocaleString('id-ID', {
    timeZone: spec.brand?.timezone || 'Asia/Jakarta'
  })
  ws.getCell(r, 1).value = `Dicetak: ${genDate}`
  ws.getCell(r, 1).font = { size: 8, color: { argb: 'FF94A3B8' } }
  mergeWidth(ws, r, colCount)
  r++
  return r
}

const addTable = (ws, spec, startRow) => {
  const headerRow = startRow
  const accent = spec.accentColor || '#0f172a'
  const argb = accentToArgb(accent)

  // Header
  const header = ws.getRow(headerRow)
  spec.columns.forEach((col, i) => {
    const cell = header.getCell(i + 1)
    cell.value = col.label
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb }
    }
    cell.alignment = { horizontal: col.align || 'left', vertical: 'middle' }
  })
  header.height = 22

  // Data rows + zebra
  let dataRow = headerRow + 1
  spec.rows?.forEach((rowData, rowIdx) => {
    const excelRow = ws.getRow(dataRow + rowIdx)
    spec.columns.forEach((col, i) => {
      const cell = excelRow.getCell(i + 1)
      cell.value = formatValue(rowData[col.key], col.type)
      cell.alignment = { horizontal: col.align || 'left' }
      if ((dataRow + rowIdx) % 2 === 1) { // zebra on even data rows (header=1)
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF1F5F9' }
        }
      }
    })
  })

  // Set column widths
  applyColumnWidths(ws, spec.columns)

  return dataRow + (spec.rows?.length || 0) // return next row after table
}

const addTotalsRow = (ws, spec, startRow) => {
  if (!spec.totals || spec.totals.length === 0 || !spec.rows || spec.rows.length === 0) return startRow
  let r = startRow
  const acc = {}
  for (const row of spec.rows) {
    for (const key of spec.totals) acc[key] = (acc[key] || 0) + Number(row[key] || 0)
  }
  const totalRow = ws.getRow(r)
  spec.columns.forEach((col, i) => {
    const cell = totalRow.getCell(i + 1)
    if (col.key && spec.totals.includes(col.key)) {
      cell.value = formatValue(acc[col.key], col.type)
    } else if (i === 0) {
      cell.value = 'Total'
    }
    cell.font = { bold: true }
    cell.border = { top: { style: 'medium', color: { argb: 'FF0F172A' } } }
  })
  r++
  return r
}

const addSignatureBlock = (ws, spec, startRow) => {
  const colCount = spec.columns.length
  const r = startRow
  // Three equal columns for signature labels
  const labels = [
    { key: 'Disiapkan oleh', align: 'center' },
    { key: 'Diketahui oleh', align: 'center' },
    { key: 'Disetujui oleh', align: 'center' }
  ]
  labels.forEach((labelObj, i) => {
    const cell = ws.getCell(r, i + 1)
    cell.value = labelObj.key
    cell.font = { size: 9 }
    cell.alignment = { horizontal: labelObj.align, vertical: 'top' }
    // Underline via bottom border thin
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF64748B' } } }
  })
  // Blank line for signatures
  const sigRow = r + 1
  ws.getRow(sigRow).height = 20 // blank row height
  // Date line
  const dateRow = r + 2
  ws.getCell(dateRow, 1).value = `Tanggal: __/__/____`
  ws.getCell(dateRow, 1).font = { size: 9 }
  ws.getCell(dateRow, 1).alignment = { horizontal: 'center' }
  mergeWidth(ws, dateRow, colCount)
  return dateRow + 1 // next row after signature block
}

const addFooter = (ws, spec, startRow) => {
  const colCount = spec.columns.length
  let r = startRow
  ws.getCell(r, 1).value = `Laporan ini dibuat secara otomatis oleh sistem.`
  ws.getCell(r, 1).font = { size: 8, color: { argb: 'FF64748B' } }
  ws.getCell(r, 1).alignment = { horizontal: 'center' }
  mergeWidth(ws, r, colCount)
  r++
  return r
}

const addDataBar = (ws, spec, startRow, endRow, colIdx) => {
  // Add ExcelJS conditional formatting data bar to column colIdx (1-based)
  // colIdx is index within spec.columns (1..n)
  if (!spec.rows || spec.rows.length === 0) return
  const colLetter = String.fromCharCode(64 + colIdx) // A=1, B=2...
  const range = `${colLetter}${startRow}:${colLetter}${endRow}`
  try {
    ws.addConditionalFormatting({
      ref: range,
      rules: [{
        type: 'dataBar',
        priority: 1,
        cfvo: [
          { type: 'min' },
          { type: 'max' }
        ],
        color: { argb: 'FF4F46E5' } // indigo-600
      }]
    })
  } catch {
    // if dataBar not supported (older ExcelJS), silently skip
  }
}

module.exports = {
  accentToArgb,
  mergeWidth,
  applyColumnWidths,
  addBrandHeader,
  addTitleBlock,
  addInfoBlock,
  addTable,
  addTotalsRow,
  addSignatureBlock,
  addFooter,
  addDataBar
}