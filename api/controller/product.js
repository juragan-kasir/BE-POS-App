const db = require('../../db/models')
const Product = db.product
const Category = db.category
const StockHistory = db.stock_history
const excelJS = require('exceljs')
const fs = require('fs')
const { Op } = require('sequelize')
const {
  uploadToCloudinary,
  deleteFromCloudinary
} = require('../../utils/cloudinaryStorage')
const { createNotification } = require('../../utils/createNotification')
const { createAudit } = require('../../utils/auditLog')
const { enrichAuditFields } = require('../../utils/auditFields')
const {
  downloadProductTemplate,
  parseProductTemplate
} = require('../../utils/excelTemplate')
const { isSuperAdmin } = require('../../utils/tenantScope')
const { assertSellableProductAssignment } = require('../validation/schemas')
// W3-1 (DR-11): shared authoritative outlet-price resolution (checkout +
// display use one rule).
const { getEffectivePriceMap } = require('../../utils/outletPricing')

const normalizeStores = (stores) => {
  if (!Array.isArray(stores)) return []
  return stores.flatMap((s) => {
    if (s == null) return []
    return typeof s === 'object' ? [s.id] : [s]
  })
}

const parseJSON = (val, fallback = null) => {
  if (val == null || val === '') return fallback
  if (typeof val !== 'string') return val
  try {
    return JSON.parse(val)
  } catch {
    return fallback
  }
}

// ponytail: multi-image support — uploads all `images` files (multer.fields) and a
// legacy single `image` file. Returns uploaded URLs + the legacy primary URL.
const uploadProductFiles = async (req) => {
  const multiFiles = req.files?.images || []
  const legacyFile = req.files?.image?.[0] || req.file || null
  const urls = []
  if (multiFiles.length > 0) {
    for (const f of multiFiles) {
      try {
        urls.push(await uploadToCloudinary(f.path, 'pos-app-products'))
      } catch (err) {
        console.warn(
          'Image upload skipped (Cloudinary not configured):',
          err.message
        )
      }
    }
  }
  let primaryUrl = null
  if (legacyFile && multiFiles.length === 0) {
    try {
      primaryUrl = await uploadToCloudinary(legacyFile.path, 'pos-app-products')
    } catch (err) {
      console.warn(
        'Image upload skipped (Cloudinary not configured):',
        err.message
      )
    }
  }
  return { urls, primaryUrl }
}

// Resolves the ordered gallery from an `imageOrder` manifest:
// plain strings = retained/existing URLs, "file:N" = N-th newly uploaded file.
const resolveImageGallery = (rawOrder, uploadedUrls) => {
  if (!Array.isArray(rawOrder)) return []
  return rawOrder
    .map((item) => {
      if (typeof item !== 'string') return null
      if (item.startsWith('file:')) {
        const idx = Number(item.slice(5))
        return Number.isInteger(idx) ? uploadedUrls[idx] : null
      }
      return item || null
    })
    .filter((u) => typeof u === 'string' && u.length > 0)
}

let _productStoreExists = null
let _categoryStoreExists = null
const hasProductStoreTable = async () => {
  if (_productStoreExists !== null) return _productStoreExists
  try {
    await db.sequelize.query('SELECT 1 FROM product_store LIMIT 1')
    _productStoreExists = true
  } catch {
    _productStoreExists = false
  }
  return _productStoreExists
}
const hasCategoryStoreTable = async () => {
  if (_categoryStoreExists !== null) return _categoryStoreExists
  try {
    await db.sequelize.query('SELECT 1 FROM category_store LIMIT 1')
    _categoryStoreExists = true
  } catch {
    _categoryStoreExists = false
  }
  return _categoryStoreExists
}

const syncProductStores = async (productId, storeIds, transaction) => {
  if (!(await hasProductStoreTable())) return
  const existing = await db.product_store.findAll({
    where: { product: productId },
    attributes: ['store'],
    raw: true,
    transaction
  })
  const existingIds = existing.map((r) => r.store)
  const toAdd = storeIds.filter((id) => !existingIds.includes(id))
  const toRemove = existingIds.filter((id) => !storeIds.includes(id))

  if (toAdd.length > 0) {
    await db.product_store.bulkCreate(
      toAdd.map((storeId) => ({ product: productId, store: storeId })),
      { transaction }
    )
  }
  if (toRemove.length > 0) {
    await db.product_store.destroy({
      where: { product: productId, store: { [Op.in]: toRemove } },
      transaction
    })
  }
}

// product_store IS the product's tenant boundary. The persisted
// location.tenantId values decide it — never a caller-supplied store id, and
// never a caller-supplied "this is global" claim. Rejects a write that would
// make a product's assignment set straddle two tenants, mix a still-tenantless
// migration-state store with an owned one, or reference a store that does not
// exist, BEFORE any row is written so the caller gets a deterministic 400
// instead of a hook-thrown 500.
const assertProductStoresAssignable = async (
  productId,
  storeIds,
  transaction
) => {
  if (!(await hasProductStoreTable())) return null
  if (!storeIds.length) return null
  const result = await db.product_store.assertTenantConsistentAssignment({
    product: productId,
    storeIds,
    options: { transaction }
  })
  if (result.ok) return null
  return result
}

const getProductStoreSubQuery = (storeId) => {
  return db.sequelize.literal(
    `EXISTS (SELECT 1 FROM product_store WHERE product = "product".id AND store = ${Number(storeId)} AND "deletedAt" IS NULL)`
  )
}

const getUnassignedProductSubQuery = () => {
  return db.sequelize.literal(
    `NOT EXISTS (SELECT 1 FROM product_store WHERE product = "product".id AND "deletedAt" IS NULL)`
  )
}

// product has no store column of its own — ownership is many-to-many via
// the product_store junction table. Reuses this file's own existing
// subquery helpers so a single product-by-id fetch matches the SAME
// convention getAllProductInTable's list view already uses: a non-super-
// admin sees a product if it's assigned to their store OR not assigned to
// any store at all. (An earlier version of this fix used an inner-join
// include that excluded unassigned products, matching getAllProduct's
// stricter convention instead — that broke real, currently-passing tests:
// editing a product's stock is a normal admin action performed on products
// that were never assigned a product_store row in the first place, which
// getAllProductInTable's looser convention already accounted for and
// getAllProduct's didn't. Verified against product-edit-stock-flow.test.js
// before landing this version.) Only scoped when the junction table
// actually exists, matching this file's existing graceful-degrade.
const findProductInScope = async (req, id, options = {}) => {
  if (isSuperAdmin(req) || !(await hasProductStoreTable())) {
    return Product.findByPk(id, options)
  }
  const userStore = Number(req.user?.store)
  const storeId = Number.isFinite(userStore) ? userStore : -1
  return Product.findOne({
    ...options,
    where: {
      ...(options.where || {}),
      id,
      [Op.or]: [
        getProductStoreSubQuery(storeId),
        getUnassignedProductSubQuery()
      ]
    }
  })
}

