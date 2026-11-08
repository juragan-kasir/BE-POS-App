'use strict'

// Dedicated E2E configuration. Kept out of the default `npm test` run: these
// specs model whole business segments (owner + many employees) and are
// intentionally slower/heavier than the unit/integration suite.
module.exports = {
  testEnvironment: 'node',
  globalSetup: '<rootDir>/scripts/setup-test-db.js',
  testTimeout: 120000,
  roots: ['<rootDir>/__tests__/e2e'],
  testMatch: ['**/*.e2e.js'],
  testPathIgnorePatterns: ['/node_modules/'],
  maxWorkers: 1
}
