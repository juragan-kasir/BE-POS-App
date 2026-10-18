const { Op } = require('sequelize')
const db = require('../../db/models')
const { recordAudit, AUDIT_ACTIONS } = require('../../utils/auditLog')
const Location = db.location
const Region = db.region
const sequelize = db.sequelize
const User = db.user
const BestSelling = db.best_selling
const Checkout = db.checkout
const Category = db.category
const Discount = db.discount
const InvoiceSetting = db.invoice_setting
const Member = db.member
const SocialMedia = db.social_media
const TypePayment = db.type_payment
const Shift = db.shift
const Ingredient = db.ingredient
const CashRegister = db.cashRegister
const DailySummary = db.daily_summary
const StockOpname = db.stockOpname
const StockHistory = db.stock_history
const PurchaseOrder = db.purchase_order

const Order = db.order
const Expense = db.expense
const Table = db.table
const MemberTier = db.member_tier
const Supplier = db.supplier
const ExpenseCategory = db.expense_category
const Position = db.position
const Role = db.role

const {
  uploadToCloudinaryWithDedup,
  deleteFromCloudinary
} = require('../../utils/cloudinaryStorage')
const { createNotification } = require('../../utils/createNotification')
const { createAudit } = require('../../utils/auditLog')
const { enrichAuditFields } = require('../../utils/auditFields')
const { resolveAuthorizationContext } = require('../../utils/authContext')
const { okPage } = require('../../utils/canonicalHttp')
const { page: pageOf, paginated } = require('../service/scopeVisibilityService')
const { assertOperationalStoreTenant, resolveRequestedLifecycleStatus } = require('../validation/schemas')

// Store ownership/lifecycle is decided from persisted authorization state
// only. req.user.store, the JWT store claim, cookies, query params and the
// request body are never ownership evidence: the body `tenantId` is at most a
// target-tenant candidate, validated against the resolved context below.
const resolveStoreLifecycleContext = (req) =>
  resolveAuthorizationContext(db, { userId: req.user?.id })

const assertApprovedTenant = async (tenantId) => {
  if (tenantId == null) {
    return { ok: true, code: null, field: null, message: null }
  }
  const tenant = await db.tenant.findByPk(tenantId, {
    attributes: ['id', 'status', 'deletedAt']
  })
  if (!tenant || tenant.deletedAt != null || tenant.status !== 'active') {
    return {
      ok: false,
      code: 'TENANT_NOT_APPROVED',
      field: 'tenantId',
      message: 'the target tenant does not exist or is not active'
    }
  }
  return { ok: true, code: null, field: null, message: null }
}

// Phase 39 Batch 6D — per-day is24Hours flag on openingHours. Defaults a
// missing/non-boolean is24Hours to false; never inferred from open===close,
// since a store could legitimately be open exactly midnight-to-midnight
// without being a 24-hour operation (e.g. a data-entry placeholder).
const normalizeOpeningHours = (hours) => {
  if (!Array.isArray(hours)) return hours
  return hours.map((entry) =>
    entry && typeof entry === 'object'
      ? { ...entry, is24Hours: typeof entry.is24Hours === 'boolean' ? entry.is24Hours : false }
      : entry
  )
}

exports.getAllLocationPublic = async (req, res) => {
  try {
    const { status } = req.query
    const whereClause = status === 'all' ? {} : { status: 'active' }
    const locations = await Location.findAll({
      where: whereClause,
      attributes: [
        'id',
        'store',
        'name',
        'city',
        'province',
        'detailLocation',
        'latitude',
        'longitude',
        'status'
      ]
    })
    return res
      .status(200)
      .json({ success: true, message: 'Success', data: locations })
  } catch (error) {
    console.error('Error:', error)
    return res
      .status(500)
      .json({ success: false, message: 'Internal Server Error' })
  }
}

