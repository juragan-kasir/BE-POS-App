process.env.NODE_ENV = 'test'

// BA DR-28 step 4: the widening migration only ever widens a VARCHAR to the
// field-length standard, replays safely, and never touches a value.
const db = require('../db/models')
const migration = require('../db/migrations/20261024000001-dr28-widen-text-columns')

const TAG = `DR28W_${Date.now()}`

const lengths = async () => {
  const [rows] = await db.sequelize.query(
    `SELECT table_name, column_name, data_type, character_maximum_length AS len
       FROM information_schema.columns WHERE table_schema = 'public'`
  )
  return new Map(rows.map((r) => [`${r.table_name}.${r.column_name}`, r]))
}

describe('planWidening', () => {
  const col = (dataType, length) => ({ dataType, length })

  test('widens only a narrower VARCHAR', () => {
    const plan = migration.planWidening(
      new Map([
        ['tenant.name', col('character varying', 100)],
        ['table.area', col('character varying', 50)], // already at the standard
        ['product.image', col('character varying', 4000)], // wider: never narrowed
        ['supplier.website', col('text', null)] // TEXT: left alone
      ])
    )
    expect(plan).toEqual([['tenant', 'name', 150]])
  })

  test('a missing column or table is skipped', () => {
    expect(migration.planWidening(new Map())).toEqual([])
  })

  test('the targets follow the DR-28 standard', () => {
    const byColumn = Object.fromEntries(migration.TARGETS.map(([t, c, n]) => [`${t}.${c}`, n]))
    expect(byColumn['tenant.name']).toBe(150)
    expect(byColumn['table.area']).toBe(50)
    expect(byColumn['stock_transfer.reason']).toBe(255)
    for (const url of ['product.image', 'category.image', 'location.image', 'user.image', 'supplier.website', 'social_media.link']) {
      expect(byColumn[url]).toBe(2048)
    }
  })
})

describe('up()', () => {
  let category
  afterAll(async () => {
    if (category) await db.category.destroy({ where: { id: category.id }, force: true })
  })

  test('widens every target, replays safely and keeps values', async () => {
    category = await db.category.create({ name: `${TAG}_cat`, image: 'https://res.cloudinary.com/demo/image/upload/v1/a.jpg' })
    const queryInterface = db.sequelize.getQueryInterface()

    await migration.up(queryInterface, db.Sequelize)
    await migration.up(queryInterface, db.Sequelize)

    const after = await lengths()
    for (const [table, column, length] of migration.TARGETS) {
      const c = after.get(`${table}.${column}`)
      if (!c) continue
      expect({ col: `${table}.${column}`, len: c.len }).toEqual({ col: `${table}.${column}`, len: length })
    }
    await category.reload()
    expect(category.image).toBe('https://res.cloudinary.com/demo/image/upload/v1/a.jpg')

    // the column now holds what the standard allows
    const longUrl = `https://example.com/${'p'.repeat(1500)}`
    await db.sequelize.query('UPDATE category SET image = :img WHERE id = :id', {
      replacements: { img: longUrl, id: category.id }
    })
    await category.reload()
    expect(category.image).toBe(longUrl)
  })

  test('down() changes nothing', async () => {
    const before = await lengths()
    await migration.down(db.sequelize.getQueryInterface(), db.Sequelize)
    const after = await lengths()
    expect(after.get('tenant.name').len).toBe(before.get('tenant.name').len)
  })
})
