require('dotenv').config({ path: __dirname + '/.env' })
const { requireSeedPassword, requireEnv } = require('../utils/seedCredential')
const bcrypt = require('bcrypt')

async function simpleSetup() {
  const { Client } = require('pg')
  const client = new Client({
    user: process.env.DB_DEV_USERNAME || 'postgres',
    host: process.env.DB_DEV_HOST || 'localhost',
    database: process.env.DB_DEV_DATABASE || 'cashier_app',
    password: requireEnv('DB_DEV_PASSWORD'),
    port: process.env.DB_DEV_PORT || 5432
  })

  try {
    console.log('🔌 Connecting to database...')
    await client.connect()
    console.log('✅ Connected!\n')

    // Clear existing data
    await client.query('BEGIN')
    await client.query('DELETE FROM "user"')
    await client.query('DELETE FROM role')
    await client.query('COMMIT')

    // Create roles
    console.log('🏷️  Creating default roles...')
    const roles = [
      {
        name: 'Super Admin',
        roleType: 'super_admin',
        store: null,
        accessMenu: [],
        status: 'active'
      },
      {
        name: 'Admin',
        roleType: 'admin',
        store: null,
        accessMenu: [],
        status: 'active'
      },
      {
        name: 'Cashier',
        roleType: 'kasir',
        store: null,
        accessMenu: [],
        status: 'active'
      },
      {
        name: 'Staff',
        roleType: 'user',
        store: null,
        accessMenu: [],
        status: 'active'
      }
    ]

    for (const role of roles) {
      try {
        await client.query(
          `INSERT INTO role ("name", "roleType", "store", "accessMenu", "status", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
          [
            role.name,
            role.roleType,
            role.store,
            JSON.stringify(role.accessMenu),
            role.status
          ]
        )
      } catch {
        console.log(`Role ${role.roleType} already exists`)
      }
    }

    // Create super admin user
    console.log('🏷️  Creating Super Admin user...')
    const hashedPassword = await bcrypt.hash(requireSeedPassword('SEED_SUPER_ADMIN_PASSWORD'), 10)

    const roleIdResult = await client.query(
      'SELECT id FROM role WHERE "roleType" = $1',
      ['super_admin']
    )

    if (roleIdResult.rows.length > 0) {
      await client.query(
        `INSERT INTO "user" (
          "userName", "fullName", "password", "email", "employeeID", 
          "roleType", "roleId", "userType", "status",
          "createdAt", "updatedAt", "deletedAt"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW(), null)`,
        [
          'super_admin',
          'Super Admin',
          hashedPassword,
          'superadmin@posapp.com',
          'EMP-0001',
          'super_admin',
          roleIdResult.rows[0].id,
          'super_admin',
          'active'
        ]
      )
      console.log('✅ Super Admin user created successfully!')
    }

    await client.query('COMMIT')
    console.log('\n🎉 Setup completed successfully!')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Setup failed:', error.message)
    process.exit(1)
  } finally {
    await client.end()
  }
}

simpleSetup()
