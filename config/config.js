const pg = require('pg')
const envPath =
  process.env.NODE_ENV === 'production'
    ? `${process.cwd()}/.env.production`
    : `${process.cwd()}/.env`
require('dotenv').config({ path: envPath })

module.exports = {
  development: {
    username: process.env.DB_DEV_USERNAME || 'postgres',
    password: process.env.DB_DEV_PASSWORD,
    database: process.env.DB_DEV_DATABASE || 'cashier_app',
    host: process.env.DB_DEV_HOST || '127.0.0.1', // ✅ gunakan 127.0.0.1
    port: process.env.DB_DEV_PORT || 5432, // ✅ jangan pakai string
    dialect: 'postgres',
    // Without this, Sequelize defaults to pool.max: 5 — fine for one
    // developer clicking around, but genuinely concurrent local load
    // (or a concurrency test) starves that pool almost immediately and
    // manifests as requests hanging, not a clean error. Match production's
    // shape so local behavior isn't misleadingly different under load.
    pool: {
      max: 20,
      min: 0,
      acquire: 30000,
      idle: 10000
    },
    timezone: '+07:00'
  },
  test: {
    username: process.env.DB_DEV_USERNAME,
    password: process.env.DB_DEV_PASSWORD,
    database: process.env.DB_TEST_DATABASE || 'cashier_app_test',
    host: process.env.DB_DEV_HOST,
    port: process.env.DB_DEV_PORT,
    dialect: 'postgres',
    // Sequelize defaults to console.log-ing every query. Across 149 DB-heavy
    // integration test files that's tens of thousands of multi-line log
    // entries retained in memory by Jest's per-file console buffering,
    // which was the actual cause of "JavaScript heap out of memory" crashes
    // during `npm test` — not an application-level leak.
    logging: false,
    pool: {
      max: 20,
      min: 0,
      acquire: 30000,
      idle: 10000
    },
    timezone: '+07:00'
  },
  production: {
    username: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DATABASE,
    host: process.env.POSTGRES_HOST,
    port: process.env.POSTGRES_PORT || 5432,
    dialect: 'postgres',
    dialectModule: pg,
    protocol: 'postgres',
    pool: {
      max: 20,
      min: 5,
      acquire: 30000,
      idle: 10000
    },
    dialectOptions: {
      ssl: {
        require: true,
        rejectUnauthorized: false
      }
    },
    timezone: '+07:00'
  },
  // W-02R.4 staging rehearsal target. Disjoint variable namespace from
  // production on purpose: staging can never read POSTGRES_* and production
  // can never read STAGING_DB_*. No secrets live here — values come from
  // the operator's environment only. The ephemeral rehearsal harness sets
  // STAGING_DB_DATABASE to the created rehearsal database name.
  staging: {
    username: process.env.STAGING_DB_USER || 'postgres',
    password: process.env.STAGING_DB_PASSWORD,
    database: process.env.STAGING_DB_DATABASE,
    host: process.env.STAGING_DB_HOST || '127.0.0.1',
    port: process.env.STAGING_DB_PORT || 5432,
    dialect: 'postgres',
    logging: false,
    pool: {
      max: 5,
      min: 0,
      acquire: 30000,
      idle: 10000
    },
    timezone: '+07:00'
  }
}
