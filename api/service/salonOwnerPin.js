'use strict'

const bcrypt = require('bcrypt')
const db = require('../../db/models')
const { SalonError } = require('./salonContext')

// Salon owner PIN (BR-SLN-015): a kasir without `pos.refund` approves a refund
// with the owner PIN of the outlet. The PIN is per outlet and lives as a bcrypt
// hash in location.salonSettings.ownerPinHash. The model getter never exposes
// it (or the attempt counters below); code here reads the raw value.
//
// A 4–6 digit PIN has at most 1,000,000 values, so wrong attempts are counted
// per outlet: after MAX_FAILURES wrong PINs in a row the outlet refuses every
// PIN (even the right one) for LOCK_MINUTES. The check runs in its own
// transaction with the outlet row locked, so parallel guesses are serialized
// and every one is counted, and a refund that fails later still keeps the count.

const MAX_FAILURES = 5
const LOCK_MINUTES = 15
const BCRYPT_ROUNDS = 10

const rawSettings = (row) => {
  const value = row?.getDataValue('salonSettings')
  return value && typeof value === 'object' ? value : {}
}

/** New PIN: hash it, clear the attempt counters. Caller holds the row lock. */
const setOwnerPin = async (row, pin, userId, transaction) => {
  const ownerPinHash = await bcrypt.hash(String(pin), BCRYPT_ROUNDS)
  await row.update(
    {
      salonSettings: {
        ...rawSettings(row),
        ownerPinHash,
        ownerPinSetAt: new Date().toISOString(),
        ownerPinFailures: 0,
        ownerPinLockedUntil: null
      },
      modifiedBy: userId
    },
    { transaction }
  )
}

/** Remove the PIN: a kasir can no longer approve refunds at this outlet. */
const clearOwnerPin = async (row, userId, transaction) => {
  // eslint-disable-next-line no-unused-vars
  const { ownerPinHash, ownerPinSetAt, ownerPinFailures, ownerPinLockedUntil, ...rest } = rawSettings(row)
  await row.update({ salonSettings: rest, modifiedBy: userId }, { transaction })
}

const lockedError = (until, now) =>
  new SalonError('OWNER_PIN_LOCKED', `PIN owner dikunci ${LOCK_MINUTES} menit karena terlalu sering salah`, 429, {
    retryAfterSec: Math.max(1, Math.ceil((until - now) / 1000))
  })

/**
 * Throws OWNER_PIN_NOT_SET (422), OWNER_PIN_LOCKED (429) or OWNER_PIN_INVALID
 * (403); returns when `pin` is the outlet's owner PIN.
 */
const verifyOwnerPin = async (storeId, pin, now = Date.now()) => {
  const failure = await db.sequelize.transaction(async (t) => {
    const row = await db.location.findByPk(storeId, {
      attributes: ['id', 'salonSettings'],
      transaction: t,
      lock: t.LOCK.UPDATE
    })
    const settings = rawSettings(row)
    if (!settings.ownerPinHash) return new SalonError('OWNER_PIN_NOT_SET', 'PIN owner outlet ini belum diatur', 422)

    const lockedUntil = settings.ownerPinLockedUntil ? Date.parse(settings.ownerPinLockedUntil) : 0
    if (lockedUntil > now) return lockedError(lockedUntil, now)
    // No PIN typed: ask for it, without spending an attempt.
    if (!pin) return new SalonError('OWNER_PIN_INVALID', 'Masukkan PIN owner', 403, { attemptsLeft: MAX_FAILURES - (Number(settings.ownerPinFailures) || 0) })

    if (await bcrypt.compare(String(pin), settings.ownerPinHash)) {
      if (settings.ownerPinFailures || settings.ownerPinLockedUntil) {
        await row.update({ salonSettings: { ...settings, ownerPinFailures: 0, ownerPinLockedUntil: null } }, { transaction: t })
      }
      return null
    }

    // An expired lock starts a fresh count.
    const failures = (lockedUntil ? 0 : Number(settings.ownerPinFailures) || 0) + 1
    if (failures >= MAX_FAILURES) {
      const until = now + LOCK_MINUTES * 60 * 1000
      await row.update(
        { salonSettings: { ...settings, ownerPinFailures: 0, ownerPinLockedUntil: new Date(until).toISOString() } },
        { transaction: t }
      )
      return lockedError(until, now)
    }
    await row.update({ salonSettings: { ...settings, ownerPinFailures: failures, ownerPinLockedUntil: null } }, { transaction: t })
    return new SalonError('OWNER_PIN_INVALID', 'PIN owner salah', 403, { attemptsLeft: MAX_FAILURES - failures })
  })
  // Thrown after commit, so the counted attempt is kept.
  if (failure) throw failure
}

module.exports = { MAX_FAILURES, LOCK_MINUTES, setOwnerPin, clearOwnerPin, verifyOwnerPin }
