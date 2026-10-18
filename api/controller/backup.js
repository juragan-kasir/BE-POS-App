'use strict'
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const { promisify } = require('util')
const db = require('../../db/models')
const execFileAsync = promisify(execFile)

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(process.cwd(), 'backups')
const SCHEDULE_FILE = path.join(BACKUP_DIR, '.schedule.json')

const DB_CONFIG = () => {
  const envPath =
    process.env.NODE_ENV === 'production'
      ? `${process.cwd()}/.env.production`
      : `${process.cwd()}/.env`
  // Load manually to avoid mutating global env repeatedly
  if (!process.env.BACKUP_DB_LOADED) {
    require('dotenv').config({ path: envPath })
    process.env.BACKUP_DB_LOADED = '1'
  }
  return {
    host: process.env.DB_DEV_HOST || process.env.POSTGRES_HOST || '127.0.0.1',
    port: process.env.DB_DEV_PORT || process.env.POSTGRES_PORT || 5432,
    user:
      process.env.DB_DEV_USERNAME || process.env.POSTGRES_USER || 'postgres',
    password: process.env.DB_DEV_PASSWORD || process.env.POSTGRES_PASSWORD,
    database:
      process.env.DB_DEV_DATABASE ||
      process.env.POSTGRES_DATABASE ||
      'cashier_app'
  }
}

const ensureDir = () => {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true })
}

const sanitizeFilename = (name) => name.replace(/[^a-zA-Z0-9._-]/g, '_')

// CRIT-3: backup artifacts are reachable by primary key. Access rule keyed on
// the CALLER'S REAL store from the JWT (never on caller-supplied params):
//  - global super_admin (store null in token) -> full access
//  - store-bound super_admin            -> ONLY their own store's artifacts
// Tenant roles never reach these ops (requireRole('super_admin') upstream).
const canAccessBackupArtifact = (record, req) => {
  const callerStore =
    req.user?.store != null ? parseInt(req.user.store, 10) : null
  if (callerStore === null) return true
  if (!record) return false
  const recordStore = record.store != null ? parseInt(record.store, 10) : null
  return recordStore === callerStore
}

// Effective store for a backup artifact: always the caller's REAL store when
// the caller is a store-bound super_admin; only a global super_admin may
// choose an explicit store.
const effectiveBackupStore = (req) => {
  const callerStore =
    req.user?.store != null ? parseInt(req.user.store, 10) : null
  if (callerStore !== null) return callerStore
  return req.storeId || null
}

const runPgDump = async ({ outputFile, format = 'custom' }) => {
  const c = DB_CONFIG()
  const args = ['--no-owner', '--no-privileges']
  if (format === 'custom') {
    args.push('-Fc')
  } else {
    args.push('-Fp')
  }
  args.push(
    '-h',
    String(c.host),
    '-p',
    String(c.port),
    '-U',
    String(c.user),
    '-f',
    outputFile,
    String(c.database)
  )
  const env = { ...process.env, PGPASSWORD: String(c.password) }
  await execFileAsync('pg_dump', args, {
    env,
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024
  })
}

const runPgRestore = async ({ inputFile, format = 'custom' }) => {
  const c = DB_CONFIG()
  const env = { ...process.env, PGPASSWORD: String(c.password) }
  if (format === 'plain') {
    await execFileAsync(
      'psql',
      [
        '-h',
        String(c.host),
        '-p',
        String(c.port),
        '-U',
        String(c.user),
        '-d',
        String(c.database),
        '-f',
        inputFile
      ],
      { env, timeout: 600000, maxBuffer: 64 * 1024 * 1024 }
    )
    return
  }
  await execFileAsync(
    'pg_restore',
    [
      '--no-owner',
      '--no-privileges',
      '--exit-on-error',
      '-h',
      String(c.host),
      '-p',
      String(c.port),
      '-U',
      String(c.user),
      '-d',
      String(c.database),
      inputFile
    ],
    { env, timeout: 600000, maxBuffer: 64 * 1024 * 1024 }
  )
}

const readSchedule = () => {
  try {
    if (fs.existsSync(SCHEDULE_FILE)) {
      return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'))
    }
  } catch (err) {
    console.error('Backup schedule read error:', err)
  }
  return { enabled: false, cron: '0 0 * * *', retention: 7 }
}

const writeSchedule = (schedule) => {
  ensureDir()
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2), 'utf8')
}

const parseCron = (cron) => {
  const parts = String(cron || '')
    .trim()
    .split(/\s+/)
  if (parts.length !== 5) return null
  const num = (p) => {
    if (p === '*') return []
    return p.split(',').map((x) => (x === '*' ? [] : parseInt(x, 10)))
  }
  return {
    minute: num(parts[0]),
    hour: num(parts[1]),
    dayOfMonth: num(parts[2]),
    month: num(parts[3]),
    dayOfWeek: num(parts[4])
  }
}

