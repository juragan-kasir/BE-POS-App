require('dotenv').config({ path: __dirname + '/.env' })
const { requireSeedPassword, requireEnv } = require('../utils/seedCredential')
const bcrypt = require('bcrypt')

async function setupDatabase() {
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

    // Check if roles exist
    console.log('🏷️  Checking roles...')
    const roleResult = await client.query('SELECT COUNT(*) FROM role')
    if (parseInt(roleResult.rows[0].count) === 0) {
      console.log('   No roles found, creating default roles...')
      await client.query(`
        INSERT INTO role ("name", "roleType", "store", "accessMenu", "createdAt", "updatedAt")
        VALUES 
          ('Super Admin', 'super_admin', null, '[]', NOW(), NOW()),
          ('Admin', 'admin', null, '[]', NOW(), NOW()),
          ('Cashier', 'kasir', null, '[]', NOW(), NOW()),
          ('Staff', 'user', null, '[]', NOW(), NOW())
      `)
      console.log('   ✅ Roles created successfully!')
    } else {
      console.log('   ✅ Roles already exist!')
    }

    // Check if super admin user exists
    console.log('Checking for existing super admin user...')
    const userResult = await client.query(
      'SELECT id FROM "user" WHERE "roleType" = $1 LIMIT 1',
      ['super_admin']
    )

    if (userResult.rows.length === 0) {
      console.log('🏷️  Creating Super Admin user...')
      const hashedPassword = await bcrypt.hash(requireSeedPassword('SEED_SUPER_ADMIN_PASSWORD'), 10)

      // Get the roleId for super_admin
      const roleIdResult = await client.query(
        'SELECT id FROM role WHERE "roleType" = $1',
        ['super_admin']
      )

      if (roleIdResult.rows.length > 0) {
        await client.query(
          `INSERT INTO "user" (
            "userName", "fullName", "password", "email", "employeeID", 
            "roleType", "roleId", "userType", "status",
            "createdAt", "updatedAt"
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())`,
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
        console.log('   Username: super_admin')
      }
    } else {
      console.log('   ✅ Super Admin user already exists!')
    }

    // IMPORTANT: Don't close the connection yet, keep it open
    console.log('\n🎉 Setup completed successfully!')
    console.log('   Connection remains open. You can now run seed-test-data.js')
  } catch (error) {
    console.error('❌ Setup failed:', error.message)
    process.exit(1)
  }
}

setupDatabase()
