'use strict'

const { Op } = require('sequelize')
const db = require('../../../db/models')
const { salonRoute, withStatus } = require('./http')
const { SalonError, publicTenant, publicStore } = require('../../service/salonContext')
const { SettingsInput, StoreInput, OwnerPinInput } = require('../../validation/salonSchemas')
const { setOwnerPin, clearOwnerPin } = require('../../service/salonOwnerPin')
const { SALON_PRODUCT_TYPES, idParam, notFound, iEquals } = require('./shared')

// Salon tenant settings and outlets (SALON-BA §2, onboarding U1–U10).
//
// Tenant settings live in tenant.salonSettings; outlet hours in
// location.salonSettings next to the refund owner-PIN hash, which every
// write here keeps (the model getter hides it, so it is read raw).

exports.updateSettings = salonRoute({ perm: 'settings.manage' }, async ({ salon, body }) => {
  const input = SettingsInput.parse(body)
  const tenant = await db.tenant.findByPk(salon.tenant.id)
  await tenant.update({ salonSettings: { ...(tenant.salonSettings || {}), ...input } })
  return publicTenant(tenant)
})

const assertStoreNameFree = async (salon, name, excludeId, transaction) => {
  const clash = await db.location.findOne({
    where: {
      tenantId: salon.tenant.id,
      ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}),
      [Op.and]: [iEquals('name', name)]
    },
    attributes: ['id'],
    transaction
  })
  if (clash) throw new SalonError('DUPLICATE', 'Nama outlet sudah dipakai', 409, { field: 'name' })
}

const storeValues = (input, rawSettings) => ({
  name: input.name,
  address: input.address,
  detailLocation: input.address,
  phoneNumber: input.phone,
  timezone: input.timezone,
  status: input.active ? 'active' : 'inactive',
  salonSettings: { ...(rawSettings || {}), openTime: input.openTime, closeTime: input.closeTime }
})

exports.createStore = salonRoute({ perm: 'outlet.manage' }, async ({ req, salon, user, body }) => {
  const input = StoreInput.parse(body)
  const location = await db.sequelize.transaction(async (t) => {
    // One outlet name per tenant; serialize concurrent creates of the tenant.
    await db.sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', {
      replacements: { key: `salon_store:${salon.tenant.id}` },
      transaction: t
    })
    await assertStoreNameFree(salon, input.name, null, t)
    const [seq] = await db.sequelize.query("SELECT nextval('location_id_seq') AS id", { transaction: t })
    const id = Number(seq[0].id)
    const created = await db.location.create(
      {
        id,
        store: id,
        tenantId: salon.tenant.id,
        businessType: 'salon',
        createdBy: user.id,
        ...storeValues(input, null)
      },
      { transaction: t }
    )
    // The tenant's services and products are sold at the new outlet too.
    const products = await db.product.findAll({
      where: { tenantId: salon.tenant.id, tipeProduk: SALON_PRODUCT_TYPES },
      attributes: ['id'],
      transaction: t
    })
    if (products.length) {
      await db.product_store.bulkCreate(
        products.map((p) => ({ product: p.id, store: id, createdBy: user.id })),
        { transaction: t }
      )
    }
    // Onboarding: an owner without a home outlet gets this one, so the
    // outlet-scoped shared flows (cash register, attendance) have a store.
    await db.user.update({ store: id }, { where: { id: user.id, store: null }, transaction: t })
    return created
  })
  req.salon = null
  return withStatus(201, publicStore(location))
})

/** The caller's outlet `id`, row-locked. An admin addresses only their own outlet; the owner, every outlet. */
const lockOwnStore = async (salon, id, t) => {
  const row = await db.location.findOne({
    where: { id, tenantId: salon.tenant.id },
    transaction: t,
    lock: t.LOCK.UPDATE
  })
  if (!row || !salon.stores.some((s) => Number(s.id) === id)) throw notFound('Outlet tidak ditemukan')
  return row
}

exports.updateStore = salonRoute({ perm: 'outlet.manage' }, async ({ salon, user, body, params }) => {
  const input = StoreInput.parse(body)
  const id = idParam(params.id, 'Outlet tidak ditemukan')
  const location = await db.sequelize.transaction(async (t) => {
    const row = await lockOwnStore(salon, id, t)
    await assertStoreNameFree(salon, input.name, id, t)
    await row.update(
      { ...storeValues(input, row.getDataValue('salonSettings')), modifiedBy: user.id },
      { transaction: t }
    )
    return row
  })
  return publicStore(location)
})

// Owner PIN of an outlet (BR-SLN-015): what a kasir types to get a refund
// approved. `outlet.manage` = owner only, so an admin cannot set the PIN that
// approves refunds at their own outlet. The PIN is write-only: the outlet
// shows `hasOwnerPin`, never the PIN or its hash.
exports.setOwnerPin = salonRoute({ perm: 'outlet.manage' }, async ({ salon, user, body, params }) => {
  const { pin } = OwnerPinInput.parse(body)
  const id = idParam(params.id, 'Outlet tidak ditemukan')
  const location = await db.sequelize.transaction(async (t) => {
    const row = await lockOwnStore(salon, id, t)
    await setOwnerPin(row, pin, user.id, t)
    return row
  })
  return publicStore(location)
})

exports.clearOwnerPin = salonRoute({ perm: 'outlet.manage' }, async ({ salon, user, params }) => {
  const id = idParam(params.id, 'Outlet tidak ditemukan')
  const location = await db.sequelize.transaction(async (t) => {
    const row = await lockOwnStore(salon, id, t)
    await clearOwnerPin(row, user.id, t)
    return row
  })
  return publicStore(location)
})