const cronMatches = (cron, date) => {
  const c = parseCron(cron)
  if (!c) return false
  const match = (list, val) => list.length === 0 || list.includes(val)
  return (
    match(c.minute, date.getMinutes()) &&
    match(c.hour, date.getHours()) &&
    match(c.dayOfMonth, date.getDate()) &&
    match(c.month, date.getMonth() + 1) &&
    match(c.dayOfWeek, date.getDay())
  )
}

// MED-2: the schedule this controls (retention, cron) drives
// runScheduledBackupIfDue -> cleanupRetention(), an unattended background
// sweep that deletes old backups FOR EVERY STORE, not just one — there is
// no per-request "caller" by the time it runs, so the only place the
// authorization boundary can be enforced is here, at configuration time.
// requireRole('super_admin') alone does not distinguish a global super_admin
// from a store-bound one (canAccessBackupArtifact already restricts the
// latter to their own store's artifacts) — without this check a store-bound
// super_admin could shorten the global retention window and cause another
// P0: global authority = super_admin with no store. Backup artifacts are
// platform-global (pg_dump covers the shared DB); the store label is
// metadata, never authority. Only a global super_admin may perform backup
// operations.
const isGlobalSuperAdmin = (req) =>
  req.user?.roleType === 'super_admin' && req.user?.store == null

// store's (or the global admin's) backups to be deleted, despite having no
// direct access to those artifacts at all.
const requireGlobalSuperAdmin = (req, res) => {
  if (!isGlobalSuperAdmin(req)) {
    res.status(403).json({
      success: false,
      message:
        'Hanya super admin global yang dapat mengatur jadwal backup sistem'
    })
    return false
  }
  return true
}

exports.getSchedule = async (req, res) => {
  try {
    if (!requireGlobalSuperAdmin(req, res)) return
    return res.status(200).json({ success: true, data: readSchedule() })
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message })
  }
}

exports.setSchedule = async (req, res) => {
  try {
    if (!requireGlobalSuperAdmin(req, res)) return
    const { enabled, cron, retention } = req.body
    const current = readSchedule()
    const schedule = {
      enabled: enabled !== undefined ? !!enabled : current.enabled,
      cron: cron || current.cron,
      retention:
        retention !== undefined
          ? Math.max(0, parseInt(retention, 10))
          : current.retention
    }
    if (schedule.enabled && !parseCron(schedule.cron)) {
      return res.status(400).json({
        success: false,
        message: 'Cron expression tidak valid (format: m h dom mon dow)'
      })
    }
    writeSchedule(schedule)
    return res.status(200).json({
      success: true,
      message: 'Jadwal backup disimpan',
      data: schedule
    })
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message })
  }
}

exports.createBackup = async (req, res) => {
  try {
    // P0: platform-global operation — global super_admin only, before dump.
    if (!requireGlobalSuperAdmin(req, res)) return
    const now = new Date()
    const stamp = now.toISOString().replace(/[:.]/g, '-')
    const filename = `backup_${stamp}.dump`
    const outputFile = path.join(BACKUP_DIR, filename)
    ensureDir()

    await runPgDump({ outputFile, format: 'custom' })

    const stat = fs.statSync(outputFile)
    const backupStore = effectiveBackupStore(req)
    const location = await db.location.findByPk(backupStore, {
      attributes: ['name']
    })

    const record = await db.db_backup.create({
      filename,
      filepath: outputFile,
      size: stat.size,
      format: 'custom',
      status: 'success',
      trigger: req.body?.trigger === 'scheduled' ? 'scheduled' : 'manual',
      store: backupStore,
      createdBy: req.user?.id || null,
      metadata: {
        storeName: location?.name || null,
        // NOTE: pg_dump always dumps the ENTIRE shared database. This flag
        // records that explicitly so the artifact is never mistaken for a
        // tenant-isolated per-store dump. (CRIT-3)
        globalDump: backupStore == null
      }
    })

    return res.status(201).json({
      success: true,
      message: 'Backup berhasil dibuat',
      data: record.toJSON()
    })
  } catch (err) {
    console.error('Backup create error:', err)
    return res.status(500).json({
      success: false,
      message: `Backup gagal: ${err.message}`
    })
  }
}

exports.listBackups = async (req, res) => {
  try {
    // P0: platform-global operation — global super_admin only.
    // The store label is metadata and never grants listing authority.
    if (!requireGlobalSuperAdmin(req, res)) return
    // Store-bound super_admin always sees ONLY their own store. A global
    // super_admin may narrow the listing with an explicit store, otherwise
    // the listing is global (with the global nature documented). (CRIT-3)
    const boundCallerStore =
      req.user?.store != null ? parseInt(req.user.store, 10) : null
    const store = boundCallerStore !== null ? boundCallerStore : req.storeId || null
    const { limit = 50, offset = 0 } = req.query
    const where = {}
    if (store) where.store = store
    const { rows, count } = await db.db_backup.findAndCountAll({
      where,
      order: [['updatedAt', 'DESC']],
      limit: Math.min(parseInt(limit, 10) || 50, 200),
      offset: parseInt(offset, 10) || 0
    })
    return res.status(200).json({
      success: true,
      data: rows.map((r) => {
        const d = r.toJSON()
        d.exists = fs.existsSync(d.filepath)
        delete d.filepath
        return d
      }),
      pagination: { total: count }
    })
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message })
  }
}

