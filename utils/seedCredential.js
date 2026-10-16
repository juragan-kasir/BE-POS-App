'use strict'
const crypto = require('crypto')

// BA gap 039 (DR-06, BA §35.7): no known or default credential is ever
// seeded or committed. Seeded accounts get their password only from an
// environment variable; developer scripts refuse to run without one.
const MIN_LENGTH = 12

// Migrations and seeders: the password comes from `envName` when set; when
// it is unset, a random password nobody knows is used and the account
// stays unusable until someone sets a real one through a password reset.
// It is never logged.
const seedPassword = (envName) => {
  const value = process.env[envName]
  if (value === undefined || value === '') {
    return { password: crypto.randomBytes(24).toString('base64url'), source: 'random' }
  }
  if (value.length < MIN_LENGTH) {
    throw new Error(`${envName} must be at least ${MIN_LENGTH} characters`)
  }
  return { password: value, source: envName }
}

// Human-readable note for seed logs — never the password itself.
const describeSeedPassword = ({ source }) =>
  source === 'random'
    ? 'random password (set one with a password reset)'
    : `password from ${source}`

// Developer scripts: refuse to run without an explicit password.
const requireSeedPassword = (envName) => {
  const value = process.env[envName]
  if (!value || value.length < MIN_LENGTH) {
    throw new Error(`Set ${envName} (at least ${MIN_LENGTH} characters) before running this script`)
  }
  return value
}

const requireEnv = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`Set ${name} before running this script`)
  return value
}

module.exports = {
  MIN_LENGTH,
  seedPassword,
  describeSeedPassword,
  requireSeedPassword,
  requireEnv
}
