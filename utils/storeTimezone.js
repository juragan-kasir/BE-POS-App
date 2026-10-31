const db = require('../db/models')
const { DEFAULT_TIMEZONE, isValidTimezone } = require('./businessDate')

// The IANA timezone a store keeps its business day in (location.timezone),
// falling back to DEFAULT_TIMEZONE for no store, an unknown store or an
// invalid value.
const resolveStoreTimezone = async (store) => {
  if (!store) return DEFAULT_TIMEZONE
  const location = await db.location.findByPk(store, { attributes: ['timezone'] })
  return isValidTimezone(location?.timezone) ? location.timezone : DEFAULT_TIMEZONE
}

module.exports = { resolveStoreTimezone }
