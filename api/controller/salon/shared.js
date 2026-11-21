'use strict'

const { Op } = require('sequelize')
const db = require('../../../db/models')
const { SalonError, resolveSalonStore } = require('../../service/salonContext')

// Small helpers shared by the /salon/* controllers.

const SALON_SERVICE = 'salon_service'
const SALON_RETAIL = 'salon_retail'
const SALON_PRODUCT_TYPES = [SALON_SERVICE, SALON_RETAIL]

/** Route id → positive integer, or NOT_FOUND (ids are strings in the contract). */
const idParam = (value, message = 'Data tidak ditemukan') => {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n <= 0) throw new SalonError('NOT_FOUND', message, 404)
  return n
}

const notFound = (message) => new SalonError('NOT_FOUND', message, 404)

/** HH:mm from a Postgres TIME ('09:00:00'). */
const hhmm = (value) => (value ? String(value).slice(0, 5) : value)

/** Case-insensitive equality on a column. */
const iEquals = (column, value) =>
  db.sequelize.where(db.sequelize.fn('lower', db.sequelize.col(column)), String(value).trim().toLowerCase())

/** Every outlet id of the tenant (not only the actor's). */
const tenantStoreIds = async (tenantId, transaction) => {
  const rows = await db.location.findAll({ where: { tenantId }, attributes: ['id'], transaction })
  return rows.map((r) => r.id)
}

/**
 * The outlet a request may optionally address: `?store=` when given (must be
 * the actor's), else the actor's only outlet, else null (owner of several
 * outlets without a choice, or no outlet yet).
 */
const optionalStore = (salon, requested) => {
  if (requested !== undefined && requested !== null && requested !== '') return resolveSalonStore(salon, requested)
  return salon.stores.length === 1 ? salon.stores[0] : null
}

/** Category row for a name inside the tenant, created on first use. */
const categoryFor = async (tenantId, name, userId, transaction) => {
  const existing = await db.category.findOne({
    where: { tenantId, [Op.and]: [iEquals('name', name)] },
    transaction
  })
  if (existing) return existing
  return db.category.create(
    { name: String(name).trim(), tenantId, status: 'active', createdBy: userId == null ? null : String(userId) },
    { transaction }
  )
}

module.exports = {
  SALON_SERVICE,
  SALON_RETAIL,
  SALON_PRODUCT_TYPES,
  idParam,
  notFound,
  hhmm,
  iEquals,
  tenantStoreIds,
  optionalStore,
  categoryFor
}