exports.downloadBackup = async (req, res) => {
  try {
    // P0: platform-global artifact — global super_admin only. Label is metadata.
    if (!requireGlobalSuperAdmin(req, res)) return
    const { id } = req.params
    const record = await db.db_backup.findByPk(id)
    if (!record) {
      return res
        .status(404)
        .json({ success: false, message: 'Backup tidak ditemukan' })
    }
    if (!canAccessBackupArtifact(record, req)) {
      return res.status(403).json({
        success: false,
        message: 'Anda hanya dapat mengakses backup toko Anda'
      })
    }
    const filepath = record.filepath
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({
        success: false,
        message: 'File backup tidak ada di server'
      })
    }
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${sanitizeFilename(record.filename)}"`
    )
    res.setHeader('Content-Length', record.size)
    fs.createReadStream(filepath).pipe(res)
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message })
  }
}

exports.restoreBackup = async (req, res) => {
  try {
    // P0: platform-global destructive operation — global super_admin only,
    // verified BEFORE any pg_restore execution. Label is never authority.
    if (!requireGlobalSuperAdmin(req, res)) return
    const { id } = req.params
    const record = await db.db_backup.findByPk(id)
    if (!record) {
      return res
        .status(404)
        .json({ success: false, message: 'Backup tidak ditemukan' })
    }
    if (!canAccessBackupArtifact(record, req)) {
      return res.status(403).json({
        success: false,
        message: 'Anda hanya dapat mengakses backup toko Anda'
      })
    }
    const filepath = record.filepath
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({
        success: false,
        message: 'File backup tidak ada di server'
      })
    }

    await runPgRestore({
      inputFile: filepath,
      format: record.format || 'custom'
    })

    await record.update({ status: 'restored' })
    return res.status(200).json({
      success: true,
      message: 'Restore berhasil dilakukan'
    })
  } catch (err) {
    console.error('Backup restore error:', err)
    return res.status(500).json({
      success: false,
      message: `Restore gagal: ${err.message}`
    })
  }
}

exports.deleteBackup = async (req, res) => {
  try {
    // P0: platform-global artifact — global super_admin only. Label is metadata.
    if (!requireGlobalSuperAdmin(req, res)) return
    const { id } = req.params
    const record = await db.db_backup.findByPk(id)
    if (!record) {
      return res
        .status(404)
        .json({ success: false, message: 'Backup tidak ditemukan' })
    }
    if (!canAccessBackupArtifact(record, req)) {
      return res.status(403).json({
        success: false,
        message: 'Anda hanya dapat mengakses backup toko Anda'
      })
    }
    if (fs.existsSync(record.filepath)) {
      fs.unlinkSync(record.filepath)
    }
    await record.destroy()
    return res.status(200).json({
      success: true,
      message: 'Backup dihapus'
    })
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message })
  }
}

exports.cleanupRetention = async () => {
  const schedule = readSchedule()
  const retention = Number(schedule.retention || 0)
  if (!retention) return 0
  const cutoff = new Date(Date.now() - retention * 24 * 60 * 60 * 1000)
  const old = await db.db_backup.findAll({
    where: { createdAt: { [db.Sequelize.Op.lt]: cutoff } }
  })
  let removed = 0
  for (const r of old) {
    try {
      if (fs.existsSync(r.filepath)) fs.unlinkSync(r.filepath)
      await r.destroy()
      removed += 1
    } catch (err) {
      console.error('Cleanup backup error:', err)
    }
  }
  return removed
}

exports.readBackupSchedule = () => readSchedule()

exports.runScheduledBackupIfDue = async (date = new Date()) => {
  const schedule = readSchedule()
  if (!schedule.enabled || !parseCron(schedule.cron)) return false
  if (!cronMatches(schedule.cron, date)) return false
  return exports.runScheduledBackup()
}

// Unconditional variant used by the cron endpoint when the exact-minute match
// missed (Vercel Hobby fires crons anywhere within the scheduled hour) but the
// last scheduled backup is already stale. Callers must enforce the staleness
// guard and the shared 'backup' lease.
exports.runScheduledBackup = async () => {
  try {
    const now = new Date()
    const stamp = now.toISOString().replace(/[:.]/g, '-')
    const filename = `backup_${stamp}.dump`
    const outputFile = path.join(BACKUP_DIR, filename)
    ensureDir()
    await runPgDump({ outputFile, format: 'custom' })
    const stat = fs.statSync(outputFile)
    await db.db_backup.create({
      filename,
      filepath: outputFile,
      size: stat.size,
      format: 'custom',
      status: 'success',
      trigger: 'scheduled',
      store: null,
      createdBy: null,
      metadata: {
        source: 'scheduler',
        // Explicit: scheduled backups are full-DB (global) dumps. (CRIT-3)
        globalDump: true
      }
    })
    await exports.cleanupRetention()
    return true
  } catch (err) {
    console.error('Scheduled backup error:', err)
    return false
  }
}
