process.env.NODE_ENV = 'test'

// Local database bootstrap (scripts/bootstrap-db.js). Pure: only the state
// decision and argument parsing are exercised, no database is touched.
const { classifyTables, parseEnv, CORE_TABLES } = require('../scripts/bootstrap-db')

describe('db:bootstrap target classification', () => {
  test('no public tables → empty (load snapshot + stamp baseline)', () => {
    expect(classifyTables([])).toBe('empty')
  })

  test('all core tables present → baseline (migrate only)', () => {
    expect(classifyTables([...CORE_TABLES, 'tenant'])).toBe('baseline')
  })

  test('tables present but core tables missing → unknown (refused)', () => {
    expect(classifyTables(['foo'])).toBe('unknown')
    expect(classifyTables(CORE_TABLES.slice(1))).toBe('unknown')
  })
})

describe('db:bootstrap --env parsing', () => {
  test('--env value and --env=value', () => {
    expect(parseEnv(['--env', 'development'])).toBe('development')
    expect(parseEnv(['--env=production'])).toBe('production')
  })

  test('falls back to NODE_ENV', () => {
    expect(parseEnv([])).toBe('test')
  })
})
