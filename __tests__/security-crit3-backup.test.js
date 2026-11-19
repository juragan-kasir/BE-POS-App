process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const fs = require('fs')
const os = require('os')
const path = require('path')

// Point the backup file store at a throwaway dir BEFORE the app module loads
// (BACKUP_DIR is captured at module-load time in api/controller/backup.js).
process.env.BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'crit3-backups-'))

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// CRIT-3 regression: backup operations acted on the entire shared DB and
// backup records were reachable by primary key with no tenant boundary.
//
// Required invariant: tenant-level roles (user/admin/kasir) cannot invoke any
// global backup operation; a store-bound super_admin cannot download/delete/
// restore another tenant's backup artifact.

const BACKUP_DIR = process.env.BACKUP_DIR

const mkToken = (roleType, store, id) =>
  signSessionToken(
    { id, userName: `tok_${roleType}_${id}`, roleType, store },
    JWT_SECRET
  )

let store1 = null
let store2 = null
let backupS1 = null
let createdIds = []

const makeBackup = async (store, filename, content) => {
  const filepath = path.join(BACKUP_DIR, filename)
  fs.writeFileSync(filepath, content || filename)
  const rec = await db.db_backup.create({
    filename,
    filepath,
    size: Buffer.byteLength(content || filename),
    format: 'custom',
    status: 'success',
    store
  })
  createdIds.push(rec.id)
  return rec
}

beforeAll(async () => {
  store1 = await db.location.create(await withTestTenant({
    name: `CRIT3_STORE1_${Date.now()}`,
    status: 'active'
  }))
  store2 = await db.location.create(await withTestTenant({
    name: `CRIT3_STORE2_${Date.now()}`,
    status: 'active'
  }))

  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true })

  backupS1 = await makeBackup(store1.id, 's1.dump', 'STORE1_DUMP')

  // P1-4: central gate denies unknown caller identities; these rows give
  // every await mkToken() caller id below a real identity with matching
  // role/store semantics. Assertions below are unchanged.
  for (const [id, userName, roleType, userType, store] of [
    [7101, 'cr3_user', 'user', 'user', store1.id],
    [7102, 'cr3_admin', 'admin', 'admin', store1.id],
    [7103, 'cr3_kasir', 'kasir', 'user', store1.id],
    [7201, 'cr3_bound1', 'super_admin', 'admin', store1.id],
    [7202, 'cr3_bound2', 'super_admin', 'admin', store1.id],
    [7203, 'cr3_bound3', 'super_admin', 'admin', store1.id],
    [7204, 'cr3_bound4', 'super_admin', 'admin', store1.id],
    [7205, 'cr3_bound5', 'super_admin', 'admin', store1.id],
    [7206, 'cr3_global1', 'super_admin', 'admin', null],
    [7207, 'cr3_bound6', 'super_admin', 'admin', store1.id],
    [7208, 'cr3_global2', 'super_admin', 'admin', null],
    [7209, 'cr3_bound7', 'super_admin', 'admin', store1.id]
  ]) {
    await db.user.create({
      id,
      userName,
      email: `p14-${id}-crit3@test.com`,
      roleType,
      userType,
      store,
      status: 'active',
      fullName: userName
    })
  }
})

afterAll(async () => {
  await db.user.destroy({ where: { id: [7101, 7102, 7103, 7201, 7202, 7203, 7204, 7205, 7206, 7207, 7208, 7209] }, force: true })
  await db.db_backup.destroy({ where: { id: createdIds }, force: true })
  await db.location.destroy({
    where: { id: [store1?.id, store2?.id].filter(Boolean) },
    force: true
  })
  try {
    fs.rmSync(BACKUP_DIR, { recursive: true, force: true })
  } catch {}
})

