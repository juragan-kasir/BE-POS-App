const db = require('../db/models')
const { DEFAULT_TIMEZONE, isValidTimezone } = require('./businessDate')

// The IANA timezone a store keeps its business day in (location.timezone),
// falling back to DEFAULT_TIMEZONE for no store, an unknown store or an
// invalid value. Pass the caller's transaction when it holds one: a lookup
// outside it takes a second pool connection, and N concurrent transactions
// each waiting for that second connection starve a pool of N.
const resolveStoreTimezone = async (store, { transaction } = {}) => {
  if (!store) return DEFAULT_TIMEZONE
  const location = await db.location.findByPk(store, { attributes: ['timezone'], transaction })
  return isValidTimezone(location?.timezone) ? location.timezone : DEFAULT_TIMEZONE
}

module.exports = { resolveStoreTimezone }
