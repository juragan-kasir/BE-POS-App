process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

jest.mock('../utils/cloudinaryStorage', () => ({
  uploadToCloudinary: jest.fn(async () => 'https://res.cloudinary.com/test/upload/v1/pos-app/uploaded.jpg'),
  uploadToCloudinaryWithDedup: jest.fn(async () => ({
    url: `https://res.cloudinary.com/test/upload/v1/pos-app/uploaded-${Date.now()}-${Math.random().toString(16).slice(2)}.jpg`,
    hash: 'test-hash'
  })),
  deleteFromCloudinary: jest.fn(async () => undefined)
}))

const fs = require('fs')
const request = require('supertest')
const bcrypt = require('bcrypt')
const { Op } = require('sequelize')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const {
  deleteFromCloudinary,
  uploadToCloudinaryWithDedup
} = require('../utils/cloudinaryStorage')

const SUFFIX = `${Date.now()}-${Math.floor(Math.random() * 100000)}`
const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

let store1
let store2
let admin1
let admin1Token
let emp2
let shift2

const password = 'InitialPass123!'

const unique = (label) => `P0_${label}_${SUFFIX}`
let employeeSeq = 0

const createEmployee = (attrs = {}) => {
  const employeeKey = `${unique('emp')}_${++employeeSeq}`
  return db.user.create({
    userName: employeeKey,
    email: `${employeeKey}@test.com`,
    userType: 'user',
    roleType: 'user',
    status: 'active',
    password,
    fullName: unique('Employee'),
    ...attrs
  })
}

beforeAll(async () => {
  store1 = await db.location.create({ name: unique('STORE_1'), status: 'active' })
  store2 = await db.location.create({ name: unique('STORE_2'), status: 'active' })

  admin1 = await db.user.create({
    userName: unique('admin'),
    email: `${unique('admin')}@test.com`,
    userType: 'admin',
    roleType: 'admin',
    store: store1.id,
    status: 'active',
    password
  })

  admin1Token = await signSessionToken(
    { id: admin1.id, userName: admin1.userName, roleType: 'admin', store: store1.id },
    JWT_SECRET
  )

  emp2 = await createEmployee({ store: store2.id })

  shift2 = await db.shift.create({
    store: store2.id,
    name: unique('SHIFT_2'),
    startTime: '08:00:00',
    endTime: '16:00:00',
    tipe_shift: 'regular',
    karyawan: [emp2.id],
    status: 'active'
  })
})

afterAll(async () => {
  await db.user
    .destroy({
      where: { store: [store1?.id, store2?.id].filter(Boolean) },
      force: true
    })
    .catch(() => {})
  await db.shift
    .destroy({ where: { store: [store1?.id, store2?.id].filter(Boolean) }, force: true })
    .catch(() => {})
  await db.location
    .destroy({ where: { id: [store1?.id, store2?.id].filter(Boolean) }, force: true })
    .catch(() => {})
})

describe('draft employee credentials', () => {
  test('creating a draft never uses the public default password', async () => {
    const employeeID = unique('DRAFT')

    const res = await request(app)
      .post('/employee/add-employee')
      .set('Authorization', `Bearer ${admin1Token}`)
      .field('status', 'draft')
      .field('fullName', 'Draft Employee')
      .field('employeeId', employeeID)
      .field('shift', '')

    expect(res.status).toBe(200)

    const created = await db.user
      .scope('withCredentials')
      .findOne({ where: { employeeID }, paranoid: false })

    expect(created).toBeTruthy()
    expect(created.status).toBe('draft')
    expect(await bcrypt.compare('Draft!12345', created.password)).toBe(false)
  })

  test('adding an employee cannot attach a shift from another store', async () => {
    const employeeID = unique('FOREIGN_SHIFT')
    const userName = unique('foreign_shift_login')

    const res = await request(app)
      .post('/employee/add-employee')
      .set('Authorization', `Bearer ${admin1Token}`)
      .field('status', 'active')
      .field('fullName', 'Foreign Shift Employee')
      .field('employeeId', employeeID)
      .field('userName', userName)
      .field('password', password)
      .field('confirmPassword', password)
      .field('shift', String(shift2.id))

    expect(res.status).toBe(403)

    const created = await db.user.findOne({ where: { employeeID }, paranoid: false })
    expect(created).toBeNull()
  })

  test('a draft account cannot log in even when its password is known', async () => {
    const draft = await createEmployee({
      userName: unique('draft_login'),
      email: `${unique('draft_login')}@test.com`,
      store: store1.id,
      status: 'draft',
      password: 'KnownDraftPass123!'
    })

    const res = await request(app)
      .post('/auth/login')
      .send({ userName: draft.userName, password: 'KnownDraftPass123!' })

    expect(res.status).toBe(401)

    const fresh = await db.user.findByPk(draft.id)
    expect(fresh.status).toBe('draft')
  })
})

describe('employee status disablement', () => {
  test('marking an employee inactive disables login and keeps it disabled', async () => {
    const employee = await createEmployee({ store: store1.id })

    const update = await request(app)
      .put('/employee/edit-employee')
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({ id: employee.id, status: 'inactive' })

    expect(update.status).toBe(200)

    const fresh = await db.user.findByPk(employee.id)
    expect(fresh.status).toBe('inactive')
    expect(fresh.disabledAt).not.toBeNull()

    const login = await request(app)
      .post('/auth/login')
      .send({ userName: employee.userName, password })

    expect(login.status).toBe(401)
  })
})

