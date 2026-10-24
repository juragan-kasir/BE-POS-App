const userContext = require('./userContext')

// Field length audit 2026-10-24: a string longer than its VARCHAR column made
// Postgres fail the write (22001 "value too long"), and every controller
// turned that into a 500. The model hooks below refuse such a write before
// it reaches the database, naming the field; the responder turns the
// controller's 500 for that request into a 400 VALUE_TOO_LONG. Per-field
// limits in the zod schemas stay the primary check — this is the net under
// every column at once.

const CODE = 'VALUE_TOO_LONG'

class ValueTooLongError extends Error {
  constructor({ model, field, max }) {
    super(`${field} maksimal ${max} karakter`)
    this.name = 'ValueTooLongError'
    this.code = CODE
    this.statusCode = 400
    this.model = model
    this.field = field
    this.max = max
  }
}

// VARCHAR(n) length of an attribute, or null when it has none (TEXT, ENUM,
// numbers, JSON …). A bare STRING is VARCHAR(255).
const columnLength = (attribute) => {
  if (attribute?.type?.key !== 'STRING') return null
  const length = attribute.type._length ?? attribute.type.options?.length
  return Number.isInteger(length) ? length : 255
}

// Postgres counts characters (code points), not UTF-16 units, and accepts a
// longer value when everything past the limit is spaces (it trims them).
const exceeds = (value, max) => {
  const chars = [...value]
  return chars.length > max && chars.slice(max).join('').trim() !== ''
}

const findTooLong = (model, values, fields) => {
  const attributes = model?.rawAttributes || {}
  for (const field of fields || Object.keys(values || {})) {
    const value = values?.[field]
    if (typeof value !== 'string') continue
    const max = columnLength(attributes[field])
    if (max !== null && exceeds(value, max)) return { model: model.name, field, max }
  }
  return null
}

const refuse = (found) => {
  const store = userContext.getStore()
  if (store) store.valueTooLong = found
  throw new ValueTooLongError(found)
}

const checkInstance = (instance) => {
  const changed = instance.changed()
  const fields = Array.isArray(changed) ? changed : Object.keys(instance.dataValues || {})
  const found = findTooLong(instance.constructor, instance.dataValues, fields)
  if (found) refuse(found)
}

const installValueTooLongHooks = (sequelize) => {
  sequelize.addHook('beforeSave', checkInstance)
  sequelize.addHook('beforeBulkCreate', (instances) => instances.forEach(checkInstance))
  sequelize.addHook('beforeBulkUpdate', (options) => {
    const found = findTooLong(options.model, options.attributes)
    if (found) refuse(found)
  })
  sequelize.addHook('beforeUpsert', (values, options) => {
    const found = findTooLong(options.model, values)
    if (found) refuse(found)
  })
}

const bodyFor = ({ field, max }) => {
  const message = field ? `${field} maksimal ${max} karakter` : `Teks maksimal ${max} karakter`
  return {
    success: false,
    code: CODE,
    message,
    field: field || null,
    max: max ?? null,
    errors: [{ field: field || null, message }]
  }
}

// A Postgres 22001 that did not come through a model write (raw SQL).
// "value too long for type character varying(20)" → { field: null, max: 20 }.
const fromDatabaseError = (error) => {
  const pg = error?.parent || error?.original || error
  if (pg?.code !== '22001') return null
  const max = Number((String(pg.message).match(/varying\((\d+)\)/) || [])[1])
  return { field: null, max: Number.isFinite(max) ? max : null }
}

// Express middleware: when this request hit a too-long value and the
// handler answered 5xx, answer 400 VALUE_TOO_LONG instead.
const valueTooLongResponder = (req, res, next) => {
  const store = userContext.getStore()
  const json = res.json.bind(res)
  res.json = (body) => {
    if (res.statusCode >= 500 && store?.valueTooLong) {
      res.status(400)
      return json(bodyFor(store.valueTooLong))
    }
    return json(body)
  }
  next()
}

// For the app's error handler: the 400 for an error that reached it.
const valueTooLongFromError = (error) => {
  if (error instanceof ValueTooLongError) return { field: error.field, max: error.max }
  return fromDatabaseError(error)
}

module.exports = {
  CODE,
  ValueTooLongError,
  installValueTooLongHooks,
  valueTooLongResponder,
  valueTooLongFromError,
  bodyFor,
  findTooLong
}
