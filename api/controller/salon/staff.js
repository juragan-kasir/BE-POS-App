'use strict'

const crypto = require('crypto')
const { Op } = require('sequelize')
const db = require('../../../db/models')
const { salonRoute, withStatus } = require('./http')
const { SalonError } = require('../../service/salonContext')
const {
  StaffInput,
  StaffProfileInput,
  StaffSkill,
  Availability,
  TimeOffInput
} = require('../../validation/salonSchemas')
const { SALON_SERVICE, idParam, notFound, hhmm, iEquals } = require('./shared')
const { z } = require('zod')

// Salon staff (SALON-BA §6, BR-SLN-003/008). A staff member is a `user`
// (roleType 'user' = canonical 'staff') with one salon_staff_profile per
// outlet, plus skills, weekly availability and time off at that outlet.
//
// The contract's free-text `position` is kept as a tenant `position` row
// (found by name, created on first use), so every profile has a positionId
// and DELETE /salon/positions/:id can refuse a position still in use.

// Appointment item statuses that block a time-off window (mock handler rule:
// only bookings not yet started; a running service is handled at the desk).
const TIME_OFF_BLOCKING = ['booked', 'confirmed']
// Time off older than this is history and no longer returned.
const TIME_OFF_HISTORY_DAYS = 30

const serializeStaff = (profile, { skills, availability, timeOff }) => ({
  userId: String(profile.userId),
  store: String(profile.store),
  name: profile.userData?.fullName || profile.userData?.userName || '',
  username: profile.userData?.userName || '',
  position: profile.positionData?.name || '',
  positionId: profile.positionId == null ? null : String(profile.positionId),
  level: profile.level,
  colorTag: profile.colorTag,
  acceptsOnline: profile.acceptsOnline,
  active: profile.active,
  commissionOverride: profile.commissionOverride || null,
  skills: skills.map((s) => ({
    productId: String(s.productId),
    durationOverride: s.durationOverride,
    priceOverride: s.priceOverride
  })),
  availability: availability.map((a) => ({
    weekday: a.weekday,
    startTime: hhmm(a.startTime),
    endTime: hhmm(a.endTime)
  })),
  timeOff: timeOff.map((t) => ({
    id: String(t.id),
    startAt: new Date(t.startAt).toISOString(),
    endAt: new Date(t.endAt).toISOString(),
    reason: t.reason
  }))
})

const profileInclude = [
  { model: db.user, as: 'userData', attributes: ['id', 'fullName', 'userName'] },
  { model: db.position, as: 'positionData', attributes: ['id', 'name'] }
]

/** Serialize profiles with their skills / availability / time off (3 queries). */
const loadStaff = async (profiles, transaction) => {
  if (!profiles.length) return []
  const keys = profiles.map((p) => ({ store: p.store, userId: p.userId }))
  const where = { [Op.or]: keys }
  const since = new Date(Date.now() - TIME_OFF_HISTORY_DAYS * 86400000)
  // Sequential: inside a transaction one connection runs one query at a time.
  const skills = await db.salon_staff_skill.findAll({ where, order: [['id', 'ASC']], transaction })
  const availability = await db.salon_availability.findAll({
    where,
    order: [['weekday', 'ASC'], ['startTime', 'ASC']],
    transaction
  })
  const timeOff = await db.salon_time_off.findAll({
    where: { ...where, endAt: { [Op.gte]: since } },
    order: [['startAt', 'ASC']],
    transaction
  })
  const of = (rows, p) => rows.filter((r) => r.store === p.store && r.userId === p.userId)
  return profiles.map((p) =>
    serializeStaff(p, { skills: of(skills, p), availability: of(availability, p), timeOff: of(timeOff, p) })
  )
}

const findProfile = async (salon, store, userId, transaction) => {
  const profile = await db.salon_staff_profile.findOne({
    where: { tenantId: salon.tenant.id, store: store.id, userId: idParam(userId, 'Staff tidak ditemukan') },
    include: profileInclude,
    transaction
  })
  if (!profile) throw notFound('Staff tidak ditemukan')
  return profile
}

const reload = async (salon, store, userId, transaction) => {
  const profile = await findProfile(salon, store, userId, transaction)
  return (await loadStaff([profile], transaction))[0]
}

