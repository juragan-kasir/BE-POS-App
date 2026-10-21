const db = require('../../db/models')
const { Op } = require('sequelize')
const { createNotification } = require('../../utils/createNotification')
const { createAudit } = require('../../utils/auditLog')
const { enrichAuditFields } = require('../../utils/auditFields')
const ExcelJS = require('exceljs')
const Location = db.location

let _spExists = null
const hasSupplierProductTable = async () => {
  if (_spExists !== null) return _spExists
  try {
    await db.sequelize.query('SELECT 1 FROM supplier_product LIMIT 1')
    _spExists = true
  } catch {
    _spExists = false
  }
  return _spExists
}

const normalizeStores = (stores) => {
  if (!Array.isArray(stores)) return []
  return stores.flatMap((s) => {
    if (s == null) return []
    return typeof s === 'object' ? [s.id] : [s]
  })
}

const resolveStoreNames = async (storeIds) => {
  if (!storeIds || !Array.isArray(storeIds) || storeIds.length === 0) return []
  const ids = normalizeStores(storeIds)
  const locations = await Location.findAll({
    where: { id: ids },
    attributes: ['id', 'name']
  })
  return locations.map((l) => ({ id: l.id, name: l.name }))
}

const syncSupplierProducts = async (supplierId, products, userId) => {
  if (!Array.isArray(products)) return
  if (!(await hasSupplierProductTable())) return

  const existing = await db.supplier_product.findAll({
    where: { supplier: supplierId },
    attributes: [
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
      'updatedAt',
      'deletedAt'
    ],
    raw: true
  })
  const existingMap = new Map(
    existing.map((r) => [r.name.toLowerCase().trim(), r])
  )

  const incomingNames = products.map((p) =>
    (typeof p === 'object' ? p.name : p).toLowerCase().trim()
  )

  for (const item of products) {
    const productName =
      typeof item === 'object' ? (item.name || '').trim() : item
    const price = typeof item === 'object' ? item.price || 0 : 0
    const unit = typeof item === 'object' ? item.unit || 'pcs' : 'pcs'
    const leadTime = typeof item === 'object' ? item.leadTime || 0 : 0
    const leadTimeUnit =
      typeof item === 'object' ? item.leadTimeUnit || 'hari' : 'hari'
    const qualityRating = typeof item === 'object' ? item.qualityRating || 0 : 0
    const minOrderQty = typeof item === 'object' ? item.minOrderQty || '1' : '1'
    const notes = typeof item === 'object' ? item.notes || null : null
    const lastPrice = typeof item === 'object' ? item.lastPrice || 0 : 0
    const productId = typeof item === 'object' ? item.productId || null : null
    const nameKey = productName.toLowerCase().trim()

    if (existingMap.has(nameKey)) {
      await db.supplier_product.update(
        {
          price,
          unit,
          leadTime,
          leadTimeUnit,
          qualityRating,
          minOrderQty,
          notes,
          lastPrice,
          productId: productId || existingMap.get(nameKey).productId,
          modifiedBy: userId
        },
        { where: { supplier: supplierId, name: existingMap.get(nameKey).name } }
      )
    } else {
      await db.supplier_product.create(
        {
          supplier: supplierId,
          productId: productId || null,
          name: productName,
          price,
          unit,
          leadTime,
          leadTimeUnit,
          qualityRating,
          minOrderQty,
          notes,
          lastPrice,
          createdBy: userId
        },
        {
          returning: [
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
            'createdAt',
            'updatedAt'
          ]
        }
      )
    }
  }

  const toDelete = existing.filter(
    (r) => !incomingNames.includes(r.name.toLowerCase().trim())
  )
  if (toDelete.length > 0) {
    await db.supplier_product.destroy({
      where: {
        supplier: supplierId,
        name: { [Op.in]: toDelete.map((r) => r.name) }
      }
    })
  }
}

const syncSupplierContacts = async (supplierId, contacts) => {
  if (!Array.isArray(contacts)) return

  const existing = await db.supplier_contact.findAll({
    where: { supplier: supplierId },
    attributes: ['id', 'fullName'],
    raw: true
  })

  const existingNames = new Set(existing.map((r) => r.fullName.toLowerCase().trim()))
  const incomingNames = contacts.map((c) => String(c.fullName || '').toLowerCase().trim())

  const toDelete = existing.filter(
    (r) => !incomingNames.includes(r.fullName.toLowerCase().trim())
  )
  if (toDelete.length > 0) {
    await db.supplier_contact.destroy({
      where: { supplier: supplierId, id: { [Op.in]: toDelete.map((r) => r.id) } }
    })
  }

  for (const item of contacts) {
    const trimmedName = String(item.fullName || '').trim()
    if (!trimmedName) continue

    if (existingNames.has(trimmedName)) {
      const row = existing.find((r) => r.fullName.toLowerCase().trim() === trimmedName)
      if (row) {
        await db.supplier_contact.update(
          {
            position: item.position?.trim() || null,
            email: item.email?.trim() || null,
            phone: item.phone?.trim() || null
          },
          { where: { id: row.id } }
        )
      }
    } else {
      await db.supplier_contact.create({
        supplier: supplierId,
        fullName: trimmedName,
        position: item.position?.trim() || null,
        email: item.email?.trim() || null,
        phone: item.phone?.trim() || null
      })
    }
  }
}

