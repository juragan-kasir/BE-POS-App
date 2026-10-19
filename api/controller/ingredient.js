const db = require('../../db/models')
const { Op } = require('sequelize')
const { createAudit } = require('../../utils/auditLog')
const { enrichAuditFields } = require('../../utils/auditFields')
const { resolveStoreId } = require('../../utils/tenantScope')
const {
  adjustIngredientStock,
  getIngredientStockRecording
} = require('../service/stockMutationService')
const excelJS = require('exceljs')
const { DEFAULT_TIMEZONE, getStoreDayBounds } = require('../../utils/businessDate')

// openingStockRecorded=false means the stock figure was never entered
// through a recorded event (opening entry, count, receipt): a 0 there is
// unknown, not a verified zero. lastCountedAt = latest physical count.
// stockState keeps the three cases explicit: 'recorded' (known), 'unrecorded'
// (a value exists, but its provenance is unverified) and 'uninitialized'
// (never entered, so its 0 is unknown).
const stockStateOf = (rec, stock) =>
  rec ? 'recorded' : Number(stock) === 0 ? 'uninitialized' : 'unrecorded'

const annotateStockRecording = async (ingredients) => {
  const recording = await getIngredientStockRecording(ingredients.map((i) => i.id))
  for (const ing of ingredients) {
    const rec = recording.get(ing.id)
    ing.setDataValue('openingStockRecorded', Boolean(rec))
    ing.setDataValue('stockState', stockStateOf(rec, ing.stock))
    ing.setDataValue('lastStockRecordedAt', rec?.lastRecordedAt || null)
    ing.setDataValue('lastCountedAt', rec?.lastCountedAt || null)
  }
}