/** positionId when given (must be the tenant's), else the position named `name`. */
const resolvePosition = async (salon, user, positionId, name, transaction) => {
  if (positionId) {
    const position = await db.position.findOne({
      where: { id: idParam(positionId, 'Jabatan tidak ditemukan'), tenantId: salon.tenant.id },
      transaction
    })
    if (!position) throw notFound('Jabatan tidak ditemukan')
    return position
  }
  const existing = await db.position.findOne({
    where: { tenantId: salon.tenant.id, [Op.and]: [iEquals('name', name)] },
    transaction
  })
  if (existing) return existing
  return db.position.create(
    { name, description: '', status: 'active', tenantId: salon.tenant.id, store: null, createdBy: user.id },
    { transaction }
  )
}

const profileValues = (input, position, user) => ({
  positionId: position.id,
  level: input.level,
  colorTag: input.colorTag,
  acceptsOnline: input.acceptsOnline,
  active: input.active,
  commissionOverride: input.commissionOverride,
  modifiedBy: user.id
})

// ---------- list ----------

exports.listStaff = salonRoute({ perm: ['employee.read', 'appointment.read'], store: true }, async ({ salon, store, user }) => {
  const where = { tenantId: salon.tenant.id, store: store.id }
  // A stylist sees only their own row (DR-SLN-15).
  if (salon.canonicalRole === 'staff') where.userId = user.id
  const profiles = await db.salon_staff_profile.findAll({
    where,
    include: profileInclude,
    order: [['id', 'ASC']]
  })
  return { data: await loadStaff(profiles) }
})

// ---------- create ----------

exports.createStaff = salonRoute({ perm: 'employee.manage', store: true }, async ({ salon, store, user, body }) => {
  const input = StaffInput.parse(body)
  // A one-time password for the new account; the owner hands it to the
  // stylist, who signs in on their phone (/salon/me). Never stored in clear.
  const temporaryPassword = crypto.randomBytes(6).toString('base64url')
  const staff = await db.sequelize.transaction(async (t) => {
    const taken = await db.user.findOne({
      where: { userName: input.username },
      paranoid: false,
      attributes: ['id'],
      transaction: t
    })
    if (taken) throw new SalonError('DUPLICATE', 'Username sudah dipakai', 409, { field: 'username' })
    const position = await resolvePosition(salon, user, input.positionId, input.position, t)
    const account = await db.user.create(
      {
        roleType: 'user',
        userType: 'user',
        fullName: input.name,
        userName: input.username,
        password: temporaryPassword,
        email: null,
        store: store.id,
        position: position.id,
        status: 'active',
        employeeID: String(crypto.randomInt(100000, 999999)),
        createdBy: user.id
      },
      { transaction: t }
    )
    await db.salon_staff_profile.create(
      {
        tenantId: salon.tenant.id,
        store: store.id,
        userId: account.id,
        ...profileValues(input, position, user),
        createdBy: user.id
      },
      { transaction: t }
    )
    return reload(salon, store, account.id, t)
  })
  return withStatus(201, { ...staff, temporaryPassword })
})

// ---------- profile ----------

exports.updateProfile = salonRoute({ perm: 'employee.manage', store: true }, async ({ salon, store, user, body, params }) => {
  const input = StaffProfileInput.parse(body)
  return db.sequelize.transaction(async (t) => {
    const profile = await findProfile(salon, store, params.userId, t)
    const position = await resolvePosition(salon, user, input.positionId, input.position, t)
    await profile.update(profileValues(input, position, user), { transaction: t })
    await db.user.update(
      { fullName: input.name, position: position.id, modifiedBy: user.id },
      { where: { id: profile.userId }, transaction: t }
    )
    return reload(salon, store, profile.userId, t)
  })
})

// ---------- skills ----------

