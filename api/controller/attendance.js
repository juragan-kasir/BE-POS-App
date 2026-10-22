'use strict'
const { Op } = require('sequelize')
const db = require('../../db/models')
const Attendance = db.attendance
const { enrichAuditFields } = require('../../utils/auditFields')

const isGlobalSuperAdmin = (req) =>
  req.user?.roleType === 'super_admin' && req.user?.store == null

const ownStoreId = (req) => {
  const store = Number(req.user?.store)
  return Number.isInteger(store) && store > 0 ? store : null
}

const MAX_ACCURACY_M = 150
const ORIGIN_EPSILON = 1 / 1000000
const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_GEOFENCE_M = 200
const MAX_STORE_DISTANCE_M = (() => {
  const configured = Number(process.env.ATTENDANCE_GEOFENCE_METERS)
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_GEOFENCE_M
})()

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v)

const toRadians = (value) => (value * Math.PI) / 180

const distanceMeters = (lat1, lng1, lat2, lng2) => {
  const earthRadius = 6371000
  const dLat = toRadians(lat2 - lat1)
  const dLng = toRadians(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) ** 2
  return 2 * earthRadius * Math.asin(Math.sqrt(a))
}

const storeDistance = async (storeId, latitude, longitude) => {
  if (!storeId) return null
  const store = await db.location.findByPk(storeId, {
    attributes: ['id', 'latitude', 'longitude']
  })
  if (
    !store ||
    store.latitude == null ||
    store.longitude == null ||
    !isFiniteNumber(Number(store.latitude)) ||
    !isFiniteNumber(Number(store.longitude))
  ) {
    return null
  }
  return distanceMeters(
    Number(store.latitude),
    Number(store.longitude),
    latitude,
    longitude
  )
}

const validateCoordinate = (latitude, longitude) => {
  if (!isFiniteNumber(latitude) || !isFiniteNumber(longitude)) {
    return 'Koordinat lokasi tidak valid'
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return 'Koordinat lokasi di luar jangkauan'
  }
  if (
    Math.abs(latitude) < ORIGIN_EPSILON &&
    Math.abs(longitude) < ORIGIN_EPSILON
  ) {
    return 'Koordinat lokasi tidak valid (0,0)'
  }
  return null
}

const computeStatus = ({ latitude, longitude, accuracy }) => {
  const coordErr = validateCoordinate(latitude, longitude)
  if (coordErr) return { status: 'untrusted', note: coordErr }
  if (!isFiniteNumber(accuracy) || accuracy <= 0 || accuracy > MAX_ACCURACY_M) {
    return {
      status: 'untrusted',
      note: 'Akurasi GPS tidak dapat dipercaya (kemungkinan GPS simulasi)'
    }
  }
  return { status: 'valid', note: 'Lokasi terverifikasi' }
}

const dayRange = (dateStr) => {
  const now = new Date()
  const base =
    dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
      ? new Date(`${dateStr}T00:00:00`)
      : new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(base.getTime() + DAY_MS)
  return { start: base, end }
}

const serializeAttendance = (r) => ({
  id: r.id,
  userId: r.userId,
  store: r.store,
  shiftId: r.shiftId,
  type: r.type,
  absenAt: r.absenAt,
  latitude: r.latitude,
  longitude: r.longitude,
  accuracy: r.accuracy,
  algorithm: r.algorithm,
  status: r.status,
  note: r.note,
  createdAt: r.createdAt,
  userData: r.userData
    ? {
        id: r.userData.id,
        fullName: r.userData.fullName,
        userName: r.userData.userName
      }
    : null,
  storeData: r.storeData ? { id: r.storeData.id, name: r.storeData.name } : null,
  shiftData: r.shiftData
    ? {
        id: r.shiftData.id,
        name: r.shiftData.name,
        jam_mulai: r.shiftData.startTime,
        jam_selesai: r.shiftData.endTime
      }
    : null
})

