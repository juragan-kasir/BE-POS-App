const db = require('../../db/models')
const { Op } = require('sequelize')
const { createAudit } = require('../../utils/auditLog')
const { resolveStoreId } = require('../../utils/tenantScope')

const isGlobalSuperAdmin = (req) =>
  req.user?.roleType === 'super_admin' && req.user?.store == null

const boundStoreId = (req) => {
  const store = Number(req.user?.store)
  return Number.isInteger(store) && store > 0 ? store : null
}

const scopedStoreId = (req) => {
  if (isGlobalSuperAdmin(req)) {
    const resolved = resolveStoreId(req)
    return resolved == null ? null : Number(resolved)
  }
  return boundStoreId(req)
}

const tripStoreWhere = (req, where = {}) => {
  const store = scopedStoreId(req)
  if (store != null) return { ...where, store }
  if (isGlobalSuperAdmin(req)) return { ...where }
  return { ...where, store: -1 }
}

const isValidDateOnly = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`))

const isNonNegativeNumber = (value) =>
  value !== null &&
  value !== undefined &&
  value !== '' &&
  Number.isFinite(Number(value)) &&
  Number(value) >= 0

const validateTripPayload = (body, { partial = false } = {}) => {
  const has = (key) => body[key] !== undefined
  const error = (message) => ({ ok: false, message })

  if (!partial || has('destination')) {
    if (typeof body.destination !== 'string' || body.destination.trim() === '') {
      return error('destination wajib diisi')
    }
  }
  if (!partial || has('departureDate')) {
    if (!isValidDateOnly(body.departureDate)) {
      return error('departureDate tidak valid (format YYYY-MM-DD)')
    }
  }
  if (!partial || has('returnDate')) {
    if (!isValidDateOnly(body.returnDate)) {
      return error('returnDate tidak valid (format YYYY-MM-DD)')
    }
  }
  if (has('budget') && body.budget !== null && !isNonNegativeNumber(body.budget)) {
    return error('budget harus berupa angka >= 0')
  }
  if (has('budgetItems')) {
    if (!Array.isArray(body.budgetItems)) {
      return error('budgetItems harus berupa array')
    }
    for (const item of body.budgetItems) {
      if (!item || typeof item !== 'object') {
        return error('Item budget tidak valid')
      }
      if (!isNonNegativeNumber(item.qty ?? 0)) {
        return error('qty budget harus berupa angka >= 0')
      }
      if (!isNonNegativeNumber(item.tarif ?? 0)) {
        return error('tarif budget harus berupa angka >= 0')
      }
      if (item.komponen != null && typeof item.komponen !== 'string') {
        return error('komponen budget harus berupa teks')
      }
    }
  }
  if (has('employees') && !Array.isArray(body.employees)) {
    return error('employees harus berupa array')
  }
  return { ok: true }
}

const assertDateOrder = (departureDate, returnDate) => {
  if (
    isValidDateOnly(departureDate) &&
    isValidDateOnly(returnDate) &&
    returnDate < departureDate
  ) {
    return 'returnDate tidak boleh sebelum departureDate'
  }
  return null
}

const validateEmployeesForStore = async (employeeRows, store) => {
  if (store == null || !Array.isArray(employeeRows) || employeeRows.length === 0) {
    return null
  }
  for (const row of employeeRows) {
    if (row.employeeId == null) continue
    const employee = await db.user.findOne({ where: { id: row.employeeId } })
    if (!employee) return { status: 404, message: 'Employee not found' }
    if (employee.store != null && Number(employee.store) !== Number(store)) {
      return {
        status: 400,
        message: 'Selected employee does not belong to the selected store'
      }
    }
  }
  return null
}

const validateSingleEmployeeForStore = async (employeeId, store) => {
  if (employeeId == null || store == null) return null
  const employee = await db.user.findOne({ where: { id: employeeId } })
  if (!employee) return { status: 404, message: 'Employee not found' }
  if (employee.store != null && Number(employee.store) !== Number(store)) {
    return {
      status: 400,
      message: 'Selected employee does not belong to the selected store'
    }
  }
  return null
}

const generateTripNumber = () => {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const random = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, '0')
  return `BT-${year}${month}${day}-${random}`
}

const normalizeBudgetItems = (items = []) =>
  items.map((it) => {
    const qty = it.qty == null ? 0 : Number(it.qty)
    const tarif = it.tarif == null ? 0 : Number(it.tarif)
    return {
      komponen: it.komponen || '',
      qty,
      satuan: it.satuan || '',
      tarif,
      total: qty * tarif,
      catatan: it.catatan || ''
    }
  })

const mapIncludes = (tripSeq) => {
  const employees = (tripSeq.employees || []).map((e) => ({
    id: e.id,
    employeeId: e.employeeId,
    employeeName: e.employeeName,
    employeePosition: e.employeePosition,
    employeeUser: e.employeeUser || null
  }))
  const budgetItems = (tripSeq.budgetItems || []).map((b) => ({
    id: b.id,
    komponen: b.komponen,
    qty: b.qty,
    satuan: b.satuan,
    tarif: b.tarif,
    total: b.total,
    catatan: b.catatan
  }))
  return { employees, budgetItems }
}

const tripInclude = (dbModels) => [
  { model: dbModels.location, as: 'storeData', attributes: ['id', 'name'] },
  {
    model: dbModels.user,
    as: 'employeeUser',
    attributes: ['id', 'userName', 'fullName']
  },
  {
    model: dbModels.user,
    as: 'approvedByUser',
    attributes: ['id', 'userName', 'fullName']
  },
  {
    model: dbModels.user,
    as: 'createdByUser',
    attributes: ['id', 'userName', 'fullName']
  },
  {
    model: dbModels.user,
    as: 'modifiedByUser',
    attributes: ['id', 'userName', 'fullName']
  },
  {
    model: dbModels.businessTripEmployee,
    as: 'employees',
    include: [
      {
        model: dbModels.user,
        as: 'employeeUser',
        attributes: ['id', 'userName', 'fullName']
      }
    ]
  },
  { model: dbModels.businessTripBudgetItem, as: 'budgetItems' }
]

const businessTripController = {
  async getAll(req, res) {
    try {
      const { status, search, queryStore } = req.query
      const page = Math.max(1, parseInt(req.query.page, 10) || 1)
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10))
      const where = {}
      const global = isGlobalSuperAdmin(req)
      const effectiveStore = scopedStoreId(req)

      if (queryStore && global) where.store = Number(queryStore)
      else if (effectiveStore != null) where.store = effectiveStore
      else if (!global) where.store = -1

      if (status) where.status = status

      if (search) {
        where[Op.or] = [
          { tripNumber: { [Op.iLike]: `%${search}%` } },
          { employeeName: { [Op.iLike]: `%${search}%` } },
          { destination: { [Op.iLike]: `%${search}%` } },
          { '$storeData.name$': { [Op.iLike]: `%${search}%` } }
        ]
      }

      const offset = (page - 1) * limit

      const [trips, total, pendingCount, approvedCount, rejectedCount] =
        await Promise.all([
          db.businessTrip.findAll({
            where,
            include: tripInclude(db),
            order: [['updatedAt', 'DESC']],
            limit,
            offset
          }),
          db.businessTrip.count({ where }),
          db.businessTrip.count({ where: { ...where, status: 'pending' } }),
          db.businessTrip.count({ where: { ...where, status: 'approved' } }),
          db.businessTrip.count({ where: { ...where, status: 'rejected' } })
        ])

      const data = trips.map((trip) => {
        const { employees, budgetItems } = mapIncludes(trip)
        return {
          id: trip.id,
          tripNumber: trip.tripNumber,
          status: trip.status,
          employeeName: trip.employeeName,
          destination: trip.destination,
          departureDate: trip.departureDate,
          returnDate: trip.returnDate,
          budget: trip.budget,
          employees,
          budgetItems,
          budgetTotal: budgetItems.reduce((s, b) => s + Number(b.total || 0), 0),
          store: trip.storeData
            ? { id: trip.storeData.id, name: trip.storeData.name }
            : null,
          createdByUser: trip.createdByUser,
          modifiedByUser: trip.modifiedByUser,
          approvedByUser: trip.approvedByUser,
          createdAt: trip.createdAt,
          updatedAt: trip.updatedAt
        }
      })

      return res.status(200).json({
        success: true,
        message: 'Success',
        data,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        },
        stats: {
          total,
          pending: pendingCount,
          approved: approvedCount,
          rejected: rejectedCount
        }
      })
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async getById(req, res) {
    try {
      const { id } = req.params
      const trip = await db.businessTrip.findOne({
        where: tripStoreWhere(req, { id }),
        include: tripInclude(db)
      })
      if (!trip) {
        return res
          .status(404)
          .json({ success: false, message: 'Business trip not found' })
      }
      return res
        .status(200)
        .json({ success: true, message: 'Success', data: trip })
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async create(req, res) {
    try {
      const resBody = req.body || {}
      const global = isGlobalSuperAdmin(req)
      const requestedStore =
        resBody.store === undefined || resBody.store === null || resBody.store === ''
          ? null
          : Number(resBody.store)
      const store = global ? requestedStore ?? scopedStoreId(req) : boundStoreId(req)

      if (!global && store == null) {
        return res.status(403).json({
          success: false,
          message: 'Store assignment required'
        })
      }
      if (!global && requestedStore != null && requestedStore !== store) {
        return res.status(403).json({
          success: false,
          message: 'Tidak dapat membuat business trip untuk toko lain'
        })
      }

      const payloadCheck = validateTripPayload(resBody)
      if (!payloadCheck.ok) {
        return res.status(400).json({ success: false, message: payloadCheck.message })
      }
      const dateError = assertDateOrder(resBody.departureDate, resBody.returnDate)
      if (dateError) {
        return res.status(400).json({ success: false, message: dateError })
      }

      const {
        employeeId,
        employeeName,
        employeePosition,
        employees,
        budgetItems,
        destination,
        tripPurpose,
        departureDate,
        returnDate,
        budget,
        notes
      } = resBody
      const createdBy = req.user?.id || null

      const employeeRows = Array.isArray(employees)
        ? employees.map((e) => ({
            employeeId: e.employeeId != null ? Number(e.employeeId) : null,
            employeeName: e.employeeName || '',
            employeePosition: e.employeePosition || ''
          }))
        : []

      const employeeError =
        (await validateEmployeesForStore(employeeRows, store)) ||
        (await validateSingleEmployeeForStore(employeeId, store))
      if (employeeError) {
        return res
          .status(employeeError.status)
          .json({ success: false, message: employeeError.message })
      }

      const tripNumber = generateTripNumber()
      const trip = await db.sequelize.transaction(async (transaction) => {
        const created = await db.businessTrip.create(
          {
            tripNumber,
            store: store ?? null,
            status: 'draft',
            employeeId: employeeId || null,
            employeeName: employeeName || '',
            employeePosition: employeePosition || '',
            destination,
            tripPurpose: tripPurpose || '',
            departureDate,
            returnDate,
            budget: budget == null ? null : budget,
            notes: notes || '',
            createdBy
          },
          { transaction }
        )

        if (employeeRows.length > 0) {
          await db.businessTripEmployee.bulkCreate(
            employeeRows.map((r) => ({ ...r, tripId: created.id })),
            { transaction }
          )
        }
        const budgetRows = normalizeBudgetItems(budgetItems)
        if (budgetRows.length > 0) {
          await db.businessTripBudgetItem.bulkCreate(
            budgetRows.map((r) => ({ ...r, tripId: created.id })),
            { transaction }
          )
        }
        return created
      })

      await createAudit(
        req,
        'create',
        'business_trip',
        trip.id,
        'Created business_trip: ' + trip.id
      )

      const created = await db.businessTrip.findOne({
        where: tripStoreWhere(req, { id: trip.id }),
        include: tripInclude(db)
      })
      return res.status(201).json({
        success: true,
        message: 'Success create business trip',
        data: created
      })
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async update(req, res) {
    try {
      const { id } = req.params
      const resBody = req.body || {}
      const global = isGlobalSuperAdmin(req)

      const trip = await db.businessTrip.findOne({
        where: tripStoreWhere(req, { id })
      })
      if (!trip) {
        return res
          .status(404)
          .json({ success: false, message: 'Business trip not found' })
      }
      if (!['draft', 'pending', 'rejected'].includes(trip.status)) {
        return res.status(400).json({
          success: false,
          message: 'Only draft, pending or rejected business trip can be updated'
        })
      }

      const requestedStore =
        resBody.store === undefined || resBody.store === null || resBody.store === ''
          ? null
          : Number(resBody.store)
      if (!global && requestedStore != null && requestedStore !== Number(trip.store)) {
        return res.status(403).json({
          success: false,
          message: 'Tidak dapat memindahkan business trip ke toko lain'
        })
      }
      const effectiveStore = global
        ? requestedStore ?? (trip.store == null ? null : Number(trip.store))
        : Number(trip.store)

      const payloadCheck = validateTripPayload(resBody, { partial: true })
      if (!payloadCheck.ok) {
        return res.status(400).json({ success: false, message: payloadCheck.message })
      }

      const fields = [
        'employeeId',
        'employeeName',
        'employeePosition',
        'destination',
        'tripPurpose',
        'departureDate',
        'returnDate',
        'budget',
        'notes'
      ]
      const patch = { modifiedBy: req.user?.id || null }
      for (const f of fields) {
        if (resBody[f] !== undefined) patch[f] = resBody[f]
      }
      if (global && requestedStore != null) patch.store = requestedStore
      if (trip.status === 'rejected') patch.status = 'draft'

      const effectiveDeparture = patch.departureDate ?? trip.departureDate
      const effectiveReturn = patch.returnDate ?? trip.returnDate
      const dateError = assertDateOrder(effectiveDeparture, effectiveReturn)
      if (dateError) {
        return res.status(400).json({ success: false, message: dateError })
      }

      let employeeRows = null
      if (Array.isArray(resBody.employees)) {
        employeeRows = resBody.employees.map((e) => ({
          employeeId: e.employeeId != null ? Number(e.employeeId) : null,
          employeeName: e.employeeName || '',
          employeePosition: e.employeePosition || ''
        }))
        const employeeError = await validateEmployeesForStore(employeeRows, effectiveStore)
        if (employeeError) {
          return res
            .status(employeeError.status)
            .json({ success: false, message: employeeError.message })
        }
      }

      const effectiveEmployeeId =
        patch.employeeId !== undefined ? patch.employeeId : trip.employeeId
      const singleEmployeeError = await validateSingleEmployeeForStore(
        effectiveEmployeeId,
        effectiveStore
      )
      if (singleEmployeeError) {
        return res
          .status(singleEmployeeError.status)
          .json({ success: false, message: singleEmployeeError.message })
      }

      await db.sequelize.transaction(async (transaction) => {
        await trip.update(patch, { transaction })

        if (employeeRows) {
          await db.businessTripEmployee.destroy({
            where: { tripId: trip.id },
            transaction,
            force: true
          })
          if (employeeRows.length > 0) {
            await db.businessTripEmployee.bulkCreate(
              employeeRows.map((r) => ({ ...r, tripId: trip.id })),
              { transaction }
            )
          }
        }

        if (Array.isArray(resBody.budgetItems)) {
          const budgetRows = normalizeBudgetItems(resBody.budgetItems)
          await db.businessTripBudgetItem.destroy({
            where: { tripId: trip.id },
            transaction,
            force: true
          })
          if (budgetRows.length > 0) {
            await db.businessTripBudgetItem.bulkCreate(
              budgetRows.map((r) => ({ ...r, tripId: trip.id })),
              { transaction }
            )
          }
        }
      })

      await createAudit(
        req,
        'update',
        'business_trip',
        trip.id,
        'Updated business_trip: ' + trip.id
      )

      const updated = await db.businessTrip.findOne({
        where: tripStoreWhere(req, { id: trip.id }),
        include: tripInclude(db)
      })
      return res
        .status(200)
        .json({ success: true, message: 'Success update business trip', data: updated })
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async delete(req, res) {
    try {
      const { id } = req.params
      const trip = await db.businessTrip.findOne({
        where: tripStoreWhere(req, { id })
      })
      if (!trip) {
        return res
          .status(404)
          .json({ success: false, message: 'Business trip not found' })
      }
      if (!['draft', 'pending', 'rejected'].includes(trip.status)) {
        return res.status(400).json({
          success: false,
          message: 'Only draft, pending or rejected business trip can be deleted'
        })
      }

      await trip.destroy()
      await createAudit(
        req,
        'delete',
        'business_trip',
        trip.id,
        'Deleted business_trip: ' + trip.id
      )
      return res.status(200).json({
        success: true,
        message: 'Success delete business trip',
        data: { id: trip.id }
      })
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  },

  async changeStatus(req, res) {
    try {
      const { id } = req.params
      const { status } = req.body
      const approvedBy = req.user?.id || null

      const validStatuses = ['approved', 'rejected', 'pending']
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid status' })
      }

      const trip = await db.businessTrip.findOne({
        where: tripStoreWhere(req, { id })
      })
      if (!trip) {
        return res
          .status(404)
          .json({ success: false, message: 'Business trip not found' })
      }
      if (trip.status === 'approved' && status !== 'approved') {
        return res.status(400).json({
          success: false,
          message: 'Approved business trip cannot be changed'
        })
      }
      if (
        status === 'approved' &&
        trip.status !== 'approved' &&
        Number(trip.createdBy) === Number(req.user?.id)
      ) {
        return res.status(403).json({
          success: false,
          message: 'Tidak dapat menyetujui business trip yang Anda buat sendiri'
        })
      }

      await trip.update({
        status,
        approvedBy: status === 'approved' ? approvedBy : null,
        approvedAt: status === 'approved' ? new Date() : null,
        modifiedBy: req.user?.id || null
      })
      await createAudit(
        req,
        status,
        'business_trip',
        trip.id,
        `${status} business_trip: ${trip.id}`
      )
      return res.status(200).json({
        success: true,
        message: `Business trip ${status}`,
        data: { id: trip.id, status }
      })
    } catch (error) {
      console.error(error)
      return res
        .status(500)
        .json({ success: false, message: 'Internal server error' })
    }
  }
}

module.exports = businessTripController
