'use strict'

// The W3 backfill tests (B21–B23) insert outlet rows with tenantId NULL by
// raw SQL to recreate the state those batches ran against. Batch B27 (Z3)
// came later and makes that state impossible, so those tests lift the CHECK
// for their own run and put it back (backfill + validate) in afterAll.
// Shards run --runInBand, so no other suite runs while it is lifted.
const check = require('../db/migrations/20261124000001-store-tenant-check')

const liftStoreTenantCheck = (db) => check.down(db.sequelize.getQueryInterface())
const restoreStoreTenantCheck = (db) => check.up(db.sequelize.getQueryInterface())

module.exports = { liftStoreTenantCheck, restoreStoreTenantCheck }
