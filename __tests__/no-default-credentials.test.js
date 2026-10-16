process.env.NODE_ENV = 'test'

const fs = require('fs')
const path = require('path')
const bcrypt = require('bcrypt')
const {
  seedPassword,
  describeSeedPassword,
  requireSeedPassword,
  MIN_LENGTH
} = require('../utils/seedCredential')

// BA gap 039 (DR-06, BA §35.7): no known or default credential may survive
// in a deployed environment. Seeded accounts never get a password from
// source; developer scripts need one from the environment; and no
// credential literal is committed.

const ROOT = path.join(__dirname, '..')
const KNOWN_DEFAULTS = [
  'admin123',
  'kasir123',
  'staff123',
  'superadmin123',
  'dev123',
  'angga123',
  'febi123',
  'surya123',
  'tegar123',
  'luthfi123',
  'password123',
  'password456',
  'password789'
]
const SEED_ENVS = [
  'SEED_SUPER_ADMIN_PASSWORD',
  'SEED_DEV_PASSWORD',
  'SEED_ADMIN_PASSWORD',
  'SEED_KASIR_PASSWORD',
  'SEED_STAFF_PASSWORD'
]

const withoutSeedEnv = async (fn) => {
  const saved = Object.fromEntries(SEED_ENVS.map((k) => [k, process.env[k]]))
  SEED_ENVS.forEach((k) => delete process.env[k])
  try {
    return await fn()
  } finally {
    SEED_ENVS.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    })
  }
}

// Minimal queryInterface double: the role lookup finds a role, no user
// exists yet, and every inserted row is captured.
const fakeQueryInterface = () => {
  const inserted = []
  return {
    inserted,
    sequelize: {
      query: async (sql) => {
        if (/FROM role/i.test(sql)) {
          return [
            { id: 1, roleType: 'super_admin' },
            { id: 2, roleType: 'admin' },
            { id: 3, roleType: 'user' }
          ]
        }
        if (/FROM "user"/i.test(sql)) return /roleType/.test(sql) ? [[]] : []
        return [[]]
      }
    },
    bulkInsert: async (_table, rows) => {
      inserted.push(...rows)
    }
  }
}

const matchesAnyDefault = async (hash) => {
  for (const known of KNOWN_DEFAULTS) {
    if (await bcrypt.compare(known, hash)) return known
  }
  return null
}

describe('seedCredential helper', () => {
  test('without the env variable a random, unpredictable password is used', async () => {
    await withoutSeedEnv(async () => {
      const a = seedPassword('SEED_SUPER_ADMIN_PASSWORD')
      const b = seedPassword('SEED_SUPER_ADMIN_PASSWORD')
      expect(a.source).toBe('random')
      expect(a.password).not.toBe(b.password)
      expect(a.password.length).toBeGreaterThanOrEqual(MIN_LENGTH)
      expect(describeSeedPassword(a)).not.toContain(a.password)
    })
  })

  test('the env variable is used when set; a short one is refused', async () => {
    await withoutSeedEnv(async () => {
      process.env.SEED_ADMIN_PASSWORD = 'a-long-enough-secret'
      expect(seedPassword('SEED_ADMIN_PASSWORD')).toEqual({
        password: 'a-long-enough-secret',
        source: 'SEED_ADMIN_PASSWORD'
      })
      process.env.SEED_ADMIN_PASSWORD = 'short'
      expect(() => seedPassword('SEED_ADMIN_PASSWORD')).toThrow(/at least/)
    })
  })

  test('developer scripts refuse to run without a password', async () => {
    await withoutSeedEnv(async () => {
      expect(() => requireSeedPassword('SEED_SUPER_ADMIN_PASSWORD')).toThrow(/Set SEED_SUPER_ADMIN_PASSWORD/)
    })
  })
})

describe('seeded accounts never get a known password', () => {
  test.each([
    ['db/migrations/20260618000004-create-super-admin-users.js'],
    ['db/migrations/20260620000005-create-dev-user.js'],
    ['db/seeders/20240515000001-super-admin-user.js'],
    ['db/seeders/20260601122557-create-admin-and-user-accounts.js']
  ])('%s', async (file) => {
    await withoutSeedEnv(async () => {
      const qi = fakeQueryInterface()
      const logs = []
      const spy = jest.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')))
      try {
        await require(path.join(ROOT, file)).up(qi, { QueryTypes: { SELECT: 'SELECT' } })
      } finally {
        spy.mockRestore()
      }
      expect(qi.inserted.length).toBeGreaterThan(0)
      for (const row of qi.inserted) {
        expect(await matchesAnyDefault(row.password)).toBeNull()
      }
      const output = logs.join('\n')
      for (const known of KNOWN_DEFAULTS) expect(output).not.toContain(known)
    })
  })
})

describe('no credential literal is committed', () => {
  const SCANNED_DIRS = ['db', 'scripts', 'api', 'utils', 'config']
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(js|sh|json)$/.test(entry.name)) files.push(full)
    }
  }
  SCANNED_DIRS.forEach((d) => walk(path.join(ROOT, d)))

  test('no known default password appears in source', () => {
    const hits = []
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8')
      for (const known of KNOWN_DEFAULTS) {
        if (new RegExp(`['"\`]${known}['"\`]`).test(text)) hits.push(`${path.relative(ROOT, file)}: ${known}`)
      }
    }
    expect(hits).toEqual([])
  })

  test('no password is hashed from a literal and no env password has a literal fallback', () => {
    const hits = []
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8')
      if (/bcrypt\.hash(Sync)?\(\s*['"`]/.test(text)) hits.push(`${path.relative(ROOT, file)}: bcrypt literal`)
      if (/(PASSWORD|PASS|SECRET)[A-Z_]*\s*\|\|\s*['"][^'"]+['"]/.test(text)) {
        hits.push(`${path.relative(ROOT, file)}: credential fallback`)
      }
    }
    expect(hits).toEqual([])
  })
})