exports.getAllLocationInTable = async (req, res) => {
  try {
    const userRole = req.user?.roleType
    const {
      page = 1,
      limit = 10,
      status = 'all',
      category = 'all',
      search,
      store: queryStore
    } = req.query
    const offset = (page - 1) * limit

    let whereClause = {}
    // Non-super_admin callers are pinned to their own store: the list (and
    // its stats below) must never expose another store's rows. validateStoreAccess
    // already rejected store-less non-super_admin callers, so req.user.store
    // is a real store id here.
    if (userRole !== 'super_admin') {
      whereClause.id = req.user.store
    }
    if (status === 'active' || status === 'true') {
      whereClause.status = 'active'
    } else if (status === 'inactive' || status === 'false') {
      whereClause.status = 'inactive'
    } else if (status === 'draft') {
      whereClause.status = 'draft'
    }

    if (userRole === 'super_admin' && queryStore) {
      whereClause.id = queryStore
    }

    if (search) {
      whereClause[Op.or] = [
        { name: { [Op.iLike]: `%${search}%` } },
        { detailLocation: { [Op.iLike]: `%${search}%` } },
        { phoneNumber: { [Op.iLike]: `%${search}%` } }
      ]
    }

    if (category && category !== 'all') {
      whereClause.category = category
    }

    const [total, activeCount, inactiveCount, draftCount, citiesResult] =
      await Promise.all([
        Location.count({ where: whereClause }),
        Location.count({ where: { ...whereClause, status: 'active' } }),
        Location.count({ where: { ...whereClause, status: 'inactive' } }),
        Location.count({ where: { ...whereClause, status: 'draft' } }),
        Location.findAll({
          where: whereClause,
          attributes: [
            [sequelize.fn('DISTINCT', sequelize.col('city')), 'city']
          ],
          raw: true
        })
      ])
    const citiesCount = citiesResult.filter((r) => r.city).length

    const categoriesResult = await Location.findAll({
      attributes: [
        [sequelize.fn('DISTINCT', sequelize.col('category')), 'category']
      ],
      raw: true
    })
    const categories = categoriesResult
      .map((r) => r.category)
      .filter(Boolean)
      .sort()

    const { rows: locations } = await Location.findAndCountAll({
      where: whereClause,
      limit: parseInt(limit),
      offset: parseInt(offset),
      order: [['updatedAt', 'DESC']]
    })

    await enrichAuditFields(db, locations)

    // Resolve region codes (province/city/district/village) to their names
    const regionCodes = []
    for (const loc of locations) {
      if (loc.province) regionCodes.push(['province', loc.province])
      if (loc.city) regionCodes.push(['city', loc.city])
      if (loc.district) regionCodes.push(['district', loc.district])
      if (loc.village) regionCodes.push(['village', loc.village])
    }
    const regionNameMap = {}
    if (regionCodes.length) {
      try {
        const regions = await Region.findAll({
          where: {
            [Op.or]: regionCodes.map(([level, code]) => ({ level, code }))
          },
          attributes: ['level', 'code', 'name'],
          raw: true
        })
        for (const r of regions) {
          regionNameMap[`${r.level}:${r.code}`] = r.name
        }
      } catch {
        // region table may not exist yet — fall back to raw codes
      }
    }
    const nameFor = (level, code) =>
      code ? regionNameMap[`${level}:${code}`] || code : null

    const data = locations.map((loc) => ({
      id: `loc-${String(loc.id).padStart(3, '0')}`,
      storeId: `ST-${String(loc.id).padStart(3, '0')}`,
      name: loc.name,
      // ponytail: alamat jalan ada di kolom `address`; `detailLocation` adalah
      // patokan tambahan yang boleh kosong (konsisten dgn endpoint detail)
      address: loc.address,
      phoneNumber: loc.phoneNumber,
      email: loc.email,
      image: loc.image,
      isActive: loc.status === 'active',
      status: loc.status,
      province: loc.province,
      provinceName: nameFor('province', loc.province),
      city: loc.city,
      cityName: nameFor('city', loc.city),
      district: loc.district,
      districtName: nameFor('district', loc.district),
      village: loc.village,
      villageName: nameFor('village', loc.village),
      postalCode: loc.postalCode,
      category: loc.category || 'Main Branch',
      managerName: loc.managerName,
      dailyTarget: loc.dailyTarget,
      latitude: loc.latitude,
      longitude: loc.longitude,
      openingHours: normalizeOpeningHours(loc.openingHours) || [
        { day: 'Monday', open: null, close: null, is24Hours: false },
        { day: 'Tuesday', open: null, close: null, is24Hours: false },
        { day: 'Wednesday', open: null, close: null, is24Hours: false },
        { day: 'Thursday', open: null, close: null, is24Hours: false },
        { day: 'Friday', open: null, close: null, is24Hours: false },
        { day: 'Saturday', open: null, close: null, is24Hours: false },
        { day: 'Sunday', open: null, close: null, is24Hours: false }
      ],
      socialMedia: loc.socialMedia || [],
      createdAt: loc.createdAt,
      updatedAt: loc.updatedAt,
      createdBy: loc.createdBy,
      createdByUser: loc.dataValues?.createdByUser || null,
      modifiedBy: loc.modifiedBy,
      modifiedByUser: loc.dataValues?.modifiedByUser || null
    }))

    return res.status(200).json({
      data,
      total,
      pagination: {
        total,
        totalPages: Math.ceil(total / limit),
        page: parseInt(page),
        limit: parseInt(limit)
      },
      stats: {
        total: activeCount + inactiveCount + draftCount,
        active: activeCount,
        inactive: inactiveCount,
        draft: draftCount,
        cities: citiesCount
      },
      categories
    })
  } catch (error) {
    console.error('Error:', error)
    return res.status(500).json({
      success: false,
      message: error.message || 'Internal server error'
    })
  }
}

exports.generateLocationId = async (req, res) => {
  try {
    const lastLocation = await Location.findOne({
      order: [['createdAt', 'DESC']],
      attributes: ['id']
    })

    const nextId = (lastLocation?.id || 0) + 1
    const locationId = `loc-${String(nextId).padStart(3, '0')}`

    return res.status(200).json({
      success: true,
      message: 'Location ID generated successfully',
      data: {
        locationId,
        storeId: `ST-${String(nextId).padStart(3, '0')}`
      }
    })
  } catch (error) {
    console.error('Error:', error)
    return res
      .status(500)
      .json({ success: false, message: 'Internal server error' })
  }
}

