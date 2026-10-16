require('dotenv').config({ path: __dirname + '/../.env' })
const { requireEnv } = require('../utils/seedCredential')

// Phase 30F-1: default-deny guard BEFORE any Sequelize instantiation or
// authentication. This script TRUNCATEs the production user table by design.
const guard = require('./destructive-guard')

try {
  guard.assertDestructiveAllowed({
    operation: 'scripts/sync-user-prod.js DEV-to-PROD user copy',
    nodeEnv: process.env.NODE_ENV,
    host: process.env.POSTGRES_HOST,
    database: process.env.POSTGRES_DATABASE,
    allowVar: process.env.ALLOW_DESTRUCTIVE_SYNC,
    hasForceFlag: guard.parseForceFlag(process.argv)
  })
} catch (err) {
  console.error(err.message)
  console.error(
    'Refusing DEV-to-PROD user copy. Production copy is default-deny.'
  )
  process.exit(1)
}

const { Sequelize } = require('sequelize')

const devConfig = {
  username: process.env.DB_DEV_USERNAME || 'postgres',
  password: requireEnv('DB_DEV_PASSWORD'),
  database: process.env.DB_DEV_DATABASE || 'cashier_app',
  host: process.env.DB_DEV_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_DEV_PORT) || 5432,
  dialect: 'postgres',
  logging: false
}

const prodConfig = {
  username: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DATABASE,
  host: process.env.POSTGRES_HOST,
  port: 5432,
  dialect: 'postgres',
  dialectModule: require('pg'),
  protocol: 'postgres',
  dialectOptions: {
    ssl: { require: true, rejectUnauthorized: false }
  },
  logging: false
}

const sequelizeDev = new Sequelize(devConfig)
const sequelizeProd = new Sequelize(prodConfig)

async function syncUserTable() {
  console.log('🔄 Syncing table: user (DEV → PROD)\n')

  try {
    console.log('🔌 Connecting to databases...')
    await sequelizeDev.authenticate()
    console.log('✅ DEV database connected')
    await sequelizeProd.authenticate()
    console.log('✅ PROD database connected\n')

    const [prodRoles] = await sequelizeProd.query(
      `SELECT id, "roleType" FROM role`
    )
    const roleMap = Object.fromEntries(prodRoles.map((r) => [r.roleType, r.id]))
    console.log('📋 Role mapping (roleType → PROD id):', roleMap)

    const [prodLocations] = await sequelizeProd.query(`SELECT id FROM location`)
    const prodLocationIds = new Set(prodLocations.map((l) => l.id))

    const [prodPositions] = await sequelizeProd.query(`SELECT id FROM position`)
    const prodPositionIds = new Set(prodPositions.map((l) => l.id))

    const [rows] = await sequelizeDev.query(`SELECT * FROM "user"`)

    if (rows.length === 0) {
      console.log('⏭️  No user data found in DEV, skipping...')
      return
    }

    const mappedRows = rows.map((row) => {
      if (row.roleId && roleMap[row.roleType]) {
        row.roleId = roleMap[row.roleType]
      }
      if (row.store != null && !prodLocationIds.has(row.store)) {
        console.log(
          `   ℹ️  Clearing store=${row.store} for user ${row.userName || row.id} (not in PROD)`
        )
        row.store = null
      }
      if (row.position != null && !prodPositionIds.has(row.position)) {
        console.log(
          `   ℹ️  Clearing position=${row.position} for user ${row.userName || row.id} (not in PROD)`
        )
        row.position = null
      }
      if (row.shift != null) {
        console.log(
          `   ℹ️  Clearing shift=${row.shift} for user ${row.userName || row.id} (not synced)`
        )
        row.shift = null
      }
      return row
    })

    console.log(`\n📋 Found ${rows.length} user records in DEV\n`)

    await sequelizeProd.query(`TRUNCATE TABLE "user" RESTART IDENTITY CASCADE`)

    const batchSize = 100
    for (let i = 0; i < mappedRows.length; i += batchSize) {
      const batch = mappedRows.slice(i, i + batchSize)
      const columns = Object.keys(batch[0])

      const colList = columns.map((c) => `"${c}"`).join(', ')
      const placeholders = batch
        .map(() => `(${columns.map(() => '?').join(', ')})`)
        .join(', ')
      const values = batch.flatMap((row) => columns.map((col) => row[col]))

      try {
        await sequelizeProd.query(
          `INSERT INTO "user" (${colList}) VALUES ${placeholders}`,
          { replacements: values }
        )
      } catch (err) {
        console.log(`   ⚠️  Batch error: ${err.message}`)
        for (let j = 0; j < batch.length; j++) {
          const row = batch[j]
          const rowValues = columns.map((c) => row[c])
          try {
            await sequelizeProd.query(
              `INSERT INTO "user" (${colList}) VALUES (${columns.map(() => '?').join(', ')})`,
              { replacements: rowValues }
            )
          } catch (rowErr) {
            console.log(`   ⚠️  Row ${i + j + 1} error: ${rowErr.message}`)
          }
        }
      }
    }

    console.log(`\n✅ Synced ${rows.length} user records to PROD`)
  } catch (error) {
    console.error('❌ Sync failed:', error.message)
    process.exit(1)
  } finally {
    await sequelizeDev.close()
    await sequelizeProd.close()
  }
}

syncUserTable()