exports.clock = async (req, res) => {
  try {
    const {
      type = 'check-in',
      latitude,
      longitude,
      accuracy,
      algorithm = 'gps',
      shiftId
    } = req.body || {}

    if (!['check-in', 'check-out'].includes(String(type).toLowerCase())) {
      return res.status(400).json({
        success: false,
        message: 'Tipe absensi harus check-in atau check-out'
      })
    }

    const coordErr = validateCoordinate(Number(latitude), Number(longitude))
    if (coordErr) {
      return res.status(400).json({ success: false, message: coordErr })
    }

    const { status, note } = computeStatus({
      latitude: Number(latitude),
      longitude: Number(longitude),
      accuracy: Number(accuracy)
    })

    const clockStore = req.user?.store ? Number(req.user.store) : null
    const distance = await storeDistance(
      clockStore,
      Number(latitude),
      Number(longitude)
    )
    if (distance != null && distance > MAX_STORE_DISTANCE_M) {
      return res.status(400).json({
        success: false,
        message: 'Anda berada di luar radius toko'
      })
    }

    const now = new Date()
    const { start, end } = dayRange()
    const existing = await Attendance.findOne({ // nosemgrep: Sequelize SQL query — tidak rentan NoSQL injection
      where: {
        userId: req.user.id,
        type: String(type).toLowerCase(),
        absenAt: { [Op.gte]: start, [Op.lt]: end },
        status: { [Op.ne]: 'cancelled' }
      }
    })

    if (existing) {
      return res.status(409).json({
        success: false,
        message:
          type === 'check-in'
            ? 'Anda sudah melakukan absen masuk hari ini'
            : 'Anda sudah melakukan absen pulang hari ini'
      })
    }

    const record = await Attendance.create({
      userId: req.user.id,
      // Clock-in store must come from the authenticated user's own
      // assignment, never from client-supplied body/query/cookie —
      // those are spoofable and this route has no validateStoreAccess.
      store: req.user?.store ? Number(req.user.store) : null,
      shiftId: shiftId ? Number(shiftId) : null,
      type: String(type).toLowerCase(),
      absenAt: now,
      latitude: Number(latitude),
      longitude: Number(longitude),
      accuracy: Number(accuracy),
      algorithm,
      status,
      note
    })

    await enrichAuditFields(db, [record])

    return res.status(201).json({
      success: true,
      message: type === 'check-in' ? 'Absen masuk berhasil' : 'Absen pulang berhasil',
      data: serializeAttendance(record)
    })
  } catch (error) {
    console.error('Error attendance clock =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.getMyAttendance = async (req, res) => {
  try {
    const { start, end } = dayRange(req.query.date)

    const records = await Attendance.findAll({
      where: {
        userId: req.user.id,
        absenAt: { [Op.gte]: start, [Op.lt]: end }
      },
      include: [
        { model: db.location, as: 'storeData', attributes: ['id', 'name'] },
        {
          model: db.shift,
          as: 'shiftData',
          attributes: ['id', 'name', 'startTime', 'endTime']
        }
      ],
      order: [['absenAt', 'ASC']]
    })

    await enrichAuditFields(db, records)

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: records.map(serializeAttendance),
      total: records.length
    })
  } catch (error) {
    console.error('Error attendance my =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.getTodayAttendance = async (req, res) => {
  try {
    const { start, end } = dayRange(req.query.date)
    const where = {
      absenAt: { [Op.gte]: start, [Op.lt]: end }
    }

    const effectiveStore = isGlobalSuperAdmin(req) ? req.storeId : ownStoreId(req)
    if (effectiveStore) where.store = Number(effectiveStore)
    else if (!isGlobalSuperAdmin(req)) where.store = -1

    const records = await Attendance.findAll({
      where,
      include: [
        {
          model: db.user,
          as: 'userData',
          attributes: ['id', 'fullName', 'userName', 'roleType']
        },
        { model: db.location, as: 'storeData', attributes: ['id', 'name'] },
        {
          model: db.shift,
          as: 'shiftData',
          attributes: ['id', 'name', 'startTime', 'endTime']
        }
      ],
      order: [['absenAt', 'DESC']]
    })

    await enrichAuditFields(db, records)

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: records.map(serializeAttendance),
      total: records.length
    })
  } catch (error) {
    console.error('Error attendance today =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}

exports.getByShift = async (req, res) => {
  try {
    const shiftId = Number(req.query.shiftId)
    if (!shiftId) {
      return res.status(400).json({
        success: false,
        message: 'Parameter shiftId wajib diisi'
      })
    }

    const where = { shiftId }
    const effectiveStore = isGlobalSuperAdmin(req) ? req.storeId : ownStoreId(req)
    if (effectiveStore) where.store = Number(effectiveStore)
    else if (!isGlobalSuperAdmin(req)) where.store = -1

    const records = await Attendance.findAll({
      where,
      include: [
        {
          model: db.user,
          as: 'userData',
          attributes: ['id', 'fullName', 'userName', 'roleType']
        },
        { model: db.location, as: 'storeData', attributes: ['id', 'name'] },
        {
          model: db.shift,
          as: 'shiftData',
          attributes: ['id', 'name', 'startTime', 'endTime']
        }
      ],
      order: [['absenAt', 'ASC']]
    })

    await enrichAuditFields(db, records)

    return res.status(200).json({
      success: true,
      message: 'Success',
      data: records.map(serializeAttendance),
      total: records.length
    })
  } catch (error) {
    console.error('Error attendance by-shift =>', error)
    return res.status(500).json({
      success: false,
      message: 'Terjadi Kesalahan Internal Server'
    })
  }
}