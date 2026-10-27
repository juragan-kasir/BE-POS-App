const db = require('../../db/models')
const { Op } = require('sequelize')
const excelJS = require('exceljs')
const { createAudit } = require('../../utils/auditLog')
const { enrichAuditFields } = require('../../utils/auditFields')
const { setProductStock } = require('../service/stockMutationService')
const {
  isInventoryItemMode,
  assertNoOwnStockWrites,
  InventoryLinkError,
  inventoryLinkErrorBody
} = require('../service/inventoryLinkService')
const { scalarStoreScope, resolveStoreId } = require('../../utils/tenantScope')
const { assertDecimalQuantity } = require('../../utils/decimalQuantityGuard')

// Phase 34: the six primary stock-opname quantity fields, all DECIMAL(10,4).
// A field left null/undefined is an intentionally-uncounted value (e.g. a
// draft row's stokFisikJumlah/selisihJumlah before the physical count is
// taken) and is exempt from this check, not coerced into an error or a
// misleading 0 — only a value that IS present must be a valid decimal.
const OPNAME_QUANTITY_FIELDS = [
  'stokAwalJumlah',
  'barangMasukJumlah',
  'barangKeluarJumlah',
  'stokAkhirJumlah',
  'stokFisikJumlah',
  'selisihJumlah'
]

function validateOpnameItemQuantities(items) {
  for (const item of items) {
    for (const field of OPNAME_QUANTITY_FIELDS) {
      const value = item?.[field]
      if (value === null || value === undefined) continue
      assertDecimalQuantity(value, field)
    }
  }
}

const generateOpnameNumber = () => {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const timestamp = Date.now()
  return `SO-${year}${month}${day}-${timestamp}`
}

// F-STOCK-2: re-read an ingredient row under a row lock inside the
// completion transaction. Completion writes an absolute counted value —
// without holding the lock across read+write, a concurrent mutation
// (sale, receipt, another opname) landing in between is silently
// overwritten (lost update). Same discipline as setProductStock, which
// already protects the product lines.
// BRD BR-01: a product linked to an inventory item has no stock of its
// own — its count is the item's (matched by name). A count that names only
// the linked product is refused rather than lost.
const linkedProductCount = async (product, ingredient, transaction) => {
  if (!product || !isInventoryItemMode(product.inventoryMode)) return product
  if (!ingredient) await assertNoOwnStockWrites([product.id], transaction)
  return null
}

const lockIngredientRow = async (ingredient, transaction) => {
  if (!ingredient) return null
  return db.ingredient.findByPk(ingredient.id, {
    lock: transaction.LOCK.UPDATE,
    transaction
  })
}

const STOCK_OPNAME_EXCEL_HEADERS = [
  { header: 'No.', key: 'no', width: 6 },
  { header: 'Kode Barang', key: 'kodeBarang', width: 15 },
  { header: 'Nama Barang', key: 'namaBarang', width: 25 },
  { header: 'Satuan', key: 'satuan', width: 10 },
  { header: 'Lokasi', key: 'lokasi', width: 20 },
  { header: 'Stok Awal', key: 'stokAwalJumlah', width: 14 },
  { header: 'Barang Masuk', key: 'barangMasukJumlah', width: 16 },
  { header: 'Barang Keluar', key: 'barangKeluarJumlah', width: 16 },
  { header: 'Stok Akhir', key: 'stokAkhirJumlah', width: 14 },
  { header: 'Stok Fisik', key: 'stokFisikJumlah', width: 14 },
  { header: 'Selisih', key: 'selisihJumlah', width: 12 },
  { header: 'Keterangan', key: 'keterangan', width: 25 }
]

