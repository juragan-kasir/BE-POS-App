// Turns an error message, written in either language in the controllers,
// into the language the client asked for (Accept-Language; Indonesian by
// default, the app's language). A message nobody catalogued is returned as
// written, so an unknown text still says what went wrong.

const fromEnglish = require('./messages.en-source')
const fromIndonesian = require('./messages.id-source')
const { MESSAGE_PATTERNS, REASON_PATTERNS } = require('./patterns')

const SUPPORTED = ['id', 'en']
const DEFAULT_LANGUAGE = 'id'

const CATALOG = new Map()
Object.entries(fromEnglish).forEach(([source, id]) => CATALOG.set(source, { id, en: source }))
Object.entries(fromIndonesian).forEach(([source, en]) => CATALOG.set(source, { id: source, en }))

// The first supported language in an Accept-Language header ("en-US,en;q=0.9").
const languageFrom = (header) => {
  const tags = String(header || '')
    .split(',')
    .map((part) => part.split(';')[0].trim().toLowerCase().slice(0, 2))
  return tags.find((tag) => SUPPORTED.includes(tag)) || DEFAULT_LANGUAGE
}

const matchPatterns = (patterns, text) => {
  for (const [re, render] of patterns) {
    const m = re.exec(text)
    if (m) return render(m)
  }
  return null
}

const translateOne = (text, language) => {
  const known = CATALOG.get(text) || matchPatterns(MESSAGE_PATTERNS, text)
  return known ? known[language] : null
}

// "field: reason; field2: reason2" from the zod validation middleware.
const translateIssues = (text, language) => {
  const parts = text.split('; ').map((part) => {
    const at = part.indexOf(': ')
    if (at < 1) return null
    const field = part.slice(0, at)
    const reason = part.slice(at + 2)
    const known = CATALOG.get(reason) || matchPatterns(REASON_PATTERNS, reason)
    return known ? `${field}: ${known[language]}` : null
  })
  return parts.every(Boolean) ? parts.join('; ') : null
}

const translateMessage = (text, language = DEFAULT_LANGUAGE) => {
  if (typeof text !== 'string' || !text) return text
  return translateOne(text, language) || translateIssues(text, language) || text
}

module.exports = { translateMessage, languageFrom, DEFAULT_LANGUAGE }
