'use strict'
const db = require('../../db/models')
const reportDefs = require('../service/reportDefs')
const { exportReport } = require('../service/reportExporter')
const { loadLogoImage } = require('../service/reportExporter/logoImage')
const { getReportStore } = require('../service/reportDefs/getReportStore')
const { DEFAULT_BRANDING } = require('./reportConfig')
const { recordAudit, AUDIT_ACTIONS } = require('../../utils/auditLog')

const VALID_FORMATS = ['excel', 'pdf', 'csv']

// The header of an exported report shows THE STORE THE REPORT IS FOR
// (getReportStore: a store user's own store, or the store a super admin
// picked). Only a super admin exporting across all stores falls back to
// the main branch. Region codes are resolved to names.
const loadBrand = async (req, { withLogo = true } = {}) => {
  const store = req ? getReportStore(req) : null
  const loc = store
    ? await db.location.findByPk(store)
    : await db.location.findOne({ where: { mainBranch: true }, order: [['id', 'ASC']] })
  if (!loc) return null

  const codes = [loc.city, loc.province].filter(Boolean).map(String)
  const names = new Map()
  if (codes.length && db.region) {
    const rows = await db.region.findAll({ where: { code: codes }, attributes: ['code', 'name'] })
    rows.forEach((r) => names.set(String(r.code), r.name))
  }
  const nameOf = (code) => (code ? names.get(String(code)) || null : null)

  return {
    name: loc.name,
    address: loc.address,
    city: nameOf(loc.city),
    province: nameOf(loc.province),
    postalCode: loc.postalCode,
    phoneNumber: loc.phoneNumber,
    email: loc.email,
    timezone: loc.timezone || 'Asia/Jakarta',
    logo: loc.image || null,
    logoImage: withLogo ? await loadLogoImage(loc.image) : null
  }
}

// Columns follow /report/settings: the selected keys, in the saved order.
// Keys a report no longer has are dropped; if none are left, the report
// falls back to its default columns rather than rendering an empty table.
const buildSpecFromDef = (def, data, config, brand) => {
  const selected = (config?.selectedColumns || [])
    .map((key) => def.defaultColumns.find((c) => c.key === key))
    .filter(Boolean)
  const columns = selected.length ? selected : def.defaultColumns
  const cfg = config || {}
  return {
    title: data.title || def.label,
    subtitle: data.subtitle || '',
    brand,
    columns,
    rows: data.rows || [],
    totals: def.totals,
    accentColor: cfg.accentColor || '#0f172a',
    archetype: def.archetype || 'summary',
    layout: def.layout || null,
    branding: { ...DEFAULT_BRANDING, ...(cfg.branding || {}) }
  }
}

// Sums the totals columns exactly like the PDF/Excel/CSV totals row.
const sumTotals = (spec) => {
  if (!spec.totals?.length || !spec.rows.length) return null
  const visible = new Set(spec.columns.map((c) => c.key))
  const keys = spec.totals.filter((key) => visible.has(key))
  if (!keys.length) return null
  return Object.fromEntries(keys.map((key) => [key, spec.rows.reduce((sum, row) => sum + Number(row[key] || 0), 0)]))
}

const requireTenantStore = (req, res) => {
  if (req.user?.roleType === 'super_admin') return true
  if (req.storeId ?? req.user?.store) return true
  res.status(403).json({ success: false, message: 'Store assignment required' })
  return false
}

const loadConfig = async (key) => {
  const configRow = await db.reportConfig.findOne({ where: { key } })
  return configRow?.config || null
}

// GET /report/data/:key — the rows/columns/totals the export would contain,
// as JSON, so the on-screen report table shows exactly what is exported and
// follows /report/settings (selected columns, their order, accent colour).
const reportData = async (req, res) => {
  try {
    const { key } = req.params
    const def = reportDefs[key]
    if (!def) return res.status(404).json({ success: false, message: 'Report tidak ditemukan' })
    if (!requireTenantStore(req, res)) return

    const data = await def.getData(req)
    const spec = buildSpecFromDef(def, data, await loadConfig(key), null)
    await recordAudit({
      req,
      action: AUDIT_ACTIONS.REPORT_EXPORT,
      entity: 'report',
      entityId: null,
      description: `Report ${key} data read`,
      storeId: req.storeId ?? req.user?.store,
      metadata: {
        key,
        rows: Array.isArray(spec.rows) ? spec.rows.length : 0,
        columns: spec.columns.map((column) => column.key)
      }
    })
    return res.status(200).json({
      success: true,
      data: {
        key,
        title: spec.title,
        subtitle: spec.subtitle,
        accentColor: spec.accentColor,
        columns: spec.columns.map(({ key: colKey, label, type, align }) => ({ key: colKey, label, type, align })),
        rows: spec.rows,
        totals: sumTotals(spec)
      }
    })
  } catch (err) {
    if (err.statusCode === 403 || err.message === 'Store assignment required') {
      return res.status(403).json({ success: false, message: err.message })
    }
    console.error('Report data error:', err)
    return res.status(500).json({ success: false, message: err.message })
  }
}

const exportOne = async (req, res) => {
  try {
    const { key } = req.params
    const format = req.query.format
    const def = reportDefs[key]
    if (!def) return res.status(404).json({ success: false, message: 'Report tidak ditemukan' })
    if (!VALID_FORMATS.includes(format)) return res.status(400).json({ success: false, message: 'Format tidak didukung' })

    if (!requireTenantStore(req, res)) return

    const data = await def.getData(req)
    const config = await loadConfig(key)
    const showLogo = config?.branding?.showLogo !== false
    const brand = await loadBrand(req, { withLogo: showLogo && format !== 'csv' })
    const spec = buildSpecFromDef(def, data, config, brand)

    await recordAudit({
      req,
      action: AUDIT_ACTIONS.REPORT_EXPORT,
      entity: 'report',
      entityId: null,
      description: `Report ${key} exported as ${format}`,
      storeId: req.storeId ?? req.user?.store,
      metadata: {
        key,
        format,
        rows: Array.isArray(spec.rows) ? spec.rows.length : 0,
        columns: spec.columns.map((column) => column.key)
      }
    })

    await exportReport({ format, spec, filename: def.filename(req), res })
  } catch (err) {
    if (err.statusCode === 403 || err.message === 'Store assignment required') {
      return res.status(403).json({ success: false, message: err.message })
    }
    console.error('Export error:', err)
    if (!res.headersSent) return res.status(500).json({ success: false, message: err.message })
    res.end()
  }
}

module.exports = { exportOne, reportData, buildSpecFromDef, loadBrand }