exports.updateSkills = salonRoute({ perm: 'employee.manage', store: true }, async ({ salon, store, body, params }) => {
  const skills = z.array(StaffSkill).max(200).parse(body)
  const ids = skills.map((s) => idParam(s.productId, 'Layanan tidak ditemukan'))
  if (new Set(ids).size !== ids.length) {
    throw new SalonError('VALIDATION_FAILED', 'Layanan yang sama dipilih dua kali', 400, { field: 'productId' })
  }
  return db.sequelize.transaction(async (t) => {
    const profile = await findProfile(salon, store, params.userId, t)
    if (ids.length) {
      const services = await db.product.findAll({
        where: { id: ids, tenantId: salon.tenant.id, tipeProduk: SALON_SERVICE },
        attributes: ['id'],
        transaction: t
      })
      const known = new Set(services.map((s) => s.id))
      const missing = ids.find((id) => !known.has(id))
      if (missing) throw new SalonError('NOT_FOUND', 'Layanan tidak ditemukan', 404, { productId: String(missing) })
    }
    const key = { tenantId: salon.tenant.id, store: store.id, userId: profile.userId }
    await db.salon_staff_skill.destroy({ where: key, transaction: t })
    if (skills.length) {
      await db.salon_staff_skill.bulkCreate(
        skills.map((s, i) => ({
          ...key,
          productId: ids[i],
          durationOverride: s.durationOverride,
          priceOverride: s.priceOverride
        })),
        { transaction: t }
      )
    }
    return reload(salon, store, profile.userId, t)
  })
})

// ---------- availability ----------

/** Per weekday: end after start and no overlapping windows (BR-SLN-003). */
const assertAvailability = (rows) => {
  for (let day = 0; day <= 6; day += 1) {
    const sorted = rows.filter((r) => r.weekday === day).sort((a, b) => a.startTime.localeCompare(b.startTime))
    sorted.forEach((r, i) => {
      if (r.endTime <= r.startTime) {
        throw new SalonError('VALIDATION_FAILED', 'Jam selesai harus setelah jam mulai', 400, { weekday: day })
      }
      if (i > 0 && sorted[i - 1].endTime > r.startTime) {
        throw new SalonError('VALIDATION_FAILED', 'Jam kerja di hari yang sama tumpang tindih', 400, { weekday: day })
      }
    })
  }
}

exports.updateAvailability = salonRoute({ perm: 'employee.manage', store: true }, async ({ salon, store, body, params }) => {
  const rows = z.array(Availability).max(70).parse(body)
  assertAvailability(rows)
  return db.sequelize.transaction(async (t) => {
    const profile = await findProfile(salon, store, params.userId, t)
    const key = { tenantId: salon.tenant.id, store: store.id, userId: profile.userId }
    await db.salon_availability.destroy({ where: key, transaction: t })
    if (rows.length) {
      await db.salon_availability.bulkCreate(rows.map((r) => ({ ...key, ...r })), { transaction: t })
    }
    return reload(salon, store, profile.userId, t)
  })
})

// ---------- time off ----------

exports.addTimeOff = salonRoute({ perm: 'employee.manage', store: true }, async ({ salon, store, user, body, params }) => {
  const input = TimeOffInput.parse(body)
  const startAt = new Date(input.startAt)
  const endAt = new Date(input.endAt)
  const staff = await db.sequelize.transaction(async (t) => {
    const profile = await findProfile(salon, store, params.userId, t)
    // BR-SLN-008: leave cannot cover a booking; move the booking first.
    const clash = await db.salon_appointment_item.findOne({
      where: {
        tenantId: salon.tenant.id,
        staffId: profile.userId,
        status: TIME_OFF_BLOCKING,
        startAt: { [Op.lt]: endAt },
        endAt: { [Op.gt]: startAt }
      },
      attributes: ['id', 'appointmentId'],
      transaction: t
    })
    if (clash) {
      throw new SalonError('SLOT_TAKEN', 'Ada booking di jam cuti itu. Pindahkan booking dulu.', 409, {
        appointmentId: String(clash.appointmentId)
      })
    }
    await db.salon_time_off.create(
      {
        tenantId: salon.tenant.id,
        store: store.id,
        userId: profile.userId,
        startAt,
        endAt,
        reason: input.reason,
        createdBy: user.id
      },
      { transaction: t }
    )
    return reload(salon, store, profile.userId, t)
  })
  return withStatus(201, staff)
})

exports.removeTimeOff = salonRoute({ perm: 'employee.manage', store: true }, async ({ salon, store, params }) => {
  const profile = await findProfile(salon, store, params.userId)
  const id = idParam(params.id, 'Cuti tidak ditemukan')
  // Idempotent like the mock: removing an absent row is not an error.
  await db.salon_time_off.destroy({
    where: { id, tenantId: salon.tenant.id, store: store.id, userId: profile.userId }
  })
  return reload(salon, store, profile.userId)
})