exports.addNewLocation = async (req, res) => {
  let bodyData = req.body
  if (req.body.data) {
    try {
      bodyData =
        typeof req.body.data === 'string'
          ? JSON.parse(req.body.data)
          : req.body.data
    } catch {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid JSON format in data field' })
    }
  }
  const {
    name,
    phoneNumber,
    email,
    address,
    detailLocation,
    province,
    city,
    district,
    village,
    postalCode,
    description,
    isActive,
    status,
    category,
    managerName,
    latitude,
    longitude,
    coordinates,
    mainBranch,
    openingHours,
    socialMedia,
    timezone,
    tenantId: requestedTenantId,
    _createdBy
  } = bodyData

  const imageFile = req.file

  // Handle coordinates mapping
  const finalLatitude = coordinates?.lat ?? latitude ?? null
  const finalLongitude = coordinates?.lng ?? longitude ?? null

  const resolvedStatus =
    status ||
    (isActive !== undefined ? (isActive ? 'active' : 'inactive') : 'draft')

  try {
    const lifecycleContext = await resolveStoreLifecycleContext(req)
    const lifecycle = assertOperationalStoreTenant(lifecycleContext, {
      currentStatus: null,
      requestedStatus: resolvedStatus,
      tenantId: requestedTenantId
    })
    if (!lifecycle.ok) {
      return res.status(422).json({
        success: false,
        code: lifecycle.code,
        field: lifecycle.field,
        message: lifecycle.message
      })
    }
    const approvedTenant = await assertApprovedTenant(lifecycle.tenantId)
    if (!approvedTenant.ok) {
      return res.status(422).json({
        success: false,
        code: approvedTenant.code,
        field: approvedTenant.field,
        message: approvedTenant.message
      })
    }

    // F1: sequence-authoritative allocation. A supplied locationId is
    // accepted but ignored (FE preview round-trip): the id always comes
    // from location_id_seq, which is atomic under concurrency. pg returns
    // nextval (bigint) as a string, hence the Number() conversion. The
    // legacy store mirror is set to the same value in the same INSERT, so
    // the id/store pair is atomic from readers' perspective.
    const [seqRows] = await db.sequelize.query(
      "SELECT nextval('location_id_seq') AS id"
    )
    const nextId = Number(seqRows?.[0]?.id)
    if (!Number.isSafeInteger(nextId) || nextId <= 0) {
      return res
        .status(500)
        .json({ success: false, message: 'Failed to allocate location id' })
    }

    // Check for duplicate name
    if (name) {
      const existingLocationByName = await Location.findOne({ where: { name } })
      if (existingLocationByName) {
        return res
          .status(403)
          .json({ success: false, message: 'Location already exists' })
      }
    }

    let imageUrl = null
    if (imageFile) {
      const { url } = await uploadToCloudinaryWithDedup(
        imageFile.path,
        'pos-app-locations'
      )
      const duplicate = await Location.findOne({
        where: { image: url, id: { [Op.ne]: nextId } }
      })
      if (duplicate) {
        return res.status(409).json({
          success: false,
          message: 'Gambar sudah digunakan oleh lokasi lain'
        })
      }
      imageUrl = url
    }

    const newLocation = await Location.create({
      id: nextId,
      store: nextId,
      tenantId: lifecycle.tenantId ?? null,
      image: imageUrl,
      name,
      phoneNumber,
      email,
      address,
      detailLocation,
      province,
      city,
      district,
      village,
      postalCode,
      description,
      status: resolvedStatus,
      category,
      managerName,
      latitude: finalLatitude,
      longitude: finalLongitude,
      mainBranch: mainBranch || false,
      openingHours: normalizeOpeningHours(openingHours) || [],
      socialMedia: socialMedia || [],
      timezone: timezone || undefined,
      createdBy: req.user?.id || null
    })

    const newLocationId = `loc-${String(newLocation.id).padStart(3, '0')}`
    const storeId = `ST-${String(newLocation.id).padStart(3, '0')}`

    createNotification({
      type: 'location_created',
      store: newLocation.store,
      referenceId: newLocation.id,
      referenceType: 'location',
      params: [name],
      createdBy: req.user?.fullName || 'System'
    }).catch(console.error)
    createAudit(
      req,
      'create',
      'location',
      newLocation.id,
      `Created location: ${name}`
    )

    return res.status(201).json({
      success: true,
      message: 'Location created successfully',
      data: {
        id: newLocation.id,
        locationId: newLocationId,
        storeId,
        ...newLocation.dataValues
      }
    })
  } catch (error) {
    console.error('Error:', error)
    const message = error.http_code
      ? `Gagal upload gambar: ${error.message}`
      : error.message || 'Internal server error'
    return res.status(500).json({ success: false, message })
  }
}

exports.editLocationById = async (req, res) => {
  let bodyData = req.body
  if (req.body.data) {
    try {
      bodyData =
        typeof req.body.data === 'string'
          ? JSON.parse(req.body.data)
          : req.body.data
    } catch {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid JSON format in data field' })
    }
  }
  const {
    locationId: rawId,
    id: rawIdAlt,
    name,
    status,
    _confirmUserUpdate,
    coordinates,
    _image,
    _storeId,
    location: _locationField,
    isActive,
    tenantId: requestedTenantId,
    ...rest
  } = bodyData
  const id = rawId
    ? parseInt(rawId.replace('loc-', ''))
    : rawIdAlt
      ? parseInt(String(rawIdAlt).replace('loc-', ''))
      : null
  if (!id) {
    return res.status(400).json({
      success: false,
      message: 'ID is required to update the location.'
    })
  }

  try {
    const location = await Location.findByPk(id)
    if (!location) {
      return res
        .status(404)
        .json({ success: false, message: 'Location not found.' })
    }

    const dataExist = location.dataValues
    // HB-2 R1: `status` is authoritative; a legacy `isActive` never overrides
    // it, and only actual booleans carry legacy intent (strings pass through
    // to be rejected as unknown, never coerced by truthiness).
    const requestedStatus = resolveRequestedLifecycleStatus({ status, isActive })

    const lifecycleContext = await resolveStoreLifecycleContext(req)
    const lifecycle = assertOperationalStoreTenant(lifecycleContext, {
      currentStatus: dataExist.status,
      requestedStatus,
      tenantId: requestedTenantId,
      persistedTenantId: dataExist.tenantId
    })
    if (!lifecycle.ok) {
      return res.status(422).json({
        success: false,
        code: lifecycle.code,
        field: lifecycle.field,
        message: lifecycle.message
      })
    }
    const approvedTenant = await assertApprovedTenant(lifecycle.tenantId)
    if (!approvedTenant.ok) {
      return res.status(422).json({
        success: false,
        code: approvedTenant.code,
        field: approvedTenant.field,
        message: approvedTenant.message
      })
    }

    let imageUrl = dataExist.image
    if (req.file) {
      const { url } = await uploadToCloudinaryWithDedup(
        req.file.path,
        'pos-app-locations'
      )
      const duplicate = await Location.findOne({
        where: { image: url, id: { [Op.ne]: id } }
      })
      if (duplicate) {
        return res.status(409).json({
          success: false,
          message: 'Gambar sudah digunakan oleh lokasi lain'
        })
      }
      if (dataExist.image && dataExist.image !== url) {
        await deleteFromCloudinary(dataExist.image)
      }
      imageUrl = url
    }

    const updatedData = {
      ...rest,
      image: imageUrl,
      name,
      modifiedBy: req.user?.id,
      status: requestedStatus
    }

    // A store that already has a tenant keeps it: assertOperationalStoreTenant
    // rejects any reassignment, so this only ever performs a first-time
    // assignment of a still-tenantless (non-operational migration state) store.
    if (lifecycle.tenantId != null) {
      updatedData.tenantId = lifecycle.tenantId
    }

    // Handle coordinates mapping
    if (coordinates) {
      if (coordinates.lat) updatedData.latitude = coordinates.lat
      if (coordinates.lng) updatedData.longitude = coordinates.lng
    }

    // Only touch openingHours when the caller actually sent it — omitting
    // it from an edit payload must leave the stored schedule untouched.
    if (rest.openingHours !== undefined) {
      updatedData.openingHours = normalizeOpeningHours(rest.openingHours)
    }

    const [, updatedRows] = await Location.update(updatedData, {
      returning: true,
      where: { id }
    })

    // Only propagate status changes to related models (not name)
    await batchUpdateModels(id, { status: updatedData.status })

    createNotification({
      type: 'location_updated',
      store: id,
      referenceId: id,
      referenceType: 'location',
      params: [name],
      createdBy: req.user?.fullName || 'System'
    }).catch(console.error)
    createAudit(
      req,
      'update',
      'location',
      id,
      `Updated location: ${name}`,
      dataExist,
      updatedData
    )

    return res.status(200).json({
      success: true,
      message: 'Successfully updated location.',
      data: updatedRows[0]?.dataValues || null
    })
  } catch (error) {
    console.error('Error:', error)
    const message = error.http_code
      ? `Gagal upload gambar: ${error.message}`
      : error.message || 'Internal server error'
    return res.status(500).json({ success: false, message })
  }
}

