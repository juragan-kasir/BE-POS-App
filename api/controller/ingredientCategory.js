const db = require('../../db/models')
const { Op } = require('sequelize')
const { createAudit } = require('../../utils/auditLog')
const { enrichAuditFields } = require('../../utils/auditFields')
const ExcelJS = require('exceljs')

const { visibleWhere, canWrite, storeForNew } = require('../../utils/ownedOrSharedScope')

// Wave 4 (owner decision 2026-11-05): ingredient categories are per tenant,
// the same as ingredients themselves. A caller reads its own outlets' rows
// plus the shared ones (store null) and changes only its own; a global
// super admin also changes the shared ones. Ingredient reads use the same
// rule — it used to return every tenant's ingredients to any super_admin,
// store-bound owners included.
const sharedReadOnly = (res) =>
  res.status(403).json({
    success: false,
    code: 'SHARED_CATEGORY_READ_ONLY',
    message:
      'Kategori bawaan bersama hanya bisa diubah oleh super admin pusat. Buat kategori untuk toko Anda sendiri.'
  })
const outsideStore = (res) =>
  res.status(403).json({ success: false, message: 'Anda hanya dapat mengakses data di toko Anda' })

const ingredientCategoryController = {
  async getAll(req, res) {
    try {
      const { search, status, page = 1, limit = 10, supplier } = req.query

      const where = {}
      if (search) {
        where.name = { [Op.iLike]: `%${search}%` }
      }
      if (status && status !== 'all') {
        where.status = status
      }

      let supplierFilteredIds = null
      if (supplier) {
        const usedCategories = await db.ingredient.findAll({
          where: await visibleWhere(req, { supplier: Number(supplier) }),
          attributes: ['category'],
          group: ['category']
        })
        supplierFilteredIds = usedCategories
          .map((r) => r.category)
          .filter(Boolean)
      }

      const offset = (page - 1) * limit

      const categoryWhere = await visibleWhere(req, { ...where })
      if (supplierFilteredIds !== null) {
        if (supplierFilteredIds.length > 0) {
          categoryWhere.id = { [Op.in]: supplierFilteredIds }
        } else {
          categoryWhere.id = { [Op.in]: [0] }
        }
      }

      const [categories, total] = await Promise.all([
        db.ingredientCategory.findAll({
          where: categoryWhere,
          limit: parseInt(limit),
          offset: parseInt(offset),
          order: [['updatedAt', 'DESC']]
        }),
        db.ingredientCategory.count({ where: categoryWhere })
      ])
      await enrichAuditFields(db, categories)

      const totalPages = Math.ceil(total / limit)

      const active = await db.ingredientCategory.count({
        where: { ...categoryWhere, status: 'active' }
      })
      const draft = await db.ingredientCategory.count({
        where: { ...categoryWhere, status: 'draft' }
      })
      const inactive = await db.ingredientCategory.count({
        where: { ...categoryWhere, status: 'inactive' }
      })

      return res.status(200).json({
        success: true,
        message: 'Success get ingredient categories',
        data: categories,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages
        },
        stats: { total, active, draft, inactive }
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

      const category = await db.ingredientCategory.findOne({ where: await visibleWhere(req, { id }) })

      if (!category) {
        return res.status(404).json({
          success: false,
          message: 'Ingredient category not found'
        })
      }

      // ponytail: sertakan bahan baku yang termasuk kategori ini
      const ingredients = await db.ingredient.findAll({
        where: await visibleWhere(req, { category: id }),
        attributes: ['id', 'name', 'stock', 'minStock', 'unit', 'status', 'costPrice'],
        order: [['updatedAt', 'DESC']]
      })

      return res.status(200).json({
        success: true,
        message: 'Success get ingredient category',
        data: {
          ...category.toJSON(),
          ingredients,
          ingredientCount: ingredients.length
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

  async create(req, res) {
    try {
      const { name, status } = req.body
      const createdBy = req.user?.id || null

      if (!name) {
        return res.status(400).json({
          success: false,
          message: 'Name is required'
        })
      }

      const scope = await storeForNew(req)
      if (scope.error) return outsideStore(res)

      const existing = await db.ingredientCategory.findOne({
        where: await visibleWhere(req, { name: { [Op.iLike]: name.trim() } })
      })
      if (existing) {
        return res.status(400).json({
          success: false,
          message: 'Kategori dengan nama tersebut sudah ada'
        })
      }

      const category = await db.ingredientCategory.create({
        store: scope.store,
        name: name.trim(),
        status: ['active', 'inactive', 'draft'].includes(status)
          ? status
          : 'active',
        createdBy
      })

      createAudit(
        req,
        'create',
        'ingredientCategory',
        category.id,
        'Created ingredient category: ' + name
      )

      return res.status(201).json({
        success: true,
        message: 'Success create ingredient category',
        data: category
      })
    } catch (error) {
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
      const { name, status } = req.body
      const modifiedBy = req.user?.id || null

      const category = await db.ingredientCategory.findOne({ where: await visibleWhere(req, { id }) })

      if (!category) {
        return res.status(404).json({
          success: false,
          message: 'Ingredient category not found'
        })
      }
      if (!(await canWrite(req, category))) return sharedReadOnly(res)

      if (name && name.trim().toLowerCase() !== category.name.toLowerCase()) {
        const existing = await db.ingredientCategory.findOne({
          where: await visibleWhere(req, { name: { [Op.iLike]: name.trim() }, id: { [Op.ne]: id } })
        })
        if (existing) {
          return res.status(400).json({
            success: false,
            message: 'Kategori dengan nama tersebut sudah ada'
          })
        }
      }

      await category.update({
        name: name ? name.trim() : category.name,
        status:
          status !== undefined
            ? status === true
              ? 'active'
              : status === false
                ? 'inactive'
                : status
            : category.status,
        modifiedBy
      })

      createAudit(
        req,
        'update',
        'ingredientCategory',
        id,
        'Updated ingredient category: ' + id
      )

      return res.status(200).json({
        success: true,
        message: 'Success update ingredient category',
        data: category
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

      const category = await db.ingredientCategory.findOne({ where: await visibleWhere(req, { id }) })

      if (!category) {
        return res.status(404).json({
          success: false,
          message: 'Ingredient category not found'
        })
      }
      if (!(await canWrite(req, category))) return sharedReadOnly(res)

      await category.destroy()
      createAudit(
        req,
        'delete',
        'ingredientCategory',
        id,
        'Deleted ingredient category: ' + id
      )

      return res.status(200).json({
        success: true,
        message: 'Success delete ingredient category'
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
      const categories = await db.ingredientCategory.findAll({
        where: await visibleWhere(req, {}),
        order: [['createdAt', 'ASC']]
      })

      const workbook = new ExcelJS.Workbook()
      const worksheet = workbook.addWorksheet('Kategori Bahan Baku')

      worksheet.columns = [
        { header: 'No', key: 'no', width: 8 },
        { header: 'Name', key: 'name', width: 25 },
        { header: 'Status', key: 'status', width: 15 }
      ]

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

      let rowIndex = 2
      categories.forEach((cat) => {
        const no = rowIndex - 1
        worksheet.getCell(`A${rowIndex}`).value = no
        worksheet.getCell(`A${rowIndex}`).protection = { locked: true }
        worksheet.getCell(`A${rowIndex}`).alignment = { horizontal: 'center' }

        worksheet.getCell(`B${rowIndex}`).value = cat.name
        worksheet.getCell(`B${rowIndex}`).protection = { locked: false }

        worksheet.getCell(`C${rowIndex}`).value =
          cat.status === 'active'
            ? 'Active'
            : cat.status === 'draft'
              ? 'Draft'
              : 'Non-Active'
        worksheet.getCell(`C${rowIndex}`).protection = { locked: false }
        worksheet.getCell(`C${rowIndex}`).dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: ['"Active,Non-Active,Draft"']
        }

        rowIndex++
      })

      const maxRows = Math.max(rowIndex + 50, 100)
      for (let row = rowIndex; row <= maxRows; row++) {
        worksheet.getCell(`A${row}`).value = row - 1
        worksheet.getCell(`A${row}`).protection = { locked: true }
        worksheet.getCell(`A${row}`).alignment = { horizontal: 'center' }
        ;['B', 'C'].forEach((col) => {
          worksheet.getCell(`${col}${row}`).protection = { locked: false }
        })

        worksheet.getCell(`C${row}`).dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: ['"Active,Non-Active,Draft"']
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
        'attachment; filename=ingredient-category-template.xlsx'
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
      const categories = await db.ingredientCategory.findAll({
        where: await visibleWhere(req, {}),
        order: [['createdAt', 'ASC']]
      })

      const workbook = new ExcelJS.Workbook()
      const worksheet = workbook.addWorksheet('Kategori Bahan Baku')

      worksheet.columns = [
        { header: 'ID', key: 'id', width: 8 },
        { header: 'Name', key: 'name', width: 25 },
        { header: 'Status', key: 'status', width: 15 },
        { header: 'Created At', key: 'createdAt', width: 20 }
      ]

      const headerRow = worksheet.getRow(1)
      headerRow.font = { bold: true, color: { argb: 'FFFFFF' } }
      headerRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: '4472C4' }
      }
      headerRow.alignment = { horizontal: 'center', vertical: 'middle' }
      headerRow.height = 25

      categories.forEach((c) => {
        worksheet.addRow({
          id: c.id,
          name: c.name,
          status:
            c.status === 'active'
              ? 'Active'
              : c.status === 'draft'
                ? 'Draft'
                : 'Non-Active',
          createdAt: c.createdAt ? c.createdAt.toISOString() : ''
        })
      })

      const buffer = await workbook.xlsx.writeBuffer()

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
      res.setHeader(
        'Content-Disposition',
        'attachment; filename=ingredient-categories.xlsx'
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

      const toCreate = []
      const errors = []

      worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return

        try {
          const values = row.values
          const name = values[2]

          if (!name) return

          const statusRaw = values[3] || 'Active'

          toCreate.push({
            name: name.trim(),
            status: (() => {
              const s = statusRaw.toString().toLowerCase()
              return s === 'draft'
                ? 'draft'
                : s === 'inactive' || s === 'non-active'
                  ? 'inactive'
                  : 'active'
            })(),
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

      const scope = await storeForNew(req)
      if (scope.error) return outsideStore(res)
      const created = []
      const skipped = []
      for (const item of toCreate) {
        const existing = await db.ingredientCategory.findOne({
          where: await visibleWhere(req, { name: item.name })
        })
        if (existing) {
          skipped.push(item.name)
          continue
        }
        const cat = await db.ingredientCategory.create({ ...item, store: scope.store })
        created.push(cat)
      }

      createAudit(
        req,
        'create',
        'ingredientCategory',
        null,
        `Imported ${created.length} ingredient categories, skipped ${skipped.length}`
      )

      return res.status(201).json({
        success: true,
        message: `Successfully imported ${created.length} from ${toCreate.length} ingredient categories`,
        data: {
          total: toCreate.length,
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
  }
}

module.exports = ingredientCategoryController