const ingredientController = {
  async getAll(req, res) {
    try {
      // F21-03: this previously trusted the raw req.query.store directly
      // (for any role) instead of resolveStoreId(req) — the same hardened
      // helper every other function in this file already uses. Over the
      // real route chain validateStoreAccess already blocks a mismatched
      // ?store= for non-super-admin, but the controller itself was not
      // independently safe against a forged/stale store value; resolveStoreId
      // always prefers req.storeId (the middleware-verified value) for
      // non-super-admin, and preserves the existing "explicit store, else
      // all stores" behavior for super_admin.
      const store = resolveStoreId(req)
      const {
        search,
        status,
        lowStock,
        supplier,
        page = 1,
        limit = 10
      } = req.query
      const offset = (parseInt(page) - 1) * parseInt(limit)

      const where = {}
      const andConditions = []
      if (store) {
        where[Op.or] = [{ store }, { store: null }]
      }
      if (search) {
        andConditions.push({ name: { [Op.iLike]: `%${search}%` } })
      }
      if (status !== undefined && status !== 'all') {
        andConditions.push({
          status
        })
      }
      if (supplier) {
        andConditions.push({ supplier: Number(supplier) })
      }
      // F21-05: previously applied after findAndCountAll's own limit/offset
      // had already paginated (`ingredients.filter(...)` + `count =
      // ingredients.length`) — a low-stock ingredient outside the raw page
      // window was invisible, and the reported total was just "how many of
      // this one page happened to qualify," not a true count. Pushing the
      // condition into the WHERE clause makes findAndCountAll's own count
      // and pagination correct by construction. Column-to-column compare
      // (stock <= minStock), matching the same unguarded low-stock
      // definition already used by every other ingredient low-stock query
      // in the codebase (stockHistory.js, pos.js getDashboardSummary).
      if (lowStock === 'true') {
        andConditions.push(
          db.sequelize.where(db.sequelize.col('stock'), Op.lte, db.sequelize.col('minStock'))
        )
      }
      if (andConditions.length > 0) {
        where[Op.and] = andConditions
      }

      const { count, rows: ingredients } = await db.ingredient.findAndCountAll({
        where,
        include: [
          {
            model: db.supplier,
            as: 'supplierData',
            attributes: ['id', 'name']
          },
          {
            model: db.ingredientCategory,
            as: 'categoryData',
            attributes: ['id', 'name']
          },
          {
            model: db.location,
            as: 'storeData',
            attributes: ['id', 'name']
          }
        ],
        limit: parseInt(limit),
        offset,
        order: [['updatedAt', 'DESC']]
      })

      await enrichAuditFields(db, ingredients)
      await annotateStockRecording(ingredients)

      const storeFilter = store ? { [Op.or]: [{ store }, { store: null }] } : {}
      const [active, draft, inactive] = await Promise.all([
        db.ingredient.count({ where: { ...storeFilter, status: 'active' } }),
        db.ingredient.count({ where: { ...storeFilter, status: 'draft' } }),
        db.ingredient.count({ where: { ...storeFilter, status: 'inactive' } })
      ])

      return res.status(200).json({
        success: true,
        message: 'Success get ingredients',
        totalItems: count,
        totalPages: Math.ceil(count / parseInt(limit)),
        currentPage: parseInt(page),
        data: ingredients,
        stats: { total: active + draft + inactive, active, draft, inactive },
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(count / parseInt(limit))
        }
      })
    } catch (error) {
      console.log(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async getById(req, res) {
    try {
      const { id } = req.params
      const store = resolveStoreId(req)

      const ingredient = await db.ingredient.findOne({
        where: { id, ...(store ? { store } : {}) },
        include: [
          {
            model: db.supplier,
            as: 'supplierData',
            attributes: ['id', 'name', 'phone']
          },
          {
            model: db.ingredientCategory,
            as: 'categoryData',
            attributes: ['id', 'name']
          }
        ]
      })

      if (!ingredient) {
        return res.status(404).json({
          success: false,
          message: 'Ingredient not found'
        })
      }

      await annotateStockRecording([ingredient])

      return res.status(200).json({
        success: true,
        message: 'Success get ingredient',
        data: ingredient
      })
    } catch (error) {
      console.log(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async create(req, res) {
    try {
      const store = resolveStoreId(req)
      const {
        name,
        category,
        supplier,
        stock = 0,
        minStock = 0,
        unit,
        costPrice,
        status,
        baseUnit,
        conversionFactor
      } = req.body
      const createdBy = req.user?.id || null

      if (!name) {
        return res.status(400).json({
          success: false,
          message: 'Name is required'
        })
      }

      // The row starts at 0; a non-zero opening stock goes through the
      // ledger so it is recorded (stock_history) like any other entry. A
      // 0 here is "not entered yet", never a counted zero.
      const ingredient = await db.sequelize.transaction(async (t) => {
        const created = await db.ingredient.create(
          {
            store,
            name,
            category,
            supplier,
            stock: 0,
            minStock,
            unit: unit || 'pcs',
            baseUnit: baseUnit || unit || 'pcs',
            conversionFactor:
              conversionFactor != null ? parseFloat(conversionFactor) : 1,
            costPrice: costPrice || 0,
            status:
              status !== undefined
                ? status === true
                  ? 'active'
                  : status === false
                    ? 'inactive'
                    : status
                : 'active',
            createdBy
          },
          { transaction: t }
        )
        if (Number(stock) > 0) {
          await adjustIngredientStock({
            ingredientId: created.id,
            mode: 'set',
            quantity: Number(stock),
            notes: 'Stok awal (bahan baku baru)',
            createdBy,
            transaction: t
          })
        }
        return created.reload({ transaction: t })
      })
      createAudit(
        req,
        'create',
        'ingredient',
        ingredient.id,
        'Created ingredient: ' + (ingredient.name || ingredient.id)
      )

      return res.status(201).json({
        success: true,
        message: 'Success create ingredient',
        data: ingredient
      })
    } catch (error) {
      if (error.statusCode && error.statusCode < 500) {
        return res.status(error.statusCode).json({ success: false, message: error.message })
      }
      console.log(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async update(req, res) {
    try {
      const { id } = req.params
      const store = resolveStoreId(req)
      const {
        name,
        category,
        supplier,
        stock,
        minStock,
        unit,
        costPrice,
        status,
        baseUnit,
        conversionFactor
      } = req.body
      const modifiedBy = req.user?.id || null

      const isSuperAdmin = req.user?.roleType === 'super_admin'

      const updated = await db.sequelize.transaction(async (t) => {
        let ingredient = await db.ingredient.findOne({
          where: { id, ...(store ? { store } : {}) },
          transaction: t,
          lock: t.LOCK.UPDATE
        })

        if (!ingredient && isSuperAdmin) {
          ingredient = await db.ingredient.findOne({
            where: { id },
            transaction: t,
            lock: t.LOCK.UPDATE
          })
        }

        if (!ingredient) return null

        // Stock is never part of this generic write. A changed value goes
        // through the locked ledger path (delta from the locked value + a
        // stock_history row); an unchanged or omitted value leaves it alone.
        await ingredient.update(
          {
            name: name || ingredient.name,
            category: category !== undefined ? category : ingredient.category,
            supplier: supplier !== undefined ? supplier : ingredient.supplier,
            minStock: minStock !== undefined ? minStock : ingredient.minStock,
            unit: unit || ingredient.unit,
            baseUnit: baseUnit !== undefined ? baseUnit : ingredient.baseUnit,
            conversionFactor:
              conversionFactor != null
                ? parseFloat(conversionFactor)
                : ingredient.conversionFactor,
            store: store !== undefined ? store : ingredient.store,
            costPrice: costPrice !== undefined ? costPrice : ingredient.costPrice,
            status:
              status !== undefined
                ? status === true
                  ? 'active'
                  : status === false
                    ? 'inactive'
                    : status
                : ingredient.status,
            modifiedBy
          },
          { transaction: t }
        )

        if (stock !== undefined && Number(stock) !== Number(ingredient.stock)) {
          await adjustIngredientStock({
            ingredientId: ingredient.id,
            mode: 'set',
            quantity: Number(stock),
            notes: 'Ubah stok dari form bahan baku',
            createdBy: modifiedBy,
            transaction: t
          })
        }
        return ingredient.reload({ transaction: t })
      })

      if (!updated) {
        return res.status(404).json({
          success: false,
          message: 'Ingredient not found'
        })
      }
      createAudit(req, 'update', 'ingredient', id, 'Updated ingredient: ' + id)

      return res.status(200).json({
        success: true,
        message: 'Success update ingredient',
        data: updated
      })
    } catch (error) {
      if (error.statusCode && error.statusCode < 500) {
        return res.status(error.statusCode).json({ success: false, message: error.message })
      }
      console.log(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  // Opening stock / correction / count for one ingredient. type 'set'
  // records an absolute count (also a counted 0); 'add'/'subtract' move it.
  async adjustStock(req, res) {
    try {
      const { id } = req.params
      const store = resolveStoreId(req)
      const { quantity, type, notes } = req.body

      const outcome = await db.sequelize.transaction((t) =>
        adjustIngredientStock({
          ingredientId: id,
          store,
          mode: type,
          quantity,
          notes: notes || null,
          createdBy: req.user?.id || null,
          transaction: t
        })
      )

      if (!outcome) {
        return res.status(404).json({
          success: false,
          message: 'Ingredient not found'
        })
      }
      const { ingredient, quantityBefore, quantityChange, quantityAfter } = outcome
      createAudit(
        req,
        'update',
        'ingredient',
        ingredient.id,
        `Adjusted ingredient stock (${type}): ${ingredient.name} ${quantityBefore} -> ${quantityAfter}`,
        { stock: quantityBefore },
        { stock: quantityAfter, type, notes: notes || null }
      )

      return res.status(200).json({
        success: true,
        message: 'Success adjust stock',
        data: {
          ingredient,
          quantityBefore,
          quantityChange,
          quantityAfter
        }
      })
    } catch (error) {
      if (error.statusCode && error.statusCode < 500) {
        return res
          .status(error.statusCode)
          .json({ success: false, message: error.message, ...(error.code ? { code: error.code } : {}) })
      }
      console.log(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  // Remaining-stock view for one store, read from the stock ledger: per
  // ingredient, the period's opening balance, what sales consumed, what
  // reversals/returns restored, manual entries, counts and receipts, and
  // the closing balance. Menu units sold are reported separately — they
  // are portions, not ingredient units.
  async stockSummary(req, res) {
    try {
      const store = resolveStoreId(req)
      if (store == null) {
        return res.status(400).json({ success: false, message: 'store is required' })
      }
      // YYYY-MM-DD = a business day in the store's own timezone.
      const location = await db.location.findByPk(store, { attributes: ['id', 'timezone'] })
      const timezone = location?.timezone || DEFAULT_TIMEZONE
      const parseDate = (v, edge) => {
        if (!v) return null
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return undefined
        const bounds = getStoreDayBounds(String(v), timezone)
        return Number.isNaN(bounds[edge].getTime()) ? undefined : bounds[edge]
      }
      const start = parseDate(req.query.startDate, 'start')
      const end = parseDate(req.query.endDate, 'end')
      if (start === undefined || end === undefined) {
        return res
          .status(400)
          .json({ success: false, message: 'startDate/endDate must be YYYY-MM-DD' })
      }

      const ingredients = await db.ingredient.findAll({
        where: { store },
        attributes: ['id', 'name', 'stock', 'unit', 'baseUnit', 'minStock', 'status'],
        order: [['name', 'ASC']]
      })
      const ids = ingredients.map((i) => i.id)

      // Signed quantity per (ingredient, bucket), split at the period edges.
      const movements = ids.length
        ? await db.sequelize.query(
            `SELECT ingredient AS "ingredientId",
                    CASE
                      WHEN "referenceType"::text = 'sale' THEN 'consumed'
                      WHEN "referenceType"::text IN ('sale_reversal', 'sale_return', 'sale_return_reversal') THEN 'restored'
                      WHEN "referenceType"::text = 'adjustment' THEN 'adjusted'
                      WHEN "referenceType"::text = 'opname' THEN 'counted'
                      WHEN "referenceType"::text IN ('purchase', 'purchase_return') THEN 'received'
                      ELSE 'other'
                    END AS bucket,
                    CASE
                      WHEN CAST(:end AS timestamptz) IS NOT NULL AND "createdAt" > CAST(:end AS timestamptz) THEN 'after'
                      WHEN CAST(:start AS timestamptz) IS NOT NULL AND "createdAt" < CAST(:start AS timestamptz) THEN 'before'
                      ELSE 'in'
                    END AS slot,
                    SUM("quantityChange") AS qty
               FROM stock_history
              WHERE "deletedAt" IS NULL AND ingredient IN (:ids)
              GROUP BY 1, 2, 3`,
            {
              replacements: { ids, start: start || null, end: end || null },
              type: db.Sequelize.QueryTypes.SELECT
            }
          )
        : []
      const recording = await getIngredientStockRecording(ids)

      const round4 = (n) => Math.round(n * 10000) / 10000
      const byIngredient = new Map()
      for (const m of movements) {
        const key = Number(m.ingredientId)
        if (!byIngredient.has(key)) byIngredient.set(key, [])
        byIngredient.get(key).push(m)
      }

      const items = ingredients.map((ing) => {
        const rows = byIngredient.get(ing.id) || []
        const inPeriod = { consumed: 0, restored: 0, adjusted: 0, counted: 0, received: 0, other: 0 }
        let after = 0
        for (const r of rows) {
          const qty = Number(r.qty) || 0
          if (r.slot === 'after') after += qty
          else if (r.slot === 'in') inPeriod[r.bucket] += qty
        }
        const currentStock = Number(ing.stock) || 0
        const closing = round4(currentStock - after)
        const netInPeriod = Object.values(inPeriod).reduce((a, b) => a + b, 0)
        const rec = recording.get(ing.id)
        return {
          id: ing.id,
          name: ing.name,
          unit: ing.baseUnit || ing.unit || 'pcs',
          status: ing.status,
          minStock: ing.minStock,
          openingStockRecorded: Boolean(rec),
          stockState: stockStateOf(rec, currentStock),
          lastRecordedAt: rec?.lastRecordedAt || null,
          lastCountedAt: rec?.lastCountedAt || null,
          openingBalance: round4(closing - netInPeriod),
          consumed: round4(-inPeriod.consumed),
          restored: round4(inPeriod.restored),
          adjusted: round4(inPeriod.adjusted),
          counted: round4(inPeriod.counted),
          received: round4(inPeriod.received),
          other: round4(inPeriod.other),
          closingBalance: closing,
          currentStock
        }
      })

      // Menu portions sold in the period (paid, not cancelled/voided). Gross:
      // later returns are not subtracted here. Enum columns are compared as
      // text so a value absent from one environment's enum never errors.
      const menuSold = await db.sequelize.query(
        `SELECT oi.product AS "productId",
                MAX(oi."productName") AS "productName",
                SUM(oi.quantity) AS quantity
           FROM order_item oi
           JOIN "order" o ON o.id = oi."order"
          WHERE o.store = :store
            AND o."deletedAt" IS NULL AND oi."deletedAt" IS NULL
            AND o."paymentStatus"::text IN ('paid', 'refunded')
            AND o.status::text NOT IN ('cancelled', 'void')
            AND (CAST(:start AS timestamptz) IS NULL OR o."createdAt" >= CAST(:start AS timestamptz))
            AND (CAST(:end AS timestamptz) IS NULL OR o."createdAt" <= CAST(:end AS timestamptz))
          GROUP BY oi.product
          ORDER BY 3 DESC`,
        {
          replacements: { store, start: start || null, end: end || null },
          type: db.Sequelize.QueryTypes.SELECT
        }
      )

      return res.status(200).json({
        success: true,
        message: 'Success get ingredient stock summary',
        data: {
          store,
          startDate: start,
          endDate: end,
          items,
          menuSold: menuSold.map((m) => ({
            productId: m.productId,
            productName: m.productName,
            quantity: Number(m.quantity) || 0
          }))
        }
      })
    } catch (error) {
      console.log(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async delete(req, res) {
    try {
      const { id } = req.params
      const store = resolveStoreId(req)

      const ingredient = await db.ingredient.findOne({
        where: { id, ...(store ? { store } : {}) }
      })

      if (!ingredient) {
        return res.status(404).json({
          success: false,
          message: 'Ingredient not found'
        })
      }

      await ingredient.destroy()
      createAudit(req, 'delete', 'ingredient', id, 'Deleted ingredient: ' + id)

      return res.status(200).json({
        success: true,
        message: 'Success delete ingredient'
      })
    } catch (error) {
      console.log(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async downloadTemplate(req, res) {
    try {
      const store = resolveStoreId(req)
      const categories = await db.ingredientCategory.findAll({
        attributes: ['name'],
        order: [['createdAt', 'ASC']]
      })
      const suppliers = await db.supplier.findAll({
        where: store ? { store } : {},
        attributes: ['name'],
        order: [['createdAt', 'ASC']]
      })
      const catList = categories.map((c) => c.name).join(',')
      const suppList = suppliers.map((s) => s.name).join(',')

      const workbook = new excelJS.Workbook()

      // --- Sheet 1: Template ---
      const ws = workbook.addWorksheet('Template')
      ws.columns = [
        { header: 'No', key: 'no', width: 6 },
        { header: 'Nama Bahan Baku', key: 'name', width: 28 },
        { header: 'Kategori', key: 'category', width: 22 },
        { header: 'Supplier', key: 'supplier', width: 22 },
        { header: 'Unit Pembelian', key: 'unit', width: 18 },
        { header: 'Base Unit', key: 'baseUnit', width: 16 },
        { header: 'Faktor Konversi', key: 'conversionFactor', width: 16 },
        { header: 'Stok Awal', key: 'stock', width: 12 },
        { header: 'Minimal Stok', key: 'minStock', width: 14 },
        { header: 'Harga Beli (Rp)', key: 'costPrice', width: 16 },
        { header: 'Status', key: 'status', width: 14 }
      ]

      const headerRow = ws.getRow(1)
      headerRow.font = { bold: true, color: { argb: 'FFFFFF' }, size: 11 }
      headerRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: '4472C4' }
      }
      headerRow.alignment = { horizontal: 'center', vertical: 'middle' }
      headerRow.height = 28
      headerRow.eachCell((cell) => {
        cell.protection = { locked: true }
      })

      for (let r = 2; r <= 200; r++) {
        ws.getCell(`C${r}`).dataValidation = {
          type: 'list',
          formulae: [catList ? `"${catList}"` : '""'],
          showErrorMessage: true,
          errorTitle: 'Kategori tidak valid',
          error: 'Pilih kategori yang tersedia'
        }
        ws.getCell(`D${r}`).dataValidation = {
          type: 'list',
          formulae: [suppList ? `"${suppList}"` : '""'],
          showErrorMessage: true,
          errorTitle: 'Supplier tidak valid',
          error: 'Pilih supplier yang tersedia'
        }
        ws.getCell(`E${r}`).dataValidation = {
          type: 'list',
          formulae: [
            '"pcs,buah,kg,gram,liter,ml,meter,cm,lusin,pack,box,karton"'
          ],
          showErrorMessage: true,
          errorTitle: 'Unit tidak valid'
        }
        ws.getCell(`F${r}`).dataValidation = {
          type: 'list',
          formulae: ['"pcs,gram,ml,cm,buah,lembar"'],
          showErrorMessage: true,
          errorTitle: 'Base Unit tidak valid'
        }
        ws.getCell(`K${r}`).dataValidation = {
          type: 'list',
          formulae: ['"Active,Inactive,Draft"'],
          showErrorMessage: true,
          errorTitle: 'Status tidak valid',
          error: 'Pilih Active, Inactive, atau Draft'
        }
      }

      // Pre-fill conversion hints
      const hints = [
        { unit: 'kg', base: 'gram', factor: 1000 },
        { unit: 'liter', base: 'ml', factor: 1000 },
        { unit: 'meter', base: 'cm', factor: 100 },
        { unit: 'lusin', base: 'pcs', factor: 12 },
        { unit: 'karton', base: 'pcs', factor: 50 },
        { unit: 'box', base: 'pcs', factor: 10 },
        { unit: 'pack', base: 'pcs', factor: 5 }
      ]
      const sampleRow = 3
      ws.getCell(`A${sampleRow}`).value = 1
      ws.getCell(`B${sampleRow}`).value = 'Contoh: Tepung Terigu'
      ws.getCell(`E${sampleRow}`).value = 'kg'
      ws.getCell(`F${sampleRow}`).value = 'gram'
      ws.getCell(`G${sampleRow}`).value = 1000
      ws.getCell(`H${sampleRow}`).value = 0
      ws.getCell(`I${sampleRow}`).value = 10
      ws.getCell(`J${sampleRow}`).value = 12000
      ws.getCell(`K${sampleRow}`).value = 'Active'

      // Unlock all data cells so users can edit freely
      for (let r = 1; r <= 200; r++) {
        for (let c = 1; c <= 11; c++) {
          ws.getCell(r, c).protection = { locked: false }
        }
      }

      // --- Sheet 2: Rumus Konversi ---
      const rs = workbook.addWorksheet('Rumus Konversi')
      rs.columns = [
        { header: 'Unit Pembelian', key: 'unit', width: 18 },
        { header: 'Base Unit', key: 'base', width: 16 },
        { header: 'Faktor Konversi', key: 'factor', width: 18 },
        { header: 'Rumus', key: 'formula', width: 30 }
      ]
      const rHeader = rs.getRow(1)
      rHeader.font = { bold: true, color: { argb: 'FFFFFF' }, size: 11 }
      rHeader.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: '4472C4' }
      }
      rHeader.alignment = { horizontal: 'center', vertical: 'middle' }

      hints.forEach((h, i) => {
        const row = i + 2
        rs.getCell(`A${row}`).value = h.unit
        rs.getCell(`B${row}`).value = h.base
        rs.getCell(`C${row}`).value = h.factor
        rs.getCell(`D${row}`).value = `1 ${h.unit} = ${h.factor} ${h.base}`
      })

      rs.addRow([])
      rs.addRow(['', '', '', 'Stok dalam sistem tersimpan dalam Base Unit'])
      rs.addRow(['', '', '', 'Contoh: Stok 5 kg tersimpan sebagai 5000 gram'])

      const buffer = await workbook.xlsx.writeBuffer()
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
      res.setHeader(
        'Content-Disposition',
        'attachment; filename=template-bahan-baku.xlsx'
      )
      return res.send(buffer)
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async downloadData(req, res) {
    try {
      const store = resolveStoreId(req)
      const ingredients = await db.ingredient.findAll({
        where: store ? { store } : {},
        include: [
          {
            model: db.supplier,
            as: 'supplierData',
            attributes: ['id', 'name']
          },
          {
            model: db.ingredientCategory,
            as: 'categoryData',
            attributes: ['id', 'name']
          }
        ],
        order: [['createdAt', 'ASC']]
      })

      const workbook = new excelJS.Workbook()
      const ws = workbook.addWorksheet('Bahan Baku')
      ws.columns = [
        { header: 'No', key: 'no', width: 6 },
        { header: 'Nama Bahan Baku', key: 'name', width: 28 },
        { header: 'Kategori', key: 'category', width: 22 },
        { header: 'Supplier', key: 'supplier', width: 22 },
        { header: 'Unit Pembelian', key: 'unit', width: 18 },
        { header: 'Base Unit', key: 'baseUnit', width: 16 },
        { header: 'Faktor Konversi', key: 'conversionFactor', width: 16 },
        { header: 'Stok', key: 'stock', width: 12 },
        { header: 'Minimal Stok', key: 'minStock', width: 14 },
        { header: 'Harga Beli', key: 'costPrice', width: 16 },
        { header: 'Status', key: 'status', width: 12 }
      ]

      const headerRow = ws.getRow(1)
      headerRow.font = { bold: true, color: { argb: 'FFFFFF' }, size: 11 }
      headerRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: '4472C4' }
      }
      headerRow.alignment = { horizontal: 'center', vertical: 'middle' }
      headerRow.height = 28

      ingredients.forEach((ing, i) => {
        ws.addRow({
          no: i + 1,
          name: ing.name,
          category: ing.categoryData?.name || '',
          supplier: ing.supplierData?.name || '',
          unit: ing.unit || 'pcs',
          baseUnit: ing.baseUnit || ing.unit || 'pcs',
          conversionFactor: ing.conversionFactor || 1,
          stock: ing.stock,
          minStock: ing.minStock,
          costPrice: ing.costPrice || 0,
          status: ing.status === 'active' ? 'Active' : 'Inactive'
        })
      })

      const buffer = await workbook.xlsx.writeBuffer()
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
      res.setHeader(
        'Content-Disposition',
        'attachment; filename=data-bahan-baku.xlsx'
      )
      return res.send(buffer)
    } catch (error) {
      console.log(error)
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
          .json({ success: false, message: 'Tidak ada file yang diupload' })
      }

      const store = req.user?.store
      if (!store) {
        return res
          .status(400)
          .json({ success: false, message: 'Store tidak ditemukan' })
      }

      const workbook = new excelJS.Workbook()
      await workbook.xlsx.load(req.file.buffer)
      const ws = workbook.getWorksheet('Template')
      if (!ws) {
        return res
          .status(400)
          .json({ success: false, message: 'Sheet "Template" tidak ditemukan' })
      }

      // Validate headers
      const expected = [
        'No',
        'Nama Bahan Baku',
        'Kategori',
        'Supplier',
        'Unit Pembelian',
        'Base Unit',
        'Faktor Konversi',
        'Stok Awal',
        'Minimal Stok',
        'Harga Beli (Rp)',
        'Status'
      ]
      const headers = []
      ws.getRow(1).eachCell((cell) => {
        headers.push(cell.value ? String(cell.value).trim() : '')
      })
      const headerValid = expected.every((h, i) => headers[i] === h)
      if (!headerValid) {
        return res.status(400).json({
          success: false,
          message: 'Header file tidak sesuai dengan template'
        })
      }

      // Fetch lookup maps — match store OR global (store IS NULL)
      const allCategories = await db.ingredientCategory.findAll({
        where: store ? { [Op.or]: [{ store }, { store: null }] } : {}
      })
      const categoryMap = {}
      allCategories.forEach((c) => {
        categoryMap[c.name.toLowerCase()] = c.id
      })

      const allSuppliers = await db.supplier.findAll({
        where: store ? { [Op.or]: [{ store }, { store: null }] } : {}
      })
      const supplierMap = {}
      allSuppliers.forEach((s) => {
        supplierMap[s.name.toLowerCase()] = s.id
      })

      // Parse rows
      const ingredients = []
      const errors = []

      ws.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return // skip header
        const name = row.getCell(2).value
        if (!name) return
        const ingredientName = String(name).trim()
        if (!ingredientName || ingredientName.startsWith('Contoh:')) return

        const catName = row.getCell(3).value
          ? String(row.getCell(3).value).trim()
          : ''
        const suppName = row.getCell(4).value
          ? String(row.getCell(4).value).trim()
          : ''
        const unit = row.getCell(5).value
          ? String(row.getCell(5).value).trim().toLowerCase()
          : 'pcs'
        const baseUnit = row.getCell(6).value
          ? String(row.getCell(6).value).trim().toLowerCase()
          : unit
        const conversionFactor = parseFloat(row.getCell(7).value) || 1
        const stock = parseInt(row.getCell(8).value) || 0
        const minStock = parseInt(row.getCell(9).value) || 0
        const costPrice =
          parseInt(String(row.getCell(10).value).replace(/[^0-9]/g, '')) || 0
        const statusRaw = row.getCell(11).value
          ? String(row.getCell(11).value).trim().toLowerCase()
          : 'active'
        const status = ['active', 'inactive', 'draft'].includes(statusRaw)
          ? statusRaw
          : 'active'

        // Resolve category
        let categoryId = null
        if (catName) {
          categoryId = categoryMap[catName.toLowerCase()]
          if (!categoryId)
            errors.push(
              `Baris ${rowNumber}: Kategori "${catName}" tidak ditemukan`
            )
        }

        // Resolve supplier
        let supplierId = null
        if (suppName) {
          supplierId = supplierMap[suppName.toLowerCase()]
          if (!supplierId)
            errors.push(
              `Baris ${rowNumber}: Supplier "${suppName}" tidak ditemukan`
            )
        }

        ingredients.push({
          store,
          name: ingredientName,
          category: categoryId,
          supplier: supplierId,
          unit,
          baseUnit,
          conversionFactor,
          stock,
          minStock,
          costPrice,
          status,
          createdBy: req.user?.id || null
        })
      })

      // Insert with duplicate checking
      let insertedCount = 0
      const duplicateErrors = []
      for (const ing of ingredients) {
        const existing = await db.ingredient.findOne({
          where: { name: ing.name, store: ing.store }
        })
        if (existing) {
          duplicateErrors.push(`"${ing.name}" sudah terdaftar`)
          continue
        }
        await db.ingredient.create(ing)
        insertedCount++
      }

      createAudit(
        req,
        'import',
        'ingredient',
        null,
        `Imported ${insertedCount} ingredients`
      )

      return res.status(201).json({
        success: true,
        message: `Berhasil import ${insertedCount} dari ${ingredients.length} bahan baku`,
        data: {
          total: ingredients.length,
          created: insertedCount,
          skipped: duplicateErrors.length,
          skippedNames: duplicateErrors.length > 0 ? duplicateErrors : undefined
        }
      })
    } catch (error) {
      console.log(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async getProductNames(req, res) {
    try {
      const { supplier } = req.query

      if (!supplier) {
        return res.status(400).json({
          success: false,
          message: 'Supplier is required'
        })
      }

      const supplierId = Number(supplier)

      const where = { supplier: supplierId }
      const productAttrs = [
        'id',
        'supplier',
        'productId',
        'name',
        'price',
        'unit',
        'leadTime',
        'leadTimeUnit',
        'qualityRating',
        'minOrderQty',
        'notes',
        'lastPrice',
        'createdBy',
        'modifiedBy',
        'createdAt',
        'updatedAt'
      ]
      let products = await db.supplier_product.findAll({
        where,
        attributes: productAttrs,
        raw: true
      })

      const seen = new Set()
      products = products.filter((p) => {
        const key = p.name.toLowerCase().trim()
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      return res.status(200).json({
        success: true,
        message: 'Success get product names',
        data: products
      })
    } catch (error) {
      console.log(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  }
}

module.exports = ingredientController