const stockOpnameController = {
  async getAll(req, res) {
    try {
      const {
        page = 1,
        limit = 10,
        status,
        startDate,
        endDate,
        search
      } = req.query

      const where = {}
      const effectiveStore = req.storeId
      if (effectiveStore) where.store = effectiveStore

      if (status) {
        where.status = status
      }

      if (search) {
        where[Op.or] = [
          { auditId: { [Op.iLike]: `%${search}%` } },
          { auditor: { [Op.iLike]: `%${search}%` } },
          { '$storeData.name$': { [Op.iLike]: `%${search}%` } }
        ]
      }

      if (startDate || endDate) {
        where.date = {}
        if (startDate) where.date[Op.gte] = new Date(startDate)
        if (endDate) where.date[Op.lte] = new Date(endDate)
      }

      const offset = (parseInt(page) - 1) * parseInt(limit)

      const [opnames, total, draftCount, completedCount, cancelledCount] =
        await Promise.all([
          db.stockOpname.findAll({
            where,
            include: [
              { model: db.stockOpnameItem, as: 'items' },
              {
                model: db.location,
                as: 'storeData',
                attributes: ['id', 'name']
              }
            ],
            order: [['updatedAt', 'DESC']],
            limit: parseInt(limit),
            offset
          }),
          db.stockOpname.count({ where }),
          db.stockOpname.count({ where: { ...where, status: 'draft' } }),
          db.stockOpname.count({ where: { ...where, status: 'completed' } }),
          db.stockOpname.count({ where: { ...where, status: 'cancelled' } })
        ])

      const totalItemsResult = await db.stockOpnameItem.count({
        include: [
          {
            model: db.stockOpname,
            as: 'parentOpname',
            where
          }
        ]
      })

      await enrichAuditFields(db, opnames)

      const data = opnames.map((opname) => {
        const items = opname.items || []
        const totalItems = items.length
        // Phase 34: selisihJumlah is DECIMAL(10,4), returned as a string by
        // Sequelize/pg for DB-loaded rows — `sum + item.x` would silently
        // string-concatenate without this explicit Number() coercion.
        const totalSelisih = items.reduce(
          (sum, item) => sum + (Number(item.selisihJumlah) || 0),
          0
        )
        const highVarianceItems = items.filter(
          (item) => Math.abs(item.selisihJumlah || 0) > 0
        ).length

        return {
          id: opname.id,
          opnameNumber: opname.opnameNumber,
          auditDate: opname.auditDate,
          auditor: opname.auditor,
          notes: opname.notes,
          status: opname.status,
          store: opname.storeData
            ? { id: opname.storeData.id, name: opname.storeData.name }
            : null,
          stats: { totalItems, totalSelisih, highVarianceItems },
          items: items.map((item) => ({
            id: item.id,
            product: item.product,
            kodeBarang: item.kodeBarang,
            namaBarang: item.namaBarang,
            satuan: item.satuan,
            lokasiId: item.lokasiId,
            stokAwalJumlah: item.stokAwalJumlah,
            barangMasukJumlah: item.barangMasukJumlah,
            barangKeluarJumlah: item.barangKeluarJumlah,
            stokAkhirJumlah: item.stokAkhirJumlah,
            stokFisikJumlah: item.stokFisikJumlah,
            selisihJumlah: item.selisihJumlah,
            keterangan: item.keterangan
          })),
          createdAt: opname.createdAt,
          updatedAt: opname.updatedAt
        }
      })

      return res.status(200).json({
        success: true,
        message: 'Success',
        data,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit))
        },
        stats: {
          total,
          draft: draftCount,
          completed: completedCount,
          cancelled: cancelledCount,
          totalItems: totalItemsResult
        }
      })
    } catch (error) {
      console.error(error)
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
      const userRole = req.user?.roleType

      const whereClause = { id }
      if (store && userRole !== 'super_admin') {
        whereClause.store = store
      }

      const opname = await db.stockOpname.findOne({
        where: whereClause,
        include: [
          { model: db.stockOpnameItem, as: 'items' },
          { model: db.location, as: 'storeData', attributes: ['id', 'name'] }
        ]
      })

      if (!opname) {
        return res.status(404).json({
          success: false,
          message: 'Stock opname not found'
        })
      }

      const items = opname.items || []
      const totalItems = items.length
      // Phase 34: same string-coercion fix as getAll (DB-loaded DECIMAL
      // selisihJumlah is a string; Number() prevents string concatenation).
      const totalSelisih = items.reduce(
        (sum, item) => sum + (Number(item.selisihJumlah) || 0),
        0
      )
      const highVarianceItems = items.filter(
        (item) => Math.abs(item.selisihJumlah || 0) > 0
      ).length

      const data = {
        id: opname.id,
        opnameNumber: opname.opnameNumber,
        auditDate: opname.auditDate,
        auditor: opname.auditor,
        notes: opname.notes,
        status: opname.status,
        store: opname.storeData
          ? { id: opname.storeData.id, name: opname.storeData.name }
          : null,
        stats: { totalItems, totalSelisih, highVarianceItems },
        items: items.map((item) => ({
          id: item.id,
          product: item.product, // Add productId field for frontend compatibility
          kodeBarang: item.kodeBarang,
          namaBarang: item.namaBarang,
          satuan: item.satuan,
          lokasiId: item.lokasiId,
          stokAwalJumlah: item.stokAwalJumlah,
          barangMasukJumlah: item.barangMasukJumlah,
          barangKeluarJumlah: item.barangKeluarJumlah,
          stokAkhirJumlah: item.stokAkhirJumlah,
          stokFisikJumlah: item.stokFisikJumlah,
          selisihJumlah: item.selisihJumlah,
          keterangan: item.keterangan
        }))
      }

      return res.status(200).json({
        success: true,
        message: 'Success',
        data
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
      const store = resolveStoreId(req)
      const userStore = req.user?.store
      const {
        items,
        notes,
        date,
        auditDate,
        auditor,
        status: reqStatus
      } = req.body
      let effectiveStore = store || userStore

      if (!effectiveStore && items && items.length > 0) {
        effectiveStore = items[0].lokasiId
      }

      if (!effectiveStore) {
        return res.status(400).json({
          success: false,
          message:
            'Store tidak ditemukan. Pastikan store/lokasi sudah terdaftar.'
        })
      }

      if (!items || items.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Items are required'
        })
      }

      try {
        validateOpnameItemQuantities(items)
      } catch (err) {
        return res.status(err.statusCode || 422).json({
          success: false,
          message: err.message
        })
      }

      const opnameNumber = generateOpnameNumber()

      const totalAdjustment = items.reduce((sum, item) => {
        return sum + (item.selisihJumlah || 0)
      }, 0)

      const t = await db.sequelize.transaction()
      try {
        const opname = await db.stockOpname.create(
          {
            store: effectiveStore,
            opnameNumber,
            date: date || new Date(),
            auditDate: auditDate || null,
            auditor: auditor || null,
            totalAdjustment,
            status: reqStatus === 'completed' ? 'completed' : 'draft',
            notes,
            createdBy: req.user?.id || null
          },
          { transaction: t }
        )

        const opnameItems = items.map((item) => ({
          stockOpname: opname.id,
          kodeBarang: item.kodeBarang || null,
          namaBarang: item.namaBarang || null,
          satuan: item.satuan || null,
          lokasiId: item.lokasiId || null,
          lokasi:
            item.lokasi !== null && item.lokasi !== undefined
              ? String(item.lokasi)
              : null,
          product: item.product || item.productId || null,
          ingredientName: item.ingredientName || null,
          systemStock:
            item.systemStock !== undefined
              ? item.systemStock
              : item.stokAkhirJumlah || 0,
          actualStock:
            item.actualStock !== undefined
              ? item.actualStock
              : item.stokFisikJumlah || 0,
          adjustment:
            item.adjustment !== undefined
              ? item.adjustment
              : item.selisihJumlah || 0,
          unit: item.unit || item.satuan || 'pcs',
          notes: null,
          stokAwalJumlah: item.stokAwalJumlah || 0,
          barangMasukJumlah: item.barangMasukJumlah || 0,
          barangKeluarJumlah: item.barangKeluarJumlah || 0,
          stokAkhirJumlah: item.stokAkhirJumlah || 0,
          stokFisikJumlah: item.stokFisikJumlah || 0,
          selisihJumlah: item.selisihJumlah || 0,
          keterangan: item.keterangan || null
        }))

        await db.stockOpnameItem.bulkCreate(opnameItems, { transaction: t })

        const created = await db.stockOpname.findByPk(opname.id, {
          include: [{ model: db.stockOpnameItem, as: 'items' }],
          transaction: t
        })

        for (const item of created.items) {
          let product = null
          let ingredient = null

          if (item.product) {
            product = await db.product.findByPk(item.product, {
              transaction: t
            })
          }

          if (!product && item.namaBarang) {
            product = await db.product.findOne({
              where: { nameProduct: { [Op.iLike]: item.namaBarang.trim() } },
              transaction: t
            })
          }

          if (product && !item.product) {
            await item.update({ product: product.id }, { transaction: t })
          }

          if (item.ingredientName) {
            ingredient = await db.ingredient.findOne({
              where: {
                name: { [Op.iLike]: item.ingredientName.trim() },
                store: effectiveStore
              },
              transaction: t
            })
          }

          if (!ingredient && item.namaBarang) {
            ingredient = await db.ingredient.findOne({
              where: {
                name: { [Op.iLike]: item.namaBarang.trim() },
                store: effectiveStore
              },
              transaction: t
            })
          }

          if (!ingredient && !product && item.namaBarang) {
            ingredient = await db.ingredient.findOne({
              where: {
                name: { [Op.iLike]: item.namaBarang.trim() },
                store: effectiveStore
              },
              transaction: t
            })
          }

          if (ingredient && !item.ingredientName) {
            await item.update(
              { ingredientName: ingredient.name },
              { transaction: t }
            )
          }

          product = await linkedProductCount(product, ingredient, t)
          if (
            product &&
            reqStatus === 'completed' &&
            item.stokFisikJumlah !== null &&
            item.stokFisikJumlah !== undefined
          ) {
            // `product` above was looked up unlocked (possibly by fuzzy
            // name match) purely to resolve WHICH product this line
            // refers to — setProductStock re-reads it under a lock and
            // computes the delta against that fresh value, so a
            // concurrent sale's atomic decrement landing between the
            // physical count being taken and this commit is preserved
            // (added under the count) instead of silently overwritten by
            // an absolute-set computed from a stale pre-count read.
            await setProductStock({
              productId: product.id,
              store: opname.store,
              newQty: Number(item.stokFisikJumlah) || 0,
              referenceType: 'opname',
              notes: `Stock opname: ${item.namaBarang} (${item.keterangan || ''})`,
              createdBy: req.user?.id || null,
              transaction: t
            })
          }

          if (
            ingredient &&
            reqStatus === 'completed' &&
            item.stokFisikJumlah !== null &&
            item.stokFisikJumlah !== undefined
          ) {
            // F-STOCK-2: locked re-read — oldStock below is current as of
            // this transaction's lock, so the absolute set cannot clobber
            // a concurrent mutation.
            ingredient = await lockIngredientRow(ingredient, t)
            if (!ingredient) {
              throw new Error(
                `Stock opname references ingredient #${item.ingredientName || item.namaBarang}, which no longer exists`
              )
            }
            const oldStock = Number(ingredient.stock) || 0
            const newStock = Number(item.stokFisikJumlah) || 0
            const diff = newStock - oldStock
            await ingredient.update({ stock: newStock }, { transaction: t })
            await db.stock_history.create(
              {
                ingredient: ingredient.id,
                ingredientName: ingredient.name,
                store: opname.store,
                referenceType: 'opname',
                quantityBefore: oldStock,
                quantityChange: diff,
                quantityAfter: newStock,
                unit: item.unit || item.satuan || ingredient.unit || 'pcs',
                notes: `Stock opname: ${ingredient.name} (${item.keterangan || ''})`,
                createdBy: req.user?.id || null
              },
              { transaction: t }
            )
          }
        }

        for (const item of created.items) {
          let minStock = Infinity
          if (item.product) {
            const p = await db.product.findByPk(item.product, {
              transaction: t
            })
            if (p) minStock = Number(p.minStock) || Infinity
          }
          if ((minStock === Infinity || minStock === 0) && item.namaBarang) {
            const p = await db.product.findOne({
              where: { nameProduct: { [Op.iLike]: item.namaBarang.trim() } },
              transaction: t
            })
            if (p) minStock = Number(p.minStock) || Infinity
          }
          if (
            (minStock === Infinity || minStock === 0) &&
            item.ingredientName
          ) {
            const ing = await db.ingredient.findOne({
              where: {
                name: { [Op.iLike]: item.ingredientName.trim() },
                store: effectiveStore
              },
              transaction: t
            })
            if (ing) minStock = Number(ing.minStock) || Infinity
          }
          if ((minStock === Infinity || minStock === 0) && item.namaBarang) {
            const ing = await db.ingredient.findOne({
              where: {
                name: { [Op.iLike]: item.namaBarang.trim() },
                store: effectiveStore
              },
              transaction: t
            })
            if (ing) minStock = Number(ing.minStock) || Infinity
          }
          const selisih = Number(item.selisihJumlah) || 0
          let note
          if (selisih !== 0) note = 'kurang'
          else if (
            minStock !== Infinity &&
            Number(item.stokFisikJumlah) <= minStock
          )
            note = 'menipis'
          else note = 'sesuai'
          await item.update({ notes: note }, { transaction: t })
        }

        const finalOpname = await db.stockOpname.findByPk(opname.id, {
          include: [{ model: db.stockOpnameItem, as: 'items' }],
          transaction: t
        })

        await t.commit()

        await createAudit(
          req,
          'create',
          'stock_opname',
          opname.id,
          'Created stock_opname: ' + opname.id
        )

        return res.status(201).json({
          success: true,
          message: 'Success create stock opname',
          data: finalOpname
        })
      } catch (err) {
        await t.rollback()
        throw err
      }
    } catch (error) {
      if (error instanceof InventoryLinkError) {
        return res.status(error.statusCode).json(inventoryLinkErrorBody(error))
      }
      console.error(error)
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
      const userRole = req.user?.roleType
      const { items, notes, date, auditDate, auditor } = req.body

      const whereClause = { id }
      if (store && userRole !== 'super_admin') {
        whereClause.store = store
      }

      const opname = await db.stockOpname.findOne({
        where: whereClause
      })

      if (!opname) {
        return res.status(404).json({
          success: false,
          message: 'Stock opname not found'
        })
      }

      if (opname.status !== 'draft') {
        return res.status(400).json({
          success: false,
          message: `Cannot update stock opname with status "${opname.status}". Only draft can be updated.`
        })
      }

      if (items) {
        try {
          validateOpnameItemQuantities(items)
        } catch (err) {
          return res.status(err.statusCode || 422).json({
            success: false,
            message: err.message
          })
        }

        await db.sequelize.transaction(async (t) => {
          await db.stockOpnameItem.destroy({
            where: { stockOpname: id },
            transaction: t
          })

          const opnameItems = items.map((item) => ({
            stockOpname: id,
            kodeBarang: item.kodeBarang || null,
            namaBarang: item.namaBarang || null,
            satuan: item.satuan || null,
            lokasiId: item.lokasiId || null,
            lokasi:
              item.lokasi !== null && item.lokasi !== undefined
                ? String(item.lokasi)
                : null,
            product: item.product || item.productId || null, // Accept both product and productId for FE compatibility
            ingredientName: item.ingredientName || null,
            systemStock:
              item.systemStock !== undefined
                ? item.systemStock
                : item.stokAkhirJumlah || 0,
            actualStock:
              item.actualStock !== undefined
                ? item.actualStock
                : item.stokFisikJumlah || 0,
            adjustment:
              item.adjustment !== undefined
                ? item.adjustment
                : item.selisihJumlah || 0,
            unit: item.unit || item.satuan || 'pcs',
            notes: item.notes || item.keterangan || null,
            stokAwalJumlah: item.stokAwalJumlah || 0,
            barangMasukJumlah: item.barangMasukJumlah || 0,
            barangKeluarJumlah: item.barangKeluarJumlah || 0,
            stokAkhirJumlah: item.stokAkhirJumlah || 0,
            stokFisikJumlah: item.stokFisikJumlah || 0,
            selisihJumlah: item.selisihJumlah || 0,
            keterangan: item.keterangan || null
          }))

          await db.stockOpnameItem.bulkCreate(opnameItems, { transaction: t })
        })
      }

      const allItems = await db.stockOpnameItem.findAll({
        where: { stockOpname: id }
      })

      const totalAdjustment = allItems.reduce((sum, item) => {
        // Phase 34: selisihJumlah is DECIMAL(10,4); Sequelize/pg returns it
        // as a string when re-fetched from the DB (allItems, unlike the
        // JSON-body items in create()/uploadExcel), so `sum + item.x`
        // would silently string-concatenate instead of add.
        return sum + (Number(item.selisihJumlah) || 0)
      }, 0)

      await opname.update({
        totalAdjustment,
        auditDate: auditDate !== undefined ? auditDate : opname.auditDate,
        auditor: auditor !== undefined ? auditor : opname.auditor,
        notes: notes !== undefined ? notes : opname.notes,
        date: date || opname.date
      })

      const updated = await db.stockOpname.findByPk(id, {
        include: [{ model: db.stockOpnameItem, as: 'items' }]
      })

      await createAudit(
        req,
        'update',
        'stock_opname',
        id,
        'Updated stock_opname: ' + id
      )

      return res.status(200).json({
        success: true,
        message: 'Success update stock opname',
        data: updated
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
      const store = resolveStoreId(req)
      const userRole = req.user?.roleType

      const whereClause = { id }
      if (store && userRole !== 'super_admin') {
        whereClause.store = store
      }

      const opname = await db.stockOpname.findOne({
        where: whereClause
      })

      if (!opname) {
        return res.status(404).json({
          success: false,
          message: 'Stock opname not found'
        })
      }

      if (opname.status !== 'draft') {
        return res.status(400).json({
          success: false,
          message: `Cannot delete stock opname with status "${opname.status}". Only draft can be deleted.`
        })
      }

      await db.stockOpnameItem.destroy({
        where: { stockOpname: id }
      })

      await opname.destroy()

      await createAudit(
        req,
        'delete',
        'stock_opname',
        id,
        'Deleted stock_opname: ' + id
      )

      return res.status(200).json({
        success: true,
        message: 'Success delete stock opname'
      })
    } catch (error) {
      console.error(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async changeStatus(req, res) {
    try {
      const { id } = req.params
      const { status } = req.body
      const store = resolveStoreId(req)
      const userRole = req.user?.roleType

      if (!['completed', 'cancelled'].includes(status)) {
        return res.status(400).json({
          success: false,
          message: 'Status must be "completed" or "cancelled"'
        })
      }

      const whereClause = { id }
      if (store && userRole !== 'super_admin') {
        whereClause.store = store
      }

      const opname = await db.stockOpname.findOne({ where: whereClause })

      if (!opname) {
        return res.status(404).json({
          success: false,
          message: 'Stock opname not found'
        })
      }

      if (opname.status !== 'draft') {
        return res.status(400).json({
          success: false,
          message: `Cannot change status from "${opname.status}". Only draft can be changed.`
        })
      }

      if (status === 'completed') {
        const t = await db.sequelize.transaction()
        try {
          // F-STOCK-2: lock the header and re-check the draft guard inside
          // the transaction — the outer read is stale, so two concurrent
          // completions could otherwise both apply the counted values.
          // Locked without includes (FOR UPDATE cannot span the LEFT
          // OUTER JOINs); items are re-fetched under the lock.
          const lockedHeader = await db.stockOpname.findByPk(id, {
            lock: t.LOCK.UPDATE,
            transaction: t
          })
          if (!lockedHeader) {
            await t.rollback()
            return res.status(404).json({
              success: false,
              message: 'Stock opname not found'
            })
          }
          if (lockedHeader.status !== 'draft') {
            await t.rollback()
            return res.status(400).json({
              success: false,
              message: `Cannot change status from "${lockedHeader.status}". Only draft can be changed.`
            })
          }
          const updated = await db.stockOpname.findByPk(id, {
            include: [{ model: db.stockOpnameItem, as: 'items' }],
            transaction: t
          })

          for (const item of updated.items) {
            let product = null
            let ingredient = null

            if (item.product) {
              product = await db.product.findByPk(item.product, {
                transaction: t
              })
            }

            if (!product && item.namaBarang) {
              product = await db.product.findOne({
                where: { nameProduct: { [Op.iLike]: item.namaBarang.trim() } },
                transaction: t
              })
            }

            if (product && !item.product) {
              await item.update({ product: product.id }, { transaction: t })
            }

            if (item.ingredientName) {
              ingredient = await db.ingredient.findOne({
                where: {
                  name: { [Op.iLike]: item.ingredientName.trim() },
                  store: opname.store
                },
                transaction: t
              })
            }

            if (!ingredient && !product && item.namaBarang) {
              ingredient = await db.ingredient.findOne({
                where: {
                  name: { [Op.iLike]: item.namaBarang.trim() },
                  store: opname.store
                },
                transaction: t
              })
            }

            if (ingredient && !item.ingredientName) {
              await item.update(
                { ingredientName: ingredient.name },
                { transaction: t }
              )
            }

            product = await linkedProductCount(product, ingredient, t)
            if (
              product &&
              item.stokFisikJumlah !== null &&
              item.stokFisikJumlah !== undefined
            ) {
              // See the equivalent block above (create/direct-completion
              // path) for why this re-reads under a lock instead of
              // trusting the unlocked `product` fetched above.
              await setProductStock({
                productId: product.id,
                store: opname.store,
                newQty: Number(item.stokFisikJumlah) || 0,
                referenceType: 'opname',
                notes: `Stock opname: ${item.namaBarang} (${item.keterangan || ''})`,
                createdBy: req.user?.id || null,
                transaction: t
              })
            }

            if (
              ingredient &&
              item.stokFisikJumlah !== null &&
              item.stokFisikJumlah !== undefined
            ) {
              // F-STOCK-2: locked re-read — see the create-path block.
              ingredient = await lockIngredientRow(ingredient, t)
              if (!ingredient) {
                throw new Error(
                  `Stock opname references ingredient #${item.ingredientName || item.namaBarang}, which no longer exists`
                )
              }
              const oldStock = Number(ingredient.stock) || 0
              const newStock = Number(item.stokFisikJumlah) || 0
              const diff = newStock - oldStock
              await ingredient.update({ stock: newStock }, { transaction: t })
              await db.stock_history.create(
                {
                  ingredient: ingredient.id,
                  ingredientName: ingredient.name,
                  store: opname.store,
                  referenceType: 'opname',
                  quantityBefore: oldStock,
                  quantityChange: diff,
                  quantityAfter: newStock,
                  unit: item.unit || item.satuan || ingredient.unit || 'pcs',
                  notes: `Stock opname: ${ingredient.name} (${item.keterangan || ''})`,
                  createdBy: req.user?.id || null
                },
                { transaction: t }
              )
            }
          }

          for (const item of updated.items) {
            let minStock = Infinity
            if (item.product) {
              const p = await db.product.findByPk(item.product, {
                transaction: t
              })
              if (p) minStock = Number(p.minStock) || Infinity
            }
            if ((minStock === Infinity || minStock === 0) && item.namaBarang) {
              const p = await db.product.findOne({
                where: { nameProduct: { [Op.iLike]: item.namaBarang.trim() } },
                transaction: t
              })
              if (p) minStock = Number(p.minStock) || Infinity
            }
            if (
              (minStock === Infinity || minStock === 0) &&
              item.ingredientName
            ) {
              const ing = await db.ingredient.findOne({
                where: {
                  name: { [Op.iLike]: item.ingredientName.trim() },
                  store: opname.store
                },
                transaction: t
              })
              if (ing) minStock = Number(ing.minStock) || Infinity
            }
            if ((minStock === Infinity || minStock === 0) && item.namaBarang) {
              const ing = await db.ingredient.findOne({
                where: {
                  name: { [Op.iLike]: item.namaBarang.trim() },
                  store: opname.store
                },
                transaction: t
              })
              if (ing) minStock = Number(ing.minStock) || Infinity
            }
            const selisih = Number(item.selisihJumlah) || 0
            let note
            if (selisih !== 0) note = 'kurang'
            else if (
              minStock !== Infinity &&
              Number(item.stokFisikJumlah) <= minStock
            )
              note = 'menipis'
            else note = 'sesuai'
            await item.update({ notes: note }, { transaction: t })
          }

          await opname.update(
            {
              status,
              modifiedBy: req.user?.id || null
            },
            { transaction: t }
          )

          await t.commit()

          await createAudit(
            req,
            'update',
            'stock_opname',
            id,
            'Updated stock_opname status to ' + status + ': ' + id
          )

          const updatedWithItems = await db.stockOpname.findByPk(id, {
            include: [{ model: db.stockOpnameItem, as: 'items' }]
          })

          return res.status(200).json({
            success: true,
            message: `Status changed to "${status}"`,
            data: updatedWithItems
          })
        } catch (err) {
          await t.rollback()
          throw err
        }
      }

      await opname.update({
        status,
        modifiedBy: req.user?.id || null
      })

      await createAudit(
        req,
        'update',
        'stock_opname',
        id,
        'Updated stock_opname status to ' + status + ': ' + id
      )

      const updated = await db.stockOpname.findByPk(id)
      return res.status(200).json({
        success: true,
        message: `Status changed to "${status}"`,
        data: updated
      })
    } catch (error) {
      if (error instanceof InventoryLinkError) {
        return res.status(error.statusCode).json(inventoryLinkErrorBody(error))
      }
      console.error(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async downloadExcel(req, res) {
    try {
      const store = resolveStoreId(req)
      const userRole = req.user?.roleType

      const locationWhere = { status: 'active' }
      if (store && userRole !== 'super_admin') {
        locationWhere.store = store
      }

      const locations = await db.location.findAll({
        where: locationWhere,
        attributes: ['id', 'name']
      })

      const workbook = new excelJS.Workbook()
      const worksheet = workbook.addWorksheet('Stock Opname')

      worksheet.columns = STOCK_OPNAME_EXCEL_HEADERS.map((h) => ({
        header: h.header,
        key: h.key,
        width: h.width
      }))

      const headerRow = worksheet.getRow(1)
      headerRow.font = { bold: true, color: { argb: 'FFFFFF' } }
      headerRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: '4472C4' }
      }
      headerRow.alignment = { horizontal: 'center', vertical: 'middle' }
      headerRow.height = 25

      headerRow.eachCell((cell) => {
        cell.protection = { locked: true }
      })

      const locationList = locations.map((l) => l.name).join(',')
      const maxRows = 100

      for (let row = 2; row <= maxRows; row++) {
        worksheet.getCell(`A${row}`).value = row - 1
        worksheet.getCell(`A${row}`).protection = { locked: true }

        const inputCols = ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'L']
        inputCols.forEach((col) => {
          worksheet.getCell(`${col}${row}`).protection = { locked: false }
        })

        const formulaStyle = {
          fill: {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF3F3F3' }
          }
        }

        worksheet.getCell(`I${row}`).value = {
          formula: `F${row}+G${row}-H${row}`
        }
        worksheet.getCell(`I${row}`).protection = { locked: true }
        // Phase 34: quantities are DECIMAL(10,4) — '#,##0' visually rounded
        // a fractional result to a whole number in the template.
        worksheet.getCell(`I${row}`).numFmt = '#,##0.####'
        worksheet.getCell(`I${row}`).fill = formulaStyle.fill

        worksheet.getCell(`K${row}`).value = { formula: `J${row}-I${row}` }
        worksheet.getCell(`K${row}`).protection = { locked: true }
        worksheet.getCell(`K${row}`).numFmt = '#,##0.####'
        worksheet.getCell(`K${row}`).fill = formulaStyle.fill

        if (locationList) {
          worksheet.getCell(`E${row}`).dataValidation = {
            type: 'list',
            allowBlank: true,
            formula1: [`"${locationList}"`],
            showDropDown: true
          }
        }
      }

      worksheet.protect('', {
        selectLockedCells: true,
        selectUnlockedCells: true,
        formatCells: false,
        formatColumns: false,
        formatRows: false,
        insertColumns: false,
        insertRows: false,
        insertHyperlinks: false,
        deleteColumns: false,
        deleteRows: false,
        sort: false,
        autoFilter: false,
        pivotTables: false
      })

      const buffer = await workbook.xlsx.writeBuffer()

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
      res.setHeader(
        'Content-Disposition',
        'attachment; filename=stock-opname-template.xlsx'
      )

      return res.send(buffer)
    } catch (error) {
      console.error(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async uploadExcel(req, res) {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: 'Tidak ada file yang diupload'
        })
      }

      const workbook = new excelJS.Workbook()
      await workbook.xlsx.load(req.file.buffer)

      const worksheet = workbook.getWorksheet('Stock Opname')
      if (!worksheet) {
        return res.status(400).json({
          success: false,
          message: 'Sheet "Stock Opname" tidak ditemukan'
        })
      }

      const headers = []
      worksheet.getRow(1).eachCell((cell) => {
        headers.push(cell.value ? cell.value.toString().trim() : '')
      })

      const EXPECTED = [
        'No.',
        'Kode Barang',
        'Nama Barang',
        'Satuan',
        'Lokasi',
        'Stok Awal',
        'Barang Masuk',
        'Barang Keluar',
        'Stok Akhir',
        'Stok Fisik',
        'Selisih',
        'Keterangan'
      ]

      const isValid = EXPECTED.every((h, i) => headers[i] === h)
      if (!isValid) {
        return res.status(400).json({
          success: false,
          message:
            'Header tidak valid. Pastikan menggunakan template yang benar'
        })
      }

      const items = []
      const errors = []
      const itemLokasiNames = new Set()

      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber < 2) return
        const v = row.values
        if (!v[3]) return

        const lokasi = v[5] ? String(v[5]).trim() : null
        if (lokasi) itemLokasiNames.add(lokasi)
      })

      // SO-01: was `req.cookies?.store || req.user?.store` — cookie-parser
      // is mounted and no route ever sets a `store` cookie server-side, so
      // it is entirely attacker-controlled. Checking it BEFORE the JWT
      // claim let a store-A admin attribute an uploaded stock_opname to any
      // other store by sending `Cookie: store=<foreign>`. resolveStoreId is
      // the same trusted helper already used by every other function in
      // this file (getById/create/update/delete/changeStatus/downloadExcel)
      // — non-super-admin always resolves to their own pinned store; a
      // cookie can only steer a super_admin's own already-unrestricted
      // store selection, never a tenant's.
      let effectiveStore = resolveStoreId(req)

      if (!effectiveStore && itemLokasiNames.size > 0) {
        const firstLokasi = [...itemLokasiNames][0]
        const location = await db.location.findOne({
          where: { name: firstLokasi }
        })
        if (location) effectiveStore = location.id
      }

      if (!effectiveStore) {
        const firstLocation = await db.location.findOne({
          where: { status: 'active' }
        })
        if (firstLocation) effectiveStore = firstLocation.id
      }

      if (!effectiveStore) {
        return res.status(400).json({
          success: false,
          message:
            'Tidak dapat menentukan store/lokasi. Pastikan lokasi sudah terdaftar.'
        })
      }

      const locationMap = {}
      const allLocations = await db.location.findAll({
        attributes: ['id', 'name']
      })
      allLocations.forEach((loc) => {
        locationMap[loc.name.toLowerCase().trim()] = loc.id
      })

      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber < 2) return
        const v = row.values
        if (!v[3]) return

        const kodeBarang = v[2] ? String(v[2]).trim() : null
        const namaBarang = v[3] ? String(v[3]).trim() : null
        const satuan = v[4] ? String(v[4]).trim() : null
        const lokasiName = v[5] ? String(v[5]).trim() : null
        const stokAwal = parseFloat(v[6]) || 0
        const barangMasuk = parseFloat(v[7]) || 0
        const barangKeluar = parseFloat(v[8]) || 0
        const stokAkhir = parseFloat(v[9])
        const stokAkhirVal = !isNaN(stokAkhir)
          ? stokAkhir
          : stokAwal + barangMasuk - barangKeluar
        const stokFisik = parseFloat(v[10]) || 0
        const selisih = parseFloat(v[11])
        const selisihVal = !isNaN(selisih) ? selisih : stokFisik - stokAkhirVal
        const keterangan = v[12] ? String(v[12]).trim() : null

        if (!namaBarang) {
          errors.push(`Baris ${rowNumber}: Nama barang wajib diisi`)
          return
        }

        const lokasiId = lokasiName
          ? locationMap[lokasiName.toLowerCase().trim()] || null
          : null

        items.push({
          kodeBarang,
          namaBarang,
          satuan: satuan || 'pcs',
          lokasiId,
          lokasi: lokasiName,
          stokAwalJumlah: stokAwal,
          barangMasukJumlah: barangMasuk,
          barangKeluarJumlah: barangKeluar,
          stokAkhirJumlah: stokAkhirVal,
          stokFisikJumlah: stokFisik,
          selisihJumlah: selisihVal,
          keterangan,
          systemStock: stokAkhirVal,
          actualStock: stokFisik,
          adjustment: selisihVal,
          unit: satuan || 'pcs',
          notes: keterangan
        })
      })

      if (errors.length > 0) {
        return res
          .status(400)
          .json({ success: false, message: 'Terdapat kesalahan', errors })
      }

      if (items.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Tidak ada data yang valid untuk diupload'
        })
      }

      const opnameNumber = generateOpnameNumber()
      const totalAdjustment = items.reduce((sum, i) => sum + i.selisihJumlah, 0)

      const result = await db.sequelize.transaction(async (t) => {
        const opname = await db.stockOpname.create(
          {
            store: effectiveStore,
            opnameNumber,
            date: req.body.date ? new Date(req.body.date) : new Date(),
            auditDate: req.body.auditDate || null,
            auditor:
              req.body.auditor || req.user?.userName || req.user?.id || null,
            totalAdjustment,
            status: 'draft',
            notes: req.body.notes || 'Upload dari Excel',
            createdBy: req.user?.id || null
          },
          { transaction: t }
        )

        const opnameItems = items.map((item) => ({
          stockOpname: opname.id,
          ...item
        }))

        await db.stockOpnameItem.bulkCreate(opnameItems, { transaction: t })

        return db.stockOpname.findByPk(opname.id, {
          include: [{ model: db.stockOpnameItem, as: 'items' }],
          transaction: t
        })
      })

      await createAudit(
        req,
        'import',
        'stock_opname',
        null,
        'Imported stock_opname from file'
      )

      return res.status(201).json({
        success: true,
        message: `Berhasil upload ${items.length} item stock opname`,
        data: result
      })
    } catch (error) {
      console.error(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async exportSelected(req, res) {
    try {
      const { ids } = req.body

      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'ids harus berupa array dan tidak boleh kosong'
        })
      }

      // N-4 (security): never trust the supplied ids alone as proof of tenant
      // ownership. The query is scoped so a non-super-admin can only ever load
      // rows belonging to their own store (req.storeId); foreign or
      // nonexistent rows are indistinguishable and excluded. Super_admin
      // retains global export.
      const opnames = await db.stockOpname.findAll({
        where: { id: { [Op.in]: ids }, ...scalarStoreScope(req) },
        include: [
          { model: db.stockOpnameItem, as: 'items' },
          { model: db.location, as: 'storeData', attributes: ['id', 'name'] }
        ],
        order: [['createdAt', 'ASC']]
      })

      if (opnames.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Stock opname tidak ditemukan'
        })
      }

      const workbook = new excelJS.Workbook()
      const worksheet = workbook.addWorksheet('Stock Opname')

      worksheet.columns = STOCK_OPNAME_EXCEL_HEADERS.map((h) => ({
        header: h.header,
        key: h.key,
        width: h.width
      }))

      const headerRow = worksheet.getRow(1)
      headerRow.font = { bold: true, color: { argb: 'FFFFFF' } }
      headerRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: '4472C4' }
      }
      headerRow.alignment = { horizontal: 'center', vertical: 'middle' }
      headerRow.height = 25

      let rowIndex = 2

      for (const opname of opnames) {
        const storeName = opname.storeData ? opname.storeData.name : '-'
        worksheet.mergeCells(`A${rowIndex}:L${rowIndex}`)
        const titleCell = worksheet.getCell(`A${rowIndex}`)
        titleCell.value = `${opname.opnameNumber} - ${storeName} (${opname.status})`
        titleCell.font = { bold: true, size: 12 }
        titleCell.alignment = { vertical: 'middle' }
        worksheet.getRow(rowIndex).height = 22
        rowIndex++

        worksheet.mergeCells(`A${rowIndex}:L${rowIndex}`)
        const dateCell = worksheet.getCell(`A${rowIndex}`)
        dateCell.value = `Audit: ${opname.auditDate || '-'} | Auditor: ${opname.auditor || '-'} | Notes: ${opname.notes || '-'}`
        dateCell.font = { italic: true, size: 10, color: { argb: '666666' } }
        worksheet.getRow(rowIndex).height = 18
        rowIndex++

        const items = opname.items || []
        for (let i = 0; i < items.length; i++) {
          const item = items[i]
          worksheet.getCell(`A${rowIndex}`).value = i + 1
          worksheet.getCell(`B${rowIndex}`).value = item.kodeBarang || ''
          worksheet.getCell(`C${rowIndex}`).value = item.namaBarang || ''
          worksheet.getCell(`D${rowIndex}`).value = item.satuan || ''
          worksheet.getCell(`E${rowIndex}`).value = item.lokasi || ''
          // Phase 34: these quantities are DECIMAL(10,4), returned as
          // strings by Sequelize/pg — Number() ensures ExcelJS stores a
          // real numeric cell value, not a text string.
          worksheet.getCell(`F${rowIndex}`).value =
            item.stokAwalJumlah != null ? Number(item.stokAwalJumlah) : 0
          worksheet.getCell(`G${rowIndex}`).value =
            item.barangMasukJumlah != null ? Number(item.barangMasukJumlah) : 0
          worksheet.getCell(`H${rowIndex}`).value =
            item.barangKeluarJumlah != null ? Number(item.barangKeluarJumlah) : 0
          worksheet.getCell(`I${rowIndex}`).value =
            item.stokAkhirJumlah != null ? Number(item.stokAkhirJumlah) : 0
          worksheet.getCell(`J${rowIndex}`).value =
            item.stokFisikJumlah != null ? Number(item.stokFisikJumlah) : 0
          worksheet.getCell(`K${rowIndex}`).value =
            item.selisihJumlah != null ? Number(item.selisihJumlah) : 0
          worksheet.getCell(`L${rowIndex}`).value = item.keterangan || ''
          rowIndex++
        }

        rowIndex++
      }

      worksheet.columns.forEach((col) => {
        col.width = col.width || 12
      })

      const buffer = await workbook.xlsx.writeBuffer()

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
      res.setHeader(
        'Content-Disposition',
        'attachment; filename=stock-opname-export-selected.xlsx'
      )

      return res.send(buffer)
    } catch (error) {
      console.error(error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async checkExists(req, res) {
    try {
      // SO-02: was `req.query.store || req.cookies?.store` — validateStoreAccess
      // validates req.query.store when present (rejecting a mismatched
      // explicit value for non-super-admin), but omitting the query param
      // entirely fell through to the raw, unvalidated cookie. resolveStoreId
      // is the trusted equivalent already used elsewhere in this file: for
      // non-super-admin it is always the caller's own pinned store,
      // regardless of what the client sends via query or cookie.
      const effectiveStore = resolveStoreId(req)

      if (!effectiveStore) {
        return res.status(400).json({
          success: false,
          message: 'store is required'
        })
      }

      const count = await db.stockOpname.count({
        where: {
          store: effectiveStore,
          status: 'completed'
        }
      })

      return res.status(200).json({
        success: true,
        data: {
          exists: count > 0,
          count
        }
      })
    } catch (error) {
      console.error('Error =>', error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  },

  async getCompositionItems(req, res) {
    try {
      // SO-03: same fix as checkExists (SO-02) — resolveStoreId replaces the
      // query-then-cookie fallback so an omitted query param can never fall
      // through to the unvalidated, attacker-controlled cookie.
      const effectiveStore = resolveStoreId(req)

      if (!effectiveStore) {
        return res.status(400).json({
          success: false,
          message: 'store is required'
        })
      }

      const opnames = await db.stockOpname.findAll({
        where: {
          store: effectiveStore,
          status: 'completed'
        },
        include: [{ model: db.stockOpnameItem, as: 'items' }],
        order: [['createdAt', 'DESC']]
      })

      const seen = new Set()
      const items = []
      for (const opname of opnames) {
        for (const item of opname.items || []) {
          const key = item.product || item.namaBarang || item.ingredientName
          if (key && !seen.has(key)) {
            seen.add(key)
            items.push({
              name: item.namaBarang || item.ingredientName,
              kodeBarang: item.kodeBarang,
              unit: item.satuan,
              product: item.product,
              stockOpnameItemId: item.id
            })
          }
        }
      }

      return res.status(200).json({
        success: true,
        data: items
      })
    } catch (error) {
      console.error('Error =>', error)
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      })
    }
  }
}

module.exports = stockOpnameController