// Map model -> update payload when location is deleted
// Different models need different status handling based on their field types
const getLocationDeleteUpdates = () => [
  // Boolean status -> set status = false
  { model: Discount, update: { store: null, status: 'inactive' } },
  { model: InvoiceSetting, action: 'delete' },
  { model: Member, update: { store: null, status: 'inactive' } },
  { model: SocialMedia, update: { store: null, status: 'inactive' } },
  { model: TypePayment, update: { store: null, status: 'inactive' } },
  { model: Shift, update: { store: null, status: 'inactive' } },
  { model: Ingredient, update: { store: null, status: 'inactive' } },
  { model: MemberTier, update: { store: null, status: false } },
  { model: Supplier, update: { store: null, status: 'inactive' } },
  { model: ExpenseCategory, update: { store: null, status: 'inactive' } },
  { model: Position, update: { store: null, status: 'inactive' } },
  { model: Role, update: { store: null, status: 'inactive' } },

  // ENUM status models -> set appropriate closed/cancelled state
  { model: StockOpname, update: { store: null, status: 'cancelled' } },
  // P1-9: orders keep their store — they are financial history, and
  // detaching them would orphan the cancelled records outside every
  // store scope. (Collected-money orders already refuse deletion above.)
  { model: Order, update: { status: 'cancelled' } },
  { model: PurchaseOrder, update: { store: null, status: 'cancelled' } },
  { model: CashRegister, update: { store: null, status: 'closed' } },
  { model: Expense, update: { store: null, status: 'rejected' } },
  { model: Table, update: { store: null, status: 'maintenance' } },

  // No status field -> just null the store reference
  { model: DailySummary, update: { store: null } },
  { model: StockHistory, update: { store: null } },

  // Models without status field
  { model: Checkout, update: { store: null } },
  { model: BestSelling, update: { store: null } },

  // Special: User -> also deactivate account
  { model: User, update: { store: null, status: 'inactive' } }
]

exports.deleteLocationById = async (req, res) => {
  const { id } = req.body

  try {
    if (!id) {
      return res.status(400).json({ success: false, message: 'ID is required' })
    }
    const dbId = parseInt(id.replace('loc-', ''))

    const location = await Location.findByPk(dbId)
    if (!location) {
      return res
        .status(404)
        .json({ success: false, message: 'Location not found' })
    }

    // DR-23 (BA §35.10 G) / DR-05: the cascade below sets every order of
    // this store to 'cancelled' without any refund. An order that still
    // holds net-collected money must never be cancelled that way (money
    // would remain on a cancelled order), and DR-05 forbids rewriting
    // financial history on closure — refuse instead.
    const [collected] = await db.sequelize.query(
      `SELECT o.id
         FROM "order" o
         JOIN "transaction" t ON t."order" = o.id AND t."deletedAt" IS NULL
        WHERE o.store = :store
          AND o."deletedAt" IS NULL
          AND o.status NOT IN ('cancelled', 'void')
        GROUP BY o.id
       HAVING SUM(t.amount) > 0
        LIMIT 1`,
      { replacements: { store: dbId }, type: db.sequelize.QueryTypes.SELECT }
    )
    if (collected) {
      return res.status(409).json({
        success: false,
        code: 'STORE_HAS_COLLECTED_ORDERS',
        message: 'This location has orders holding collected payments; it cannot be deleted (retire it instead)'
      })
    }

    const entries = getLocationDeleteUpdates()

    // P1-9: the whole cascade is one atomic unit. Per-model errors used to
    // be swallowed one by one (console.error + continue) with the location
    // deleted afterwards — a failure midway left a half-detached store
    // behind. Any failure now rolls everything back and reports 500 with
    // nothing mutated.
    await db.sequelize.transaction(async (t) => {
      for (const { model, update, action } of entries) {
        if (!model) continue
        if (action === 'delete') {
          await model.destroy({ where: { store: dbId }, transaction: t })
        } else {
          await model.update(update, { where: { store: dbId }, transaction: t })
        }
      }

      // P1-9: assignment state (not history) for this store is removed:
      // product/category junction rows and per-store stock shadows. The
      // shadow quantities are first subtracted from the global
      // product.stock derived total so closing a store does not leave
      // phantom stock behind; shared catalog rows themselves are kept.
      const shadows = await db.product_store_stock.findAll({
        where: { store: dbId },
        attributes: ['product', 'stock'],
        transaction: t
      })
      for (const shadow of shadows) {
        const qty = Number(shadow.stock) || 0
        if (qty > 0) {
          await db.product.update(
            { stock: db.sequelize.literal(`GREATEST(stock - ${qty}, 0)`) },
            { where: { id: shadow.product }, transaction: t }
          )
        }
      }
      await db.product_store_stock.destroy({ where: { store: dbId }, transaction: t })
      if (db.product_store) {
        await db.product_store.destroy({ where: { store: dbId }, transaction: t })
      }
      if (db.category_store) {
        await db.category_store.destroy({ where: { store: dbId }, transaction: t })
      }

      // Hard delete the location (force: true bypasses paranoid if set)
      await Location.destroy({ where: { id: dbId }, transaction: t })
    })

    // Outside the transaction: external side effect, must never roll back
    // (or block) the already-consistent delete. A failure only logs.
    if (location.image) {
      try {
        await deleteFromCloudinary(location.image)
      } catch (imageError) {
        console.error('Error deleting location image:', imageError.message)
      }
    }

    createNotification({
      type: 'location_deleted',
      store: dbId,
      referenceId: dbId,
      referenceType: 'location',
      params: [location.name],
      createdBy: req.user?.fullName || 'System'
    }).catch(console.error)
    createAudit(
      req,
      'delete',
      'location',
      dbId,
      `Deleted location: ${location.name}`
    )

    return res
      .status(200)
      .json({ success: true, message: 'Location deleted successfully' })
  } catch (error) {
    console.error('Error:', error)
    return res
      .status(500)
      .json({ success: false, message: 'Internal server error' })
  }
}

