process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const app = require('../api/index')
const db = require('../db/models')

let closedStore
let openStore

const closedHours = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday'
].map((day) => ({ day, open: null, close: null, is24Hours: false }))

beforeAll(async () => {
  closedStore = await db.location.create({
    name: 'PUBLIC_CLOSED_STORE',
    status: 'active',
    timezone: 'Asia/Jakarta',
    openingHours: closedHours
  })
  openStore = await db.location.create({
    name: 'PUBLIC_OPEN_STORE',
    status: 'active',
    timezone: 'Asia/Jakarta',
    openingHours: null
  })
})

afterAll(async () => {
  await db.location.destroy({
    where: { id: [closedStore.id, openStore.id] },
    force: true
  })
})

test('public locations expose the open state without opening hours internals', async () => {
  const res = await request(app).get('/location/get-location-public')
  expect(res.status).toBe(200)

  const closed = res.body.data.find((item) => item.id === closedStore.id)
  const open = res.body.data.find((item) => item.id === openStore.id)

  expect(closed).toMatchObject({ isOpen: false, nextOpenAt: null })
  expect(open).toMatchObject({ isOpen: true, nextOpenAt: null })
  expect(closed.openingHours).toBeUndefined()
})
