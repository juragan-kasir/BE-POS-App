'use strict'
const PDFDocument = require('pdfkit')
const { formatValue } = require('./formatters')

const renderPdf = (spec, res) => {
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margin: 40,
    info: { Title: spec.title }
  })
  doc.pipe(res)

  const accent = spec.accentColor || '#0f172a'
  const fmt = (v, type) => formatValue(v, type)
  const tableTop = 150
  let y = tableTop
  const left = 40
  const right = doc.page.width - 40
  const usable = right - left

  // Header: logo + brand block. Each line follows its /report/settings
  // switch (logo, address, phone, email).
  const branding = { showLogo: true, showAddress: true, showPhone: true, showEmail: true, ...(spec.branding || {}) }
  const brand = spec.brand || {}
  let textLeft = left
  if (branding.showLogo && brand.logoImage) {
    try {
      doc.image(brand.logoImage.buffer, left, 36, { fit: [64, 52] })
      textLeft = left + 76
    } catch {
      textLeft = left // unreadable image: header without a logo
    }
  }
  const textWidth = usable - (textLeft - left)
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#0f172a')
  doc.text(brand.name || '', textLeft, 40, { width: textWidth })
  let hy = doc.y + 4
  const lines = []
  if (branding.showAddress && brand.address) lines.push(brand.address)
  if (branding.showAddress) {
    const cityLine = [brand.city, brand.province, brand.postalCode].filter(Boolean).join(', ')
    if (cityLine) lines.push(cityLine)
  }
  if (branding.showPhone && brand.phoneNumber) lines.push(`Telp: ${brand.phoneNumber}`)
  if (branding.showEmail && brand.email) lines.push(brand.email)
  doc.font('Helvetica').fontSize(8).fillColor('#64748b')
  lines.forEach((line) => {
    doc.text(line, textLeft, hy, { width: textWidth })
    hy = doc.y + 2
  })

  doc.moveTo(left, 110).lineTo(right, 110).lineWidth(1).stroke('#e2e8f0')

  // Title + subtitle
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#0f172a')
  doc.text(spec.title || '', left, 120, { width: usable })
  if (spec.subtitle) {
    doc.font('Helvetica').fontSize(9).fillColor('#64748b')
    doc.text(spec.subtitle, left, doc.y + 2, { width: usable })
  }

  // Column X positions based on width weights
  const totalWeight = spec.columns.reduce((s, c) => s + (c.width || 16), 0)
  let cx = left
  const colX = spec.columns.map((c) => {
    const w = (usable * (c.width || 16)) / totalWeight
    const pos = cx
    cx += w
    return { c, x: pos, w }
  })

  const drawHeader = (top) => {
    doc.rect(left, top, usable, 22).fill(accent)
    colX.forEach(({ c, x, w }) => {
      const align = c.align === 'right' ? 'right' : 'left'
      const xPos = align === 'right' ? x + w : x + 4
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff')
      doc.text(c.label, xPos, top + 7, {
        width: w - (align === 'right' ? 6 : 8),
        align
      })
    })
    return top + 22
  }

  let headerTop = drawHeader(y)
  y = headerTop
  let pageNum = 1

  const drawFooter = () => {
    doc.font('Helvetica').fontSize(7).fillColor('#94a3b8')
    doc.text(`Halaman ${pageNum}`, left, doc.page.height - 28, {
      width: usable,
      align: 'right'
    })
    pageNum++
  }

  const ensureSpace = (needed) => {
    if (y + needed > doc.page.height - 50) {
      drawFooter()
      doc.addPage()
      y = 40
      headerTop = drawHeader(40)
      y = headerTop
    }
  }

  for (const row of spec.rows || []) {
    ensureSpace(18)
    const baseY = y
    colX.forEach(({ c, x, w }, i) => {
      const align = c.align === 'right' ? 'right' : 'left'
      const xPos = align === 'right' ? x + w : x + 4
      doc.font('Helvetica').fontSize(8)
      doc.fillColor(i % 2 === 0 ? '#0f172a' : '#334155')
      doc.text(fmt(row[c.key], c.type), xPos, baseY + 5, {
        width: w - (align === 'right' ? 6 : 8),
        align
      })
    })
    if (y !== baseY) y = baseY
    y += 18
    // Zebra background band (decorative; draw after text so it sits under)
  }

  if (spec.totals && spec.totals.length > 0 && (spec.rows || []).length) {
    ensureSpace(20)
    const acc = {}
    for (const row of spec.rows) {
      for (const key of spec.totals) acc[key] = (acc[key] || 0) + Number(row[key] || 0)
    }
    const baseY = y
    doc.moveTo(left, baseY).lineTo(right, baseY).lineWidth(1.5).stroke(accent)
    colX.forEach(({ c, x, w }) => {
      const align = c.align === 'right' ? 'right' : 'left'
      const xPos = align === 'right' ? x + w : x + 4
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#0f172a')
      if (c.key && spec.totals.includes(c.key)) {
        doc.text(fmt(acc[c.key], c.type), xPos, baseY + 5, {
          width: w - (align === 'right' ? 6 : 8),
          align
        })
      } else if (colX[0].c.key === c.key) {
        doc.text('Total', xPos, baseY + 5, { width: w - 8, align })
      }
    })
    y += 22
  }

  drawFooter()
  doc.end()
  return new Promise((resolve, reject) => {
    res.on('finish', resolve)
    res.on('error', reject)
  })
}

module.exports = { renderPdf }
