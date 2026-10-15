const db = require('../../db/models')
const { Op } = require('sequelize')
const ExcelJS = require('exceljs')
const { createAudit } = require('../../utils/auditLog')
const { enrichAuditFields } = require('../../utils/auditFields')
const { fetchActiveTaxRows, pickAppliedPpn } = require('../../utils/taxResolution')

const taxConfigController = {
  async getPublic(req, res) {
    try {
      const store = req.query.store
      if (!store) {
        return res.status(400).json({ message: 'store is required' })
      }
      const storeId = Number(store)
      if (isNaN(storeId)) {
        return res.status(400).json({ message: 'Invalid store value' })
      }
      const { status } = req.query
      const where = { store: storeId }
      if (status !== undefined && status !== 'all') {
        where.status = status
      }
      const taxes = await db.taxConfig.findAll({
        where,
        order: [['updatedAt', 'DESC']]
      })
      return res.status(200).json({
        success: true,
        message: 'Success get tax configs',
        data: taxes
      })
    } catch (error) {
      console.error('getPublic error:', error)
      return res.status(500).json({ message: 'Internal server error' })
    }
  },

  async getEffective(req, res) {
    // P1: read-only effective-tax summary for one evaluated scope. Uses
    // the same row resolution as checkout (fetchActiveTaxRows) and reports
    // what checkout would charge — it never changes checkout behavior.
    // Scope: explicit ?store=<id>, else the caller's own store, else the
    // global scope for a super_admin with no store selected. Outlet
    // callers can never see another outlet (enforced by
    // validateStoreAccess before this handler runs).
    try {
      const rawStore = req.query?.store
      let store = null
      if (rawStore !== undefined && rawStore !== null && rawStore !== '') {
        store = Number(rawStore)
        if (!Number.isInteger(store) || store <= 0) {
          return res.status(400).json({
            success: false,
            code: 'INVALID_STORE',
            message: 'Invalid store value'
          })
        }
      } else if (req.user?.roleType !== 'super_admin') {
        store = req.storeId ?? req.user?.store ?? null
      }

      const rawChannel = req.query?.channel
      const channel =
        rawChannel === undefined || rawChannel === null || rawChannel === ''
          ? 'counter'
          : rawChannel
      if (channel !== 'counter' && channel !== 'qr') {
        return res.status(400).json({
          success: false,
          code: 'INVALID_CHANNEL',
          message: 'channel must be counter or qr'
        })
      }

      let rows
      try {
        rows = await fetchActiveTaxRows(store)
      } catch (error) {
        console.error('getEffective error:', error)
        return res.status(500).json({
          success: false,
          message: 'Internal server error'
        })
      }

      // Missing PPN mirrors the checkout setup error (DR-17 fail-closed):
      // an explicit error, never a silent zero.
      if (rows.ppn.length === 0) {
        return res.status(400).json({
          success: false,
          code: 'PPN_MISSING',
          message: `PPN tax configuration is missing for this outlet (store ${store}); configure an active PPN rate before selling`
        })
      }

      const toRow = (r) => ({
        id: r.id,
        name: r.name,
        rate: Number(r.rate),
        scope: r.store === null || r.store === undefined ? 'global' : 'outlet'
      })
      // D3 (decided 2026-10-16): one applied PPN row, never a sum.
      const appliedPpn = pickAppliedPpn(rows.ppn)
      const ppnRows = rows.ppn.map((r) => ({ ...toRow(r), applied: r.id === appliedPpn.id }))
      const ppnRate = Number(appliedPpn.rate)

      const findings = []
      const scopesPresent = new Set(ppnRows.map((r) => r.scope))
      const byScope = {}
      for (const r of ppnRows) {
        byScope[r.scope] = byScope[r.scope] || []
        byScope[r.scope].push(r)
      }
      for (const [scope, group] of Object.entries(byScope)) {
        if (group.length > 1) {
          findings.push({
            code: 'MULTIPLE_ACTIVE_SAME_SCOPE',
            severity: 'warning',
            message:
              `${group.length} active PPN rows share the ${scope} scope; ` +
              'only the applied row is charged (use "Gunakan di Kasir & BISA" to keep one)',
            policyRef: 'D3',
            decision: 'decided'
          })
        }
      }
      if (scopesPresent.has('global') && scopesPresent.has('outlet')) {
        findings.push({
          code: 'GLOBAL_AND_OUTLET_COMBINED',
          severity: 'info',
          message: 'the outlet PPN row overrides the global default; the global row is not charged',
          policyRef: 'D3',
          decision: 'decided'
        })
      }
      if (ppnRate === 0) {
        findings.push({
          code: 'PPN_ZERO_CONFIGURED',
          severity: 'info',
          message:
            'effective PPN is 0 from explicitly configured rows (valid configuration, distinct from missing PPN)'
        })
      }

      // Service charge follows checkout semantics: resolved for counter,
      // never applicable to QR (same contract as getCustomerTaxRate).
      let serviceCharge
      if (channel === 'qr') {
        serviceCharge = { status: 'not_applicable', rate: null, rows: [] }
      } else {
        const scRows = rows.serviceCharge.map(toRow)
        const scRate = scRows.reduce((sum, r) => sum + r.rate, 0)
        serviceCharge =
          scRows.length === 0
            ? { status: 'absent', rate: 0, rows: [] }
            : { status: 'configured', rate: scRate, rows: scRows }
      }

      return res.status(200).json({
        success: true,
        message: 'Success get effective tax',
        data: {
          store,
          channel,
          ppn: { status: 'configured', rate: ppnRate, rows: ppnRows },
          serviceCharge,
          findings
        }
      })
    } catch (error) {
      console.error('getEffective error:', error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async getAll(req, res) {
    try {
      // MEDIUM fix: removed req.cookies.store — cookie is client-controlled and
      // never validated by validateStoreAccess. Use server-pinned storeId only.
      const store = req.storeId ?? req.user?.store
      const { page = 1, limit = 10, search, status } = req.query

      // P1-B: reading the list must never create tax configuration.
      // The former auto-seed of a default active global PPN 11% row is
      // removed: DR-17 fail-closed behavior requires missing PPN to stay
      // missing (explicit setup error at checkout), never silently
      // materialized by a read. Explicit seeding remains available only
      // through the super_admin-gated POST /tax-config/seed endpoint.
      const where = {}
      if (store) {
        where[Op.or] = [{ store }, { store: null }]
      }
      if (search) {
        where.name = { [Op.iLike]: `%${search}%` }
      }
      if (status !== undefined && status !== 'all') {
        where.status = status
      }

      const offset = (parseInt(page) - 1) * parseInt(limit)

      const [taxes, total] = await Promise.all([
        db.taxConfig.findAll({
          where,
          order: [['updatedAt', 'DESC']],
          limit: parseInt(limit),
          offset
        }),
        db.taxConfig.count({ where })
      ])
      await enrichAuditFields(db, taxes)

      const [active, draft, inactive] = await Promise.all([
        db.taxConfig.count({ where: { status: 'active' } }),
        db.taxConfig.count({ where: { status: 'draft' } }),
        db.taxConfig.count({ where: { status: 'inactive' } })
      ])

      return res.status(200).json({
        success: true,
        message: 'Success get tax configs',
        data: taxes,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit))
        },
        stats: { total: active + draft + inactive, active, draft, inactive }
      })
    } catch (error) {
      console.error('getAll error:', error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async getById(req, res) {
    try {
      const id = String(req.params.id || '').trim()
      // MEDIUM fix: removed req.cookies.store — use server-pinned storeId only.
      const store = req.storeId ?? req.user?.store

      const tax = await db.taxConfig.findOne({ // codacy-ignore-line
        where: {
          id,
          ...(store ? { [Op.or]: [{ store }, { store: null }] } : {})
        }
      })

      if (!tax) {
        return res.status(404).json({
          success: false,
          message: 'Tax config not found'
        })
      }

      return res.status(200).json({
        success: true,
        message: 'Success get tax config',
        data: tax
      })
    } catch (error) {
      console.error(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async create(req, res) {
    try {
      // MEDIUM fix: removed req.body.store and req.cookies.store — only
      // server-pinned req.storeId is authoritative for tenant data writes.
      // super_admin may legitimately create global (null-store) tax configs;
      // that path is preserved by the ?? req.user?.store fallback.
      const store = req.storeId ?? req.user?.store
      const { name, rate, type, description, status } = req.body
      const createdBy = req.user?.id || null

      if (!name || rate === undefined || rate === null) {
        return res.status(400).json({
          success: false,
          message: 'Name and rate are required'
        })
      }

      const tax = await db.taxConfig.create({
        store,
        name,
        rate: parseInt(rate),
        type: type || 'ppn',
        description,
        status: status || 'active',
        createdBy
      })
      createAudit(
        req,
        'create',
        'tax_config',
        tax.id,
        'Created tax_config: ' + (tax.name || tax.id)
      )

      return res.status(201).json({
        success: true,
        message: 'Success create tax config',
        data: tax
      })
    } catch (error) {
      console.error(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  // "Gunakan di Kasir & BISA" (D3): make one PPN row THE applied rate of its
  // scope — it becomes active and every other active PPN row of the same
  // scope (same outlet, or global) is set inactive, in one transaction.
  // Checkout then charges exactly this rate, counter and QR alike (an
  // outlet row still overrides the global default). Same access rules as
  // update: an outlet admin may apply its own outlet's rows; a global row
  // only a global super_admin.
  async apply(req, res) {
    try {
      const { id } = req.params
      const store = req.storeId ?? req.user?.store
      const tax = await db.taxConfig.findOne({
        where: {
          id,
          ...(store ? { [Op.or]: [{ store }, { store: null }] } : {})
        }
      })
      if (!tax) {
        return res.status(404).json({ success: false, message: 'Tax config not found' })
      }
      if (
        (tax.store === null || tax.store === undefined) &&
        !(req.user?.roleType === 'super_admin' && req.user?.store == null)
      ) {
        return res.status(403).json({
          success: false,
          message: 'Anda hanya dapat mengakses data di toko Anda'
        })
      }
      if (tax.type !== 'ppn') {
        return res.status(400).json({
          success: false,
          code: 'TAX_APPLY_PPN_ONLY',
          message: 'Hanya pajak PPN yang bisa dipakai di kasir & aplikasi QR'
        })
      }

      const modifiedBy = req.user?.id || null
      const deactivated = await db.sequelize.transaction(async (t) => {
        const [count] = await db.taxConfig.update(
          { status: 'inactive', modifiedBy },
          {
            where: {
              id: { [Op.ne]: tax.id },
              type: 'ppn',
              status: 'active',
              store: tax.store ?? null
            },
            transaction: t
          }
        )
        await tax.update({ status: 'active', modifiedBy }, { transaction: t })
        return count
      })
      createAudit(
        req,
        'update',
        'tax_config',
        id,
        `Applied tax_config ${id} at checkout; deactivated ${deactivated} other PPN row(s) in the same scope`
      )

      return res.status(200).json({
        success: true,
        message: 'Pajak dipakai di kasir & aplikasi QR',
        data: { applied: tax, deactivated }
      })
    } catch (error) {
      console.error('apply tax config error:', error)
      return res.status(500).json({ success: false, message: 'Internal server error' })
    }
  },

  async update(req, res) {
    try {
      const { id } = req.params
      // IDOR fix: `store` was computed (from req.storeId, or falling back
      // to raw req.body.store) but never actually used in the fetch's
      // WHERE clause below — any admin could edit any store's tax config.
      // Also stopped falling back to req.body.store: req.storeId is
      // already the middleware-validated value, the same convention
      // getById/delete already use — never trust the raw body value.
      // MEDIUM fix: removed req.cookies.store. req.storeId is the
      // middleware-validated server-side value; JWT fallback only for routes
      // missing middleware (should not occur on authenticated update routes).
      const store = req.storeId ?? req.user?.store
      const { name, rate, type, description, status } = req.body
      const modifiedBy = req.user?.id || null

      const tax = await db.taxConfig.findOne({
        where: {
          id,
          ...(store ? { [Op.or]: [{ store }, { store: null }] } : {})
        }
      })

      if (!tax) {
        return res.status(404).json({
          success: false,
          message: 'Tax config not found'
        })
      }

      // P1-A: a global (store-null) row is platform configuration. An
      // outlet admin may read it but must never mutate it. Only a
      // global super_admin (roleType super_admin with no store pin)
      // keeps platform access: a store-bound super_admin has no legacy
      // platform authority (same contract as backup.js MED-2
      // isGlobalSuperAdmin and utils/authContext
      // legacySuperAdminScopeOf). Rejected requests change nothing.
      if (
        (tax.store === null || tax.store === undefined) &&
        !(
          req.user?.roleType === 'super_admin' && req.user?.store == null
        )
      ) {
        return res.status(403).json({
          success: false,
          message: 'Anda hanya dapat mengakses data di toko Anda'
        })
      }

      // P1-C: an explicitly supplied scope must equal the row's scope —
      // a different one is refused, never silently ignored with a 200.
      // Omission keeps the scope. After validation `store` is a number,
      // or null; 0 (from '' or 0) means global, the same reading the
      // former `store || null` write-back gave it.
      if (Object.prototype.hasOwnProperty.call(req.body, 'store')) {
        const requestedScope = req.body.store === null || req.body.store === 0 ? null : req.body.store
        const currentScope = tax.store ?? null
        if (requestedScope !== currentScope) {
          return res.status(409).json({
            success: false,
            code: 'TAX_SCOPE_IMMUTABLE',
            message:
              'Cakupan toko konfigurasi pajak tidak dapat diubah. Buat konfigurasi pajak baru untuk cakupan yang diinginkan.'
          })
        }
      }

      await tax.update({
        // P1-C: row scope is immutable via update. The `store` variable
        // above is scope-resolution input for the fetch filter only — it
        // must never be written back, otherwise editing a global row
        // while scoped to an outlet silently transfers it there (and an
        // outlet row could drift on any scope mismatch). Scope is
        // assigned at create; no supported re-scope workflow exists.
        name: name || tax.name,
        rate: rate !== undefined ? parseInt(rate) : tax.rate,
        type: type || tax.type,
        description: description !== undefined ? description : tax.description,
        status:
          status !== undefined
            ? status === true
              ? 'active'
              : status === false
                ? 'inactive'
                : status
            : tax.status,
        modifiedBy
      })
      createAudit(req, 'update', 'tax_config', id, 'Updated tax_config: ' + id)

      return res.status(200).json({
        success: true,
        message: 'Success update tax config',
        data: tax
      })
    } catch (error) {
      console.error(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async delete(req, res) {
    try {
      const { id } = req.params
      // MEDIUM fix: removed req.cookies.store — use server-pinned storeId.
      const store = req.storeId ?? req.user?.store

      const tax = await db.taxConfig.findOne({
        where: {
          id,
          ...(store ? { [Op.or]: [{ store }, { store: null }] } : {})
        }
      })

      if (!tax) {
        return res.status(404).json({
          success: false,
          message: 'Tax config not found'
        })
      }

      // P1-A: same global-row guard as update — only a global
      // super_admin may delete platform configuration. Rejected
      // requests change nothing.
      if (
        (tax.store === null || tax.store === undefined) &&
        !(
          req.user?.roleType === 'super_admin' && req.user?.store == null
        )
      ) {
        return res.status(403).json({
          success: false,
          message: 'Anda hanya dapat mengakses data di toko Anda'
        })
      }

      await tax.destroy()
      createAudit(req, 'delete', 'tax_config', id, 'Deleted tax_config: ' + id)

      return res.status(200).json({
        success: true,
        message: 'Success delete tax config'
      })
    } catch (error) {
      console.error(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async downloadTemplate(req, res) {
    try {
      const workbook = new ExcelJS.Workbook()
      const worksheet = workbook.addWorksheet('Tax Config Template')

      const headers = ['Name', 'Type', 'Rate', 'Description', 'Status']
      worksheet.addRow(headers)

      worksheet.getRow(1).font = { bold: true }
      worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFD3D3D3' }
      }

      worksheet.columns = [
        { width: 25 },
        { width: 15 },
        { width: 10 },
        { width: 30 },
        { width: 12 }
      ]

      for (let row = 2; row <= 12; row++) {
        worksheet.getCell(`B${row}`).dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: ['"PPN,PPh,Non-Pajak"']
        }
        worksheet.getCell(`E${row}`).dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: ['"Active,Inactive,Draft"']
        }
      }

      const buffer = await workbook.xlsx.writeBuffer()

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
      res.setHeader(
        'Content-Disposition',
        'attachment; filename=tax-config-template.xlsx'
      )

      return res.status(200).send(buffer)
    } catch (error) {
      console.error('Error =>', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async downloadData(req, res) {
    try {
      // MEDIUM fix: removed req.query.store and req.cookies.store — only
      // server-pinned req.storeId is authoritative for tenant data access.
      const store = req.storeId ?? req.user?.store
      const where = {}
      if (store) where.store = store

      const taxes = await db.taxConfig.findAll({
        where,
        order: [['createdAt', 'ASC']]
      })

      const workbook = new ExcelJS.Workbook()
      const worksheet = workbook.addWorksheet('Tax Configs')

      worksheet.addRow([
        'ID',
        'Name',
        'Type',
        'Rate',
        'Description',
        'Status',
        'Created At'
      ])
      worksheet.getRow(1).font = { bold: true }
      worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFD3D3D3' }
      }

      taxes.forEach((t) =>
        worksheet.addRow([
          t.id,
          t.name,
          t.type === 'ppn'
            ? 'PPN'
            : t.type === 'service_charge'
              ? 'Non-Pajak'
              : t.type === 'other'
                ? 'PPh'
                : t.type,
          t.rate,
          t.description,
          t.status === 'active' ? 'Active' : 'Inactive',
          t.createdAt ? t.createdAt.toISOString() : ''
        ])
      )

      worksheet.columns = [
        { width: 10 },
        { width: 25 },
        { width: 15 },
        { width: 10 },
        { width: 30 },
        { width: 10 },
        { width: 20 }
      ]

      const buffer = await workbook.xlsx.writeBuffer()

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
      res.setHeader(
        'Content-Disposition',
        'attachment; filename=tax-configs.xlsx'
      )

      return res.status(200).send(buffer)
    } catch (error) {
      console.error('Error =>', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async importData(req, res) {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({ success: false, message: 'No file uploaded' })
      }

      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(req.file.buffer)
      const worksheet = workbook.getWorksheet(1)

      const taxesToCreate = []
      const errors = []

      worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return

        try {
          const [, name, type, rate, description, status] = row.values

          if (!name || rate === undefined || rate === null) {
            errors.push(`Row ${rowNumber}: Name and rate are required`)
            return
          }

          const typeValue = String(type || '')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '_')
          const mappedType =
            typeValue === 'ppn'
              ? 'ppn'
              : typeValue === 'pph'
                ? 'other'
                : typeValue === 'non-pajak'
                  ? 'service_charge'
                  : typeValue === 'service_charge'
                    ? 'service_charge'
                    : 'ppn'

          const statusValue = status
            ? String(status).toLowerCase() === 'draft'
              ? 'draft'
              : String(status).toLowerCase() === 'active'
                ? 'active'
                : 'inactive'
            : 'active'

          taxesToCreate.push({
            // MEDIUM fix: removed req.cookies.store — use server-pinned storeId only.
            store: req.storeId ?? req.user?.store,
            name: name.trim(),
            rate: parseInt(rate),
            type: mappedType,
            description: description?.trim() || null,
            status: statusValue,
            createdBy: req.user?.id || null
          })
        } catch (error) {
          errors.push(`Row ${rowNumber}: ${error.message}`)
        }
      })

      if (errors.length > 0) {
        return res
          .status(400)
          .json({ success: false, message: 'Validation errors', errors })
      }

      const created = []
      const skipped = []
      for (const item of taxesToCreate) {
        const existing = await db.taxConfig.findOne({
          where: { name: item.name }
        })
        if (existing) {
          skipped.push(item.name)
          continue
        }
        const tax = await db.taxConfig.create(item)
        created.push(tax)
      }

      createAudit(
        req,
        'create',
        'tax_config',
        null,
        `Imported ${created.length} tax configs, skipped ${skipped.length}`
      )

      return res.status(201).json({
        success: true,
        message: `Successfully imported ${created.length} from ${taxesToCreate.length} tax configs`,
        data: {
          total: taxesToCreate.length,
          created: created.length,
          skipped: skipped.length,
          skippedNames: skipped.length > 0 ? skipped : undefined
        }
      })
    } catch (error) {
      console.error('Error =>', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async seed(req, res) {
    try {
      const totalAll = await db.taxConfig.count()
      if (totalAll > 0) {
        return res.status(200).json({
          success: true,
          message: `Tax configs already exist (${totalAll} records). No seeding needed.`,
          count: totalAll
        })
      }

      await seedDefaultTaxes()

      const count = await db.taxConfig.count()
      return res.status(201).json({
        success: true,
        message: `Successfully seeded ${count} default PPh 2026 tax configs`,
        count
      })
    } catch (error) {
      console.error('Error =>', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  }
}

async function seedDefaultTaxes() {
  const defaults = [
    {
      name: 'PPN 11%',
      rate: 11,
      type: 'ppn',
      description: 'Pajak Pertambahan Nilai standar barang/jasa',
      status: 'active'
    },
    {
      name: 'PPh 23 2%',
      rate: 2,
      type: 'other',
      description: 'Pajak Penghasilan Pasal 23 atas jasa',
      status: 'active'
    },
    {
      name: 'Non-Pajak',
      rate: 0,
      type: 'service_charge',
      description: 'Transaksi tidak dikenakan pajak',
      status: 'active'
    }
  ]
  await db.taxConfig.bulkCreate(defaults, { individualHooks: false })
}

module.exports = taxConfigController
