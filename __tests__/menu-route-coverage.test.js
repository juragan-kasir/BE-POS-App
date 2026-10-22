process.env.NODE_ENV = 'test'

const fs = require('fs')

// DR-24 C-02: the central menu-route registry is the single classification
// point for every API route file. A new route file that is neither
// menu-enforced nor explicitly allowlisted nor listed as legacy-gated fails
// this contract until it is deliberately classified.

const {
  MENU_ENFORCED_ROUTES,
  MENU_WRITE_GATED_ROUTES,
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
    ...Object.keys(MENU_WRITE_GATED_ROUTES),
    ...Object.keys(ALLOWLISTED_ROUTE_FILES),
    ...GATED_LEGACY_ROUTE_FILES
  ].sort()
  expect(classified).toEqual(files)
})

test('every write-gated route file mounts its menuWriteGate', () => {
  for (const [file, config] of Object.entries(MENU_WRITE_GATED_ROUTES)) {
    const source = fs.readFileSync(`api/routes/${file}`, 'utf8')
    expect([file, source.includes(`router.use(menuWriteGate('${file}'))`)]).toEqual([file, true])
    expect(config.offered.length).toBeGreaterThan(0)
  }
  expect(MENU_WRITE_GATED_ROUTES['table.js'].menu).toBe('/table-list')
  expect(MENU_WRITE_GATED_ROUTES['table.js'].aliases).toContain('/table')
})

test('the cron surface stays allowlisted with its fail-closed gate', () => {
  expect(ALLOWLISTED_ROUTE_FILES['internal.js']).toMatch(/CRON_SECRET/)
})
