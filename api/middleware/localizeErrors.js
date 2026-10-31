const { translateMessage, languageFrom } = require('../i18n/translate')

const isErrorBody = (res, body) =>
  body !== null &&
  typeof body === 'object' &&
  !Array.isArray(body) &&
  (res.statusCode >= 400 || body.success === false)

const localizeIssues = (errors, language) =>
  errors.map((issue) =>
    issue && typeof issue.message === 'string'
      ? { ...issue, message: translateMessage(`${issue.field || 'field'}: ${issue.message}`, language).replace(/^[^:]*: /, '') }
      : issue
  )

// Error responses are written in either language across the controllers.
// When the client says which language it shows (Accept-Language, sent by
// the admin app with its UI language), `message`, `error` and the zod
// `errors[].message` are rewritten into that language and the response is
// marked with Content-Language. Requests without the header (scripts,
// tests, older clients) get the message as written.
const localizeErrors = (req, res, next) => {
  if (!req.headers['accept-language']) return next()
  const language = languageFrom(req.headers['accept-language'])
  const json = res.json.bind(res)
  res.json = (body) => {
    if (!isErrorBody(res, body)) return json(body)
    const localized = { ...body }
    if (typeof body.message === 'string') localized.message = translateMessage(body.message, language)
    if (typeof body.error === 'string') localized.error = translateMessage(body.error, language)
    if (Array.isArray(body.errors)) localized.errors = localizeIssues(body.errors, language)
    res.set('Content-Language', language)
    return json(localized)
  }
  return next()
}

module.exports = { localizeErrors }
