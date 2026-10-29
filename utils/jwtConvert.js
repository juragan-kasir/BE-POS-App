const jwt = require('jsonwebtoken')
// The exact parser jsonwebtoken applies to `expiresIn`, reused so the JWT and
// its authorization session derive from one configured lifetime with
// identical semantics (e.g. '1d', '12h', numeric-string milliseconds).
const timespan = require('jsonwebtoken/lib/timespan')

const DEFAULT_LIFETIME = '1d'
const DEFAULT_REMEMBER_ME_LIFETIME = '30d'

const lifetimeFor = (rememberMe) =>
  rememberMe
    ? process.env.JWT_REMEMBER_ME_EXPIRED_IN || DEFAULT_REMEMBER_ME_LIFETIME
    : process.env.JWT_EXPIRED_IN || DEFAULT_LIFETIME

// AUTH-1 P1: the authentication lifetime. Returns the `iat`/`exp` (seconds) of
// a credential issued at `nowMs`; the authorization session expires at
// `exp * 1000`, so JWT lifetime == session lifetime.
const credentialWindow = (
  nowMs = Date.now(),
  lifetime = lifetimeFor(false)
) => {
  const iat = Math.floor(nowMs / 1000)
  const exp = timespan(lifetime, iat)
  if (!Number.isFinite(exp) || exp <= iat) {
    throw new Error('Invalid authentication lifetime')
  }
  return { iat, exp }
}

// With a `window`, the token carries exactly that iat/exp (login binds it to
// the session row); without one, the lifetime is applied as `expiresIn`.
const generateToken = (payload, window) => {
  const secretKey = process.env.JWT_SECRET_KEY

  if (window) {
    return jwt.sign({ ...payload, iat: window.iat, exp: window.exp }, secretKey)
  }

  return jwt.sign(payload, secretKey, {
    expiresIn: process.env.JWT_EXPIRED_IN || DEFAULT_LIFETIME
  })
}

module.exports = generateToken
module.exports.credentialWindow = credentialWindow
module.exports.lifetimeFor = lifetimeFor