exports.getProductByLocationSuperAdmin = async (req, res) => {
  const store = req.storeId
  const { search } = req.query
  // This is the cashier product-search endpoint — hit on every store
  // switch and every search keystroke, and previously ran a fully
  // unbounded query (no limit at all). 200 is generous enough that a
  // typical catalog's active-product count still comes back in one page
  // with no behavior change for existing (unpaginated) frontend callers,
  // while capping the worst case for a large catalog instead of shipping
  // every active product's full row + joins on every keystroke. Callers
  // that want to page through more can pass page/limit explicitly.
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 200, 1), 500)
  const page = Math.max(parseInt(req.query.page) || 1, 1)
  const offset = (page - 1) * limit

  try {
    const whereCondition = { status: 'active' }

    if (store) {
      const storeId = Number(store)
      if (!isNaN(storeId) && (await hasProductStoreTable())) {
        whereCondition[Op.or] = [
          getProductStoreSubQuery(storeId),
          getUnassignedProductSubQuery()
        ]
      }
    }

    if (search) {
      const searchOr = [
        { nameProduct: { [Op.iLike]: `%${search}%` } },
        { sku: { [Op.iLike]: `%${search}%` } }
      ]
      if (whereCondition[Op.or]) {
        whereCondition[Op.and] = [{ [Op.or]: searchOr }]
      } else {
        whereCondition[Op.or] = searchOr
      }
    }

    const includes = [
      {
        model: Category,
        as: 'categoryData',
        where: { status: 'active' },
        attributes: ['value', 'name', 'status']
      }
    ]
    if (store) {
      const storeId = Number(store)
      if (!isNaN(storeId)) {
        includes.push({
          model: db.product_store_stock,
          as: 'storeStocks',
          where: { store: storeId },
          required: false,
          attributes: ['store', 'stock']
        })
      }
    }
    // Fetch one extra row to know whether there's another page, without
    // paying for a separate COUNT(*) query on this hot, keystroke-driven
    // path.
    const rows = await Product.findAll({
      where: whereCondition,
      include: includes,
      order: [['id', 'ASC']],
      limit: limit + 1,
      offset
    })
    const hasMore = rows.length > limit
    const pageRows = rows.slice(0, limit)
    // W3-4 K1 (DR-11): expose the outlet-authoritative catalog price with the
    // same batched W3-1 rule as checkout (outlet row wins, otherwise base
    // price), resolved for the returned page only. Raw `price` is unchanged;
    // null when no valid store is pinned.
    const effectivePriceById =
      store && !isNaN(Number(store))
        ? await getEffectivePriceMap(pageRows, Number(store))
        : new Map()
    const getAllProduct = pageRows.map((items) => {
      const getData = {
        ...items.dataValues,
        // DR-14 (BA 027): an outlet view shows the outlet stock (0 without a
        // row); only the unscoped view shows the derived global total.
        stock: store ? (items.storeStocks?.[0]?.stock ?? 0) : items.stock,
        effectivePrice: effectivePriceById.get(String(items.id)) ?? null
      }
      delete getData.storeStocks
      return getData
    })

    let bundles = []
    if (store) {
      const storeId = Number(store)
      if (!isNaN(storeId)) {
        // ponytail: validFrom/validUntil opsional — null berarti selalu berlaku;
        // store null = Semua Toko; store bisa tersimpan scalar atau array JSONB, cek keduanya
        const now = new Date()
        const activeBundles = await db.product_bundle.findAll({
          where: {
            status: 'active',
            isAvailable: true,
            validFrom: { [Op.or]: [{ [Op.is]: null }, { [Op.lte]: now }] },
            validUntil: { [Op.or]: [{ [Op.is]: null }, { [Op.gte]: now }] },
            [Op.and]: [
              db.sequelize.literal(
                `("product_bundle"."store" IS NULL OR "product_bundle"."store"::text = '${storeId}' OR "product_bundle"."store"::jsonb @> '[${storeId}]'::jsonb)`
              )
            ]
          },
          include: [
            {
              model: db.product_bundle_item,
              as: 'items',
              include: [
                {
                  model: db.product,
                  as: 'productData',
                  attributes: ['id', 'nameProduct', 'sku']
                }
              ]
            }
          ]
        })
        bundles = activeBundles.map((b) => ({
          id: b.id,
          name: b.name,
          sku: b.sku,
          description: b.description,
          bundlePrice: b.bundlePrice,
          originalPrice: b.originalPrice,
          discountAmount: b.discountAmount,
          discountPercentage: b.discountPercentage,
          minQuantity: b.minQuantity,
          maxQuantity: b.maxQuantity,
          isAvailable: b.isAvailable,
          items: (b.items || []).map((item) => ({
            id: item.id,
            productId: item.product,
            nameProduct: item.productData?.nameProduct,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            isOptional: item.isOptional
          }))
        }))
      }
    }

    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json({
      success: true,
      message: 'Success',
      data: getAllProduct?.length > 0 ? getAllProduct : [],
      bundles,
      pagination: { page, limit, hasMore }
    })
  } catch (error) {
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

// Get All In Cashier List
exports.getAllProduct = async (req, res) => {
  const { nameProduct, category } = req.query

  try {
    const store = req.storeId
    const userRole = req.user?.roleType
    const filters = {}

    if (nameProduct) {
      filters.nameProduct = {
        [Op.like]: `${nameProduct}%`
      }
    }

    if (Number(category)) {
      filters.category = Number(category)
    }

    if (req.query.status && req.query.status !== 'all') {
      filters.status = req.query.status
    } else if (!req.query.status) {
      filters.status = 'active'
    }

    const includeOpts = [
      { model: Category, as: 'categoryData', attributes: ['value', 'name'] }
    ]

    if (store && userRole !== 'super_admin' && (await hasProductStoreTable())) {
      filters[Op.and] = [getProductStoreSubQuery(store)]
    }

    if (store) {
      includeOpts.push({
        model: db.product_store_stock,
        as: 'storeStocks',
        where: { store: Number(store) },
        required: false,
        attributes: ['store', 'stock']
      })
    }

    const getAllProduct = await Product.findAll({
      where: filters,
      include: includeOpts
    })

    // W3-1 (DR-11): expose the effective catalog price with the SAME
    // resolution rule as checkout (outlet row wins, otherwise base price),
    // batched in a single query. Raw `price` stays backward-compatible.
    const effectivePriceById = store
      ? await getEffectivePriceMap(getAllProduct, Number(store))
      : new Map()

    const resolvedCategories = getAllProduct.map((items) => ({
      ...items.dataValues,
      // DR-14 (BA 027): an outlet view shows the outlet stock (0 without a
      // row); only the unscoped view shows the derived global total.
      stock: store ? (items.storeStocks?.[0]?.stock ?? 0) : items.stock,
      effectivePrice: effectivePriceById.get(String(items.id)) ?? null,
      nameCategory: items.categoryData
        ? items.categoryData.value || items.categoryData.name
        : null
    }))

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: resolvedCategories.length > 0 ? resolvedCategories : []
    })
  } catch (error) {
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

// Get All In Table
exports.getAllProductInTable = async (req, res) => {
  const {
    page = 1,
    pageSize = req.query.limit || 10,
    status = 'all',
    search,
    category,
    sort
  } = req.query

  try {
    const offset = (page - 1) * pageSize
    const store = req.storeId

    let statusCondition = {}
    if (status && status !== 'all') {
      statusCondition = { status }
    }

    const whereCondition = {
      ...statusCondition
    }

    if (store) {
      const storeId = Number(store)
      if (!isNaN(storeId) && (await hasProductStoreTable())) {
        whereCondition[Op.or] = [
          getProductStoreSubQuery(storeId),
          getUnassignedProductSubQuery()
        ]
      }
    }

    if (search) {
      whereCondition[Op.and] = [
        ...(whereCondition[Op.and] || []),
        {
          [Op.or]: [
            { nameProduct: { [Op.iLike]: `%${search}%` } },
            { sku: { [Op.iLike]: `%${search}%` } }
          ]
        }
      ]
    }

    // Get paginated products
    const includeOpts = [
      {
        model: Category,
        as: 'categoryData',
        attributes: ['name'],
        ...(category ? { where: { name: { [Op.iLike]: category } } } : {})
      }
    ]
    if (store) {
      includeOpts.push({
        model: db.product_store_stock,
        as: 'storeStocks',
        where: { store: Number(store) },
        required: false,
        attributes: ['store', 'stock']
      })
    }

    let order = [['createdAt', 'DESC']]
    if (sort === 'price-asc') order = [['price', 'ASC']]
    else if (sort === 'price-desc') order = [['price', 'DESC']]
    else if (sort === 'stock-asc') order = [['stock', 'ASC']]

    const getAllProduct = await Product.findAll({
      where: whereCondition,
      limit: parseInt(pageSize),
      offset: parseInt(offset),
      include: includeOpts,
      order
    })

    await enrichAuditFields(db, getAllProduct)

    // Resolve store IDs to names via junction table
    const productIds = getAllProduct.map((p) => p.id)
    const storeRows =
      productIds.length > 0 && (await hasProductStoreTable())
        ? await db.product_store.findAll({
            where: { product: { [Op.in]: productIds } },
            attributes: ['product', 'store'],
            raw: true
          })
        : []
    const storeIdSet = [...new Set(storeRows.map((r) => r.store))]
    const locationMap = {}
    if (storeIdSet.length > 0) {
      const locations = await db.location.findAll({
        where: { id: storeIdSet },
        attributes: ['id', 'name']
      })
      locations.forEach((l) => {
        locationMap[l.id] = l.name
      })
    }
    const productStoreMap = {}
    storeRows.forEach((r) => {
      if (!productStoreMap[r.product]) productStoreMap[r.product] = []
      productStoreMap[r.product].push(r.store)
    })

    const resolvedCategories = getAllProduct.map((items) => ({
      ...items.dataValues,
      // DR-14 (BA 027): an outlet view shows the outlet stock (0 without a
      // row); only the unscoped view shows the derived global total.
      stock: store ? (items.storeStocks?.[0]?.stock ?? 0) : items.stock,
      nameCategory: items.categoryData ? items.categoryData.name : null,
      storeList: (productStoreMap[items.id] || []).map((id) => ({
        id,
        name: locationMap[id] || null
      }))
    }))

    // Get total count for pagination
    const countIncludeOpts = category
      ? [
          {
            model: Category,
            as: 'categoryData',
            where: { name: { [Op.iLike]: category } },
            required: true
          }
        ]
      : []
    const totalProducts = await Product.count({
      where: whereCondition,
      ...(countIncludeOpts.length
        ? { include: countIncludeOpts, distinct: true }
        : {})
    })

    // Calculate stats (based on store filter only, not status filter)
    const useStoreFilter = store && (await hasProductStoreTable())
    const statsWhere = useStoreFilter
      ? {
          [Op.or]: [
            getProductStoreSubQuery(Number(store)),
            getUnassignedProductSubQuery()
          ]
        }
      : {}
    const [totalCount, activeCount, inactiveCount, draftCount] =
      await Promise.all([
        Product.count({ where: statsWhere }),
        Product.count({ where: { ...statsWhere, status: 'active' } }),
        Product.count({ where: { ...statsWhere, status: 'inactive' } }),
        Product.count({ where: { ...statsWhere, status: 'draft' } })
      ])

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: resolvedCategories.length > 0 ? resolvedCategories : [],
      pagination: {
        currentPage: parseInt(page),
        pageSize: parseInt(pageSize),
        totalItems: totalProducts,
        totalPages: Math.ceil(totalProducts / pageSize)
      },
      stats: {
        total: totalCount,
        active: activeCount,
        nonActive: inactiveCount,
        draft: draftCount
      }
    })
  } catch (error) {
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Internal Server Error'
    })
  }
}

