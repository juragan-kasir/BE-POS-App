process.env.NODE_ENV = 'test'

const db = require('../db/models')
const {
  addPaymentMethodName,
  dropPaymentMethodName
} = require('../db/migrations/20261101000001-payment-method-name')

const TABLES = [`pmn_scratch_a_${process.pid}`, `pmn_scratch_b_${process.pid}`]
const qi = () => db.sequelize.getQueryInterface()

const hasColumn = async (table) => {
  const rows = await db.sequelize.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = :table AND column_name = 'paymentMethodName'`,
    { replacements: { table }, type: db.sequelize.QueryTypes.SELECT }
  )
  return rows.length > 0
}

beforeAll(async () => {
  for (const table of TABLES) {
    await db.sequelize.query(`CREATE TABLE "${table}" (id SERIAL PRIMARY KEY)`)
    await db.sequelize.query(`INSERT INTO "${table}" DEFAULT VALUES`)
  }
})

afterAll(async () => {
  for (const table of TABLES) {
    await db.sequelize.query(`DROP TABLE IF EXISTS "${table}"`)
  }
})

describe('B8 payment method name migration', () => {
  test('up adds a nullable column to every table and replays safely', async () => {
    await addPaymentMethodName(qi(), TABLES)
    await addPaymentMethodName(qi(), TABLES)
    for (const table of TABLES) {
      expect(await hasColumn(table)).toBe(true)
      const [row] = await db.sequelize.query(`SELECT "paymentMethodName" FROM "${table}"`, {
        type: db.sequelize.QueryTypes.SELECT
      })
      expect(row.paymentMethodName).toBeNull()
    }
  })

  test('down refuses while a row holds a name and changes nothing', async () => {
    await db.sequelize.query(`UPDATE "${TABLES[1]}" SET "paymentMethodName" = 'GoPay'`)
    await expect(dropPaymentMethodName(qi(), TABLES)).rejects.toThrow(/1 row\(s\) hold/)
    for (const table of TABLES) expect(await hasColumn(table)).toBe(true)
  })

  test('down drops the column once no row holds a name', async () => {
    await db.sequelize.query(`UPDATE "${TABLES[1]}" SET "paymentMethodName" = NULL`)
    await dropPaymentMethodName(qi(), TABLES)
    for (const table of TABLES) expect(await hasColumn(table)).toBe(false)
  })
})