const syncSupplierBankAccounts = async (supplierId, bankAccounts) => {
  if (!Array.isArray(bankAccounts)) return

  const existing = await db.supplier_bank_account.findAll({
    where: { supplier: supplierId },
    attributes: ['id', 'accountNumber'],
    raw: true
  })

  const existingNumbers = new Set(existing.map((r) => r.accountNumber.trim()))
  const incomingNumbers = bankAccounts.map((b) => String(b.accountNumber || '').trim())

  const toDelete = existing.filter(
    (r) => !incomingNumbers.includes(r.accountNumber.trim())
  )
  if (toDelete.length > 0) {
    await db.supplier_bank_account.destroy({
      where: { supplier: supplierId, id: { [Op.in]: toDelete.map((r) => r.id) } }
    })
  }

  for (const item of bankAccounts) {
    const trimmedNumber = String(item.accountNumber || '').trim()
    if (!trimmedNumber) continue

    if (existingNumbers.has(trimmedNumber)) {
      const row = existing.find((r) => r.accountNumber.trim() === trimmedNumber)
      if (row) {
        await db.supplier_bank_account.update(
          {
            bankName: item.bankName?.trim() || null,
            accountName: item.accountName?.trim() || null,
            isDefault: !!item.isDefault,
            status: item.status || 'active'
          },
          { where: { id: row.id } }
        )
      }
    } else {
      await db.supplier_bank_account.create({
        supplier: supplierId,
        bankName: String(item.bankName || '').trim(),
        accountNumber: trimmedNumber,
        accountName: String(item.accountName || '').trim(),
        isDefault: !!item.isDefault,
        status: item.status || 'active'
      })
    }
  }
}

const getSupplierProducts = async (supplierId) => {
  const hasSpTable = await hasSupplierProductTable()
  if (!hasSpTable) return []

  const rows = await db.supplier_product.findAll({
    where: { supplier: supplierId },
    attributes: [
      'id',
      'productId',
      'name',
      'price',
      'unit',
      'leadTime',
      'leadTimeUnit',
      'qualityRating',
      'minOrderQty',
      'notes',
      'lastPrice'
    ]
  })
  return rows.map((r) => ({
    id: r.id,
    productId: r.productId,
    name: r.name,
    price: r.price,
    unit: r.unit || 'pcs',
    leadTime: r.leadTime,
    leadTimeUnit: r.leadTimeUnit || 'hari',
    qualityRating: r.qualityRating,
    minOrderQty: r.minOrderQty,
    notes: r.notes,
    lastPrice: r.lastPrice
  }))
}

const getSupplierProductCount = async (supplierId) => {
  return db.supplier_product.count({ where: { supplier: supplierId } })
}

