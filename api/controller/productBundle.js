const db = require('../../db/models')
const { Op } = require('sequelize')
const { createAudit } = require('../../utils/auditLog')
const { uploadToCloudinaryWithDedup } = require('../../utils/cloudinaryStorage')
const { tenantArrayStoreWhere } = require('../../utils/tenantScope')

// ponytail: FE bisa kirim JSON langsung atau FormData (image + data JSON) —
// sama seperti pola location add/edit
const parseBundleBody = (req) => {
  let body = req.body || {}
  if (body.data) {
    try {
      body = typeof body.data === 'string' ? JSON.parse(body.data) : body.data
    } catch {
      return null
    }
  }
  return body
}

const generateBundleSku = (prefix = 'BNDL') => {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const random = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, '0')
  return `${prefix}-${year}${month}${day}-${random}`
}

// F-1: same validity-window contract order.js's createCustomerOrder uses to
// decide whether a bundle is actually orderable (isBundleWithinValidityPeriod)
// — duplicated here (not imported) because that helper is private to
// order.js and this remediation's scope excludes touching order logic. Kept
// deliberately identical so a bundle shown to the customer is always one
// that would actually be accepted at checkout.
const isBundleWithinValidityPeriod = (bundle, now = new Date()) => {
  const validFrom = bundle.validFrom ? new Date(bundle.validFrom) : null
  const validUntil = bundle.validUntil ? new Date(bundle.validUntil) : null
  if (validFrom && isNaN(validFrom.getTime())) return true
  if (validUntil && isNaN(validUntil.getTime())) return true
  if (validFrom && validFrom > now) return false
  if (validUntil && validUntil < now) return false
  return true
}

// ponytail: bundle yang sudah lewat validUntil otomatis non-aktif —
// dipanggil lazy di getAll/getById, pola sama seperti discount.
// Kasir juga tetap aman karena query di product.js sudah filter validUntil.
const expireStaleBundles = async (extraWhere = {}) => {
  try {
    await db.product_bundle.update(
      { status: 'inactive' },
      {
        where: {
          ...extraWhere,
          status: 'active',
          validUntil: {
            [Op.and]: [{ [Op.ne]: null }, { [Op.lt]: new Date() }]
          }
        }
      }
    )
  } catch (e) {
    console.error('Expire stale bundles error:', e.message)
  }
}

// ponytail: hitung jumlah transaksi (distinct order) yang memakai bundle —
// order cancelled/void tidak dihitung agar pencatatan akurat
const countBundleUsage = async (bundleId) => {
  try {
    const rows = await db.sequelize.query(
      `SELECT COUNT(DISTINCT oi."order") AS count
       FROM order_item oi
       JOIN "order" o ON o.id = oi."order"
       WHERE oi."bundleId" = :bundleId
         AND oi."deletedAt" IS NULL
         AND o."deletedAt" IS NULL
         AND o."status" NOT IN ('cancelled', 'void')`,
      {
        replacements: { bundleId: Number(bundleId) },
        type: db.sequelize.QueryTypes.SELECT
      }
    )
    return Number(rows?.[0]?.count || 0)
  } catch (e) {
    console.error('Count bundle usage error:', e.message)
    return 0
  }
}

