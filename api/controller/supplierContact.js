const db = require('../../db/models')
const { createAudit } = require('../../utils/auditLog')
const { tenantArrayStoreWhere, relatedStoreInclude } = require('../../utils/tenantScope')

module.exports = {
  async getAllBySupplier(req, res) {
    try {
      const { supplierId } = req.params
      // IDOR fix: was findByPk(supplierId) with no store filter.
      const supplier = await db.supplier.findOne({
        where: await tenantArrayStoreWhere(req, { id: supplierId }, { includeShared: true })
      })
      if (!supplier) {
        return res.status(404).json({ success: false, message: 'Supplier not found' })
      }

      const contacts = await db.supplier_contact.findAll({
        where: { supplier: supplierId },
        order: [['fullName', 'ASC']]
      })

      return res.status(200).json({ success: true, message: 'Success get contacts', data: contacts })
    } catch (error) {
      console.log(error)
      return res.status(500).json({ success: false, message: 'Internal server error' })
    }
  },

  async getById(req, res) {
    try {
      const { id } = req.params
      // IDOR fix: supplier_contact has no store column of its own —
      // ownership is via supplier.store, enforced by the inner-join include.
      const contact = await db.supplier_contact.findOne({
        where: { id },
        include: [relatedStoreInclude(req, { model: db.supplier, as: 'supplierData', parentShape: 'supplier' })]
      })
      if (!contact) {
        return res.status(404).json({ success: false, message: 'Contact not found' })
      }

      return res.status(200).json({ success: true, message: 'Success get contact', data: contact })
    } catch (error) {
      console.log(error)
      return res.status(500).json({ success: false, message: 'Internal server error' })
    }
  },

  async create(req, res) {
    try {
      const { supplierId } = req.params
      const { fullName, position, email, phone } = req.body

      // Same IDOR fix as getAllBySupplier.
      const supplier = await db.supplier.findOne({
        where: await tenantArrayStoreWhere(req, { id: supplierId }, { includeShared: true })
      })
      if (!supplier) {
        return res.status(404).json({ success: false, message: 'Supplier not found' })
      }

      const trimmedName = String(fullName || '').trim()
      if (!trimmedName) {
        return res.status(400).json({ success: false, message: 'Contact name is required' })
      }

      const contact = await db.supplier_contact.create({
        supplier: supplierId,
        fullName: trimmedName,
        position: position?.trim() || null,
        email: email?.trim() || null,
        phone: phone?.trim() || null
      })

      createAudit(req, 'create', 'supplier_contact', contact.id, `Created contact for supplier: ${supplierId}`)

      return res.status(201).json({ success: true, message: 'Success create contact', data: contact })
    } catch (error) {
      console.log(error)
      return res.status(500).json({ success: false, message: 'Internal server error' })
    }
  },

  async update(req, res) {
    try {
      const { id } = req.params
      const { fullName, position, email, phone } = req.body

      // Same IDOR fix as getById.
      const contact = await db.supplier_contact.findOne({
        where: { id },
        include: [relatedStoreInclude(req, { model: db.supplier, as: 'supplierData', parentShape: 'supplier' })]
      })
      if (!contact) {
        return res.status(404).json({ success: false, message: 'Contact not found' })
      }

      const trimmedName = fullName?.trim()
      if (trimmedName !== undefined && !trimmedName) {
        return res.status(400).json({ success: false, message: 'Contact name is required' })
      }

      await contact.update({
        fullName: trimmedName ?? contact.fullName,
        position: position !== undefined ? position?.trim() || null : contact.position,
        email: email !== undefined ? email?.trim() || null : contact.email,
        phone: phone !== undefined ? phone?.trim() || null : contact.phone
      })

      createAudit(req, 'update', 'supplier_contact', id, `Updated contact: ${id}`)

      return res.status(200).json({ success: true, message: 'Success update contact', data: contact })
    } catch (error) {
      console.log(error)
      return res.status(500).json({ success: false, message: 'Internal server error' })
    }
  },

  async delete(req, res) {
    try {
      const { id } = req.params
      // Same IDOR fix as getById.
      const contact = await db.supplier_contact.findOne({
        where: { id },
        include: [relatedStoreInclude(req, { model: db.supplier, as: 'supplierData', parentShape: 'supplier' })]
      })
      if (!contact) {
        return res.status(404).json({ success: false, message: 'Contact not found' })
      }

      await contact.destroy()
      createAudit(req, 'delete', 'supplier_contact', id, `Deleted contact: ${id}`)

      return res.status(200).json({ success: true, message: 'Success delete contact' })
    } catch (error) {
      console.log(error)
      return res.status(500).json({ success: false, message: 'Internal server error' })
    }
  }
}
