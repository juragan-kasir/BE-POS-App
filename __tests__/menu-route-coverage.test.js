process.env.NODE_ENV = 'test'

const fs = require('fs')

// DR-24 C-02: the central menu-route registry is the single classification
// point for every API route file. A new route file that is neither
// menu-enforced nor explicitly allowlisted nor listed as legacy-gated fails
// this contract until it is deliberately classified.

const {
  MENU_ENFORCED_ROUTES,
  ALLOWLISTED_ROUTE_FILES,
  GATED_LEGACY_ROUTE_FILES
} = require('../api/menuRouteMap')

test('every api/routes file is classified in the central menuRouteMap', () => {
  // Repo-relative literal: jest always runs from the repository root.
  const files = fs
    .readdirSync('api/routes')
    .filter((f) => f.endsWith('.js'))
    .sort()
  const classified = [
    ...Object.keys(MENU_ENFORCED_ROUTES),
    ...Object.keys(ALLOWLISTED_ROUTE_FILES),
    ...GATED_LEGACY_ROUTE_FILES
  ].sort()
  expect(classified).toEqual(files)
})

test('table.js is the reference menu-enforced module', () => {
  expect(MENU_ENFORCED_ROUTES['table.js']).toBeTruthy()
  expect(MENU_ENFORCED_ROUTES['table.js'].menus).toContain('/table')
})

test('the cron surface stays allowlisted with its fail-closed gate', () => {
  expect(ALLOWLISTED_ROUTE_FILES['internal.js']).toMatch(/CRON_SECRET/)
})