const supplierController = {
  async getDetail(req, res) {
    try {
      const { id } = req.params

      const supplier = await db.supplier.findByPk(id)

      if (!supplier) {
        return res.status(404).json({
          success: false,
          message: 'Supplier not found'
        })
      }

      const supplierStores = normalizeStores(supplier.store)
      if (
        req.user?.roleType !== 'super_admin' &&
        supplierStores.length > 0 &&
        !supplierStores.includes(Number(req.user?.store))
      ) {
        return res.status(403).json({
          success: false,
          message: 'Anda tidak memiliki akses untuk melihat supplier ini'
        })
      }

      let productCount = 0
      let products = []
      let contacts = []
      let bankAccounts = []
      let category = null
      try {
        const result = await Promise.all([
          getSupplierProductCount(id),
          getSupplierProducts(id)
        ])
        productCount = result[0]
        products = result[1]
      } catch (e) {
        if (
          !(e.name === 'SequelizeDatabaseError' && e.parent?.code === '42P01')
        ) {
          throw e
        }
      }

      try {
        contacts = await db.supplier_contact.findAll({
          where: { supplier: id },
          order: [['fullName', 'ASC']]
        })
      } catch (e) {
        if (!(e.name === 'SequelizeDatabaseError' && e.parent?.code === '42P01')) {
          throw e
        }
      }

      try {
        bankAccounts = await db.supplier_bank_account.findAll({
          where: { supplier: id },
          order: [['isDefault', 'DESC']]
        })
      } catch (e) {
        if (!(e.name === 'SequelizeDatabaseError' && e.parent?.code === '42P01')) {
          throw e
        }
      }

      if (supplier.categoryId) {
        try {
          category = await db.supplier_category.findByPk(supplier.categoryId)
        } catch (e) {
          if (!(e.name === 'SequelizeDatabaseError' && e.parent?.code === '42P01')) {
            throw e
          }
        }
      }

      const storeNames = await resolveStoreNames(supplierStores)

      return res.status(200).json({
        success: true,
        message: 'Success get supplier detail',
        data: {
          ...supplier.toJSON(),
          store: storeNames,
          productCount,
          products,
          contacts,
          bankAccounts,
          categoryData: category ? { id: category.id, name: category.name } : null
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

  async getAll(req, res) {
    try {
      const {
        search,
        status,
        page = 1,
        limit = 10,
        includeProducts
      } = req.query

      // The request filter is authoritative. An absent or empty `store` means
      // "no store narrowing" — the FE sends `store=` for the "All Stores"
      // control (FE src/services/supplier.js:8) and "all" for the same intent
      // (FE src/hooks/useGlobalStoreFilter.js:9). Falling back to the caller's
      // own `users.store` here silently turned "All Stores" into "my store"
      // for a store-bound super_admin, hiding every supplier that was not
      // tagged with that one store.
      const store = req.query.store
      const where = {}
      if (req.user?.roleType !== 'super_admin') {
        // Outlet staff stay confined to their own outlet plus the shared
        // (unassigned / global) suppliers — BR-ORG-001.
        if (req.user?.store) {
          const storeId = Number(req.user.store)
          where[Op.or] = [
            { store: null },
            { store: { [Op.contains]: [storeId] } },
            db.sequelize.literal('"supplier"."store" = \'[]\'::jsonb')
          ]
        }
      } else if (store && store !== '') {
        const storeId = Number(store)
        // An unrecognised filter value must not build a NaN predicate; it is
        // treated as "no narrowing" instead.
        if (Number.isFinite(storeId) && storeId > 0) {
          where[Op.or] = [
            { store: null },
            { store: { [Op.contains]: [storeId] } },
            db.sequelize.literal('"supplier"."store" = \'[]\'::jsonb')
          ]
        }
      }

      if (search) {
        const searchClause = [
          { name: { [Op.iLike]: `%${search}%` } },
          { phone: { [Op.iLike]: `%${search}%` } },
          { email: { [Op.iLike]: `%${search}%` } }
        ]
        if (where[Op.or]) {
          where[Op.and] = [{ [Op.or]: where[Op.or] }, { [Op.or]: searchClause }]
          delete where[Op.or]
        } else {
          where[Op.or] = searchClause
        }
      }
      if (status !== undefined) {
        if (typeof status === 'string') {
          where.status = status
        } else {
          where.status =
            status === true || status === 'true' || status === 'active'
              ? 'active'
              : 'inactive'
        }
      }

      const offset = (parseInt(page) - 1) * parseInt(limit)

      const [suppliers, total, activeCount, inactiveCount, draftCount] =
        await Promise.all([
          db.supplier.findAll({
            where,
            order: [['updatedAt', 'DESC']],
            limit: parseInt(limit),
            offset
          }),
          db.supplier.count({ where }),
          db.supplier.count({ where: { ...where, status: 'active' } }),
          db.supplier.count({ where: { ...where, status: 'inactive' } }),
          db.supplier.count({ where: { ...where, status: 'draft' } })
        ])

      await enrichAuditFields(db, suppliers)

      const allStoreIds = [
        ...new Set(
          suppliers.flatMap((s) =>
            Array.isArray(s.store) ? normalizeStores(s.store) : []
          )
        )
      ]
      const locationMap = {}
      if (allStoreIds.length > 0) {
        const locations = await Location.findAll({
          where: { id: allStoreIds },
          attributes: ['id', 'name']
        })
        locations.forEach((l) => {
          locationMap[l.id] = l.name
        })
      }

      const supplierIds = suppliers.map((s) => s.id)
      const productCounts = {}
      if (supplierIds.length > 0) {
        try {
          const countRows = await db.supplier_product.findAll({
            where: { supplier: { [Op.in]: supplierIds } },
            attributes: [
              'supplier',
              [db.sequelize.fn('COUNT', db.sequelize.col('*')), 'cnt']
            ],
            group: ['supplier'],
            raw: true
          })
          countRows.forEach((r) => {
            productCounts[r.supplier] = Number(r.cnt)
          })
        } catch (e) {
          if (
            e.name === 'SequelizeDatabaseError' &&
            e.parent?.code === '42P01'
          ) {
            // supplier_product table doesn't exist yet — fall back to 0
          } else {
            throw e
          }
        }
      }

      const categoryIds = [...new Set(suppliers.map((s) => s.categoryId).filter(Boolean))]
      const categoryMap = {}
      if (categoryIds.length > 0) {
        try {
          const categories = await db.supplier_category.findAll({
            where: { id: categoryIds },
            attributes: ['id', 'name'],
            raw: true
          })
          categories.forEach((c) => { categoryMap[c.id] = c.name })
        } catch (e) {
          if (!(e.name === 'SequelizeDatabaseError' && e.parent?.code === '42P01')) {
            throw e
          }
        }
      }

      const data = suppliers.map((item) => ({
        ...item.toJSON(),
        store: Array.isArray(item.store)
          ? normalizeStores(item.store).map((id) => ({
              id,
              name: locationMap[id] || null
            }))
          : [],
        productCount: productCounts[item.id] || 0,
        categoryData: item.categoryId
          ? { id: item.categoryId, name: categoryMap[item.categoryId] || null }
          : null
      }))

      if (includeProducts === 'true' && supplierIds.length > 0) {
        try {
          const allProducts = await db.supplier_product.findAll({
            where: { supplier: { [Op.in]: supplierIds } },
            attributes: [
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
              'lastPrice'
            ],
            raw: true
          })
          const productsBySupplier = {}
          allProducts.forEach((p) => {
            if (!productsBySupplier[p.supplier])
              productsBySupplier[p.supplier] = []
            productsBySupplier[p.supplier].push({
              id: p.id,
              productId: p.productId,
              name: p.name,
              price: p.price,
              unit: p.unit || 'pcs',
              leadTime: p.leadTime,
              leadTimeUnit: p.leadTimeUnit || 'hari',
              qualityRating: p.qualityRating,
              minOrderQty: p.minOrderQty,
              notes: p.notes,
              lastPrice: p.lastPrice
            })
          })
          data.forEach((s) => {
            s.products = productsBySupplier[s.id] || []
          })
        } catch (e) {
          if (
            !(e.name === 'SequelizeDatabaseError' && e.parent?.code === '42P01')
          ) {
            throw e
          }
          data.forEach((s) => {
            s.products = []
          })
        }
      }

      return res.status(200).json({
        success: true,
        message: 'Success get suppliers',
        data,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit))
        },
        stats: {
          total,
          active: activeCount,
          inactive: inactiveCount,
          draft: draftCount
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
      const supplier = await db.supplier.findByPk(id)

      if (!supplier) {
        return res.status(404).json({
          success: false,
          message: 'Supplier not found'
        })
      }

      const supplierStores = normalizeStores(supplier.store)
      if (
        req.user?.roleType !== 'super_admin' &&
        supplierStores.length > 0 &&
        !supplierStores.includes(Number(req.user?.store))
      ) {
        return res.status(403).json({
          success: false,
          message: 'Anda tidak memiliki akses untuk melihat supplier ini'
        })
      }

      const storeNames = await resolveStoreNames(supplierStores)
      let products = []
      let contacts = []
      let bankAccounts = []
      let category = null
      try {
        products = await getSupplierProducts(id)
      } catch (e) {
        if (
          !(e.name === 'SequelizeDatabaseError' && e.parent?.code === '42P01')
        ) {
          throw e
        }
      }

      try {
        contacts = await db.supplier_contact.findAll({
          where: { supplier: id },
          order: [['fullName', 'ASC']]
        })
      } catch (e) {
        if (!(e.name === 'SequelizeDatabaseError' && e.parent?.code === '42P01')) {
          throw e
        }
      }

      try {
        bankAccounts = await db.supplier_bank_account.findAll({
          where: { supplier: id },
          order: [['isDefault', 'DESC']]
        })
      } catch (e) {
        if (!(e.name === 'SequelizeDatabaseError' && e.parent?.code === '42P01')) {
          throw e
        }
      }

      if (supplier.categoryId) {
        try {
          category = await db.supplier_category.findByPk(supplier.categoryId)
        } catch (e) {
          if (!(e.name === 'SequelizeDatabaseError' && e.parent?.code === '42P01')) {
            throw e
          }
        }
      }

      return res.status(200).json({
        success: true,
        message: 'Success get supplier',
        data: {
          ...supplier.toJSON(),
          store: storeNames,
          products,
          contacts,
          bankAccounts,
          categoryData: category ? { id: category.id, name: category.name } : null
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

  async create(req, res) {
    try {
      // IDOR fix: a non-super-admin sending an arbitrary store array in
      // the body used to be written verbatim — letting a store A admin
      // tag a new supplier with store B's (or any other store's) id,
      // injecting a fabricated association into a tenant they have no
      // relationship to. Only super_admin may assign an arbitrary set of
      // stores; everyone else is pinned to their own, regardless of body
      // content.
      const store =
        req.user?.roleType === 'super_admin' && Array.isArray(req.body.store)
          ? req.body.store
          : req.user?.store
            ? [Number(req.user.store)]
            : []
      const {
        name,
        contactPerson,
        phone,
        email,
        address,
        description,
        isActive,
        status,
        products,
        paymentType,
        tempoDays,
        categoryId,
        mobile,
        whatsapp,
        fax,
        website,
        taxInclude,
        taxType,
        taxNumber,
        taxName,
        nitku,
        taxTransactionType,
        defaultDiscount,
        defaultDescription,
        contacts,
        bankAccounts
      } = req.body
      const createdBy = req.user?.id || null

      const trimmedName = name?.trim()

      if (!trimmedName && status !== 'draft') {
        return res.status(400).json({
          success: false,
          message: 'Name is required'
        })
      }

      const trimmedPhone = phone?.trim()
      if (!trimmedPhone && status !== 'draft') {
        return res.status(400).json({
          success: false,
          message: 'Phone is required'
        })
      }

      if (trimmedPhone) {
        const phoneExists = await db.supplier.findOne({
          where: { phone: trimmedPhone },
          paranoid: false
        })
        if (phoneExists) {
          return res.status(409).json({
            success: false,
            message: 'Nomor supplier sudah terdaftar'
          })
        }
      }

      const existing = await db.supplier.findOne({
        where: {
          [Op.or]: [
            { name: { [Op.iLike]: trimmedName } },
            ...(email?.trim() ? [{ email: { [Op.iLike]: email.trim() } }] : [])
          ]
        },
        paranoid: false
      })

      if (existing) {
        const field =
          existing.name.toLowerCase() === trimmedName.toLowerCase()
            ? 'Name'
            : 'Email'
        return res.status(409).json({
          success: false,
          message: `${field} already exists`
        })
      }

      const supplierStatus =
        status !== undefined
          ? status === true
            ? 'active'
            : status === false
              ? 'inactive'
              : status
          : isActive !== undefined
            ? isActive
              ? 'active'
              : 'inactive'
            : 'active'

      const supplier = await db.supplier.create({
        store,
        name: trimmedName,
        contactPerson: contactPerson?.trim() || null,
        phone: phone?.trim() || null,
        email: email?.trim() || null,
        address: address?.trim() || null,
        description: description?.trim() || null,
        status: supplierStatus,
        paymentType: paymentType || 'cbd',
        tempoDays: tempoDays || 0,
        categoryId: categoryId || null,
        mobile: mobile?.trim() || null,
        whatsapp: whatsapp?.trim() || null,
        fax: fax?.trim() || null,
        website: website?.trim() || null,
        taxInclude: taxInclude !== undefined ? taxInclude : true,
        taxType: taxType?.trim() || null,
        taxNumber: taxNumber?.trim() || null,
        taxName: taxName?.trim() || null,
        nitku: nitku?.trim() || null,
        taxTransactionType: taxTransactionType?.trim() || null,
        defaultDiscount: defaultDiscount || 0,
        defaultDescription: defaultDescription?.trim() || null,
        createdBy
      })

      if (Array.isArray(products) && products.length > 0) {
        await syncSupplierProducts(supplier.id, products, createdBy)
      }

      if (Array.isArray(contacts) && contacts.length > 0) {
        await syncSupplierContacts(supplier.id, contacts)
      }

      if (Array.isArray(bankAccounts) && bankAccounts.length > 0) {
        await syncSupplierBankAccounts(supplier.id, bankAccounts)
      }

      createNotification({
        type: 'supplier_created',
        store,
        referenceId: supplier.id,
        referenceType: 'supplier',
        params: [name],
        createdBy: req.user?.fullName || 'System'
      }).catch(console.error)
      createAudit(
        req,
        'create',
        'supplier',
        supplier.id,
        `Created supplier: ${name}`
      )

      return res.status(201).json({
        success: true,
        message: 'Success create supplier',
        data: supplier
      })
    } catch (error) {
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
      const store = req.user?.store
      const {
        name,
        contactPerson,
        phone,
        email,
        address,
        description,
        status,
        products,
        paymentType,
        tempoDays,
        categoryId,
        mobile,
        whatsapp,
        fax,
        website,
        taxInclude,
        taxType,
        taxNumber,
        taxName,
        nitku,
        taxTransactionType,
        defaultDiscount,
        defaultDescription,
        contacts,
        bankAccounts
      } = req.body
      const modifiedBy = req.user?.id || null

      const supplier = await db.supplier.findByPk(id)

      if (!supplier) {
        return res.status(404).json({
          success: false,
          message: 'Supplier not found'
        })
      }

      // C-9: `supplierStores.length > 0 &&` short-circuited for a global
      // supplier (store: null/[]) — any tenant admin could mutate it. Reads
      // of a global supplier stay open to every store (list queries already
      // treat store:null as visible everywhere via
      // Op.or:[{store:null},{store:{Op.contains:[storeId]}}]) — but
      // MUTATING a shared/global supplier record must be restricted to
      // super_admin, same as the other C-9 findings.
      if (
        req.user?.roleType !== 'super_admin' &&
        (supplierStores.length === 0 || !supplierStores.includes(Number(store)))
      ) {
        return res.status(403).json({
          success: false,
          message: 'Anda tidak memiliki akses untuk mengupdate supplier ini'
        })
      }

      const trimmedPhone = phone?.trim()
      if (trimmedPhone) {
        const phoneExists = await db.supplier.findOne({
          where: {
            id: { [Op.ne]: id },
            phone: trimmedPhone
          },
          paranoid: false
        })
        if (phoneExists) {
          return res.status(409).json({
            success: false,
            message: 'Nomor supplier sudah terdaftar'
          })
        }
      }

      const trimmedName = name?.trim()
      if (name && trimmedName) {
        const existing = await db.supplier.findOne({
          where: {
            id: { [Op.ne]: id },
            [Op.or]: [
              { name: { [Op.iLike]: trimmedName } },
              ...(email?.trim()
                ? [{ email: { [Op.iLike]: email.trim() } }]
                : [])
            ]
          },
          paranoid: false
        })

        if (existing) {
          const field =
            existing.name.toLowerCase() === trimmedName.toLowerCase()
              ? 'Name'
              : 'Email'
          return res.status(409).json({
            success: false,
            message: `${field} already exists`
          })
        }
      }

      // IDOR fix: same as create() — a non-super-admin submitting an
      // arbitrary store array used to be written verbatim regardless of
      // whether they were even authorized to edit this supplier at all,
      // letting them expand its association to stores they don't belong
      // to. Only super_admin may reassign an arbitrary set of stores.
      const newStore =
        req.user?.roleType === 'super_admin' && Array.isArray(req.body.store)
          ? req.body.store
          : undefined

      await supplier.update({
        name: trimmedName ?? supplier.name,
        contactPerson:
          contactPerson !== undefined
            ? contactPerson?.trim() || null
            : supplier.contactPerson,
        phone: phone !== undefined ? phone?.trim() || null : supplier.phone,
        email: email !== undefined ? email?.trim() || null : supplier.email,
        address:
          address !== undefined ? address?.trim() || null : supplier.address,
        description:
          description !== undefined
            ? description?.trim() || null
            : supplier.description,
        status:
          status !== undefined
            ? status === true
              ? 'active'
              : status === false
                ? 'inactive'
                : status
            : supplier.status,
        paymentType: paymentType !== undefined ? paymentType : supplier.paymentType,
        tempoDays: tempoDays !== undefined ? tempoDays : supplier.tempoDays,
        categoryId: categoryId !== undefined ? categoryId : supplier.categoryId,
        mobile: mobile !== undefined ? mobile?.trim() || null : supplier.mobile,
        whatsapp: whatsapp !== undefined ? whatsapp?.trim() || null : supplier.whatsapp,
        fax: fax !== undefined ? fax?.trim() || null : supplier.fax,
        website: website !== undefined ? website?.trim() || null : supplier.website,
        taxInclude: taxInclude !== undefined ? taxInclude : supplier.taxInclude,
        taxType: taxType !== undefined ? taxType?.trim() || null : supplier.taxType,
        taxNumber: taxNumber !== undefined ? taxNumber?.trim() || null : supplier.taxNumber,
        taxName: taxName !== undefined ? taxName?.trim() || null : supplier.taxName,
        nitku: nitku !== undefined ? nitku?.trim() || null : supplier.nitku,
        taxTransactionType: taxTransactionType !== undefined ? taxTransactionType?.trim() || null : supplier.taxTransactionType,
        defaultDiscount: defaultDiscount !== undefined ? defaultDiscount : supplier.defaultDiscount,
        defaultDescription: defaultDescription !== undefined ? defaultDescription?.trim() || null : supplier.defaultDescription,
        ...(newStore !== undefined ? { store: newStore } : {}),
        modifiedBy
      })

      if (Array.isArray(products)) {
        await syncSupplierProducts(id, products, modifiedBy)
      }

      if (Array.isArray(contacts)) {
        await syncSupplierContacts(id, contacts)
      }

      if (Array.isArray(bankAccounts)) {
        await syncSupplierBankAccounts(id, bankAccounts)
      }

      createNotification({
        type: 'supplier_updated',
        store,
        referenceId: id,
        referenceType: 'supplier',
        params: [name || supplier.name],
        createdBy: req.user?.fullName || 'System'
      }).catch(console.error)
      createAudit(req, 'update', 'supplier', id, `Updated supplier: ${id}`)

      return res.status(200).json({
        success: true,
        message: 'Success update supplier',
        data: supplier
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
      const store = Number(req.user?.store)

      const supplier = await db.supplier.findByPk(id)
      if (!supplier) {
        return res.status(404).json({
          success: false,
          message: 'Supplier not found'
        })
      }

      // C-9 (same class, found via repository-wide pattern search): the
      // original `store && supplierStores.length > 0 && !includes` let the
      // guard evaluate to false — and DELETE proceed — whenever the target
      // supplier was global (supplierStores.length === 0), for ANY tenant
      // admin. A destructive delete of a shared/global supplier must be
      // restricted to super_admin.
      const supplierStores = normalizeStores(supplier.store)
      if (
        req.user?.roleType !== 'super_admin' &&
        (supplierStores.length === 0 || !supplierStores.includes(store))
      ) {
        return res.status(403).json({
          success: false,
          message: 'Anda tidak memiliki akses untuk menghapus supplier ini'
        })
      }

      if (await hasSupplierProductTable()) {
        await db.supplier_product.destroy({ where: { supplier: id } })
      }
      await supplier.destroy()

      createNotification({
        type: 'supplier_deleted',
        store,
        referenceId: id,
        referenceType: 'supplier',
        params: [supplier.name],
        createdBy: req.user?.fullName || 'System'
      }).catch(console.error)
      createAudit(
        req,
        'delete',
        'supplier',
        id,
        `Deleted supplier: ${supplier.name}`
      )

      return res.status(200).json({
        success: true,
        message: 'Success delete supplier'
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
      const workbook = new ExcelJS.Workbook()
      const worksheet = workbook.addWorksheet('Supplier Template')

      const headers = [
        'Name',
        'Contact Person',
        'Phone',
        'Email',
        'Address',
        'Status'
      ]
      worksheet.addRow(headers)

      worksheet.getRow(1).font = { bold: true }
      worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFD3D3D3' }
      }

      worksheet.columns = [
        { width: 25 },
        { width: 22 },
        { width: 20 },
        { width: 30 },
        { width: 30 },
        { width: 12 }
      ]

      for (let row = 2; row <= 12; row++) {
        worksheet.getCell(`F${row}`).dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: ['"Active,Non-Active,Draft"']
        }
      }

      const buffer = await workbook.xlsx.writeBuffer()

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
      res.setHeader(
        'Content-Disposition',
        'attachment; filename=supplier-template.xlsx'
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
      const { store } = req.query
      const where = {}
      if (store) {
        const storeId = Number(store)
        where[Op.or] = [
          { store: null },
          { store: { [Op.contains]: [storeId] } },
          db.sequelize.literal('"supplier"."store" = \'[]\'::jsonb')
        ]
      }

      const suppliers = await db.supplier.findAll({
        where,
        order: [['createdAt', 'ASC']]
      })

      const workbook = new ExcelJS.Workbook()
      const worksheet = workbook.addWorksheet('Suppliers Data')

      worksheet.addRow([
        'ID',
        'Name',
        'Contact Person',
        'Phone',
        'Email',
        'Address',
        'Status',
        'Created At'
      ])

      worksheet.getRow(1).font = { bold: true }
      worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFD3D3D3' }
      }

      suppliers.forEach((s) =>
        worksheet.addRow([
          s.id,
          s.name,
          s.contactPerson || '',
          s.phone,
          s.email,
          s.address,
          s.status === 'active'
            ? 'Active'
            : s.status === 'draft'
              ? 'Draft'
              : 'Inactive',
          s.createdAt ? s.createdAt.toISOString() : ''
        ])
      )

      worksheet.columns = [
        { width: 10 },
        { width: 25 },
        { width: 22 },
        { width: 20 },
        { width: 30 },
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
        'attachment; filename=suppliers-data.xlsx'
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

      const suppliersToCreate = []
      const errors = []

      worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return

        try {
          const [name, contactPerson, phone, email, address, status] =
            row.values

          if (!name) {
            errors.push(`Row ${rowNumber}: Name is required`)
            return
          }

          const statusValue = status
            ? String(status).toLowerCase() === 'draft'
              ? 'draft'
              : String(status).toLowerCase() === 'active'
                ? 'active'
                : 'inactive'
            : 'active'

          suppliersToCreate.push({
            store: req.user?.store ? [Number(req.user.store)] : [],
            name: name.trim(),
            contactPerson: contactPerson?.toString().trim() || null,
            phone: phone?.toString().trim() || null,
            email: email?.trim() || null,
            address: address?.trim() || null,
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

      const createdSuppliers = []
      const skipped = []
      for (const item of suppliersToCreate) {
        const existing = await db.supplier.findOne({
          where: { name: item.name }
        })
        if (existing) {
          skipped.push(item.name)
          continue
        }
        const supplier = await db.supplier.create(item)
        createdSuppliers.push(supplier)
      }

      createAudit(
        req,
        'import',
        'supplier',
        null,
        `Imported ${createdSuppliers.length} suppliers, skipped ${skipped.length}`
      )

      return res.status(201).json({
        success: true,
        message: `Successfully imported ${createdSuppliers.length} from ${suppliersToCreate.length} suppliers`,
        data: {
          total: suppliersToCreate.length,
          created: createdSuppliers.length,
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

  async downloadProductTemplate(req, res) {
    try {
      const { supplier } = req.query
      const workbook = new ExcelJS.Workbook()
      const worksheet = workbook.addWorksheet('Supplier Product Template')

      worksheet.addRow([
        'Nama Produk',
        'Harga',
        'Satuan',
        'Lead Time',
        'Satuan Lead Time',
        'Kualitas (0-5)',
        'Min Order',
        'Catatan'
      ])

      worksheet.getRow(1).font = { bold: true }
      worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFD3D3D3' }
      }

      worksheet.columns = [
        { width: 25 },
        { width: 12 },
        { width: 10 },
        { width: 12 },
        { width: 18 },
        { width: 15 },
        { width: 15 },
        { width: 30 }
      ]

      let rowStart = 2
      let hasExistingData = false

      if (supplier) {
        const existingProducts = await db.supplier_product.findAll({
          where: { supplier: Number(supplier) },
          attributes: [
            'id',
            'name',
            'price',
            'unit',
            'leadTime',
            'leadTimeUnit',
            'qualityRating',
            'minOrderQty',
            'notes'
          ],
          order: [['name', 'ASC']]
        })
        if (existingProducts.length > 0) {
          hasExistingData = true
          existingProducts.forEach((p, i) => {
            const r = rowStart + i
            worksheet.getCell(`A${r}`).value = p.name
            worksheet.getCell(`B${r}`).value = p.price
            worksheet.getCell(`C${r}`).value = p.unit || 'pcs'
            worksheet.getCell(`D${r}`).value = p.leadTime || 0
            worksheet.getCell(`E${r}`).value = p.leadTimeUnit || 'hari'
            worksheet.getCell(`F${r}`).value = p.qualityRating || 0
            worksheet.getCell(`G${r}`).value = p.minOrderQty || '1'
            worksheet.getCell(`H${r}`).value = p.notes || ''
          })
          rowStart = rowStart + existingProducts.length
        }
      }

      if (!hasExistingData) {
        worksheet.getCell(`A2`).value = 'Contoh: Indomie Goreng'
        worksheet.getCell(`B2`).value = 3500
        worksheet.getCell(`C2`).value = 'pcs'
        worksheet.getCell(`D2`).value = 1
        worksheet.getCell(`E2`).value = 'hari'
        worksheet.getCell(`F2`).value = 4
        worksheet.getCell(`G2`).value = '10 karton'
        worksheet.getCell(`H2`).value = 'Rasa original'
      }

      const totalRows = Math.max(200, rowStart + 50)
      for (let r = 2; r <= totalRows; r++) {
        worksheet.getCell(`C${r}`).dataValidation = {
          type: 'list',
          formulae: [
            '"pcs,buah,kg,gram,liter,ml,meter,cm,lusin,pack,box,karton,krat"'
          ],
          allowBlank: true,
          showErrorMessage: true,
          errorTitle: 'Satuan tidak valid',
          error: 'Pilih satuan yang tersedia'
        }
        worksheet.getCell(`E${r}`).dataValidation = {
          type: 'list',
          formulae: ['"hari,jam,menit"'],
          allowBlank: true,
          showErrorMessage: true,
          errorTitle: 'Satuan Lead Time tidak valid',
          error: 'Pilih hari, jam, atau menit'
        }
      }

      const buffer = await workbook.xlsx.writeBuffer()

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
      res.setHeader(
        'Content-Disposition',
        'attachment; filename=supplier-product-template.xlsx'
      )

      return res.status(200).send(buffer)
    } catch (error) {
      console.error('Error =>', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async importProducts(req, res) {
    try {
      const { id } = req.params
      const isPreview = id === 'preview'
      const modifiedBy = req.user?.id || null

      if (!isPreview) {
        const supplier = await db.supplier.findByPk(id)
        if (!supplier) {
          return res.status(404).json({
            success: false,
            message: 'Supplier not found'
          })
        }
      }

      if (!req.file) {
        return res
          .status(400)
          .json({ success: false, message: 'No file uploaded' })
      }

      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(req.file.buffer)
      const worksheet = workbook.getWorksheet(1)

      const products = []
      const errors = []

      worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return

        try {
          const values = row.values
          const name = values[1]
          const price = values[2]
          const unit = values[3]
          const leadTime = values[4]
          const leadTimeUnit = values[5]
          const qualityRating = values[6]
          const minOrderQty = values[7]
          const notes = values[8]

          if (!name) {
            errors.push(`Row ${rowNumber}: Name is required`)
            return
          }

          const nameStr = String(name).trim()
          if (nameStr.startsWith('Contoh:')) return

          products.push({
            name: nameStr,
            price: Number(price) || 0,
            unit: unit ? String(unit).trim() : 'pcs',
            leadTime: Number(leadTime) || 0,
            leadTimeUnit: leadTimeUnit ? String(leadTimeUnit).trim() : 'hari',
            qualityRating: Number(qualityRating) || 0,
            minOrderQty: minOrderQty ? String(minOrderQty).trim() : '1',
            notes: notes ? String(notes).trim() : null
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

      if (!isPreview) {
        await syncSupplierProducts(id, products, modifiedBy)
        createAudit(
          req,
          'import',
          'supplier_product',
          id,
          `Imported ${products.length} products for supplier ${id}`
        )
      }

      return res.status(200).json({
        success: true,
        message: isPreview
          ? `Preview: ${products.length} products parsed`
          : `Successfully imported ${products.length} products`,
        data: products.reverse()
      })
    } catch (error) {
      console.error('Error =>', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async compareSuppliers(req, res) {
    try {
      const { productId, search } = req.query

      if (!productId && !search) {
        return res.status(400).json({
          success: false,
          message: 'productId or search query is required'
        })
      }

      const hasSpTable = await hasSupplierProductTable()
      if (!hasSpTable) {
        return res.status(200).json({
          success: true,
          message: 'Supplier product table not available',
          data: []
        })
      }

      const where = {}

      if (productId) {
        where.productId = Number(productId)
      }

      if (search) {
        where.name = { [Op.iLike]: `%${search}%` }
      }

      const supplierProducts = await db.supplier_product.findAll({
        where,
        include: [
          {
            model: db.supplier,
            as: 'supplierData',
            attributes: ['id', 'name', 'phone', 'email', 'status'],
            where: { status: 'active' }
          }
        ],
        attributes: [
          'id',
          'productId',
          'name',
          'price',
          'unit',
          'leadTime',
          'leadTimeUnit',
          'qualityRating',
          'minOrderQty',
          'notes',
          'lastPrice'
        ],
        order: [['price', 'ASC']]
      })

      const product = productId
        ? await db.product.findByPk(Number(productId), {
            attributes: ['id', 'nameProduct', 'sku', 'unit']
          })
        : null

      const result = {
        product: product
          ? {
              id: product.id,
              name: product.nameProduct,
              sku: product.sku,
              unit: product.unit
            }
          : null,
        suppliers: supplierProducts.map((sp) => ({
          supplierProductId: sp.id,
          supplierId: sp.supplierData?.id,
          supplierName: sp.supplierData?.name,
          supplierPhone: sp.supplierData?.phone,
          supplierEmail: sp.supplierData?.email,
          productName: sp.name,
          price: sp.price,
          unit: sp.unit || 'pcs',
          leadTime: sp.leadTime,
          leadTimeUnit: sp.leadTimeUnit || 'hari',
          qualityRating: sp.qualityRating,
          minOrderQty: sp.minOrderQty,
          notes: sp.notes,
          lastPrice: sp.lastPrice
        }))
      }

      if (result.suppliers.length > 0 && product) {
        const prices = result.suppliers.map((s) => s.price).filter((p) => p > 0)
        if (prices.length > 0) {
          result.summary = {
            lowestPrice: Math.min(...prices),
            highestPrice: Math.max(...prices),
            avgPrice: Math.round(
              prices.reduce((a, b) => a + b, 0) / prices.length
            ),
            supplierCount: result.suppliers.length
          }
        }
      }

      return res.status(200).json({
        success: true,
        message: 'Success compare suppliers',
        data: result
      })
    } catch (error) {
      console.error('Error compareSuppliers =>', error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  }
}

module.exports = supplierController
