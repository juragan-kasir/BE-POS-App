const db = require('../../db/models')
const { Op } = require('sequelize')
const { createAudit } = require('../../utils/auditLog')
const { enrichAuditFields } = require('../../utils/auditFields')
const { visibleWhere, canWrite, storeForNew } = require('../../utils/ownedOrSharedScope')
const { callerStoreIds, nullableArrayStoresWhere } = require('../../utils/tenantScope')

// Wave 4 (owner decision 2026-11-05): supplier categories are per tenant.
// Own outlets' categories + shared (store null) ones are readable; only own
// ones are writable. A name only has to be unique among what the caller sees.
const notFound = (res) =>
  res.status(404).json({ success: false, message: 'Supplier category not found' })
const sharedReadOnly = (res) =>
  res.status(403).json({
    success: false,
    code: 'SHARED_CATEGORY_READ_ONLY',
    message: 'Kategori bawaan bersama hanya bisa diubah oleh super admin pusat. Buat kategori untuk toko Anda sendiri.'
  })

module.exports = {
  async getAll(req, res) {
    try {
      const { search, status, page = 1, limit = 50 } = req.query
      const where = {}

      if (search) {
        where.name = { [Op.iLike]: `%${String(search).trim()}%` }
      }
      if (status !== undefined) {
        where.status = status === true || status === 'true' ? 'active' : 'inactive'
      }

      const offset = (parseInt(page) - 1) * parseInt(limit)
      const [data, total] = await Promise.all([
        db.supplier_category.findAll({
          where: await visibleWhere(req, where),
          order: [['name', 'ASC']],
          limit: parseInt(limit),
          offset
        }),
        db.supplier_category.count({ where: await visibleWhere(req, where) })
      ])

      await enrichAuditFields(db, data)

      return res.status(200).json({
        success: true,
        message: 'Success get supplier categories',
        data,
        stats: { total }
      })
    } catch (error) {
      console.log(error)
      return res.status(500).json({ success: false, message: 'Internal server error' })
    }
  },

  async getById(req, res) {
    try {
      const { id } = req.params
      const category = await db.supplier_category.findOne({ where: await visibleWhere(req, { id }) })
      if (!category) return notFound(res)

      // ponytail: sertakan supplier yang termasuk kategori ini — only the
      // caller's suppliers (a shared category is used by every tenant).
      const storeIds = await callerStoreIds(req)
      const suppliers = await db.supplier.findAll({
        where: storeIds === null ? { categoryId: id } : { categoryId: id, ...nullableArrayStoresWhere(storeIds) },
        attributes: ['id', 'name', 'status', 'phone', 'email', 'contactPerson'],
        order: [['name', 'ASC']]
      })

      await enrichAuditFields(db, [category])

      return res.status(200).json({
        success: true,
        message: 'Success get supplier category',
        data: {
          ...category.toJSON(),
          suppliers,
          supplierCount: suppliers.length
        }
      })
    } catch (error) {
      console.log(error)
      return res.status(500).json({ success: false, message: 'Internal server error' })
    }
  },

  async create(req, res) {
    try {
      const { name, description, status } = req.body
      const trimmedName = String(name || '').trim()
      if (!trimmedName) {
        return res.status(400).json({ success: false, message: 'Category name is required' })
      }

      const scope = await storeForNew(req)
      if (scope.error) {
        return res.status(403).json({ success: false, message: 'Anda hanya dapat mengakses data di toko Anda' })
      }

      const existing = await db.supplier_category.findOne({
        where: await visibleWhere(req, { name: { [Op.iLike]: trimmedName } }),
        paranoid: false
      })
      if (existing) {
        return res.status(409).json({ success: false, message: 'Category name already exists' })
      }

      const category = await db.supplier_category.create({
        store: scope.store,
        name: trimmedName,
        description: description?.trim() || null,
        status: status || 'active'
      })

      createAudit(req, 'create', 'supplier_category', category.id, `Created supplier category: ${trimmedName}`)

      return res.status(201).json({ success: true, message: 'Success create supplier category', data: category })
    } catch (error) {
      console.log(error)
      return res.status(500).json({ success: false, message: 'Internal server error' })
    }
  },

  async update(req, res) {
    try {
      const { id } = req.params
      const { name, description, status } = req.body

      const category = await db.supplier_category.findOne({ where: await visibleWhere(req, { id }) })
      if (!category) return notFound(res)
      if (!(await canWrite(req, category))) return sharedReadOnly(res)

      const trimmedName = name?.trim()
      if (trimmedName) {
        const existing = await db.supplier_category.findOne({
          where: await visibleWhere(req, { id: { [Op.ne]: id }, name: { [Op.iLike]: trimmedName } }),
          paranoid: false
        })
        if (existing) {
          return res.status(409).json({ success: false, message: 'Category name already exists' })
        }
      }

      await category.update({
        name: trimmedName ?? category.name,
        description: description !== undefined ? description?.trim() || null : category.description,
        status: status !== undefined ? status : category.status
      })

      createAudit(req, 'update', 'supplier_category', id, `Updated supplier category: ${id}`)

      return res.status(200).json({ success: true, message: 'Success update supplier category', data: category })
    } catch (error) {
      console.log(error)
      return res.status(500).json({ success: false, message: 'Internal server error' })
    }
  },

  async delete(req, res) {
    try {
      const { id } = req.params
      const category = await db.supplier_category.findOne({ where: await visibleWhere(req, { id }) })
      if (!category) return notFound(res)
      if (!(await canWrite(req, category))) return sharedReadOnly(res)

      const supplierCount = await db.supplier.count({ where: { categoryId: id } })
      if (supplierCount > 0) {
        return res.status(400).json({
          success: false,
          message: `Cannot delete category: ${supplierCount} supplier(s) still assigned to this category`
        })
      }

      await category.destroy()
      createAudit(req, 'delete', 'supplier_category', id, `Deleted supplier category: ${id}`)

      return res.status(200).json({ success: true, message: 'Success delete supplier category' })
    } catch (error) {
      console.log(error)
      return res.status(500).json({ success: false, message: 'Internal server error' })
    }
  }
}