const batchUpdateModels = async (id, updateFields) => {
  const modelsToUpdate = [
    User,
    BestSelling,
    Checkout,
    Category,
    Discount,
    InvoiceSetting,
    Member,
    SocialMedia,
    TypePayment,
    Shift,
    Ingredient,
    CashRegister,
    DailySummary,
    StockOpname,
    StockHistory,
    PurchaseOrder,
    Order,
    Expense,
    Table,
    MemberTier,
    Supplier,
    ExpenseCategory,
    Position,
    Role
  ]

  for (const model of modelsToUpdate) {
    try {
      await model.update(updateFields, { where: { store: id } })
    } catch (modelError) {
      console.error(
        `Error batch updating ${model.name || 'unknown'}:`,
        modelError.message
      )
    }
  }
}

// Shared location-detail projection (GET detail + W3 response). Extraction
// only: the exact fields and semantics built inline by getLocationById.
// `includeConfiguration` (read paths only) appends the persisted W3
// configuration fields; without it the projection is exactly the original
// one, so the locked W3 PUT response is unchanged.
const buildLocationDetailData = async (location, { includeConfiguration = false } = {}) => {
  await enrichAuditFields(db, [location])

  const regionCodes = []
  if (location.province) regionCodes.push(['province', location.province])
  if (location.city) regionCodes.push(['city', location.city])
  if (location.district) regionCodes.push(['district', location.district])
  if (location.village) regionCodes.push(['village', location.village])

  const regionNameMap = {}
  if (regionCodes.length) {
    try {
      const regions = await Region.findAll({
        where: {
          [Op.or]: regionCodes.map(([level, code]) => ({ level, code }))
        },
        attributes: ['level', 'code', 'name'],
        raw: true
      })
      for (const r of regions) {
        regionNameMap[`${r.level}:${r.code}`] = r.name
      }
    } catch {
      // region table may not exist yet — fall back to raw codes
    }
  }
  const nameFor = (level, code) =>
    code ? regionNameMap[`${level}:${code}`] || code : null

  const data = {
    id: `loc-${String(location.id).padStart(3, '0')}`,
    storeId: `ST-${String(location.id).padStart(3, '0')}`,
    name: location.name,
    address: location.address,
    detailLocation: location.detailLocation,
    phoneNumber: location.phoneNumber,
    email: location.email,
    image: location.image,
    isActive: location.status === 'active',
    status: location.status,
    city: location.city,
    cityName: nameFor('city', location.city),
    province: location.province,
    provinceName: nameFor('province', location.province),
    district: location.district,
    districtName: nameFor('district', location.district),
    village: location.village,
    villageName: nameFor('village', location.village),
    postalCode: location.postalCode,
    category: location.category || 'Main Branch',
    managerName: location.managerName,
    latitude: location.latitude,
    longitude: location.longitude,
    mainBranch: location.mainBranch,
    dailyTarget: location.dailyTarget,
    createdAt: location.createdAt,
    updatedAt: location.updatedAt,
    createdBy: location.createdBy,
    createdByUser: location.dataValues?.createdByUser || null,
    modifiedBy: location.modifiedBy,
    modifiedByUser: location.dataValues?.modifiedByUser || null,
    openingHours: normalizeOpeningHours(location.openingHours) || [
      { day: 'Monday', open: null, close: null, is24Hours: false },
      { day: 'Tuesday', open: null, close: null, is24Hours: false },
      { day: 'Wednesday', open: null, close: null, is24Hours: false },
      { day: 'Thursday', open: null, close: null, is24Hours: false },
      { day: 'Friday', open: null, close: null, is24Hours: false },
      { day: 'Saturday', open: null, close: null, is24Hours: false },
      { day: 'Sunday', open: null, close: null, is24Hours: false }
    ],
    socialMedia: location.socialMedia || []
  }

  if (includeConfiguration) {
    // Persisted values as stored; a null parked-cart value means "use the
    // built-in default" (see the location model), so it is not resolved here.
    data.description = location.description ?? null
    data.timezone = location.timezone ?? null
    data.maxActiveParkedCarts = location.maxActiveParkedCarts ?? null
    data.parkedCartTtlMinutes = location.parkedCartTtlMinutes ?? null
  }

  return data
}