describe('CRIT-3 backup global boundary', () => {
  const tenantTokens = [
    ['user', 7101],
    ['admin', 7102],
    ['kasir', 7103]
  ]

  for (const [role, id] of tenantTokens) {
    test(`tenant ${role} cannot create a backup`, async () => {
      const res = await request(app)
        .post('/backup/create')
        .set('Authorization', `Bearer ${await mkToken(role, store1.id, id)}`)

      expect([403, 401]).toContain(res.status)
    })

    test(`tenant ${role} cannot list backups`, async () => {
      const res = await request(app)
        .get('/backup/list')
        .set('Authorization', `Bearer ${await mkToken(role, store1.id, id)}`)

      expect([403, 401]).toContain(res.status)
    })

    test(`tenant ${role} cannot download a backup`, async () => {
      const res = await request(app)
        .get(`/backup/download/${backupS1.id}`)
        .set('Authorization', `Bearer ${await mkToken(role, store1.id, id)}`)

      expect([403, 401]).toContain(res.status)
    })

    test(`tenant ${role} cannot restore a backup`, async () => {
      const res = await request(app)
        .post(`/backup/restore/${backupS1.id}`)
        .set('Authorization', `Bearer ${await mkToken(role, store1.id, id)}`)

      expect([403, 401]).toContain(res.status)
    })

    test(`tenant ${role} cannot delete a backup`, async () => {
      const res = await request(app)
        .delete(`/backup/delete/${backupS1.id}`)
        .set('Authorization', `Bearer ${await mkToken(role, store1.id, id)}`)

      expect([403, 401]).toContain(res.status)
    })

    test(`tenant ${role} cannot modify the global backup schedule`, async () => {
      const res = await request(app)
        .put('/backup/schedule')
        .set('Authorization', `Bearer ${await mkToken(role, store1.id, id)}`)
        .send({ enabled: true, cron: '0 0 * * *', retention: 7 })

      expect([403, 401]).toContain(res.status)
    })
  }

  describe('super_admin tenant boundary', () => {
    let otherStoreBackup = null
    let globalBackup = null
    let ownBackup = null

    beforeEach(async () => {
      otherStoreBackup = await makeBackup(store2.id, `other_${Date.now()}.dump`, 'OTHER_DUMP')
      globalBackup = await makeBackup(null, `global_${Date.now()}.dump`, 'GLOBAL_DUMP')
      ownBackup = await makeBackup(store1.id, `own_${Date.now()}.dump`, 'OWN_DUMP')
    })

    afterEach(async () => {
      await db.db_backup.destroy({
        where: {
          id: [otherStoreBackup?.id, globalBackup?.id, ownBackup?.id].filter(Boolean)
        },
        force: true
      })
      for (const f of [otherStoreBackup?.filepath, globalBackup?.filepath, ownBackup?.filepath]) {
        if (f && fs.existsSync(f)) {
          try {
            fs.unlinkSync(f)
          } catch {}
        }
      }
    })

    test('store-bound super_admin cannot download another store backup', async () => {
      const res = await request(app)
        .get(`/backup/download/${otherStoreBackup.id}`)
        .set('Authorization', `Bearer ${await mkToken('super_admin', store1.id, 7201)}`)

      expect([403, 401, 404]).toContain(res.status)
    })

    test('store-bound super_admin cannot delete another store backup', async () => {
      const res = await request(app)
        .delete(`/backup/delete/${otherStoreBackup.id}`)
        .set('Authorization', `Bearer ${await mkToken('super_admin', store1.id, 7202)}`)

      expect([403, 401]).toContain(res.status)
      // record must survive
      expect(await db.db_backup.findByPk(otherStoreBackup.id)).not.toBeNull()
    })

    test('store-bound super_admin cannot restore another store backup', async () => {
      const res = await request(app)
        .post(`/backup/restore/${otherStoreBackup.id}`)
        .set('Authorization', `Bearer ${await mkToken('super_admin', store1.id, 7203)}`)

      expect([403, 401]).toContain(res.status)
    })

    test('store-bound super_admin cannot download a global (store-null) backup', async () => {
      const res = await request(app)
        .get(`/backup/download/${globalBackup.id}`)
        .set('Authorization', `Bearer ${await mkToken('super_admin', store1.id, 7204)}`)

      expect([403, 401, 404]).toContain(res.status)
    })

    test('store-bound super_admin can download their own store backup', async () => {
      // P0-C (locked): backups are platform-global artifacts; the store label
      // is metadata, never authority. Only global super_admin may download.
      const res = await request(app)
        .get(`/backup/download/${ownBackup.id}`)
        .set('Authorization', `Bearer ${await mkToken('super_admin', store1.id, 7205)}`)

      expect(res.status).toBe(403)
    })

    test('global super_admin can download any backup', async () => {
      const res = await request(app)
        .get(`/backup/download/${otherStoreBackup.id}`)
        .set('Authorization', `Bearer ${await mkToken('super_admin', null, 7206)}`)

      expect(res.status).toBe(200)
      expect(Buffer.isBuffer(res.body)).toBe(true)
      expect(res.body.toString()).toBe('OTHER_DUMP')
    })

    test('store-bound super_admin listing only sees their own store backups', async () => {
      // P0-C (locked): listing is platform-global; store-bound denied.
      const res = await request(app)
        .get('/backup/list')
        .set('Authorization', `Bearer ${await mkToken('super_admin', store1.id, 7207)}`)

      expect(res.status).toBe(403)
    })

    test('global super_admin listing sees backups across stores', async () => {
      const res = await request(app)
        .get('/backup/list')
        .set('Authorization', `Bearer ${await mkToken('super_admin', null, 7208)}`)

      expect(res.status).toBe(200)
      const ids = (res.body?.data || []).map((b) => b.id)
      expect(ids).toContain(otherStoreBackup.id)
      expect(ids).toContain(ownBackup.id)
    })

    test('store-bound super_admin deleting own backup succeeds', async () => {
      // P0-C (locked): delete is platform-global; store-bound denied, row survives.
      const res = await request(app)
        .delete(`/backup/delete/${ownBackup.id}`)
        .set('Authorization', `Bearer ${await mkToken('super_admin', store1.id, 7209)}`)

      expect(res.status).toBe(403)
      expect(await db.db_backup.findByPk(ownBackup.id)).not.toBeNull()
    })
  })
})