describe('cross-store shift assignment', () => {
  test('creating a shift cannot include an employee from another store', async () => {
    const name = unique('FOREIGN_MEMBER_SHIFT')

    const res = await request(app)
      .post('/shift/add-new-shift')
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({
        nama_shift: name,
        jam_mulai: '08:00:00',
        jam_selesai: '16:00:00',
        karyawan: [emp2.id]
      })

    expect(res.status).toBe(403)

    const created = await db.shift.findOne({ where: { name } })
    expect(created).toBeNull()

    const fresh = await db.user.findByPk(emp2.id)
    expect(Number(fresh.shift)).not.toBe(Number(res.body?.data?.id))
  })

  test('editing an employee cannot assign a shift from another store', async () => {
    const employee = await createEmployee({ store: store1.id })

    const res = await request(app)
      .put('/employee/edit-employee')
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({ id: employee.id, shift: shift2.id })

    expect(res.status).toBe(403)

    const fresh = await db.user.findByPk(employee.id)
    expect(fresh.shift).toBeNull()

    const foreignShift = await db.shift.findByPk(shift2.id)
    expect((foreignShift.karyawan || []).map(Number)).not.toContain(Number(employee.id))
  })
})

describe('employee status updates', () => {
  test('an unrelated edit does not silently reactivate an inactive employee', async () => {
    const employee = await createEmployee({ store: store1.id })

    const deactivate = await request(app)
      .put('/employee/edit-employee')
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({ id: employee.id, status: 'inactive' })
    expect(deactivate.status).toBe(200)

    const unrelated = await request(app)
      .put('/employee/edit-employee')
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({ id: employee.id, fullName: 'Still Inactive' })
    expect(unrelated.status).toBe(200)

    const fresh = await db.user.findByPk(employee.id)
    expect(fresh.status).toBe('inactive')
    expect(fresh.disabledAt).not.toBeNull()
  })
})

describe('employee upload safety', () => {
  beforeEach(() => {
    uploadToCloudinaryWithDedup.mockClear()
  })

  test('document upload rejects unsupported file types', async () => {
    const res = await request(app)
      .post('/employee/add-employee')
      .set('Authorization', `Bearer ${admin1Token}`)
      .field('status', 'active')
      .field('fullName', 'Unsafe Upload')
      .field('employeeId', unique('UNSAFE_UPLOAD'))
      .field('userName', unique('unsafe_upload_login'))
      .field('password', password)
      .field('confirmPassword', password)
      .field('shift', '')
      .attach('documents', Buffer.from('not a document'), {
        filename: 'payload.txt',
        contentType: 'text/plain'
      })

    expect(res.status).toBe(400)
    expect(uploadToCloudinaryWithDedup).not.toHaveBeenCalled()
  })

  test('client-supplied path segments are removed from the stored filename', async () => {
    const res = await request(app)
      .post('/employee/add-employee')
      .set('Authorization', `Bearer ${admin1Token}`)
      .field('status', 'active')
      .field('fullName', 'Path Upload')
      .field('employeeId', unique('PATH_UPLOAD'))
      .field('userName', unique('path_upload_login'))
      .field('password', password)
      .field('confirmPassword', password)
      .field('shift', '')
      .attach('documents', Buffer.from('%PDF-1.4 test'), {
        filename: '../../evil.pdf',
        contentType: 'application/pdf'
      })

    expect(res.status).toBe(200)
    expect(uploadToCloudinaryWithDedup).toHaveBeenCalledTimes(1)
    const uploadedPath = uploadToCloudinaryWithDedup.mock.calls[0][0]
    expect(uploadedPath).not.toContain('..')
    expect(uploadedPath).not.toContain('evil.pdf/')

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(fs.existsSync(uploadedPath)).toBe(false)
  })
})

describe('employee document deletion ownership', () => {
  beforeEach(() => {
    deleteFromCloudinary.mockClear()
  })

  test('only URLs already attached to the employee may be deleted', async () => {
    const ownDocument = 'https://res.cloudinary.com/test/upload/v1/pos-app-documents/own.pdf'
    const foreignDocument = 'https://res.cloudinary.com/test/upload/v1/pos-app-documents/foreign.pdf'

    const employee = await createEmployee({
      store: store1.id,
      documents: JSON.stringify([ownDocument])
    })

    const res = await request(app)
      .put('/employee/edit-employee')
      .set('Authorization', `Bearer ${admin1Token}`)
      .send({
        id: employee.id,
        deletedDocuments: JSON.stringify([ownDocument, foreignDocument])
      })

    expect(res.status).toBe(200)
    expect(deleteFromCloudinary).toHaveBeenCalledWith(ownDocument)
    expect(deleteFromCloudinary).not.toHaveBeenCalledWith(foreignDocument)

    const fresh = await db.user.findByPk(employee.id)
    expect(JSON.parse(fresh.documents || '[]')).toEqual([])
  })
})