// Function Post Add Form Product
exports.postAddProduct = async (req, res) => {
  const {
    nameProduct,
    category,
    status,
    description,
    price,
    costPrice,
    stock,
    minStock,
    unit,
    baseUnit,
    conversionFactor,
    point,
    barcode,
    brand,
    hasModifiers,
    modifiers,
    isOption,
    options,
    isAvailable,
    createdBy,
    image,
    imageOrder,
    stores,
    supplier,
    tax,
    priceTiers,
    currencyId,
    currencyCode,
    tipeProduk,
    inventoryMode,
    composition,
    redeemPoints,
    estimationTime
  } = req.body

  const normalizeStatus = (val) => {
    if (typeof val === 'boolean') return val ? 'active' : 'inactive'
    if (val === 'active' || val === 'inactive' || val === 'draft') return val
    return 'active'
  }
  const toIntOrNull = (val) => {
    if (val === '' || val === null || val === undefined) return null
    const n = Number(val)
    return Number.isNaN(n) ? null : n
  }

  try {
    const existingProduct = await Product.findOne({
      where: {
        nameProduct
      }
    })

    if (existingProduct) {
      return res.status(400).json({
        success: false,
        message: 'Product with this name already exists.'
      })
    }

    if (!nameProduct && status !== 'draft') {
      return res.status(400).json({
        success: false,
        message: 'nameProduct is required'
      })
    }

    const { urls: uploadedUrls, primaryUrl } = await uploadProductFiles(req)
    const rawOrder = parseJSON(imageOrder)
    let gallery = []
    if (Array.isArray(rawOrder) && rawOrder.length > 0) {
      gallery = resolveImageGallery(rawOrder, uploadedUrls)
    } else if (uploadedUrls.length > 0) {
      gallery = uploadedUrls
    } else if (primaryUrl) {
      gallery = [primaryUrl]
    } else if (typeof image === 'string' && image) {
      gallery = [image]
    }
    const imageUrl = gallery[0] || primaryUrl || null

    let parsedStores = []
    if (stores) {
      try {
        const raw = typeof stores === 'string' ? JSON.parse(stores) : stores
        parsedStores = normalizeStores(Array.isArray(raw) ? raw : [raw])
      } catch {
        parsedStores = []
      }
    }
    const assignmentDecision = assertSellableProductAssignment({
      assignmentProvided: stores !== undefined && stores !== null,
      storeIds: parsedStores,
      status: normalizeStatus(status),
      isAvailable
    })
    if (!assignmentDecision.ok) {
      return res.status(400).json({
        success: false,
        code: assignmentDecision.code,
        field: assignmentDecision.field,
        message: assignmentDecision.message
      })
    }
    // HIGH-7: validate the submitted stores[] against the caller's own store.
    // super_admin may bind a product to any store (intentional multi-store
    // administration). For tenant admins, any foreign store ID in the array
    // is a cross-tenant write attempt — reject the entire request.
    if (!isSuperAdmin(req) && parsedStores.length > 0) {
      const callerStore = Number(req.storeId ?? req.user?.store)
      const foreignStores = parsedStores.filter(
        (s) => Number(s) !== callerStore
      )
      if (foreignStores.length > 0) {
        return res.status(403).json({
          success: false,
          message: 'Anda hanya dapat menambahkan produk ke toko Anda sendiri'
        })
      }
    }

    let parsedPriceTiers = []
    if (priceTiers) {
      try {
        parsedPriceTiers =
          typeof priceTiers === 'string' ? JSON.parse(priceTiers) : priceTiers
      } catch {
        parsedPriceTiers = []
      }
    }
    let normalizedCategory = toIntOrNull(category)
    if (normalizedCategory === null && status !== 'draft') {
      return res.status(400).json({
        success: false,
        message: 'category is required and must be a valid ID'
      })
    }
    // ponytail: draft uses first active category as fallback
    if (normalizedCategory === null && status === 'draft') {
      const fallback = await Category.findOne({
        where: { status: 'active' },
        order: [['id', 'ASC']]
      })
      normalizedCategory = fallback ? fallback.id : null
    }
    const normalizedSupplier = toIntOrNull(supplier)
    // Resolve tax ID to full JSON object (tax column is JSONB)
    let normalizedTax = null
    const taxId = toIntOrNull(tax)
    if (taxId !== null) {
      // IDOR fix: was findByPk(taxId) with no store filter — a store A
      // admin could reference a store B tax config by id and have its
      // name/rate embedded into their own product, disclosing another
      // tenant's tax configuration and letting them apply a rate not
      // intended for their store. Mirrors taxConfig.js's own getById
      // convention: store: null is a global/default tax config visible
      // to everyone, a real store value is scoped to that store only.
      const taxScopeStore = req.storeId || req.user?.store
      const taxConfig = await db.taxConfig.findOne({
        where: {
          id: taxId,
          ...(req.user?.roleType !== 'super_admin' && taxScopeStore
            ? { [Op.or]: [{ store: taxScopeStore }, { store: null }] }
            : {})
        }
      })
      if (taxConfig) {
        normalizedTax = JSON.stringify({
          id: taxConfig.id,
          name: taxConfig.name,
          rate: taxConfig.rate
        })
      }
    }

    const createAssignmentError = await assertProductStoresAssignable(
      null,
      parsedStores
    )
    if (createAssignmentError) {
      return res.status(400).json({
        success: false,
        code: createAssignmentError.code,
        field: 'stores',
        message: createAssignmentError.message
      })
    }

    const postData = await Product.create({
      nameProduct: nameProduct || null,
      category: normalizedCategory,
      description,
      price: price || 0,
      costPrice: costPrice || 0,
      stock: stock || 0,
      minStock: minStock || 0,
      unit,
      baseUnit: baseUnit || unit || 'pcs',
      conversionFactor:
        conversionFactor != null ? parseFloat(conversionFactor) : 1,
      point: point || 0,
      redeemPoints: redeemPoints || 0,
      barcode: barcode || null,
      brand: brand || null,
      hasModifiers,
      modifiers: hasModifiers
        ? typeof modifiers === 'string'
          ? JSON.parse(modifiers)
          : modifiers
        : [],
      isOption,
      options: isOption
        ? typeof options === 'string'
          ? JSON.parse(options)
          : options
        : [],
      isAvailable,
      status: normalizeStatus(status),
      createdBy,
      tipeProduk,
      inventoryMode,
      image: imageUrl || image,
      images: gallery,
      supplier: normalizedSupplier,
      tax: normalizedTax,
      priceTiers: parsedPriceTiers,
      currencyId: currencyId || null,
      currencyCode: currencyCode || null,
      composition: composition || [],
      estimationTime: estimationTime || 0
    })

    const sku = `PRD-${String(postData.id).padStart(5, '0')}`
    await Product.update({ sku }, { where: { id: postData.id } })
    postData.sku = sku

    // Sync junction table
    if (parsedStores.length > 0) {
      await syncProductStores(postData.id, parsedStores)
    }

    const initialStock = Number(stock) || 0
    if (parsedStores.length > 0) {
      const perStore = Math.floor(initialStock / parsedStores.length)
      const remainder = initialStock - perStore * parsedStores.length
      for (let i = 0; i < parsedStores.length; i++) {
        const s = i === 0 ? perStore + remainder : perStore
        await db.product_store_stock.create({
          product: postData.id,
          store: parsedStores[i],
          stock: s,
          updatedAt: new Date()
        })
      }
    }
    if (initialStock > 0) {
      await StockHistory.create({
        product: postData.id,
        referenceType: 'adjustment',
        quantityBefore: 0,
        quantityChange: initialStock,
        quantityAfter: initialStock,
        unit: unit || 'pcs',
        notes: 'Initial stock',
        createdBy
      })
    }

    createNotification({
      type: 'product_created',
      store: parsedStores?.[0] || req.user?.store,
      referenceId: postData.id,
      referenceType: 'product',
      params: [nameProduct],
      createdBy: req.user?.fullName || 'System'
    }).catch(console.error)
    createAudit(
      req,
      'create',
      'product',
      postData.id,
      `Created product: ${postData.nameProduct}`
    )

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: postData
    })
  } catch (error) {
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Internal Server Error'
    })
  }
}