exports.getLocationById = async (req, res) => {
  const { locationId } = req.params

  try {
    if (!locationId) {
      return res
        .status(400)
        .json({ success: false, message: 'Location ID is required' })
    }
    const dbId = parseInt(locationId.replace('loc-', ''))

    // C-7: a location record IS a store (its own id is the tenant's store
    // id) — Location.findByPk(dbId) with no ownership check let any
    // authenticated user read ANY store's contact/business data (email,
    // managerName, dailyTarget, phoneNumber, ...) by guessing loc-N. This
    // route intentionally allows "all authenticated users" (no requireRole)
    // to view a location's own profile — non-super-admin must be pinned to
    // req.storeId (their own store); super_admin keeps the existing global
    // access. Same 404 for both "not found" and "not yours" so probing
    // foreign ids can't be distinguished from a nonexistent one.
    if (
      req.user?.roleType !== 'super_admin' &&
      Number(dbId) !== Number(req.storeId)
    ) {
      return res
        .status(404)
        .json({ success: false, message: 'Location not found' })
    }

    const location = await Location.findByPk(dbId)
    if (!location) {
      return res
        .status(404)
        .json({ success: false, message: 'Location not found' })
    }

    const data = await buildLocationDetailData(location, { includeConfiguration: true })

    res.set('Cache-Control', 'no-cache, no-store, must-revalidate')
    return res.status(200).json({ success: true, message: 'Success', data })
  } catch (error) {
    console.error('Error:', error)
    return res
      .status(500)
      .json({ success: false, message: 'Internal Server Error' })
  }
}

// W3 store-configuration scope resolver for requireCanonicalPermission.
// Loads the persisted target row (including soft-deleted, so the handler
// itself can answer 404) and returns ONLY its ownership as scope — never
// request input as authority. Missing/malformed selectors resolve to a
// denying scope, so absent, foreign and malformed targets are uniformly
// 403 (no existence revelation). Tenantless rows stay platform-only.
const storeConfigurationDenyScope = () => ({
  tenantId: 'w3-missing',
  storeId: 'w3-missing'
})

const storeConfigurationScope = async (req) => {
  let raw = req.body?.id
  if (raw == null && typeof req.body?.data === 'string') {
    try {
      raw = JSON.parse(req.body.data)?.id
    } catch {
      raw = null
    }
  }
  const match = /^loc-([1-9]\d*)$/.exec(String(raw ?? ''))
  if (!match) return storeConfigurationDenyScope()
  const row = await Location.findByPk(Number(match[1]), {
    attributes: ['id', 'tenantId', 'deletedAt'],
    paranoid: false
  })
  if (!row) return storeConfigurationDenyScope()
  if (row.tenantId == null && req.authContext?.isPlatformAdmin !== true) {
    return storeConfigurationDenyScope()
  }
  // A soft-deleted row carries no store pin: the permission gate passes for
  // an otherwise-authorized actor and the handler below answers 404, so
  // own-deleted rows 404 while foreign-deleted rows stay uniformly 403.
  if (row.deletedAt != null) return { tenantId: row.tenantId }
  return { tenantId: row.tenantId, storeId: row.id }
}

// W3 store configuration: explicit allowlist only. The persistence object
// below names every written column; there is no ...rest. Lifecycle (status)
// and ownership (id, store, tenantId) are untouched by construction: the
// schema rejects those keys before this handler runs.
const W3_TERMINAL_STORE_STATUSES = Object.freeze([
  'closed',
  'retired',
  'quarantined'
])

const W3_CONFIG_FIELDS = Object.freeze([
  'name',
  'phoneNumber',
  'email',
  'address',
  'detailLocation',
  'province',
  'city',
  'district',
  'village',
  'postalCode',
  'description',
  'category',
  'managerName',
  'latitude',
  'longitude',
  'socialMedia',
  'timezone',
  'mainBranch',
  'dailyTarget',
  'maxActiveParkedCarts',
  'parkedCartTtlMinutes'
])