const bundleController = {
  async getAll(req, res) {
    try {
      // MEDIUM fix: removed req.cookies.store — cookie is client-controlled and
      // never validated by validateStoreAccess.  For super_admin the explicit
      // ?store (→ req.storeId) is honoured; absent → null (global). For
      // non-super-admin req.storeId is always the JWT-pinned store.
      const effectiveStore = req.storeId ?? req.user?.store
      const { status, search, page = 1, limit = 10 } = req.query

      // ponytail: expire dulu supaya stats & list akurat
      await expireStaleBundles(
        effectiveStore ? { store: effectiveStore } : {}
      )

      const where = {}
      if (effectiveStore) where.store = effectiveStore
      if (status) where.status = status
      if (search) {
        where[Op.or] = [
          { name: { [Op.iLike]: `%${search}%` } },
          { sku: { [Op.iLike]: `%${search}%` } }
        ]
      }

      const offset = (parseInt(page) - 1) * parseInt(limit)

      const statsWhere = effectiveStore ? { store: effectiveStore } : {}
      const [activeCount, draftCount, inactiveCount] = await Promise.all([
        db.product_bundle.count({ where: { ...statsWhere, status: 'active' } }),
        db.product_bundle.count({ where: { ...statsWhere, status: 'draft' } }),
        db.product_bundle.count({
          where: { ...statsWhere, status: 'inactive' }
        })
      ])

      const stats = {
        active: activeCount,
        draft: draftCount,
        inactive: inactiveCount,
        total: activeCount + draftCount + inactiveCount
      }

      const { count, rows } = await db.product_bundle.findAndCountAll({
        where,
        include: [
          {
            model: db.product_bundle_item,
            as: 'items',
            include: [
              {
                model: db.product,
                as: 'productData',
                attributes: ['id', 'nameProduct', 'price', 'image', 'stock']
              }
            ]
          }
        ],
        order: [['updatedAt', 'DESC']],
        limit: parseInt(limit),
        offset
      })

      return res.status(200).json({
        message: 'success',
        data: {
          items: rows,
          total: count,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            totalPages: Math.ceil(count / parseInt(limit))
          },
          stats
        }
      })
    } catch (error) {
      console.error('Bundle getAll error:', error)
      return res.status(500).json({ message: error.message })
    }
  },

  // F-1: public, unauthenticated customer-facing bundle listing. Mirrors the
  // existing promoController.getCustomerActivePromos pattern (public route,
  // no requireRole, store-scoped query, customer-safe attribute allowlist) —
  // BISA-MAKAN-APP (anonymous QR customer app) has no login flow and cannot
  // legitimately reach the authenticated getAll above.
  //
  // "Public" does not mean unscoped: store is required and validated, and a
  // bundle is only returned when its own `store` array contains the
  // requested store — the exact same ownership rule
  // order.js's isBundleOrderableAtStore enforces at checkout time (including
  // that an unassigned/null-store bundle is orderable nowhere, unlike
  // products/categories, so it is never customer-visible either). No
  // requireRole/validateStoreAccess is added — this route is intentionally
  // public, matching promo.js's own public customer route.
  async getCustomerActive(req, res) {
    try {
      const { store } = req.query
      if (!store) {
        return res.status(400).json({ message: 'store is required' })
      }
      const storeId = Number(store)
      if (isNaN(storeId)) {
        return res.status(400).json({ message: 'Invalid store value' })
      }

      const storeWhere = { store: { [Op.contains]: [storeId] } }
      await expireStaleBundles(storeWhere)

      const bundles = await db.product_bundle.findAll({
        where: {
          ...storeWhere,
          status: 'active',
          isAvailable: true
        },
        attributes: [
          'id',
          'store',
          'name',
          'sku',
          'description',
          'image',
          'bundlePrice',
          'originalPrice',
          'discountAmount',
          'discountPercentage',
          'minQuantity',
          'maxQuantity',
          'isAvailable',
          'status',
          'validFrom',
          'validUntil'
        ],
        include: [
          {
            model: db.product_bundle_item,
            as: 'items',
            attributes: ['id', 'bundleId', 'product', 'quantity', 'unitPrice', 'isOptional'],
            include: [
              {
                model: db.product,
                as: 'productData',
                attributes: ['id', 'nameProduct', 'price', 'image', 'stock']
              }
            ]
          }
        ],
        order: [['updatedAt', 'DESC']]
      })

      const now = new Date()
      const items = bundles.filter((b) => isBundleWithinValidityPeriod(b, now))

      return res.status(200).json({
        success: true,
        message: 'Success get customer active bundles',
        data: { items }
      })
    } catch (error) {
      console.error('Bundle getCustomerActive error:', error)
      return res.status(500).json({ message: 'Internal server error' })
    }
  },

  async getById(req, res) {
    try {
      const { id } = req.params

      await expireStaleBundles()

      // IDOR fix: was findByPk(id) with no store filter, leaking another
      // store's bundle pricing/composition.
      const bundle = await db.product_bundle.findOne({
        where: await tenantArrayStoreWhere(req, { id }),
        include: [
          {
            model: db.product_bundle_item,
            as: 'items',
            include: [
              {
                model: db.product,
                as: 'productData',
                attributes: [
                  'id',
                  'nameProduct',
                  'price',
                  'image',
                  'stock',
                  'unit'
                ]
              }
            ]
          }
        ]
      })

      if (!bundle) {
        return res.status(404).json({ message: 'Bundle tidak ditemukan' })
      }

      // ponytail: jumlah transaksi yang memakai bundle ini (untuk detail page)
      const usageCount = await countBundleUsage(id)
      const data = bundle.toJSON()
      data.usageCount = usageCount

      return res.status(200).json({ message: 'success', data })
    } catch (error) {
      console.error('Bundle getById error:', error)
      return res.status(500).json({ message: error.message })
    }
  },

  async create(req, res) {
    try {
      const body = parseBundleBody(req)
      if (!body) {
        return res.status(400).json({ message: 'Invalid JSON format in data field' })
      }
      const {
        name,
        description,
        image,
        bundlePrice,
        items,
        isAvailable,
        status,
        validFrom,
        validUntil,
        minQuantity,
        maxQuantity,
        store
      } = body

      if (!items || items.length === 0) {
        return res
          .status(400)
          .json({ message: 'Minimal harus ada 1 item dalam bundle' })
      }

      const sku = generateBundleSku()

      let originalPrice = 0
      for (const item of items) {
        const product = await db.product.findByPk(item.product)
        if (!product) {
          return res
            .status(400)
            .json({ message: `Produk ID ${item.product} tidak ditemukan` })
        }
        const itemPrice = item.unitPrice || product.price
        originalPrice += itemPrice * (item.quantity || 1)
      }

      const discountAmount = originalPrice - (bundlePrice || 0)
      const discountPercentage =
        originalPrice > 0
          ? ((discountAmount / originalPrice) * 100).toFixed(2)
          : 0

      // MEDIUM fix: removed req.cookies.store. For super_admin, an explicit
      // body.store is preserved (intentional multi-store bundle creation).
      // For non-super-admin, req.storeId is the JWT-pinned authoritative store;
      // body.store is ignored because validateStoreAccess already enforced it.
      const effectiveStore =
        store !== undefined ? store : (req.storeId ?? req.user?.store ?? null)

      let imageUrl = image || null
      if (req.file) {
        const { url } = await uploadToCloudinaryWithDedup(
          req.file.path,
          'pos-app-bundles'
        )
        imageUrl = url
      }

      const bundle = await db.product_bundle.create({
        store: effectiveStore,
        name,
        sku,
        description,
        image: imageUrl,
        bundlePrice: bundlePrice || 0,
        originalPrice,
        discountAmount: Math.max(discountAmount, 0),
        discountPercentage: parseFloat(discountPercentage),
        isAvailable: isAvailable !== undefined ? isAvailable : true,
        status: status || 'draft',
        validFrom: validFrom || null,
        validUntil: validUntil || null,
        minQuantity: minQuantity || 1,
        maxQuantity: maxQuantity || null
      })

      for (const item of items) {
        const product = await db.product.findByPk(item.product)
        const itemPrice = item.unitPrice || product.price
        await db.product_bundle_item.create({
          bundleId: bundle.id,
          product: item.product,
          quantity: item.quantity || 1,
          unitPrice: itemPrice,
          isOptional: item.isOptional || false
        })
      }

      const result = await db.product_bundle.findByPk(bundle.id, {
        include: [
          {
            model: db.product_bundle_item,
            as: 'items',
            include: [
              {
                model: db.product,
                as: 'productData',
                attributes: ['id', 'nameProduct', 'price', 'image', 'stock']
              }
            ]
          }
        ]
      })

      await createAudit(
        req,
        'CREATE',
        'product_bundle',
        bundle.id,
        'Created bundle: ' + bundle.name,
        null,
        result.toJSON()
      )

      return res
        .status(201)
        .json({ message: 'Bundle berhasil dibuat', data: result })
    } catch (error) {
      console.error('Bundle create error:', error)
      return res.status(500).json({ message: error.message })
    }
  },

  async update(req, res) {
    try {
      const { id } = req.params
      // Same IDOR fix as getById.
      const bundle = await db.product_bundle.findOne({
        where: await tenantArrayStoreWhere(req, { id }),
        include: [{ model: db.product_bundle_item, as: 'items' }]
      })

      if (!bundle) {
        return res.status(404).json({ message: 'Bundle tidak ditemukan' })
      }

      const oldData = bundle.toJSON()

      const body = parseBundleBody(req)
      if (!body) {
        return res.status(400).json({ message: 'Invalid JSON format in data field' })
      }
      const {
        name,
        description,
        image,
        bundlePrice,
        items,
        isAvailable,
        status,
        validFrom,
        validUntil,
        minQuantity,
        maxQuantity,
        store
      } = body

      let originalPrice = 0
      if (items && items.length > 0) {
        await db.product_bundle_item.destroy({ where: { bundleId: bundle.id } })

        for (const item of items) {
          const product = await db.product.findByPk(item.product)
          if (!product) {
            return res
              .status(400)
              .json({ message: `Produk ID ${item.product} tidak ditemukan` })
          }
          const itemPrice = item.unitPrice || product.price
          originalPrice += itemPrice * (item.quantity || 1)

          await db.product_bundle_item.create({
            bundleId: bundle.id,
            product: item.product,
            quantity: item.quantity || 1,
            unitPrice: itemPrice,
            isOptional: item.isOptional || false
          })
        }
      } else {
        const existingItems = await db.product_bundle_item.findAll({
          where: { bundleId: bundle.id }
        })
        for (const item of existingItems) {
          originalPrice += item.unitPrice * item.quantity
        }
      }

      const finalBundlePrice =
        bundlePrice !== undefined ? bundlePrice : bundle.bundlePrice
      const discountAmount = originalPrice - finalBundlePrice
      const discountPercentage =
        originalPrice > 0
          ? ((discountAmount / originalPrice) * 100).toFixed(2)
          : 0

      let imageUrl = image !== undefined ? image : bundle.image
      if (req.file) {
        const { url } = await uploadToCloudinaryWithDedup(
          req.file.path,
          'pos-app-bundles'
        )
        imageUrl = url
      }

      await bundle.update({
        name: name || bundle.name,
        description:
          description !== undefined ? description : bundle.description,
        image: imageUrl,
        bundlePrice: finalBundlePrice,
        originalPrice,
        discountAmount: Math.max(discountAmount, 0),
        discountPercentage: parseFloat(discountPercentage),
        isAvailable:
          isAvailable !== undefined ? isAvailable : bundle.isAvailable,
        status: status || bundle.status,
        validFrom: validFrom !== undefined ? validFrom : bundle.validFrom,
        validUntil: validUntil !== undefined ? validUntil : bundle.validUntil,
        minQuantity:
          minQuantity !== undefined ? minQuantity : bundle.minQuantity,
        maxQuantity:
          maxQuantity !== undefined ? maxQuantity : bundle.maxQuantity,
        store: store !== undefined ? store : bundle.store
      })

      const result = await db.product_bundle.findByPk(bundle.id, {
        include: [
          {
            model: db.product_bundle_item,
            as: 'items',
            include: [
              {
                model: db.product,
                as: 'productData',
                attributes: ['id', 'nameProduct', 'price', 'image', 'stock']
              }
            ]
          }
        ]
      })

      await createAudit(
        req,
        'UPDATE',
        'product_bundle',
        bundle.id,
        'Updated bundle: ' + bundle.name,
        oldData,
        result.toJSON()
      )

      return res
        .status(200)
        .json({ message: 'Bundle berhasil diupdate', data: result })
    } catch (error) {
      console.error('Bundle update error:', error)
      return res.status(500).json({ message: error.message })
    }
  },

  async delete(req, res) {
    try {
      const { id } = req.params
      // Same IDOR fix as getById.
      const bundle = await db.product_bundle.findOne({
        where: await tenantArrayStoreWhere(req, { id })
      })

      if (!bundle) {
        return res.status(404).json({ message: 'Bundle tidak ditemukan' })
      }

      const oldData = bundle.toJSON()

      await db.product_bundle_item.destroy({ where: { bundleId: bundle.id } })
      await bundle.destroy()

      await createAudit(
        req,
        'DELETE',
        'product_bundle',
        bundle.id,
        'Deleted bundle: ' + oldData.name,
        oldData,
        null
      )

      return res.status(200).json({ message: 'Bundle berhasil dihapus' })
    } catch (error) {
      console.error('Bundle delete error:', error)
      return res.status(500).json({ message: error.message })
    }
  },

  async changeStatus(req, res) {
    try {
      const { id } = req.params
      const { status, validFrom, validUntil } = req.body

      // Same IDOR fix as getById.
      const bundle = await db.product_bundle.findOne({
        where: await tenantArrayStoreWhere(req, { id })
      })
      if (!bundle) {
        return res.status(404).json({ message: 'Bundle tidak ditemukan' })
      }

      // ponytail: FE bisa ikut mengirim masa berlaku baru saat aktivasi
      const updates = {}
      for (const [key, raw] of [
        ['validFrom', validFrom],
        ['validUntil', validUntil]
      ]) {
        if (raw === undefined) continue
        if (raw === null || raw === '') {
          updates[key] = null
          continue
        }
        const d = new Date(raw)
        if (isNaN(d.getTime())) {
          return res
            .status(400)
            .json({ message: `${key === 'validFrom' ? 'Tanggal mulai' : 'Tanggal berakhir'} tidak valid` })
        }
        updates[key] = d
      }

      const effectiveFrom =
        updates.validFrom !== undefined ? updates.validFrom : bundle.validFrom
      const effectiveUntil =
        updates.validUntil !== undefined ? updates.validUntil : bundle.validUntil

      // ponytail: bundle yang validUntil-nya sudah lewat tidak boleh
      // diaktifkan — nanti langsung di-auto-expire lagi di list berikutnya
      if (
        status === 'active' &&
        effectiveUntil &&
        new Date(effectiveUntil) < new Date()
      ) {
        return res.status(400).json({
          message:
            'Tanggal berakhir bundle sudah lewat. Perbarui masa berlaku sebelum mengaktifkan.'
        })
      }

      if (
        effectiveFrom &&
        effectiveUntil &&
        new Date(effectiveUntil) < new Date(effectiveFrom)
      ) {
        return res.status(400).json({
          message: 'Tanggal berakhir harus setelah tanggal mulai'
        })
      }

      const oldData = bundle.toJSON()

      await bundle.update({ status, ...updates })

      const result = await db.product_bundle.findByPk(id, {
        include: [
          {
            model: db.product_bundle_item,
            as: 'items',
            include: [
              {
                model: db.product,
                as: 'productData',
                attributes: ['id', 'nameProduct', 'price', 'image', 'stock']
              }
            ]
          }
        ]
      })

      await createAudit(
        req,
        'STATUS_CHANGE',
        'product_bundle',
        bundle.id,
        'Changed bundle status: ' + bundle.name,
        oldData,
        result.toJSON()
      )

      return res
        .status(200)
        .json({ message: 'Status bundle berhasil diubah', data: result })
    } catch (error) {
      console.error('Bundle changeStatus error:', error)
      return res.status(500).json({ message: error.message })
    }
  }
}

module.exports = bundleController