// Render Edit Form Product
exports.editProductByLocationAndId = async (req, res) => {
  const {
    id,
    nameProduct,
    category,
    status,
    description,
    price,
    costPrice,
    stock,
    minStock,
    unit,
    baseUnit,
    conversionFactor,
    point,
    barcode,
    brand,
    hasModifiers,
    modifiers,
    isOption,
    options,
    isAvailable,
    image: _newImage,
    imageOrder,
    stores,
    supplier,
    tax,
    priceTiers,
    currencyId,
    currencyCode,
    tipeProduk,
    inventoryMode,
    composition,
    redeemPoints,
    estimationTime
  } = req.body

  const normalizeStatus = (val) => {
    if (typeof val === 'boolean') return val ? 'active' : 'inactive'
    if (val === 'active' || val === 'inactive' || val === 'draft') return val
    return 'active'
  }
  const toIntOrNull = (val) => {
    if (val === '' || val === null || val === undefined) return null
    const n = Number(val)
    return Number.isNaN(n) ? null : n
  }

  // ponytail: modifiedBy TIDAK terisi dari reqBody & hook beforeBulkUpdate
  // terbukti tidak jalan untuk Model.update — set eksplisit dari JWT (trusted).
  const actorId = toIntOrNull(req.user?.id ?? req.body.modifiedBy)

  try {
    // IDOR fix: was findOne({where:{id}}) with no ownership check — any
    // admin could edit any store's product (cost price, stock, etc.).
    const getAllProductByIdAndLocation = await findProductInScope(req, id)

    if (!getAllProductByIdAndLocation) {
      return res.status(404).json({
        success: false,
        message: 'Product not found.'
      })
    }

    const existingImages = Array.isArray(getAllProductByIdAndLocation.images)
      ? getAllProductByIdAndLocation.images.filter(Boolean)
      : getAllProductByIdAndLocation.image
        ? [getAllProductByIdAndLocation.image]
        : []

    const { urls: uploadedUrls, primaryUrl } = await uploadProductFiles(req)
    const rawOrder = parseJSON(imageOrder)
    const manifestProvided =
      imageOrder !== undefined && imageOrder !== null && imageOrder !== ''

    let gallery = null
    if (manifestProvided) {
      gallery = resolveImageGallery(rawOrder, uploadedUrls)
      const removed = existingImages.filter((u) => !gallery.includes(u))
      await Promise.allSettled(
        removed.map((u) => deleteFromCloudinary(u).catch(() => {}))
      )
    }

    let imageUrl = getAllProductByIdAndLocation.image
    if (manifestProvided) {
      imageUrl = gallery?.[0] || null
    } else if (uploadedUrls.length > 0) {
      imageUrl = uploadedUrls[0]
    } else if (primaryUrl) {
      imageUrl = primaryUrl
    } else if (_newImage) {
      imageUrl = _newImage
    }

    let parsedStores = []
    if (stores) {
      try {
        const raw = typeof stores === 'string' ? JSON.parse(stores) : stores
        parsedStores = normalizeStores(Array.isArray(raw) ? raw : [raw])
      } catch {
        parsedStores = []
      }
    }
    const assignmentDecision = assertSellableProductAssignment({
      assignmentProvided: stores !== undefined,
      storeIds: parsedStores,
      status:
        status !== undefined
          ? normalizeStatus(status)
          : getAllProductByIdAndLocation.status,
      isAvailable:
        isAvailable !== undefined
          ? isAvailable
          : getAllProductByIdAndLocation.isAvailable
    })
    if (!assignmentDecision.ok) {
      return res.status(400).json({
        success: false,
        code: assignmentDecision.code,
        field: assignmentDecision.field,
        message: assignmentDecision.message
      })
    }

    const editAssignmentError = await assertProductStoresAssignable(
      id,
      parsedStores
    )
    if (editAssignmentError) {
      return res.status(400).json({
        success: false,
        code: editAssignmentError.code,
        field: 'stores',
        message: editAssignmentError.message
      })
    }
    // HIGH-7: validate the submitted stores[] against the caller's own store.
    // super_admin may bind a product to any store (intentional multi-store
    // administration). For tenant admins, any foreign store ID in the array
    // is a cross-tenant write attempt — reject the entire request.
    if (!isSuperAdmin(req) && stores !== undefined && parsedStores.length > 0) {
      const callerStore = Number(req.storeId ?? req.user?.store)
      const foreignStores = parsedStores.filter(
        (s) => Number(s) !== callerStore
      )
      if (foreignStores.length > 0) {
        return res.status(403).json({
          success: false,
          message: 'Anda hanya dapat mengubah produk untuk toko Anda sendiri'
        })
      }
    }

    let parsedPriceTiers = []
    if (priceTiers) {
      try {
        parsedPriceTiers =
          typeof priceTiers === 'string' ? JSON.parse(priceTiers) : priceTiers
      } catch {
        parsedPriceTiers = []
      }
    }

    // Resolve tax ID to full JSON object (tax column is JSONB)
    let normalizedTax = null
    const taxId = toIntOrNull(tax)
    if (taxId !== null) {
      // IDOR fix: was findByPk(taxId) with no store filter — a store A
      // admin could reference a store B tax config by id and have its
      // name/rate embedded into their own product, disclosing another
      // tenant's tax configuration and letting them apply a rate not
      // intended for their store. Mirrors taxConfig.js's own getById
      // convention: store: null is a global/default tax config visible
      // to everyone, a real store value is scoped to that store only.
      const taxScopeStore = req.storeId || req.user?.store
      const taxConfig = await db.taxConfig.findOne({
        where: {
          id: taxId,
          ...(req.user?.roleType !== 'super_admin' && taxScopeStore
            ? { [Op.or]: [{ store: taxScopeStore }, { store: null }] }
            : {})
        }
      })
      if (taxConfig) {
        normalizedTax = JSON.stringify({
          id: taxConfig.id,
          name: taxConfig.name,
          rate: taxConfig.rate
        })
      }
    }

    const reqBody = {
      nameProduct,
      image: imageUrl,
      ...(gallery ? { images: gallery } : {}),
      category: category !== undefined ? toIntOrNull(category) : undefined,
      description,
      price,
      costPrice,
      stock,
      minStock,
      unit,
      baseUnit:
        baseUnit !== undefined
          ? baseUnit
          : getAllProductByIdAndLocation.baseUnit,
      conversionFactor:
        conversionFactor != null
          ? parseFloat(conversionFactor)
          : getAllProductByIdAndLocation.conversionFactor,
      point: point || 0,
      redeemPoints: redeemPoints || 0,
      barcode: barcode || null,
      brand: brand || null,
      hasModifiers,
      modifiers: hasModifiers
        ? typeof modifiers === 'string'
          ? JSON.parse(modifiers)
          : modifiers
        : [],
      isOption,
      options: isOption
        ? typeof options === 'string'
          ? JSON.parse(options)
          : options
        : [],
      isAvailable,
      status: status !== undefined ? normalizeStatus(status) : undefined,
      supplier: toIntOrNull(supplier),
      tax: normalizedTax,
      priceTiers: parsedPriceTiers,
      currencyId: currencyId || null,
      currencyCode: currencyCode || null,
      tipeProduk,
      ...(inventoryMode !== undefined ? { inventoryMode } : {}),
      composition: composition || [],
      estimationTime: estimationTime || 0,
      ...(actorId !== null && actorId > 0 ? { modifiedBy: actorId } : {})
    }

    const newStock = Number(reqBody.stock) || 0
    // HIGH-7: storeId for per-store shadow stock must derive from trusted
    // server-side context (req.storeId / JWT claim), never unvalidated cookies.
    const storeId = isSuperAdmin(req)
      ? (req.storeId ?? (req.body?.storeId ? Number(req.body.storeId) : null))
      : (req.storeId ?? req.user?.store ?? null)

    // Everything below is a real business mutation (product row + per-store
    // shadow stock + audit ledger) that previously ran as four separate,
    // unlocked, non-transactional statements — a crash partway through
    // left the product row changed but the per-store stock and audit trail
    // untouched, and two concurrent edits of the same product could lose
    // one edit outright with no serialization at all. Locking the product
    // row here also re-reads stock fresh (instead of trusting the read
    // taken before the Cloudinary upload above, which could be stale by
    // the time this actually commits) so stockDiff reflects reality, not
    // a snapshot from before any concurrent writer's change.
    let editLocation
    let oldStock
    let stockDiff
    await db.sequelize.transaction(async (t) => {
      const lockedProduct = await Product.findOne({
        where: { id },
        lock: t.LOCK.UPDATE,
        transaction: t
      })
      oldStock = Number(lockedProduct.stock) || 0
      stockDiff = newStock - oldStock

      const [, editRows] = await Product.update(reqBody, {
        returning: true,
        where: { id },
        transaction: t
      })
      editLocation = editRows[0]

      // Sync junction table
      if (stores !== undefined) {
        await syncProductStores(id, parsedStores, t)
      }

      // Update per-store stock for the current store — atomic upsert + adjust
      if (storeId && stockDiff !== 0) {
        const diff = Math.floor(Number(stockDiff)) || 0
        await db.sequelize.query(
          `INSERT INTO product_store_stock (product, store, stock, "createdAt", "updatedAt")
           VALUES ($1, $2, 0, NOW(), NOW())
           ON CONFLICT (product, store) DO NOTHING`,
          { bind: [id, storeId], transaction: t }
        )
        await db.product_store_stock.update(
          { stock: db.sequelize.literal(`GREATEST(stock + ${diff}, 0)`) },
          { where: { product: id, store: storeId }, transaction: t }
        )
      } else if (!storeId && stockDiff !== 0) {
        // Super admin without a store context: keep every per-store row in
        // sync with the absolute product stock.
        await db.product_store_stock.update(
          { stock: newStock },
          { where: { product: id }, transaction: t }
        )
      }

      if (stockDiff !== 0) {
        await StockHistory.create(
          {
            product: id,
            referenceType: 'adjustment',
            quantityBefore: oldStock,
            quantityChange: stockDiff,
            quantityAfter: newStock,
            unit: reqBody.unit || 'pcs',
            notes:
              stockDiff > 0
                ? 'Stock adjustment: added'
                : 'Stock adjustment: reduced'
          },
          { transaction: t }
        )
      }
    })

    // Get first store for notification
    const firstStoreRow = (await hasProductStoreTable())
      ? await db.product_store.findOne({
          where: { product: id },
          attributes: ['store'],
          raw: true
        })
      : null

    createNotification({
      type: 'product_updated',
      store: firstStoreRow?.store || req.user?.store,
      referenceId: id,
      referenceType: 'product',
      params: [nameProduct],
      createdBy: req.user?.fullName || 'System'
    }).catch(console.error)
    createAudit(req, 'update', 'product', id, `Updated product: ${nameProduct}`)

    return res.status(200).json({
      success: true,
      message: 'Sukses Ubah Product',
      data: editLocation?.dataValues
    })
  } catch (error) {
    console.error('ERROR =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.deleteProductByIdAndLocation = async (req, res) => {
  const { id } = req.body
  try {
    // IDOR fix: was findByPk(id) with no ownership check.
    const product = await findProductInScope(req, id)

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      })
    }

    // Get first store for notification before soft-delete
    const firstStoreRow = (await hasProductStoreTable())
      ? await db.product_store.findOne({
          where: { product: id },
          attributes: ['store'],
          raw: true
        })
      : null

    await Product.destroy({
      where: { id }
    })

    createNotification({
      type: 'product_deleted',
      store: firstStoreRow?.store || req.user?.store,
      referenceId: id,
      referenceType: 'product',
      params: [product.nameProduct || 'Unknown'],
      createdBy: req.user?.fullName || 'System'
    }).catch(console.error)
    createAudit(
      req,
      'delete',
      'product',
      id,
      `Deleted product: ${product.nameProduct}`
    )

    return res.status(200).json({
      success: true,
      message: 'Success Hapus Product'
    })
  } catch (error) {
    console.error('ERROR =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

// Download Excel Template By Excel with dropdown list of categories by storeId
exports.exportProduct = async (req, res) => {
  const { storeId } = req.params

  const workbook = new excelJS.Workbook()
  const worksheet = workbook.addWorksheet('Product')

  worksheet.columns = [
    { header: 'No.', key: 's_no', width: 10 },
    { header: 'Name Product', key: 'nameProduct', width: 20 },
    { header: 'Image', key: 'image', width: 20 },
    { header: 'Name', key: 'name', width: 20 },
    { header: 'Description', key: 'description', width: 20 },
    { header: 'Category', key: 'category', width: 20 },
    { header: 'Price', key: 'price', width: 20 }
  ]

  worksheet.getRow(1).font = { bold: true }

  try {
    const storeIdNum = Number(storeId)
    let categories
    if (storeIdNum && (await hasCategoryStoreTable())) {
      // Use junction table to find categories assigned to this store
      const categoryIds = await db.category_store
        .findAll({
          where: { store: storeIdNum },
          attributes: ['category'],
          raw: true
        })
        .then((rows) => rows.map((r) => r.category))
      categories =
        categoryIds.length > 0
          ? await Category.findAll({
              where: { id: { [Op.in]: categoryIds }, status: 'active' },
              attributes: ['name']
            })
          : []
    } else {
      categories = await Category.findAll({
        where: { status: 'active' },
        attributes: ['name']
      })
    }

    if (!categories.length) {
      return res
        .status(404)
        .json({ success: false, message: 'No categories found for this store' })
    }

    const categoryList = categories.map((cat) => cat.name).join(',')

    worksheet.getCell('F2').dataValidation = {
      type: 'list',
      allowBlank: true,
      formula1: `"${categoryList}"`,
      showDropDown: true
    }

    const buffer = await workbook.xlsx.writeBuffer()

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=product_template.xlsx'
    )

    res.send(buffer)
  } catch (err) {
    console.error('Error exporting product Excel file: ', err)
    res.status(500).send({
      success: false,
      message: 'Something went wrong while generating the Excel file',
      error: err.message
    })
  }
}

// Download Product Data as Excel
exports.downloadData = async (req, res) => {
  const store = req.storeId

  const workbook = new excelJS.Workbook()
  const worksheet = workbook.addWorksheet('Products')

  worksheet.columns = [
    { header: 'No', key: 'no', width: 5 },
    { header: 'Nama Produk', key: 'nameProduct', width: 25 },
    { header: 'Kategori', key: 'category', width: 20 },
    { header: 'Harga', key: 'price', width: 15 },
    { header: 'Stok', key: 'stock', width: 10 },
    { header: 'Status', key: 'status', width: 10 }
  ]

  try {
    const where = {}
    if (store && (await hasProductStoreTable())) {
      where[Op.or] = [
        getProductStoreSubQuery(Number(store)),
        getUnassignedProductSubQuery()
      ]
    }
    const products = await Product.findAll({
      where,
      include: [{ model: Category, as: 'categoryData', attributes: ['name'] }],
      order: [['createdAt', 'ASC']]
    })

    products.forEach((p, i) => {
      worksheet.addRow({
        no: i + 1,
        nameProduct: p.nameProduct,
        category: p.categoryData?.name || '',
        price: p.price,
        stock: p.stock || 0,
        status: p.status === 'active' ? 'Aktif' : 'Nonaktif'
      })
    })

    const buffer = await workbook.xlsx.writeBuffer()
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=products_${Date.now()}.xlsx`
    )
    res.send(buffer)
  } catch (err) {
    console.error('Error downloading products:', err)
    res.status(500).json({
      success: false,
      message: 'Gagal mengunduh produk',
      error: err.message
    })
  }
}

// Download Product Template
exports.downloadTemplate = async (req, res) => {
  try {
    const categories = await Category.findAll({
      attributes: ['name']
    })

    if (!categories.length) {
      return res.status(404).json({
        success: false,
        message: 'Tidak ada kategori. Silakan buat kategori terlebih dahulu.'
      })
    }

    const Supplier = db.supplier
    const TaxConfig = db.taxConfig
    const Location = db.location

    const [existingProducts, suppliers, taxConfigs, stores] = await Promise.all(
      [
        Product.findAll({
          include: [
            { model: Category, as: 'categoryData', attributes: ['name'] }
          ]
        }),
        Supplier.findAll({
          attributes: ['id', 'name'],
          where: { status: 'active' }
        }),
        TaxConfig.findAll({
          attributes: ['id', 'name', 'rate'],
          where: { status: 'active' }
        }),
        Location.findAll({
          where: { status: 'active' },
          attributes: ['id', 'name'],
          order: [['name', 'ASC']]
        })
      ]
    )

    const supplierMap = {}
    suppliers.forEach((s) => {
      supplierMap[s.id] = s.name
    })
    const taxMap = {}
    taxConfigs.forEach((t) => {
      taxMap[t.id] = `${t.name} (${t.rate}%)`
    })

    // Resolve store assignments via junction table
    const productIds = existingProducts.map((p) => p.id)
    const storeRows =
      productIds.length > 0 && (await hasProductStoreTable())
        ? await db.product_store.findAll({
            where: { product: { [Op.in]: productIds } },
            attributes: ['product', 'store'],
            raw: true
          })
        : []
    const productStoreMap = {}
    storeRows.forEach((r) => {
      if (!productStoreMap[r.product]) productStoreMap[r.product] = []
      productStoreMap[r.product].push(r.store)
    })

    const productsWithData = existingProducts.map((p) => {
      let taxName = ''
      if (p.tax) {
        const taxData = typeof p.tax === 'string' ? JSON.parse(p.tax) : p.tax
        taxName = taxData?.name
          ? `${taxData.name} (${taxData.rate}%)`
          : taxMap[p.tax] || ''
      }
      return {
        nameProduct: p.nameProduct,
        sku: p.sku || '',
        barcode: p.barcode || '',
        brand: p.brand || '',
        description: p.description || '',
        categoryName: p.categoryData?.name || '',
        tipeProduk: p.tipeProduk || 'menu',
        store: productStoreMap[p.id] || [],
        unit: p.unit || 'pcs',
        baseUnit: p.baseUnit || 'pcs',
        conversionFactor: p.conversionFactor || 1,
        supplierName: supplierMap[p.supplier] || '',
        taxName,
        price: p.price || 0,
        costPrice: p.costPrice || 0,
        stock: p.stock || 0,
        minStock: p.minStock || 0,
        point: p.point || 0,
        redeemPoints: p.redeemPoints || 0,
        status: p.status,
        isAvailable: p.isAvailable,
        isOption: p.isOption,
        options: p.options || []
      }
    })

    const buffer = await downloadProductTemplate({
      categories,
      existingProducts: productsWithData,
      suppliers,
      taxConfigs,
      stores
    })

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=template_produk.xlsx'
    )

    res.send(buffer)
  } catch (err) {
    console.error('Error downloading template:', err)
    res.status(500).json({
      success: false,
      message: 'Gagal mengunduh template',
      error: err.message
    })
  }
}

// Import Product from Excel Template
exports.importProduct = async (req, res) => {
  const excelFile = req.files?.['file']?.[0]
  if (!excelFile) {
    return res.status(400).json({
      success: false,
      message: 'File Excel diperlukan'
    })
  }

  try {
    const excelBuffer = fs.readFileSync(excelFile.path)
    const products = await parseProductTemplate(excelBuffer)

    if (!products.length) {
      return res.status(400).json({
        success: false,
        message: 'Data produk tidak ditemukan di file Excel'
      })
    }

    const imageFiles = req.files?.['images'] || []
    const imageMap = {}
    imageFiles.forEach((file) => {
      const baseName = file.originalname.replace(/\.[^/.]+$/, '').toLowerCase()
      imageMap[baseName] = file.path
    })

    const Supplier = db.supplier
    const TaxConfig = db.taxConfig
    const Location = db.location

    const [categories, suppliers, taxConfigs, stores] = await Promise.all([
      Category.findAll({ attributes: ['id', 'name'] }),
      Supplier.findAll({ attributes: ['id', 'name'] }),
      TaxConfig.findAll({ attributes: ['id', 'name', 'rate'] }),
      Location.findAll({ attributes: ['id', 'name'] })
    ])

    const categoryMap = categories.reduce((acc, cat) => {
      acc[cat.name.toLowerCase()] = cat.id
      return acc
    }, {})
    const supplierMap = suppliers.reduce((acc, s) => {
      acc[s.name.toLowerCase()] = s.id
      return acc
    }, {})
    const taxMap = taxConfigs.reduce((acc, t) => {
      const label = `${t.name} (${t.rate}%)`.toLowerCase()
      acc[label] = { id: t.id, name: t.name, rate: t.rate }
      return acc
    }, {})

    // ponytail: case-insensitive store name lookup for manual entry tolerance
    const storeByName = {}
    stores.forEach((s) => {
      storeByName[s.name.toLowerCase().trim()] = s.id
    })

    const parseOptions = (val) => {
      if (!val) return []
      try {
        const parsed = JSON.parse(val)
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return val
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      }
    }

    // Phase 1: Validate all products before touching DB
    const validationErrors = []
    // Fetch existing SKUs (including soft-deleted) for uniqueness check
    const existingSkus = await Product.findAll({
      attributes: ['id', 'sku', 'deletedAt'],
      paranoid: false,
      where: { sku: { [Op.ne]: null } }
    })
    const skuMap = new Map(
      existingSkus.map((p) => [p.sku, { id: p.id, deleted: !!p.deletedAt }])
    )

    for (const product of products) {
      if (!product.nameProduct) {
        validationErrors.push({ no: product.no, message: 'Nama produk kosong' })
        continue
      }
      const catId = product.category
        ? categoryMap[product.category.toLowerCase()]
        : null
      if (!catId && product.category) {
        validationErrors.push({
          no: product.no,
          message: `Kategori "${product.category}" tidak ditemukan`
        })
        continue
      }
      if (!catId) {
        validationErrors.push({
          no: product.no,
          message: 'Kategori harus diisi'
        })
        continue
      }
      // Check SKU uniqueness: skip if same product (by No) OR soft-deleted (will restore)
      if (product.sku && skuMap.has(product.sku)) {
        const owner = skuMap.get(product.sku)
        const no = parseInt(product.no)
        if (owner.id !== no && !owner.deleted) {
          validationErrors.push({
            no: product.no,
            message: `SKU "${product.sku}" sudah terdaftar`
          })
          continue
        }
      }
    }

    if (validationErrors.length) {
      const msgDetail = validationErrors
        .map((e) => `Baris ${e.no}: ${e.message}`)
        .join(', ')
      return res.status(400).json({
        success: false,
        message: `Gagal validasi (${validationErrors.length}): ${msgDetail}`,
        data: { created: [], updated: [], errors: validationErrors }
      })
    }

    // Phase 2: Upsert within transaction (No = ID)
    const sequelize = db.sequelize
    const t = await sequelize.transaction()
    const results = { created: [], updated: [], errors: [] }

    try {
      for (const product of products) {
        try {
          const categoryId = categoryMap[product.category.toLowerCase()]
          const supplierId = product.supplier
            ? supplierMap[product.supplier.toLowerCase()] || null
            : null
          const taxData = product.tax
            ? taxMap[product.tax.toLowerCase()] || null
            : null

          const statusValue =
            String(product.status).toLowerCase() === 'draft'
              ? 'draft'
              : String(product.status).toLowerCase() === 'aktif'
                ? 'active'
                : 'inactive'
          const isOptionValue = String(product.isOption).toLowerCase() === 'ya'
          const isAvailableValue =
            String(product.isAvailable).toLowerCase() === 'ya'

          const storeCell = product.store
          const storeName = storeCell ? String(storeCell).trim() : ''
          const storeNameLower = storeName.toLowerCase()
          const isAllStores = [
            '',
            'all stores',
            'pilih semua',
            'semua toko'
          ].includes(storeNameLower)
          const storeId = isAllStores
            ? null
            : storeByName[storeNameLower] || null

          // HIGH-7: Tenant admin store boundary during import
          let effectiveImportStoreId = storeId
          if (!isSuperAdmin(req)) {
            const callerStore = Number(req.storeId ?? req.user?.store)
            if (
              storeName &&
              !isAllStores &&
              storeId &&
              storeId !== callerStore
            ) {
              throw new Error(
                `Anda tidak memiliki izin untuk mengimport produk ke toko "${storeName}"`
              )
            }
            effectiveImportStoreId = callerStore
          }

          const productData = {
            nameProduct: product.nameProduct,
            sku: product.sku || null,
            barcode: product.barcode || null,
            brand: product.brand || null,
            description: product.description || null,
            category: categoryId,
            tipeProduk: product.tipeProduk || 'menu',
            unit: product.unit || 'pcs',
            baseUnit: product.baseUnit || 'pcs',
            conversionFactor: product.conversionFactor || 1,
            supplier: supplierId,
            tax: taxData ? JSON.stringify(taxData) : null,
            price: product.price || 0,
            costPrice: product.costPrice || 0,
            stock: product.stock || 0,
            minStock: product.minStock || 0,
            point: product.point || 0,
            redeemPoints: product.redeemPoints || 0,
            status: statusValue,
            isAvailable: isAvailableValue,
            isOption: isOptionValue,
            options: parseOptions(product.options)
          }

          const productFileName = product.nameProduct
            .toLowerCase()
            .replace(/\s+/g, '-')
          let imageUrl = null
          if (imageMap[productFileName]) {
            imageUrl = await uploadToCloudinary(
              imageMap[productFileName],
              'pos-app-products'
            )
          }

          const no = parseInt(product.no)
          let existingProduct = null
          if (no) {
            existingProduct = await findProductInScope(req, no, {
              transaction: t,
              paranoid: false
            })
            if (!existingProduct && !isSuperAdmin(req)) {
              const existsGlobally = await Product.findByPk(no, {
                transaction: t,
                paranoid: false
              })
              if (existsGlobally) {
                throw new Error(`Produk dengan No "${no}" milik toko lain`)
              }
            }
          }
          // Fallback: find by SKU if No didn't match (handles old templates)
          if (!existingProduct && product.sku) {
            const bySku = await Product.findOne({
              where: { sku: product.sku },
              paranoid: false,
              transaction: t
            })
            if (bySku) {
              if (!isSuperAdmin(req)) {
                const inScope = await findProductInScope(req, bySku.id, {
                  transaction: t,
                  paranoid: false
                })
                if (!inScope) {
                  throw new Error(
                    `Produk dengan SKU "${product.sku}" milik toko lain`
                  )
                }
              }
              existingProduct = bySku
            }
          }

          if (existingProduct) {
            if (existingProduct.deletedAt) {
              await existingProduct.restore({ transaction: t })
            }
            await existingProduct.update(
              {
                ...productData,
                image: imageUrl || existingProduct.image,
                modifiedBy: req.user?.id || null
              },
              { transaction: t }
            )

            // Sync junction table
            if (effectiveImportStoreId) {
              await syncProductStores(
                existingProduct.id,
                [effectiveImportStoreId],
                t
              )
            }

            results.updated.push({
              id: existingProduct.id,
              nameProduct: existingProduct.nameProduct
            })
          } else {
            const newProduct = await Product.create(
              {
                ...productData,
                image: imageUrl || null,
                createdBy: req.user?.id || null
              },
              { transaction: t }
            )

            // Create junction rows
            if (effectiveImportStoreId) {
              await syncProductStores(
                newProduct.id,
                [effectiveImportStoreId],
                t
              )
            }

            if (productData.stock > 0) {
              await StockHistory.create(
                {
                  product: newProduct.id,
                  store: effectiveImportStoreId || null,
                  referenceType: 'adjustment',
                  quantityBefore: 0,
                  quantityChange: productData.stock,
                  quantityAfter: productData.stock,
                  unit: productData.unit || 'pcs',
                  notes: 'Initial stock from import',
                  createdBy: req.user?.id || null
                },
                { transaction: t }
              )
            }

            results.created.push({
              id: newProduct.id,
              nameProduct: newProduct.nameProduct
            })
          }
        } catch (err) {
          const detail = err.errors?.[0]?.message || err.message
          results.errors.push({ no: product.no, message: detail })
          break
        }
      }

      if (results.errors.length > 0) {
        await t.rollback()
        const msgDetail = results.errors
          .map((e) => `Baris ${e.no}: ${e.message}`)
          .join(', ')
        return res.status(400).json({
          success: false,
          message: `Gagal import: ${msgDetail}`,
          data: results
        })
      }

      await t.commit()

      const totalOk = results.created.length + results.updated.length
      const msgDetail = results.errors.length
        ? `. ${results.errors.length} error: ${results.errors.map((e) => `Baris ${e.no}: ${e.message}`).join(', ')}`
        : ''
      createAudit(
        req,
        'import',
        'product',
        null,
        `Imported ${totalOk} products (${results.created.length} new, ${results.updated.length} updated)${msgDetail}`
      )

      res.status(200).json({
        success: true,
        message: `Berhasil import ${totalOk} produk${msgDetail}`,
        data: results
      })
    } catch (err) {
      await t.rollback()
      console.error('Error importing products:', err)
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: 'Gagal mengimport produk',
          error: err.message
        })
      }
    }
  } catch (err) {
    console.error('Error importing products:', err)
    res.status(500).json({
      success: false,
      message: 'Gagal mengimport produk',
      error: err.message
    })
  }
}

exports.getProductById = async (req, res) => {
  try {
    const id = req.params.id || req.query.id

    // IDOR fix: was findByPk(id) with no ownership check — product has no
    // store column, scoped through the product_store junction table.
    const product = await findProductInScope(req, id, {
      include: [
        { model: Category, as: 'categoryData', attributes: ['id', 'name'] }
      ]
    })

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      })
    }

    const data = product.toJSON()
    if (typeof data.options === 'string') {
      try {
        data.options = JSON.parse(data.options)
      } catch {
        data.options = []
      }
    }
    if (typeof data.modifiers === 'string') {
      try {
        data.modifiers = JSON.parse(data.modifiers)
      } catch {
        data.modifiers = []
      }
    }
    if (typeof data.priceTiers === 'string') {
      try {
        data.priceTiers = JSON.parse(data.priceTiers)
      } catch {
        data.priceTiers = []
      }
    }
    if (typeof data.composition === 'string') {
      try {
        data.composition = JSON.parse(data.composition)
      } catch {
        data.composition = []
      }
    }

    // Resolve store assignments from junction table
    const storeRows = (await hasProductStoreTable())
      ? await db.product_store.findAll({
          where: { product: Number(id) },
          attributes: ['store'],
          raw: true
        })
      : []
    const storeIds = storeRows.map((r) => r.store)
    const locations =
      storeIds.length > 0
        ? await db.location.findAll({
            where: { id: storeIds },
            attributes: ['id', 'name']
          })
        : []
    const locationMap = {}
    locations.forEach((l) => {
      locationMap[l.id] = l.name
    })
    data.store = storeIds.map((storeId) => ({
      id: storeId,
      name: locationMap[storeId] || null
    }))

    return res.status(200).json({
      success: true,
      message: 'Success',
      data
    })
  } catch (error) {
    console.error('Error =>', error)
    return res.status(500).json({
      success: false,
      message: 'Internal Server Error'
    })
  }
}