exports.updateStoreConfiguration = async (req, res) => {
  const ctx = req.authContext
  const dbId = parseInt(String(req.body?.id).replace('loc-', ''), 10)

  try {
    const location = await Location.findByPk(dbId, { paranoid: false })
    if (!location || location.deletedAt != null) {
      return res
        .status(404)
        .json({ success: false, message: 'Location not found.' })
    }

    // W3 terminal policy (locked): configuration edits are blocked on
    // closed/retired/quarantined stores.
    if (W3_TERMINAL_STORE_STATUSES.includes(location.status)) {
      return res.status(422).json({
        success: false,
        code: 'STORE_STATUS_IRREVERSIBLE',
        field: 'currentStatus',
        message: `${location.status} stores cannot be reconfigured by request`
      })
    }

    // Tenantless rows are platform-only (defense in depth; the permission
    // gate already denies these for non-platform actors).
    if (location.tenantId == null && ctx?.isPlatformAdmin !== true) {
      return res.status(403).json({
        message: 'Akses Ditolak - Anda tidak memiliki izin',
        code: 'FORBIDDEN'
      })
    }

    const before = { ...location.dataValues }
    const updates = {}
    for (const field of W3_CONFIG_FIELDS) {
      if (req.body[field] !== undefined) updates[field] = req.body[field]
    }

    // Only touch openingHours when the caller actually sent it — omitting
    // it must leave the stored schedule untouched.
    if (req.body.openingHours !== undefined) {
      updates.openingHours = normalizeOpeningHours(req.body.openingHours)
    }

    // Image: an uploaded file wins (existing Cloudinary flow); otherwise an
    // explicit body image value (URL or null-clear) is honored; otherwise
    // the stored image is retained.
    if (req.file) {
      const { url } = await uploadToCloudinaryWithDedup(
        req.file.path,
        'pos-app-locations'
      )
      const duplicate = await Location.findOne({
        where: { image: url, id: { [Op.ne]: dbId } }
      })
      if (duplicate) {
        return res.status(409).json({
          success: false,
          message: 'Gambar sudah digunakan oleh lokasi lain'
        })
      }
      if (location.image && location.image !== url) {
        await deleteFromCloudinary(location.image)
      }
      updates.image = url
    } else if (req.body.image !== undefined) {
      updates.image = req.body.image
    }

    if (Object.keys(updates).length > 0) {
      updates.modifiedBy = req.user?.id
      await Location.update(updates, { where: { id: dbId } })
    }

    const fresh = await Location.findByPk(dbId)
    const data = await buildLocationDetailData(fresh)

    if (Object.keys(updates).length > 0) {
      createNotification({
        type: 'location_updated',
        store: dbId,
        referenceId: dbId,
        referenceType: 'location',
        params: [fresh.name],
        createdBy: req.user?.fullName || 'System'
      }).catch(console.error)
      createAudit(
        req,
        'update',
        'location',
        dbId,
        `Updated store configuration: ${fresh.name}`,
        before,
        updates
      )
    }

    return res.status(200).json({
      success: true,
      message: 'Store configuration updated successfully.',
      data
    })
  } catch (error) {
    console.error('Error:', error)
    const message = error.http_code
      ? `Gagal upload gambar: ${error.message}`
      : error.message || 'Internal server error'
    return res.status(500).json({ success: false, message })
  }
}

exports.storeConfigurationScope = storeConfigurationScope

// W3 read follow-up: canonical store-configuration reads. Same admission as
// the W3 mutation (requireCanonicalPermission('store.manage')) and the same
// ownership-only scope semantics, so a store is readable here exactly when it
// is configurable there — except terminal stores, which are readable (only
// their mutation is 422). Legacy req.storeId is never consulted.

// Mirrors storeConfigurationScope for the path selector: missing, malformed
// (incl. zero-padded), foreign and tenantless-for-non-platform targets all
// resolve to the denying scope (uniform 403); an authorized soft-deleted row
// carries no store pin so the handler answers 404.
const storeConfigurationReadScope = async (req) => {
  const match = /^loc-([1-9]\d*)$/.exec(String(req.params?.id ?? ''))
  if (!match) return storeConfigurationDenyScope()
  const row = await Location.findByPk(Number(match[1]), {
    attributes: ['id', 'tenantId', 'deletedAt'],
    paranoid: false
  })
  if (!row) return storeConfigurationDenyScope()
  if (row.tenantId == null && req.authContext?.isPlatformAdmin !== true) {
    return storeConfigurationDenyScope()
  }
  if (row.deletedAt != null) return { tenantId: row.tenantId }
  return { tenantId: row.tenantId, storeId: row.id }
}

// Collection scope for the list: the server-resolved active tenant only
// (never request input). canAccessResource then admits a tenant actor or a
// platform actor inside that tenant, and — with no tenant — a platform actor
// alone; a non-platform actor without an active tenant is denied.
const storeConfigurationListScope = (req) => ({
  tenantId: req.authContext?.activeTenantId ?? null
})

const forbidden = (res) =>
  res.status(403).json({
    message: 'Akses Ditolak - Anda tidak memiliki izin',
    code: 'FORBIDDEN'
  })

exports.getStoreConfiguration = async (req, res) => {
  const ctx = req.authContext
  const dbId = parseInt(String(req.params.id).replace('loc-', ''), 10)

  try {
    const location = await Location.findByPk(dbId, { paranoid: false })
    if (!location || location.deletedAt != null) {
      return res
        .status(404)
        .json({ success: false, message: 'Location not found.' })
    }

    // Tenantless rows are platform-only (defense in depth; the permission
    // gate already denies these for non-platform actors).
    if (location.tenantId == null && ctx?.isPlatformAdmin !== true) {
      return forbidden(res)
    }

    const data = await buildLocationDetailData(location, { includeConfiguration: true })

    res.set('Cache-Control', 'no-cache, no-store, must-revalidate')
    return res.status(200).json({ success: true, message: 'Success', data })
  } catch (error) {
    console.error('Error:', error)
    return res
      .status(500)
      .json({ success: false, message: 'Internal Server Error' })
  }
}

// Readable set: with an active tenant (tenant_admin, or a platform actor that
// selected a tenant) exactly the context's tenant store roster; a platform
// actor without a tenant reads platform-wide, tenantless rows included.
// Soft-deleted rows never appear (paranoid default). Pagination follows the
// T-03B canonical list contract.
exports.listStoreConfigurations = async (req, res) => {
  const ctx = req.authContext

  try {
    let where = {}
    if (ctx?.activeTenantId != null) {
      where = { id: (ctx.tenantStoreIds || []).map(Number) }
    } else if (ctx?.isPlatformAdmin !== true) {
      return forbidden(res)
    }

    const paging = pageOf(req.query || {})
    const { count, rows } = await Location.findAndCountAll({
      where,
      order: [['id', 'ASC']],
      limit: paging.limit,
      offset: paging.offset
    })

    const items = []
    for (const row of rows) {
      items.push(await buildLocationDetailData(row, { includeConfiguration: true }))
    }

    res.set('Cache-Control', 'no-cache, no-store, must-revalidate')
    return okPage(res, paginated(items, paging, count))
  } catch (error) {
    console.error('Error:', error)
    return res
      .status(500)
      .json({ success: false, message: 'Internal Server Error' })
  }
}

exports.storeConfigurationReadScope = storeConfigurationReadScope
exports.storeConfigurationListScope = storeConfigurationListScope

