'use strict'

const { Op } = require('sequelize')
const db = require('../db/models')
const { shiftEvents } = require('./shiftEvents')
const Shift = db.shift
const User = db.user

const normId = (v) => Number(v)

class ShiftAssignmentError extends Error {
  constructor(message, status = 403) {
    super(message)
    this.name = 'ShiftAssignmentError'
    this.status = status
  }
}

const validateEmployeeStoreMembership = async ({
  storeId,
  employeeIds,
  transaction
}) => {
  const ids = [
    ...new Set(
      (employeeIds || [])
        .map(normId)
        .filter((n) => Number.isInteger(n) && n > 0)
    )
  ]
  if (ids.length === 0) return { ok: true }

  const targetStore = Number(storeId)
  if (!Number.isInteger(targetStore) || targetStore <= 0) {
    return {
      ok: false,
      status: 403,
      message: 'Shift tanpa toko tidak dapat memiliki karyawan'
    }
  }

  const users = await User.findAll({
    where: { id: { [Op.in]: ids } },
    attributes: ['id', 'store', 'userType'],
    transaction
  })

  if (users.length !== ids.length) {
    return {
      ok: false,
      status: 400,
      message: 'Salah satu karyawan tidak ditemukan'
    }
  }

  const foreign = users.find(
    (user) =>
      user.userType !== 'user' || Number(user.store) !== targetStore
  )
  if (foreign) {
    return {
      ok: false,
      status: 403,
      message: 'Karyawan harus berasal dari toko yang sama dengan shift'
    }
  }

  return { ok: true }
}

const validateShiftMembership = async ({
  shiftId,
  storeId,
  employeeIds = [],
  transaction
}) => {
  const id = normId(shiftId)
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, status: 400, message: 'Shift tidak valid' }
  }

  const shift = await Shift.findByPk(id, { transaction })
  if (!shift) {
    return { ok: false, status: 404, message: 'Shift tidak ditemukan' }
  }

  const targetStore =
    storeId == null || storeId === '' ? shift.store : Number(storeId)
  if (
    !Number.isInteger(Number(targetStore)) ||
    Number(shift.store) !== Number(targetStore)
  ) {
    return {
      ok: false,
      status: 403,
      message: 'Shift bukan milik toko karyawan'
    }
  }

  return validateEmployeeStoreMembership({
    storeId: targetStore,
    employeeIds,
    transaction
  })
}

const lockShiftsOf = async (t, ids) => {
  if (!t || !ids || ids.length === 0) return
  const unique = [...new Set(ids.map(normId))].filter((n) => !isNaN(n))
  if (unique.length === 0) return
  // Lock baris shift secara deterministik (urut id) agar dua proses yang
  // memindahkan karyawan ke shift yang sama tidak saling menimpa.
  for (const id of unique) {
    await Shift.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE })
  }
}

// Pindahkan SATU karyawan: keluarkan dari semua shift yang memuatnya,
// masukkan ke targetShiftId (jika ada), lalu tautkan user.shift.
const performSyncEmployeeShift = async (t, userId, targetShiftId) => {
  const id = normId(userId)
  if (isNaN(id)) return

  const containing = await Shift.findAll({
    where: { karyawan: { [Op.contains]: [id] } },
    transaction: t,
    lock: t.LOCK.UPDATE
  })
  await lockShiftsOf(t, containing.map((s) => s.id))
  await lockShiftsOf(t, targetShiftId ? [targetShiftId] : [])

  const removedShiftIds = []
  for (const shift of containing) {
    const karyawan = shift.karyawan || []
    const next = karyawan.filter((k) => normId(k) !== id)
    if (next.length !== karyawan.length) {
      removedShiftIds.push(shift.id)
      await shift.update({ karyawan: next }, { transaction: t })
    }
  }

  if (targetShiftId) {
    const target = await Shift.findByPk(targetShiftId, {
      transaction: t,
      lock: t.LOCK.UPDATE
    })
    if (target) {
      const karyawan = target.karyawan || []
      if (!karyawan.some((k) => normId(k) === id)) {
        await target.update({ karyawan: [...karyawan, id] }, { transaction: t })
      }
    }
  }

  await User.update(
    { shift: targetShiftId },
    { where: { id }, transaction: t }
  )

  return { removedShiftIds, targetShiftId }
}

const syncEmployeeShift = async ({ userId, newShiftId, transaction }) => {
  const id = normId(userId)
  if (isNaN(id)) return

  if (newShiftId != null) {
    const check = await validateShiftMembership({
      shiftId: newShiftId,
      employeeIds: [id]
    })
    if (!check.ok) throw new ShiftAssignmentError(check.message, check.status)
  }

  const own = transaction || null
  const t = own || (await db.sequelize.transaction())

  try {
    const result = await performSyncEmployeeShift(
      t,
      id,
      newShiftId != null ? normId(newShiftId) : null
    )
    if (!own) {
      await t.commit()
      shiftEvents.emit('employee:shiftChanged', {
        userId: id,
        shiftId: result.targetShiftId
      })
    }
    return result
  } catch (error) {
    if (!own) await t.rollback()
    throw error
  }
}

const syncShiftKaryawan = async ({ shiftId, employeeIds }) => {
  const shiftIdNum = normId(shiftId)
  if (isNaN(shiftIdNum)) return

  const ids = (employeeIds || []).map(normId).filter((n) => !isNaN(n) && n > 0)
  if (ids.length === 0) return

  const t = await db.sequelize.transaction()
  try {
    await lockShiftsOf(t, [shiftIdNum])

    const check = await validateShiftMembership({
      shiftId: shiftIdNum,
      employeeIds: ids,
      transaction: t
    })
    if (!check.ok) throw new ShiftAssignmentError(check.message, check.status)

    const containing = await Shift.findAll({
      where: { karyawan: { [Op.contains]: ids } },
      transaction: t,
      lock: t.LOCK.UPDATE
    })
    await lockShiftsOf(t, containing.map((s) => s.id))

    for (const id of ids) {
      await performSyncEmployeeShift(t, id, shiftIdNum)
    }

    await t.commit()
    shiftEvents.emit('shift:membersChanged', { shiftId: shiftIdNum, employeeIds: ids })
  } catch (error) {
    await t.rollback()
    throw error
  }
}

const clearRemovedMembers = async ({ shiftId, oldKaryawan, newKaryawan }) => {
  const shiftIdNum = normId(shiftId)
  if (isNaN(shiftIdNum)) return

  const oldIds = (oldKaryawan || []).map(normId).filter((n) => !isNaN(n))
  const newIds = (newKaryawan || []).map(normId).filter((n) => !isNaN(n))
  const removed = oldIds.filter((id) => !newIds.includes(id))

  if (removed.length > 0) {
    const t = await db.sequelize.transaction()
    try {
      await lockShiftsOf(t, [shiftIdNum])
      await User.update(
        { shift: null },
        { where: { id: { [Op.in]: removed }, shift: shiftIdNum }, transaction: t }
      )
      await t.commit()
      shiftEvents.emit('shift:membersRemoved', { shiftId: shiftIdNum, employeeIds: removed })
    } catch (error) {
      await t.rollback()
      throw error
    }
  }
}

module.exports = {
  syncEmployeeShift,
  syncShiftKaryawan,
  clearRemovedMembers,
  validateEmployeeStoreMembership,
  validateShiftMembership,
  ShiftAssignmentError
}