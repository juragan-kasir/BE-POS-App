//!/usr/bin/env node
require('dotenv').config({ path: __dirname + '/.env' })
const { requireSeedPassword, requireEnv } = require('../utils/seedCredential')
const bcrypt = require('bcrypt')

async function main() {
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

    // Start a transaction
    await client.query('BEGIN')

    // Clear existing data
    console.log('🗑️  Clearing existing data...')
    await client.query('DELETE FROM "user"')
    await client.query('DELETE FROM role')

    // Create roles
    console.log('🏷️  Creating default roles...')
    await client.query(`
      INSERT INTO role ("name", "roleType", "store", "accessMenu", "status", "createdAt", "updatedAt")
      VALUES 
        ('Super Admin', 'super_admin', null, '[]', 'active', NOW(), NOW()),
        ('Admin', 'admin', null, '[]', 'active', NOW(), NOW()),
        ('Cashier', 'kasir', null, '[]', 'active', NOW(), NOW()),
        ('Staff', 'user', null, '[]', 'active', NOW(), NOW())
    `)

    // Create super admin user
    console.log('🏷️  Creating Super Admin user...')
    const hashedPassword = await bcrypt.hash(requireSeedPassword('SEED_SUPER_ADMIN_PASSWORD'), 10)

    // Get the roleId for super_admin
    const roleResult = await client.query(
      'SELECT id FROM role WHERE "roleType" = $1',
      ['super_admin']
    )

    if (roleResult.rows.length > 0) {
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
          roleResult.rows[0].id,
          'super_admin',
          'active'
        ]
      )
      console.log('✅ Super Admin user created successfully!')
    }

    await client.query('COMMIT')
    console.log('\n🎉 Database setup completed successfully!')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Setup failed:', error.message)
    process.exit(1)
  } finally {
    await client.end()
  }
}

main()