// DR-24 C-04 / DR-05 (§35.7): outlet closure is an archive — reversible,
// audited, and fail-closed while the outlet still carries live operations.
// Financial/history rows are never rewritten; the destructive legacy
// /delete-location remains for purge scenarios and is untouched.
const resolveArchiveTarget = async (req) => {
  const { id } = req.body
  if (id === undefined || id === null || id === '') {
    return {
      error: { status: 400, body: { success: false, code: 'LOCATION_ID_REQUIRED', message: 'id is required' } }
    }
  }
  const dbId = parseInt(String(id).replace('loc-', ''), 10)
  if (!Number.isInteger(dbId) || dbId <= 0) {
    return {
      error: { status: 400, body: { success: false, code: 'INVALID_LOCATION_ID', message: 'Invalid location id' } }
    }
  }
  const location = await Location.findByPk(dbId)
  if (!location) {
    return {
      error: { status: 404, body: { success: false, code: 'LOCATION_NOT_FOUND', message: 'Location not found' } }
    }
  }
  // D-09: a client admin is store-bound; only the platform super_admin may
  // act on an arbitrary outlet.
  if (req.user.roleType !== 'super_admin' && Number(req.user.store) !== dbId) {
    return {
      error: {
        status: 403,
        body: { success: false, code: 'STORE_SCOPE_DENIED', message: 'This outlet is outside your scope' }
      }
    }
  }
  return { location }
}

const readArchiveReason = (req) => (typeof req.body.reason === 'string' ? req.body.reason.trim() : '')

const archivePreconditionFailure = async (storeId) => {
  const openRegisters = await db.cashRegister.count({ where: { store: storeId, status: 'open' } })
  if (openRegisters > 0) {
    return {
      status: 409,
      body: {
        success: false,
        code: 'STORE_HAS_OPEN_REGISTERS',
        message: `This outlet still has ${openRegisters} open cash register(s); close them before archiving`
      }
    }
  }
  const unsettledOrders = await db.order.count({
    where: { store: storeId, status: { [Op.notIn]: ['paid', 'cancelled', 'void'] } }
  })
  if (unsettledOrders > 0) {
    return {
      status: 409,
      body: {
        success: false,
        code: 'STORE_HAS_UNSETTLED_ORDERS',
        message: `This outlet still has ${unsettledOrders} unsettled order(s); settle or cancel them before archiving`
      }
    }
  }
  const inTransit = await db.stock_transfer.count({
    where: {
      [Op.or]: [{ fromStore: storeId }, { toStore: storeId }],
      status: { [Op.notIn]: ['received', 'cancelled', 'rejected'] }
    }
  })
  if (inTransit > 0) {
    return {
      status: 409,
      body: {
        success: false,
        code: 'STORE_HAS_IN_TRANSIT_TRANSFERS',
        message: `This outlet still has ${inTransit} stock transfer(s) in transit; complete or cancel them before archiving`
      }
    }
  }
  return null
}

exports.archiveLocationById = async (req, res) => {
  try {
    const { location, error } = await resolveArchiveTarget(req)
    if (error) return res.status(error.status).json(error.body)

    // A reason is mandatory for this elevated action (D-03).
    const reason = readArchiveReason(req)
    if (!reason) {
      return res.status(400).json({
        success: false,
        code: 'ARCHIVE_REASON_REQUIRED',
        message: 'A reason is required to archive an outlet'
      })
    }

    if (location.status === 'archived') {
      return res.status(400).json({
        success: false,
        code: 'STORE_ALREADY_ARCHIVED',
        message: 'This outlet is already archived'
      })
    }

    const precondition = await archivePreconditionFailure(location.id)
    if (precondition) return res.status(precondition.status).json(precondition.body)

    const previousStatus = location.status
    await location.update({ status: 'archived', modifiedBy: req.user.id })

    await recordAudit({
      actor: { id: req.user.id, name: req.user.userName },
      req,
      action: AUDIT_ACTIONS.STATUS_CHANGE,
      entity: 'location',
      entityId: location.id,
      storeId: location.id,
      result: 'SUCCESS',
      reason,
      previousState: { status: previousStatus },
      newState: { status: 'archived' },
      metadata: { channel: 'location-management' }
    })

    return res.status(200).json({
      success: true,
      message: 'Location archived',
      data: { id: location.id, status: 'archived' }
    })
  } catch (error) {
    console.error('Error:', error)
    return res.status(500).json({ success: false, message: 'Internal Server Error' })
  }
}

exports.reactivateLocationById = async (req, res) => {
  try {
    const { location, error } = await resolveArchiveTarget(req)
    if (error) return res.status(error.status).json(error.body)

    const reason = readArchiveReason(req)
    if (!reason) {
      return res.status(400).json({
        success: false,
        code: 'REACTIVATE_REASON_REQUIRED',
        message: 'A reason is required to reactivate an outlet'
      })
    }

    if (location.status !== 'archived') {
      return res.status(400).json({
        success: false,
        code: 'STORE_NOT_ARCHIVED',
        message: 'This outlet is not archived'
      })
    }

    const previousStatus = location.status
    await location.update({ status: 'active', modifiedBy: req.user.id })

    await recordAudit({
      actor: { id: req.user.id, name: req.user.userName },
      req,
      action: AUDIT_ACTIONS.STATUS_CHANGE,
      entity: 'location',
      entityId: location.id,
      storeId: location.id,
      result: 'SUCCESS',
      reason,
      previousState: { status: previousStatus },
      newState: { status: 'active' },
      metadata: { channel: 'location-management' }
    })

    return res.status(200).json({
      success: true,
      message: 'Location reactivated',
      data: { id: location.id, status: 'active' }
    })
  } catch (error) {
    console.error('Error:', error)
    return res.status(500).json({ success: false, message: 'Internal Server Error' })
  }
}
