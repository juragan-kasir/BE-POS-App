'use strict'

const fs = require('fs')
const path = require('path')
const Sequelize = require('sequelize')
const process = require('process')
const pg = require('pg')
// BIGINT (int8) is returned as string by pg by default to avoid precision loss beyond 2^53.
// Our monetary values are far below 9e15 (safe integer), so return as Number for API compatibility.
try { pg.types.setTypeParser(20, (val) => (val === null ? null : Number(val))) } catch {}

const basename = path.basename(__filename)
const env = process.env.NODE_ENV || 'development'
const config = require(__dirname + '/../../config/config.js')[env]
const db = {}

let sequelize
if (config.use_env_variable) {
  sequelize = new Sequelize(process.env[config.use_env_variable], config)
} else {
  sequelize = new Sequelize(
    config.database,
    config.username,
    config.password,
    config
  )
}

const userContext = require('../../utils/userContext')

sequelize.addHook('beforeCreate', (instance) => {
  const rawAttrs = instance.constructor?.rawAttributes || {}
  const store = userContext.getStore()
  if (!store?.userId) return

  if (rawAttrs.createdBy && !instance.getDataValue('createdBy')) {
    const type = rawAttrs.createdBy.type?.key || ''
    const value =
      type === 'STRING' ? store.userName || store.userId : store.userId
    instance.setDataValue('createdBy', value)
  }
})

sequelize.addHook('beforeSave', (instance) => {
  if (instance.isNewRecord) return
  const rawAttrs = instance.constructor?.rawAttributes || {}
  const store = userContext.getStore()
  if (!store?.userId) return

  if (rawAttrs.modifiedBy && !instance.getDataValue('modifiedBy')) {
    const type = rawAttrs.modifiedBy.type?.key || ''
    const value =
      type === 'STRING' ? store.userName || store.userId : store.userId
    instance.setDataValue('modifiedBy', value)
  }
})

sequelize.addHook('beforeBulkUpdate', (options) => {
  const store = userContext.getStore()
  if (!store?.userId) return
  if (options.attributes && options.attributes.modifiedBy !== undefined) return
  const rawAttrs = options.model?.rawAttributes || {}
  if (rawAttrs.modifiedBy) {
    const type = rawAttrs.modifiedBy.type?.key || ''
    const value =
      type === 'STRING' ? store.userName || store.userId : store.userId
    options.attributes = options.attributes || {}
    options.attributes.modifiedBy = value
  }
})

// A string longer than its VARCHAR column is refused before the write
// (400 VALUE_TOO_LONG instead of a database error → 500).
require('../../utils/valueTooLong').installValueTooLongHooks(sequelize)

fs.readdirSync(__dirname)
  .filter((file) => {
    return (
      file.indexOf('.') !== 0 &&
      file !== basename &&
      file.slice(-3) === '.js' &&
      file.indexOf('.test.js') === -1
    )
  })
  .forEach((file) => {
    const modelDef = require(path.join(__dirname, file))

    let model
    if (typeof modelDef === 'function') {
      model = modelDef(sequelize, Sequelize.DataTypes)
    } else if (modelDef && typeof modelDef === 'object') {
      model = modelDef
    }

    if (model && model.name) {
      db[model.name] = model
    }
  })

Object.keys(db).forEach((modelName) => {
  if (db[modelName].associate) {
    db[modelName].associate(db)
  }
})

const { enrichAuditFields } = require('../../utils/auditFields')

Object.keys(db).forEach((modelName) => {
  const model = db[modelName]
  if (typeof model !== 'function' || !model.rawAttributes) return
  const rawAttrs = model.rawAttributes
  if (!rawAttrs.createdBy && !rawAttrs.modifiedBy) return
  model.addHook('afterFind', async (result) => {
    try {
      if (!result) return
      const records = Array.isArray(result) ? result : [result]
      await enrichAuditFields(db, records)
    } catch (e) {
      console.error(`afterFind hook error for ${model.name}:`, e.message)
    }
  })
})

// ponytail: removed broken beforeSave hook that set updatedAt=null on create

db.sequelize = sequelize
db.Sequelize = Sequelize

// Phase 33 R-5: the legacy runtime schema auto-patch (afterConnect +
// ensureColumns + pendingMigrations + Model.sync repair + role backfill) was
// retired here. Application startup MUST NOT perform schema DDL or backfills;
// schema ownership resides in db/migrations (R-1/R-2 + historical chain),
// scripts/dev-schema.sql (incl. R-3 deviceId reconciliation), and the R-4
// test provisioning in scripts/setup-test-db.js. This module only defines
// models and associations against the already-provisioned schema.

module.exports = db
