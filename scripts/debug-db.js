require('dotenv').config({ path: __dirname + '/.env' })
const { requireEnv } = require('../utils/seedCredential')
const { Client } = require('pg')

async function debug() {
  const client = new Client({
    user: process.env.DB_DEV_USERNAME || 'postgres',
    host: process.env.DB_DEV_HOST || 'localhost',
    database: process.env.DB_DEV_DATABASE || 'cashier_app',
    password: requireEnv('DB_DEV_PASSWORD'),
    port: process.env.DB_DEV_PORT || 5432
  })

  try {
    await client.connect()
    console.log('Connected!')

    const result = await client.query('SELECT COUNT(*) FROM role')
    console.log('Role count:', result.rows)

    const userResult = await client.query('SELECT COUNT(*) FROM "user"')
    console.log('User count:', userResult.rows)
  } catch (err) {
    console.error('Error:', err)
  } finally {
    await client.end()
  }
}

debug()
