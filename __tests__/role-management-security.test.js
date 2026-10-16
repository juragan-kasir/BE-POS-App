process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const crypto = require('crypto')
const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

// Role management security (audit 2026-10-16):
//   R-02 an edit changes only the fields it sends (no silent downgrade)
//   R-03 /role/get-role requires a signed-in manager and is scoped
//   R-04 /role/get-role-by-id is scoped (out of scope = 404)
//   R-05 role mutations take the store from the caller, never the body
//   R-08 role changes and their audit record commit together; actors come
//        from the session
//   R-09 duplicate names are a 409 within one scope
// Owner decisions taken from the BA (DR-12 §35.4), 2026-10-16:
//   D2 built-in (isSystem) roles: only the global super_admin changes them,
//      and never their type or scope (Q14 protected built-ins, Q10)
//   D4 a role still held by users is not deleted (Q5/Q6 role-anchored
//      membership) — 409 ROLE_IN_USE
//   D5 a tenant_admin (canonical role.manage) manages its tenant stores'
//      non-administrative custom roles (Q11/Q14/Q15; admin grants wait for
//      the Q31 elevated mechanism)
//   R-07 accessMenu entries must be well-formed

const PREFIX = `rms_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
let seq = 0
const unique = (key) => `${PREFIX}_${key}_${++seq}`.toLowerCase()
const sign = (claims) => signSessionToken(claims, JWT_SECRET)
const bearer = (token) => ({ Authorization: `Bearer ${token}` })

let storeA = null
let storeB = null
const roles = {}
const actors = {}
const createdUserIds = []
const createdRoleIds = []

const makeUser = async (key, attrs) => {
  const name = unique(key)
  const row = await db.user.create({
    userName: name,
    email: `${name}@test.com`,
    password: 'Rahasia123!',
    fullName: name,
    userType: 'user',
    status: 'active',
    ...attrs
  })
  createdUserIds.push(row.id)
  return row
}

const makeRole = async (key, attrs) => {
  const row = await db.role.create({
    name: unique(key),
    status: 'active',
    accessMenu: [{ menu: '/home', view: true }],
    ...attrs
  })
  createdRoleIds.push(row.id)
  return row
}

const trackRoleByName = async (name) => {
  const rows = await db.role.findAll({ where: { name }, paranoid: false })
  rows.forEach((row) => createdRoleIds.push(row.id))
  return rows
}

const snapshotRole = async (id) => {
  const row = await db.role.findByPk(id, { paranoid: false })
  if (!row) return null
  const { name, roleType, store, status, accessMenu, deletedAt } = row.get({
    plain: true
  })
  return { name, roleType, store, status, accessMenu, deletedAt }
}

let tokens = null
const T = {}

beforeAll(async () => {
  storeA = await db.location.create({
    name: unique('STORE_A'),
    status: 'active'
  })
  storeB = await db.location.create({
    name: unique('STORE_B'),
    status: 'active'
  })

  roles.globalSuper = await makeRole('GLOBAL_SUPER', {
    roleType: 'super_admin',
    store: null
  })
  roles.globalAdmin = await makeRole('GLOBAL_ADMIN', {
    roleType: 'admin',
    store: null
  })
  roles.adminA = await makeRole('ADMIN_A', {
    roleType: 'admin',
    store: storeA.id
  })
  roles.userA = await makeRole('USER_A', { roleType: 'user', store: storeA.id })
  roles.adminB = await makeRole('ADMIN_B', {
    roleType: 'admin',
    store: storeB.id
  })

  actors.superGlobal = await makeUser('superGlobal', {
    roleType: 'super_admin',
    userType: 'admin',
    store: null
  })
  actors.superBoundA = await makeUser('superBoundA', {
    roleType: 'super_admin',
    userType: 'admin',
    store: storeA.id
  })
  actors.adminA = await makeUser('adminA', {
    roleType: 'admin',
    userType: 'admin',
    store: storeA.id
  })
  actors.kasirA = await makeUser('kasirA', {
    roleType: 'kasir',
    store: storeA.id
  })
  actors.holderA = await makeUser('holderA', {
    roleType: 'admin',
    roleId: roles.adminA.id,
    store: storeA.id
  })
  actors.holderB = await makeUser('holderB', {
    roleType: 'admin',
    roleId: roles.adminB.id,
    store: storeB.id
  })

  tokens = {
    superGlobal: await sign({
      id: actors.superGlobal.id,
      roleType: 'super_admin',
      store: null
    }),
    superBoundA: await sign({
      id: actors.superBoundA.id,
      roleType: 'super_admin',
      store: storeA.id
    }),
    adminA: await sign({
      id: actors.adminA.id,
      roleType: 'admin',
      store: storeA.id
    }),
    kasirA: await sign({
      id: actors.kasirA.id,
      roleType: 'kasir',
      store: storeA.id
    })
  }
})

afterAll(async () => {
  const tenantIds = [T.tenant?.id, T.otherTenant?.id].filter(Boolean)
  if (tenantIds.length) {
    await db.tenantMembership
      .destroy({ where: { tenantId: tenantIds }, force: true })
      .catch(() => {})
  }
  await db.user
    .destroy({ where: { id: createdUserIds }, force: true })
    .catch(() => {})
  if (createdRoleIds.length) {
    await db.auditLog
      .destroy({ where: { entity: 'role', entityId: createdRoleIds } })
      .catch(() => {})
    await db.role
      .destroy({ where: { id: createdRoleIds }, force: true })
      .catch(() => {})
  }
  await db.location
    .destroy({
      where: {
        id: [
          storeA?.id,
          storeB?.id,
          T.store1?.id,
          T.store2?.id,
          T.otherStore?.id
        ].filter(Boolean)
      },
      force: true
    })
    .catch(() => {})
  if (tenantIds.length) {
    await db.tenant
      .destroy({ where: { id: tenantIds }, force: true })
      .catch(() => {})
  }
})

describe('R-02 an edit changes only the fields it sends', () => {
  test('the role editor payload keeps roleType, store and the other fields', async () => {
    const role = await makeRole('EDIT_KEEP', {
      roleType: 'admin',
      store: storeA.id
    })
    const res = await request(app)
      .put(`/role/edit-role/${role.id}`)
      .set(bearer(tokens.superGlobal))
      // Exactly what the role editor sent before this fix.
      .send({
        id: role.id,
        name: `${role.name}_renamed`,
        description: 'baru',
        status: 'active',
        modifiedBy: 999999,
        accessMenu: [{ menu: '/order-list', view: true }]
      })
    expect(res.status).toBe(200)
    const after = await db.role.findByPk(role.id)
    expect(after.roleType).toBe('admin')
    expect(after.store).toBe(storeA.id)
    expect(after.name).toBe(`${role.name}_renamed`)
    expect(after.accessMenu).toEqual([{ menu: '/order-list', view: true }])
    // The actor is the session user, never the client-supplied id.
    expect(after.modifiedBy).toBe(actors.superGlobal.id)
  })

  test('sending only accessMenu leaves name, roleType, store and status unchanged', async () => {
    const role = await makeRole('EDIT_MENU_ONLY', {
      roleType: 'admin',
      store: storeA.id,
      status: 'draft'
    })
    const before = await snapshotRole(role.id)
    const res = await request(app)
      .put(`/role/edit-role/${role.id}`)
      .set(bearer(tokens.superGlobal))
      .send({ accessMenu: [] })
    expect(res.status).toBe(200)
    expect(await snapshotRole(role.id)).toEqual({ ...before, accessMenu: [] })
  })

  test('an edit of a super_admin role by the global super_admin keeps it super_admin', async () => {
    const role = await makeRole('EDIT_SUPER', {
      roleType: 'super_admin',
      store: null
    })
    const res = await request(app)
      .put(`/role/edit-role/${role.id}`)
      .set(bearer(tokens.superGlobal))
      .send({ name: role.name, description: 'x', status: 'active' })
    expect(res.status).toBe(200)
    expect((await db.role.findByPk(role.id)).roleType).toBe('super_admin')
  })

  test('an invalid status is rejected and nothing changes', async () => {
    const role = await makeRole('EDIT_BAD_STATUS', {
      roleType: 'user',
      store: storeA.id
    })
    const before = await snapshotRole(role.id)
    const res = await request(app)
      .put(`/role/edit-role/${role.id}`)
      .set(bearer(tokens.superGlobal))
      .send({ status: 'bogus' })
    expect(res.status).toBe(400)
    expect(await snapshotRole(role.id)).toEqual(before)
  })
})

describe('R-03 GET /role/get-role is authenticated and scoped', () => {
  test('no token → 401', async () => {
    const res = await request(app).get('/role/get-role')
    expect(res.status).toBe(401)
  })

  test('a cashier → 403', async () => {
    const res = await request(app)
      .get('/role/get-role')
      .set(bearer(tokens.kasirA))
    expect(res.status).toBe(403)
  })

  test('store admin sees global and own-store roles, not other stores or super_admin roles', async () => {
    const res = await request(app)
      .get('/role/get-role')
      .set(bearer(tokens.adminA))
    expect(res.status).toBe(200)
    const ids = res.body.data.map((r) => r.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        roles.globalAdmin.id,
        roles.adminA.id,
        roles.userA.id
      ])
    )
    expect(ids).not.toContain(roles.adminB.id)
    expect(ids).not.toContain(roles.globalSuper.id)
  })

  test('store-bound super_admin sees global and own-store roles only', async () => {
    const res = await request(app)
      .get('/role/get-role')
      .set(bearer(tokens.superBoundA))
    expect(res.status).toBe(200)
    const ids = res.body.data.map((r) => r.id)
    expect(ids).toEqual(
      expect.arrayContaining([roles.globalSuper.id, roles.adminA.id])
    )
    expect(ids).not.toContain(roles.adminB.id)
  })

  test('global super_admin sees every store', async () => {
    const res = await request(app)
      .get('/role/get-role')
      .set(bearer(tokens.superGlobal))
    expect(res.status).toBe(200)
    const ids = res.body.data.map((r) => r.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        roles.adminA.id,
        roles.adminB.id,
        roles.globalSuper.id
      ])
    )
  })
})

describe('R-04 GET /role/get-role-by-id is scoped', () => {
  test('a cashier → 403', async () => {
    const res = await request(app)
      .get(`/role/get-role-by-id/${roles.adminA.id}`)
      .set(bearer(tokens.kasirA))
    expect(res.status).toBe(403)
  })

  test('store admin reads its own store role but not another store or a super_admin role', async () => {
    const own = await request(app)
      .get(`/role/get-role-by-id/${roles.adminA.id}`)
      .set(bearer(tokens.adminA))
    expect(own.status).toBe(200)
    const foreign = await request(app)
      .get(`/role/get-role-by-id/${roles.adminB.id}`)
      .set(bearer(tokens.adminA))
    expect(foreign.status).toBe(404)
    const superRole = await request(app)
      .get(`/role/get-role-by-id/${roles.globalSuper.id}`)
      .set(bearer(tokens.adminA))
    expect(superRole.status).toBe(404)
  })
})

describe('R-05 role mutations are confined to the caller scope', () => {
  test('store-bound super_admin creates roles in its own store', async () => {
    const name = unique('bound_create')
    const res = await request(app)
      .post('/role/add-new-role')
      .set(bearer(tokens.superBoundA))
      .send({ name, accessMenu: [] })
    expect(res.status).toBe(200)
    const [row] = await trackRoleByName(name)
    expect(row.store).toBe(storeA.id)
    expect(row.createdBy).toBe(actors.superBoundA.id)
  })

  test('store-bound super_admin cannot create a role in another store or globally', async () => {
    for (const store of [storeB.id, null]) {
      const name = unique('bound_foreign')
      const res = await request(app)
        .post('/role/add-new-role')
        .set(bearer(tokens.superBoundA))
        .send({ name, store })
      expect(res.status).toBe(403)
      expect(await db.role.count({ where: { name } })).toBe(0)
    }
  })

  test('global super_admin cannot create a role for a store that does not exist', async () => {
    const name = unique('ghost_store')
    const res = await request(app)
      .post('/role/add-new-role')
      .set(bearer(tokens.superGlobal))
      .send({ name, store: '999999999' })
    expect(res.status).toBe(400)
    expect(await db.role.count({ where: { name } })).toBe(0)
  })

  test('store-bound super_admin cannot edit, delete or re-menu another store role (404)', async () => {
    const before = await snapshotRole(roles.adminB.id)
    const edit = await request(app)
      .put(`/role/edit-role/${roles.adminB.id}`)
      .set(bearer(tokens.superBoundA))
      .send({ name: 'HIJACKED', accessMenu: [] })
    expect(edit.status).toBe(404)
    const menu = await request(app)
      .put('/role/update-access-menu')
      .set(bearer(tokens.superBoundA))
      .send({ roleId: roles.adminB.id, accessMenu: [] })
    expect(menu.status).toBe(404)
    const del = await request(app)
      .delete(`/role/delete-role/${roles.adminB.id}`)
      .set(bearer(tokens.superBoundA))
    expect(del.status).toBe(404)
    expect(await snapshotRole(roles.adminB.id)).toEqual(before)
    expect((await db.user.findByPk(actors.holderB.id)).roleId).toBe(
      roles.adminB.id
    )
  })

  test('store-bound super_admin cannot change a global role (403)', async () => {
    const before = await snapshotRole(roles.globalAdmin.id)
    const edit = await request(app)
      .put(`/role/edit-role/${roles.globalAdmin.id}`)
      .set(bearer(tokens.superBoundA))
      .send({ accessMenu: [] })
    expect(edit.status).toBe(403)
    const menu = await request(app)
      .put('/role/update-access-menu')
      .set(bearer(tokens.superBoundA))
      .send({ roleId: roles.globalAdmin.id, accessMenu: [] })
    expect(menu.status).toBe(403)
    expect(await snapshotRole(roles.globalAdmin.id)).toEqual(before)
  })

  test('store-bound super_admin cannot move its own role to another store', async () => {
    const role = await makeRole('BOUND_MOVE', {
      roleType: 'user',
      store: storeA.id
    })
    const before = await snapshotRole(role.id)
    const res = await request(app)
      .put(`/role/edit-role/${role.id}`)
      .set(bearer(tokens.superBoundA))
      .send({ store: storeB.id })
    expect(res.status).toBe(403)
    expect(await snapshotRole(role.id)).toEqual(before)
  })

  test('store-bound super_admin cannot assign another store role to its user', async () => {
    const target = await makeUser('assignTarget', {
      roleType: 'user',
      store: storeA.id
    })
    const res = await request(app)
      .put('/role/update-user-role')
      .set(bearer(tokens.superBoundA))
      .send({ userId: target.id, roleId: roles.adminB.id })
    expect(res.status).toBe(403)
    const after = await db.user.findByPk(target.id)
    expect(after.roleType).toBe('user')
    expect(after.roleId).toBeNull()
  })

  test('the role table is scoped and carries user counts', async () => {
    const res = await request(app)
      .get('/role/get-role-all')
      .query({ limit: 100, search: PREFIX })
      .set(bearer(tokens.superBoundA))
    expect(res.status).toBe(200)
    const ids = res.body.data.map((r) => r.id)
    expect(ids).toContain(roles.adminA.id)
    expect(ids).not.toContain(roles.adminB.id)
    expect(res.body.data.find((r) => r.id === roles.adminA.id).userCount).toBe(
      1
    )
  })
})

describe('R-08 role changes and their audit record commit together', () => {
  test('an audit write failure rolls the edit back', async () => {
    const role = await makeRole('AUDIT_ROLLBACK', {
      roleType: 'admin',
      store: storeA.id
    })
    const before = await snapshotRole(role.id)
    const spy = jest
      .spyOn(db.auditLog, 'create')
      .mockRejectedValueOnce(new Error('audit down'))
    try {
      const res = await request(app)
        .put(`/role/edit-role/${role.id}`)
        .set(bearer(tokens.superGlobal))
        .send({ roleType: 'user', accessMenu: [] })
      expect(res.status).toBe(500)
    } finally {
      spy.mockRestore()
    }
    expect(await snapshotRole(role.id)).toEqual(before)
  })

  test('an audit write failure rolls the grant back', async () => {
    const target = await makeUser('auditGrant', {
      roleType: 'user',
      store: storeA.id
    })
    const spy = jest
      .spyOn(db.auditLog, 'create')
      .mockRejectedValueOnce(new Error('audit down'))
    try {
      const res = await request(app)
        .put('/role/update-user-role')
        .set(bearer(tokens.superGlobal))
        .send({ userId: target.id, roleId: roles.adminA.id })
      expect(res.status).toBe(500)
    } finally {
      spy.mockRestore()
    }
    const after = await db.user.findByPk(target.id)
    expect(after.roleType).toBe('user')
    expect(after.roleId).toBeNull()
  })

  test('a successful edit records old and new values', async () => {
    const role = await makeRole('AUDIT_VALUES', {
      roleType: 'admin',
      store: storeA.id
    })
    const res = await request(app)
      .put(`/role/edit-role/${role.id}`)
      .set(bearer(tokens.superGlobal))
      .send({ status: 'draft' })
    expect(res.status).toBe(200)
    const [log] = await db.auditLog.findAll({
      where: { entity: 'role', entityId: role.id, action: 'update' },
      order: [['id', 'DESC']],
      limit: 1
    })
    expect(log).not.toBeNull()
    expect(log.userId).toBe(actors.superGlobal.id)
    expect(log.oldValues.status).toBe('active')
    expect(log.newValues.status).toBe('draft')
  })
})

describe('R-09 duplicates and missing roles', () => {
  test('a duplicate name in the same scope is 409; another store may reuse it', async () => {
    const dup = await request(app)
      .post('/role/add-new-role')
      .set(bearer(tokens.superGlobal))
      .send({ name: roles.adminA.name, store: storeA.id })
    expect(dup.status).toBe(409)
    const other = await request(app)
      .post('/role/add-new-role')
      .set(bearer(tokens.superGlobal))
      .send({ name: roles.adminA.name, store: storeB.id })
    expect(other.status).toBe(200)
    await trackRoleByName(roles.adminA.name)
  })

  test('renaming onto an existing name is 409 even with a different status', async () => {
    const role = await makeRole('DUP_EDIT', {
      roleType: 'user',
      store: storeA.id,
      status: 'draft'
    })
    const before = await snapshotRole(role.id)
    const res = await request(app)
      .put(`/role/edit-role/${role.id}`)
      .set(bearer(tokens.superGlobal))
      .send({ name: roles.userA.name, status: 'inactive' })
    expect(res.status).toBe(409)
    expect(await snapshotRole(role.id)).toEqual(before)
  })

  test('deleting or editing a role that does not exist is 404', async () => {
    const del = await request(app)
      .delete('/role/delete-role/999999999')
      .set(bearer(tokens.superGlobal))
    expect(del.status).toBe(404)
    const edit = await request(app)
      .put('/role/edit-role/999999999')
      .set(bearer(tokens.superGlobal))
      .send({ name: 'x' })
    expect(edit.status).toBe(404)
  })

  test('update-access-menu rejects a non-array accessMenu', async () => {
    const before = await snapshotRole(roles.userA.id)
    const res = await request(app)
      .put('/role/update-access-menu')
      .set(bearer(tokens.superGlobal))
      .send({ roleId: roles.userA.id, accessMenu: null })
    expect(res.status).toBe(400)
    expect(await snapshotRole(roles.userA.id)).toEqual(before)
  })

  test('a system role still cannot be deleted', async () => {
    const role = await makeRole('SYSTEM', {
      roleType: 'admin',
      store: null,
      isSystem: true
    })
    const res = await request(app)
      .delete(`/role/delete-role/${role.id}`)
      .set(bearer(tokens.superGlobal))
    expect(res.status).toBe(403)
    expect((await snapshotRole(role.id)).deletedAt).toBeNull()
  })
})

describe('D2 built-in roles are protected', () => {
  test('the global super_admin cannot change a built-in role type or scope', async () => {
    const role = await makeRole('SYS_TYPE', {
      roleType: 'admin',
      store: null,
      isSystem: true
    })
    const before = await snapshotRole(role.id)
    for (const body of [{ roleType: 'user' }, { store: storeA.id }]) {
      const res = await request(app)
        .put(`/role/edit-role/${role.id}`)
        .set(bearer(tokens.superGlobal))
        .send(body)
      expect(res.status).toBe(403)
    }
    expect(await snapshotRole(role.id)).toEqual(before)
  })

  test('the global super_admin may still rename a built-in role and change its menus', async () => {
    const role = await makeRole('SYS_MENU', {
      roleType: 'admin',
      store: null,
      isSystem: true
    })
    const res = await request(app)
      .put(`/role/edit-role/${role.id}`)
      .set(bearer(tokens.superGlobal))
      .send({ name: `${role.name}_x`, roleType: 'admin', accessMenu: [] })
    expect(res.status).toBe(200)
    const after = await db.role.findByPk(role.id)
    expect(after.name).toBe(`${role.name}_x`)
    expect(after.accessMenu).toEqual([])
  })

  test('a store-bound super_admin cannot change a built-in role of its own store', async () => {
    const role = await makeRole('SYS_BOUND', {
      roleType: 'user',
      store: storeA.id,
      isSystem: true
    })
    const before = await snapshotRole(role.id)
    const edit = await request(app)
      .put(`/role/edit-role/${role.id}`)
      .set(bearer(tokens.superBoundA))
      .send({ accessMenu: [] })
    expect(edit.status).toBe(403)
    const menu = await request(app)
      .put('/role/update-access-menu')
      .set(bearer(tokens.superBoundA))
      .send({ roleId: role.id, accessMenu: [] })
    expect(menu.status).toBe(403)
    expect(await snapshotRole(role.id)).toEqual(before)
  })
})

describe('D4 a role still held by users is not deleted', () => {
  test('delete answers 409 ROLE_IN_USE and leaves the role and its holders unchanged', async () => {
    const role = await makeRole('IN_USE', {
      roleType: 'user',
      store: storeA.id
    })
    const holder = await makeUser('inUseHolder', {
      roleType: 'user',
      roleId: role.id,
      store: storeA.id
    })
    const res = await request(app)
      .delete(`/role/delete-role/${role.id}`)
      .set(bearer(tokens.superGlobal))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('ROLE_IN_USE')
    expect(res.body.data.userCount).toBe(1)
    expect((await snapshotRole(role.id)).deletedAt).toBeNull()
    expect((await db.user.findByPk(holder.id)).roleId).toBe(role.id)
  })

  test('an unused role is deleted', async () => {
    const role = await makeRole('UNUSED', {
      roleType: 'user',
      store: storeA.id
    })
    const res = await request(app)
      .delete(`/role/delete-role/${role.id}`)
      .set(bearer(tokens.superGlobal))
    expect(res.status).toBe(200)
    expect((await snapshotRole(role.id)).deletedAt).not.toBeNull()
  })
})

describe('R-07 accessMenu entries must be well-formed', () => {
  test.each([[[{ menu: '/x', view: 'yes' }]], [[{ view: true }]], [['/x']]])(
    'rejects %j',
    async (accessMenu) => {
      const name = unique('bad_menu')
      const res = await request(app)
        .post('/role/add-new-role')
        .set(bearer(tokens.superGlobal))
        .send({ name, accessMenu })
      expect(res.status).toBe(400)
      expect(await db.role.count({ where: { name } })).toBe(0)
    }
  )

  test('accepts boolean and null (not applicable) flags', async () => {
    const name = unique('good_menu')
    const res = await request(app)
      .post('/role/add-new-role')
      .set(bearer(tokens.superGlobal))
      .send({
        name,
        accessMenu: [
          { menu: '/order-list', view: true, add: false, approve: null }
        ]
      })
    expect(res.status).toBe(200)
    await trackRoleByName(name)
  })
})

describe('D5 tenant_admin manages its tenant store roles', () => {
  beforeAll(async () => {
    T.tenant = await db.tenant.create({
      code: unique('TEN'),
      name: unique('Tenant')
    })
    T.otherTenant = await db.tenant.create({
      code: unique('TENX'),
      name: unique('TenantX')
    })
    T.store1 = await db.location.create({
      name: unique('T_STORE_1'),
      status: 'active',
      tenantId: T.tenant.id
    })
    T.store2 = await db.location.create({
      name: unique('T_STORE_2'),
      status: 'active',
      tenantId: T.tenant.id
    })
    T.otherStore = await db.location.create({
      name: unique('X_STORE'),
      status: 'active',
      tenantId: T.otherTenant.id
    })

    T.kasirRole1 = await makeRole('T_KASIR_1', {
      roleType: 'kasir',
      store: T.store1.id
    })
    T.adminRole1 = await makeRole('T_ADMIN_1', {
      roleType: 'admin',
      store: T.store1.id
    })
    T.kasirRole2 = await makeRole('T_KASIR_2', {
      roleType: 'kasir',
      store: T.store2.id
    })
    T.otherRole = await makeRole('X_KASIR', {
      roleType: 'kasir',
      store: T.otherStore.id
    })

    T.admin = await makeUser('tenantAdmin', {
      roleType: 'admin',
      userType: 'admin',
      store: T.store1.id
    })
    await db.tenantMembership.create({
      userId: T.admin.id,
      tenantId: T.tenant.id,
      role: 'tenant_admin',
      status: 'ACTIVE'
    })
    T.staff2 = await makeUser('tenantStaff2', {
      roleType: 'user',
      store: T.store2.id
    })
    T.manager2 = await makeUser('tenantManager2', {
      roleType: 'admin',
      store: T.store2.id
    })
    T.token = await sign({
      id: T.admin.id,
      roleType: 'admin',
      store: T.store1.id
    })
  })

  test('lists global and tenant store roles, never another tenant or super_admin roles', async () => {
    const res = await request(app)
      .get('/role/get-role-all')
      .query({ limit: 100, search: PREFIX })
      .set(bearer(T.token))
    expect(res.status).toBe(200)
    const ids = res.body.data.map((r) => r.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        T.kasirRole1.id,
        T.kasirRole2.id,
        roles.globalAdmin.id
      ])
    )
    expect(ids).not.toContain(T.otherRole.id)
    expect(ids).not.toContain(roles.adminA.id)
    expect(ids).not.toContain(roles.globalSuper.id)
  })

  test('creates a cashier role in a tenant store', async () => {
    const name = unique('t_create')
    const res = await request(app)
      .post('/role/add-new-role')
      .set(bearer(T.token))
      .send({ name, roleType: 'kasir', store: T.store2.id, accessMenu: [] })
    expect(res.status).toBe(200)
    const [row] = await trackRoleByName(name)
    expect(row.store).toBe(T.store2.id)
    expect(row.roleType).toBe('kasir')
  })

  test('cannot create without a store, in another tenant, or an administrative role', async () => {
    const cases = [
      [{ roleType: 'kasir' }, 400],
      [{ roleType: 'kasir', store: T.otherStore.id }, 403],
      [{ roleType: 'admin', store: T.store1.id }, 403],
      [{ roleType: 'super_admin', store: T.store1.id }, 403]
    ]
    for (const [body, status] of cases) {
      const name = unique('t_denied')
      const res = await request(app)
        .post('/role/add-new-role')
        .set(bearer(T.token))
        .send({ name, ...body })
      expect(res.status).toBe(status)
      expect(await db.role.count({ where: { name } })).toBe(0)
    }
  })

  test('edits its tenant cashier roles but not admin, global or foreign roles', async () => {
    const ok = await request(app)
      .put(`/role/edit-role/${T.kasirRole1.id}`)
      .set(bearer(T.token))
      .send({ accessMenu: [{ menu: '/home', view: true }] })
    expect(ok.status).toBe(200)
    for (const [role, status] of [
      [T.adminRole1, 403],
      [roles.globalAdmin, 403],
      [T.otherRole, 404]
    ]) {
      const before = await snapshotRole(role.id)
      const res = await request(app)
        .put(`/role/edit-role/${role.id}`)
        .set(bearer(T.token))
        .send({ accessMenu: [] })
      expect(res.status).toBe(status)
      expect(await snapshotRole(role.id)).toEqual(before)
    }
  })

  test('cannot turn its cashier role into an admin role', async () => {
    const before = await snapshotRole(T.kasirRole2.id)
    const res = await request(app)
      .put(`/role/edit-role/${T.kasirRole2.id}`)
      .set(bearer(T.token))
      .send({ roleType: 'admin' })
    expect(res.status).toBe(403)
    expect(await snapshotRole(T.kasirRole2.id)).toEqual(before)
  })

  test('assigns a tenant cashier role to a staff user of that store', async () => {
    const res = await request(app)
      .put('/role/update-user-role')
      .set(bearer(T.token))
      .send({ userId: T.staff2.id, roleId: T.kasirRole2.id })
    expect(res.status).toBe(200)
    const after = await db.user.findByPk(T.staff2.id)
    expect(after.roleId).toBe(T.kasirRole2.id)
    expect(after.roleType).toBe('kasir')
  })

  test('cannot assign to an admin user, a role of another store, or an admin role', async () => {
    const cases = [
      { userId: T.manager2.id, roleId: T.kasirRole2.id },
      { userId: T.staff2.id, roleId: T.kasirRole1.id },
      { userId: T.staff2.id, roleId: T.adminRole1.id }
    ]
    for (const body of cases) {
      const before = await db.user.findByPk(body.userId)
      const res = await request(app)
        .put('/role/update-user-role')
        .set(bearer(T.token))
        .send(body)
      expect(res.status).toBe(403)
      const after = await db.user.findByPk(body.userId)
      expect([after.roleType, after.roleId]).toEqual([
        before.roleType,
        before.roleId
      ])
    }
  })

  test('a store admin without a tenant_admin membership still cannot manage roles', async () => {
    const name = unique('plain_admin')
    const res = await request(app)
      .post('/role/add-new-role')
      .set(bearer(tokens.adminA))
      .send({ name })
    expect(res.status).toBe(403)
    expect(await db.role.count({ where: { name } })).toBe(0)
  })
})

describe('R-11 an inactive or draft role is not newly granted', () => {
  let inactiveRole = null
  let draftRole = null
  beforeAll(async () => {
    inactiveRole = await makeRole('INACTIVE', {
      roleType: 'user',
      store: storeA.id,
      status: 'inactive'
    })
    draftRole = await makeRole('DRAFT', {
      roleType: 'user',
      store: storeA.id,
      status: 'draft'
    })
  })

  test('update-user-role refuses an inactive or draft role and changes nothing', async () => {
    const target = await makeUser('r11Target', {
      roleType: 'user',
      store: storeA.id
    })
    for (const role of [inactiveRole, draftRole]) {
      const res = await request(app)
        .put('/role/update-user-role')
        .set(bearer(tokens.superGlobal))
        .send({ userId: target.id, roleId: role.id })
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('ROLE_INACTIVE')
    }
    expect((await db.user.findByPk(target.id)).roleId).toBeNull()
  })

  test('a user who already holds the inactive role can have it re-applied', async () => {
    const holder = await makeUser('r11Holder', {
      roleType: 'user',
      roleId: inactiveRole.id,
      store: storeA.id
    })
    const res = await request(app)
      .put('/role/update-user-role')
      .set(bearer(tokens.superGlobal))
      .send({ userId: holder.id, roleId: inactiveRole.id })
    expect(res.status).toBe(200)
  })

  test('change-profile-user refuses an inactive role', async () => {
    const target = await makeUser('r11Profile', {
      roleType: 'user',
      store: storeA.id
    })
    const res = await request(app)
      .put('/auth/change-profile-user')
      .set(bearer(tokens.superGlobal))
      .send({ id: target.id, roleId: inactiveRole.id, store: storeA.id })
    expect(res.status).toBe(400)
    expect((await db.user.findByPk(target.id)).roleId).toBeNull()
  })

  test('add-employee refuses an inactive role', async () => {
    const userName = unique('r11emp')
    const res = await request(app)
      .post('/employee/add-employee')
      .set(bearer(tokens.superGlobal))
      .send({
        userName,
        password: 'Rahasia123!',
        confirmPassword: 'Rahasia123!',
        fullName: userName,
        email: `${userName}@test.com`,
        roleId: inactiveRole.id,
        store: storeA.id,
        shift: null,
        status: 'active'
      })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/tidak aktif/)
    expect(await db.user.count({ where: { userName } })).toBe(0)
  })

  test('get-role-by-id reports how many users hold the role', async () => {
    const res = await request(app)
      .get(`/role/get-role-by-id/${roles.adminA.id}`)
      .set(bearer(tokens.superGlobal))
    expect(res.status).toBe(200)
    expect(res.body.data.userCount).toBe(1)
  })
})
