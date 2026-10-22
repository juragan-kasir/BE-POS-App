'use strict'
const db = require('../../db/models')
const { createAudit } = require('../../utils/auditLog')

const reportDefs = {
  daily: require('../service/reportDefs/daily'),
  sales: require('../service/reportDefs/sales'),
  cashFlow: require('../service/reportDefs/cashFlow'),
  profitPerProduct: require('../service/reportDefs/profitPerProduct'),
  bestSeller: require('../service/reportDefs/bestSeller'),
  productSales: require('../service/reportDefs/productSales'),
  categorySales: require('../service/reportDefs/categorySales'),
  kasirPerformance: require('../service/reportDefs/kasirPerformance')
}

const DEFAULT_BRANDING = Object.freeze({
  showLogo: true,
  showAddress: true,
  showPhone: true,
  showEmail: true
})

const DEFAULT_CONFIG = {
  selectedColumns: null, // null = use def.defaultColumns
  accentColor: '#0f172a',
  branding: { ...DEFAULT_BRANDING }
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

// The settings drive every export (PDF/Excel/CSV) and the on-screen report
// tables, so a malformed config would break all of them: refuse it here.
// Returns an error message, or null when the config is valid.
const validateConfig = (def, config) => {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return 'config wajib berupa objek'
  }
  const { selectedColumns, accentColor, branding } = config
  if (selectedColumns !== undefined && selectedColumns !== null) {
    if (!Array.isArray(selectedColumns) || selectedColumns.length === 0) {
      return 'Pilih minimal satu kolom'
    }
    const known = new Set(def.defaultColumns.map((c) => c.key))
    const unknown = selectedColumns.filter((k) => !known.has(k))
    if (unknown.length) return `Kolom tidak dikenal: ${unknown.join(', ')}`
    if (new Set(selectedColumns).size !== selectedColumns.length) {
      return 'Kolom tidak boleh duplikat'
    }
  }
  if (accentColor !== undefined && !HEX_COLOR.test(String(accentColor))) {
    return 'Warna aksen harus format #RRGGBB'
  }
  if (branding !== undefined) {
    if (!branding || typeof branding !== 'object' || Array.isArray(branding)) {
      return 'branding wajib berupa objek'
    }
    for (const [k, v] of Object.entries(branding)) {
      if (!(k in DEFAULT_BRANDING)) return `Pengaturan branding tidak dikenal: ${k}`
      if (typeof v !== 'boolean') return `Pengaturan branding ${k} harus true/false`
    }
  }
  return null
}

const listConfigs = async (req, res) => {
  try {
    const rows = await db.reportConfig.findAll()
    return res.json({ success: true, data: rows.map((r) => ({ key: r.key, config: r.config })) })
  } catch (err) {
    console.error('reportConfig list error:', err)
    return res.status(500).json({ success: false, message: err.message })
  }
}

const getConfig = async (req, res) => {
  try {
    const { key } = req.params
    const row = await db.reportConfig.findOne({ where: { key } })
    return res.json({ success: true, data: { key, config: row ? row.config : null } })
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message })
  }
}

const upsertConfig = async (req, res) => {
  try {
    const { key } = req.params
    if (!reportDefs[key]) return res.status(404).json({ success: false, message: 'Report tidak ditemukan' })
    const { config } = req.body || {}
    if (!config) return res.status(400).json({ success: false, message: 'config wajib diisi' })
    const invalid = validateConfig(reportDefs[key], config)
    if (invalid) return res.status(400).json({ success: false, message: invalid })
    const merged = {
      selectedColumns: config.selectedColumns ?? DEFAULT_CONFIG.selectedColumns,
      accentColor: config.accentColor ?? DEFAULT_CONFIG.accentColor,
      branding: { ...DEFAULT_BRANDING, ...(config.branding || {}) }
    }
    const [row, created] = await db.reportConfig.findOrCreate({
      where: { key },
      defaults: { key, config: merged, createdBy: req.user?.id || null }
    })
    const before = created ? null : row.config
    if (!created) {
      row.config = merged
      row.modifiedBy = req.user?.id || null
      await row.save()
    }
    createAudit(req, created ? 'create' : 'update', 'report_config', row.id, `Report settings: ${key}`, before, merged)
    return res.json({ success: true, data: { key, config: merged } })
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message })
  }
}

const getMeta = async (req, res) => {
  try {
    const data = Object.entries(reportDefs).map(([key, def]) => ({
      key,
      label: def.label,
      columns: def.defaultColumns,
      totals: def.totals || [],
      archetype: def.archetype,
      layout: def.layout
    }))
    return res.json({ success: true, data })
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message })
  }
}

module.exports = {
  listConfigs,
  getConfig,
  upsertConfig,
  getMeta,
  DEFAULT_CONFIG,
  DEFAULT_BRANDING,
  validateConfig
}