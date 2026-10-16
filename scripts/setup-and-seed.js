//!/usr/bin/env node
require('dotenv').config({ path: __dirname + '/.env' })
const { requireSeedPassword, requireEnv } = require('../utils/seedCredential')
const bcrypt = require('bcrypt')

async function seedTestData() {
  const { Client } = require('pg')
  const client = new Client({
    user: process.env.DB_DEV_USERNAME || 'postgres',
    host: process.env.DB_DEV_HOST || 'localhost',
    database: process.env.DB_DEV_DATABASE || 'cashier_app',
    password: requireEnv('DB_DEV_PASSWORD'),
    port: process.env.DB_DEV_PORT || 5432
  })

  try {
    console.log('🌱 Seeding test data for all 9 entities...\n')
    console.log('🔌 Connecting to database...')
    await client.connect()
    console.log('✅ Connected!\n')

    // Start a transaction
    await client.query('BEGIN')

    // Clear all test data
    console.log('🗑️  Clearing existing test data...')

    // Get all table names
    const tableResult = await client.query(
      `SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename`
    )
    const allTables = tableResult.rows.map((r) => r.tablename)

    // Truncate all tables except reference data
    const TABLES_TO_KEEP = [
      'role',
      'type_payment',
      'tax_config',
      'member_tier',
      'category',
      'supplier',
      'department',
      'position',
      'shift',
      'member',
      'product'
    ]
    const tablesToTruncate = allTables.filter(
      (t) =>
        !TABLES_TO_KEEP.includes(t) &&
        t !== 'SequelizeMeta' &&
        t !== 'user' &&
        t !== 'employee'
    )

    for (const table of tablesToTruncate) {
      await client.query(`TRUNCATE TABLE "${table}" CASCADE`)
    }

    // Clear specific tables we want to seed
    for (const table of [
      'department',
      'position',
      'shift',
      'member_tier',
      'member',
      'category',
      'product',
      'supplier',
      'user'
    ]) {
      if (table === 'user') {
        await client.query(
          `DELETE FROM "user" WHERE "roleType" != 'super_admin'`
        ) // Keep super_admin
      } else {
        await client.query(`DELETE FROM "${table}"`) // Tables use snake_case in DB
      }
    }

    console.log('   ✅ Test data cleared!')

    // Setup reference data
    console.log('🏷️  Setting up reference data...')

    // Create roles
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
        // Ignore duplicate errors
      }
    }

    // Create super admin user
    console.log('🏷️  Creating Super Admin user...')
    const hashedPassword = await bcrypt.hash(requireSeedPassword('SEED_SUPER_ADMIN_PASSWORD'), 10)
    // DR-06: test users get a hashed password from SEED_TEST_USER_PASSWORD
    // (they were stored as plaintext before).
    const testUserPasswordHash = await bcrypt.hash(requireSeedPassword('SEED_TEST_USER_PASSWORD'), 10)

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
      console.log('   Username: super_admin')
    }

    // Create the rest of the test data...
    console.log('\n🏷️  Creating Category test data (6 records)...')

    const categories = []
    for (let i = 1; i <= 2; i++) {
      const categoryResult = await client.query(
        `INSERT INTO category ("name", "description", "value", "status", "createdBy", "createdAt")
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING id`,
        [
          `Test Category ${i}`,
          `Test category description ${i}`,
          `test-category-${i}`,
          'active',
          'system'
        ]
      )
      const catId = categoryResult.rows[0].id
      await client.query(
        `INSERT INTO category_store ("category", "store", "createdAt", "updatedAt")
         VALUES ($1, 1, NOW(), NOW())`,
        [catId]
      )
      categories.push(categoryResult.rows[0])
    }
    for (let i = 1; i <= 2; i++) {
      const categoryResult = await client.query(
        `INSERT INTO category ("name", "description", "value", "status", "createdBy", "createdAt")
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING id`,
        [
          `Test Category Inactive ${i}`,
          `Inactive test category ${i}`,
          `test-category-inactive-${i}`,
          'inactive',
          'system'
        ]
      )
      const catId = categoryResult.rows[0].id
      await client.query(
        `INSERT INTO category_store ("category", "store", "createdAt", "updatedAt")
         VALUES ($1, 1, NOW(), NOW())`,
        [catId]
      )
      categories.push(categoryResult.rows[0])
    }
    for (let i = 1; i <= 2; i++) {
      const categoryResult = await client.query(
        `INSERT INTO category ("name", "description", "value", "status", "createdBy", "createdAt")
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING id`,
        [
          `Test Category Draft ${i}`,
          `Draft test category ${i} (can be completed later)`,
          `test-category-draft-${i}`,
          'draft',
          'system'
        ]
      )
      categories.push(categoryResult.rows[0])
    }
    for (let i = 1; i <= 2; i++) {
      const categoryResult = await client.query(
        `INSERT INTO category ("name", "description", "value", "status", "store", "createdBy", "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING id`,
        [
          `Test Category Inactive ${i}`,
          `Inactive test category ${i}`,
          `test-category-inactive-${i}`,
          'inactive',
          [1],
          'system'
        ]
      )
      categories.push(categoryResult.rows[0])
    }
    for (let i = 1; i <= 2; i++) {
      const categoryResult = await client.query(
        `INSERT INTO category ("name", "description", "value", "status", "store", "createdBy", "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING id`,
        [
          `Test Category Draft ${i}`,
          `Draft test category ${i} (can be completed later)`,
          `test-category-draft-${i}`,
          'draft',
          [1],
          'system'
        ]
      )
      categories.push(categoryResult.rows[0])
    }

    console.log('   ✅ Categories created successfully!')
    console.log(
      '   ✅ Total Categories: 6 records (2 active, 2 inactive, 2 draft)'
    )

    // Create Supplier test data (6 records)...
    console.log('\n🏷️  Creating Supplier test data (6 records)...')

    const suppliers = []
    for (let i = 1; i <= 2; i++) {
      const supplierResult = await client.query(
        `INSERT INTO supplier ("name", "phone", "email", "contactPerson", "address", "status", "createdBy")
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          `Test Supplier ${i}`,
          `+62 812345678${i}`,
          `supplier${i}@test.com`,
          `Contact Person ${i}`,
          `Test address supplier ${i}, Jakarta, Indonesia`,
          'active',
          'system'
        ]
      )
      suppliers.push(supplierResult.rows[0])
    }
    for (let i = 1; i <= 2; i++) {
      const supplierResult = await client.query(
        `INSERT INTO supplier ("name", "phone", "email", "contactPerson", "address", "status", "createdBy")
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          `Test Supplier Inactive ${i}`,
          `+62 823456789${i}`,
          `supplierinactive${i}@test.com`,
          `Contact Person Inactive ${i}`,
          `Inactive test address supplier ${i}`,
          'inactive',
          'system'
        ]
      )
      suppliers.push(supplierResult.rows[0])
    }
    for (let i = 1; i <= 2; i++) {
      const supplierResult = await client.query(
        `INSERT INTO supplier ("name", "phone", "email", "contactPerson", "address", "status", "createdBy")
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          `Test Supplier Draft ${i}`,
          `+62 824567890${i}`,
          `supplierdraft${i}@test.com`,
          `Contact Person Draft ${i}`,
          `Draft test address supplier ${i} (to be completed)`,
          'draft',
          'system'
        ]
      )
      suppliers.push(supplierResult.rows[0])
    }

    console.log('   ✅ Suppliers created successfully!')
    console.log(
      '   ✅ Total Suppliers: 6 records (2 active, 2 inactive, 2 draft)'
    )

    // Create Member Tier test data (6 records)...
    console.log('\n🏷️  Creating Member Tier test data (6 records)...')

    const memberTiers = []
    for (let i = 1; i <= 2; i++) {
      const tierResult = await client.query(
        `INSERT INTO member_tier ("name", "minPoints", "maxPoints", "discountPercent", "pointMultiplier", "benefits", "color", "status", "createdBy")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          `Test Member Tier ${i}`,
          100 + i * 100,
          500 + i * 200,
          10 + i * 5,
          1.0,
          `["Benefit 1 ${i}", "Benefit 2 ${i}"]`,
          `#${Math.floor(Math.random() * 16777215).toString(16)}`,
          'active',
          'system'
        ]
      )
      memberTiers.push(tierResult.rows[0])
    }
    for (let i = 1; i <= 2; i++) {
      const tierResult = await client.query(
        `INSERT INTO member_tier ("name", "minPoints", "maxPoints", "discountPercent", "pointMultiplier", "benefits", "color", "status", "createdBy")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          `Test Member Tier Inactive ${i}`,
          1000 + i * 100,
          5000 + i * 200,
          5 + i * 2,
          0.5,
          `["Inactive Benefit 1 ${i}"]`,
          `#${Math.floor(Math.random() * 16777215).toString(16)}`,
          'inactive',
          'system'
        ]
      )
      memberTiers.push(tierResult.rows[0])
    }
    for (let i = 1; i <= 2; i++) {
      const tierResult = await client.query(
        `INSERT INTO member_tier ("name", "minPoints", "maxPoints", "discountPercent", "pointMultiplier", "benefits", "color", "status", "createdBy")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          `Test Member Tier Draft ${i}`,
          10 + i * 10,
          50 + i * 50,
          2 + i,
          1.5,
          `["Draft Benefit ${i}"]`,
          `#${Math.floor(Math.random() * 16777215).toString(16)}`,
          'draft',
          'system'
        ]
      )
      memberTiers.push(tierResult.rows[0])
    }

    console.log('   ✅ Member Tiers created successfully!')
    console.log(
      '   ✅ Total Member Tiers: 6 records (2 active, 2 inactive, 2 draft)'
    )

    // Create Department test data (6 records)...
    console.log('\n🏷️  Creating Department test data (6 records)...')

    const departments = []
    for (let i = 1; i <= 2; i++) {
      const deptResult = await client.query(
        `INSERT INTO department ("name", "description", "status", "createdBy")
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [
          `Test Department ${i}`,
          `Test department description ${i}`,
          'active',
          'system'
        ]
      )
      departments.push(deptResult.rows[0])
    }
    for (let i = 1; i <= 2; i++) {
      const deptResult = await client.query(
        `INSERT INTO department ("name", "description", "status", "createdBy")
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [
          `Test Department Inactive ${i}`,
          `Inactive test department ${i}`,
          'inactive',
          'system'
        ]
      )
      departments.push(deptResult.rows[0])
    }
    for (let i = 1; i <= 2; i++) {
      const deptResult = await client.query(
        `INSERT INTO department ("name", "description", "status", "createdBy")
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [
          `Test Department Draft ${i}`,
          `Draft test department ${i}`,
          'draft',
          'system'
        ]
      )
      departments.push(deptResult.rows[0])
    }

    console.log('   ✅ Departments created successfully!')
    console.log(
      '   ✅ Total Departments: 6 records (2 active, 2 inactive, 2 draft)'
    )

    // Create Position test data (6 records)...
    console.log('\n🏷️  Creating Position test data (6 records)...')

    const positions = []
    for (let i = 1; i <= 2; i++) {
      // Use the first department as reference
      const deptId = departments[0]?.id || 1
      const posResult = await client.query(
        `INSERT INTO position ("name", "departmentId", "description", "status", "store", "createdBy")
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          `Test Position ${i}`,
          deptId,
          `Test position description ${i}`,
          'active',
          1,
          'system'
        ]
      )
      positions.push(posResult.rows[0])
    }
    for (let i = 1; i <= 2; i++) {
      const deptId = departments[i + 2]?.id || 1
      const posResult = await client.query(
        `INSERT INTO position ("name", "departmentId", "description", "status", "store", "createdBy")
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          `Test Position Inactive ${i}`,
          deptId,
          `Inactive test position ${i}`,
          'inactive',
          1,
          'system'
        ]
      )
      positions.push(posResult.rows[0])
    }
    for (let i = 1; i <= 2; i++) {
      const deptId = departments[i + 4]?.id || 1
      const posResult = await client.query(
        `INSERT INTO position ("name", "departmentId", "description", "status", "store", "createdBy")
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          `Test Position Draft ${i}`,
          deptId,
          `Draft test position ${i}`,
          'draft',
          1,
          'system'
        ]
      )
      positions.push(posResult.rows[0])
    }

    console.log('   ✅ Positions created successfully!')
    console.log(
      '   ✅ Total Positions: 6 records (2 active, 2 inactive, 2 draft)'
    )

    // Create Shift test data (6 records)...
    console.log('\n🏷️  Creating Shift test data (6 records)...')

    const shifts = []
    for (let i = 1; i <= 2; i++) {
      const shiftResult = await client.query(
        `INSERT INTO shift ("name", "description", "startTime", "endTime", "status", "store", "createdBy")
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          `Test Shift ${i}`,
          `Test shift description ${i}`,
          `08:00:00`,
          `17:00:00`,
          'active',
          1,
          'system'
        ]
      )
      shifts.push(shiftResult.rows[0])
    }
    for (let i = 1; i <= 2; i++) {
      const shiftResult = await client.query(
        `INSERT INTO shift ("name", "description", "startTime", "endTime", "status", "store", "createdBy")
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          `Test Shift Inactive ${i}`,
          `Inactive test shift ${i}`,
          `09:00:00`,
          `18:00:00`,
          'inactive',
          1,
          'system'
        ]
      )
      shifts.push(shiftResult.rows[0])
    }
    for (let i = 1; i <= 2; i++) {
      const shiftResult = await client.query(
        `INSERT INTO shift ("name", "description", "startTime", "endTime", "status", "store", "createdBy")
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          `Test Shift Draft ${i}`,
          `Draft test shift ${i}`,
          `10:00:00`,
          `19:00:00`,
          'draft',
          1,
          'system'
        ]
      )
      shifts.push(shiftResult.rows[0])
    }

    console.log('   ✅ Shifts created successfully!')
    console.log('   ✅ Total Shifts: 6 records (2 active, 2 inactive, 2 draft)')

    // Create Member test data (6 records)...
    console.log('\n🏷️  Creating Member test data (6 records)...')

    const members = []
    for (let i = 1; i <= 2; i++) {
      // Use the first member tier as reference
      const tierId = memberTiers[0]?.id || 1
      const memberResult = await client.query(
        `INSERT INTO member ("name", "phoneNumber", "email", "birthDate", "gender", "address", "tier", "totalPoints", "lifetimePoints", "status", "createdBy")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [
          `Test Member ${i}`,
          `+62 812345678${i}`,
          `member${i}@test.com`,
          new Date(1990 + i),
          i % 2 === 0 ? 'Laki-laki' : 'Perempuan',
          `Test member address ${i}, Jakarta, Indonesia`,
          tierId,
          1000 + i * 100,
          5000 + i * 500,
          'active',
          'system'
        ]
      )
      members.push(memberResult.rows[0])
    }
    for (let i = 1; i <= 2; i++) {
      const tierId = memberTiers[i + 2]?.id || 1
      const memberResult = await client.query(
        `INSERT INTO member ("name", "phoneNumber", "email", "birthDate", "gender", "address", "tier", "totalPoints", "lifetimePoints", "status", "createdBy")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [
          `Test Member Inactive ${i}`,
          `+62 823456789${i}`,
          `memberinactive${i}@test.com`,
          new Date(1991 + i),
          'Perempuan',
          `Inactive test member address ${i}`,
          tierId,
          100 + i * 50,
          1000 + i * 200,
          'inactive',
          'system'
        ]
      )
      members.push(memberResult.rows[0])
    }
    for (let i = 1; i <= 2; i++) {
      const tierId = memberTiers[i + 4]?.id || 1
      const memberResult = await client.query(
        `INSERT INTO member ("name", "phoneNumber", "email", "birthDate", "gender", "address", "tier", "totalPoints", "lifetimePoints", "status", "createdBy")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [
          `Test Member Draft ${i}`,
          `+62 824567890${i}`,
          `memberdraft${i}@test.com`,
          new Date(1992 + i),
          'Laki-laki',
          `Draft test member address ${i}`,
          tierId,
          50 + i * 10,
          500 + i * 100,
          'draft',
          'system'
        ]
      )
      members.push(memberResult.rows[0])
    }

    console.log('   ✅ Members created successfully!')
    console.log(
      '   ✅ Total Members: 6 records (2 active, 2 inactive, 2 draft)'
    )

    // Create Employee (User) test data (6 records)...
    console.log('\n🏷️  Creating Employee (User) test data (6 records)...')

    const employees = []
    for (let i = 1; i <= 2; i++) {
      const deptId = departments[i - 1]?.id || 1
      const posId = positions[i - 1]?.id || 1
      const shiftId = shifts[i - 1]?.id || 1
      const tier = i % 2 === 0 ? 'admin' : 'cashier'
      const statusVal = i % 2 === 0 ? 'active' : 'inactive'

      const employeeResult = await client.query(
        `INSERT INTO "user" (
          "fullName", "userName", "email", "password", "roleType", 
          "employeeID", "phoneNumber", "placeOfBirth", "address", "gender", 
          "dateOfBirth", "employmentType", "monthlySalary", "departmentId", "position", "shift", 
          "startDate", "contractDuration", "endDate", "status", 
          "store", "createdBy"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
         RETURNING id`,
        [
          `Test Employee ${i}`,
          `testuser${i}`,
          `employee${i}@test.com`,
          testUserPasswordHash,
          tier,
          `EMP${String(i).padStart(3, '0')}`,
          `+62 812345678${i}`,
          `Jakarta, Indonesia`,
          `Test employee address ${i}, Jakarta, Indonesia`,
          i % 2 === 0 ? 'Laki-laki' : 'Perempuan',
          new Date(1985 + i),
          'full-time',
          5000000 + i * 1000000,
          deptId,
          posId,
          shiftId,
          new Date(2020 + i),
          '12',
          new Date(2025 + i),
          statusVal,
          1,
          'system'
        ]
      )
      employees.push(employeeResult.rows[0])
    }
    for (let i = 1; i <= 2; i++) {
      const deptId = departments[i + 2]?.id || 1
      const posId = positions[i + 2]?.id || 1
      const shiftId = shifts[i + 2]?.id || 1
      const tier = 'staff'
      const statusVal = 'active'

      const employeeResult = await client.query(
        `INSERT INTO "user" (
          "fullName", "userName", "email", "password", "roleType", 
          "employeeID", "phoneNumber", "placeOfBirth", "address", "gender", 
          "dateOfBirth", "employmentType", "monthlySalary", "departmentId", "position", "shift", 
          "startDate", "contractDuration", "endDate", "status", 
          "store", "createdBy"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
         RETURNING id`,
        [
          `Test Employee Inactive ${i}`,
          `testuserinactive${i}`,
          `employeeinactive${i}@test.com`,
          testUserPasswordHash,
          tier,
          `EMP${String(100 + i).padStart(3, '0')}`,
          `+62 823456789${i}`,
          `Bandung, Indonesia`,
          `Inactive test employee address ${i}`,
          'Perempuan',
          new Date(1988 + i),
          'part-time',
          3000000 + i * 500000,
          deptId,
          posId,
          shiftId,
          new Date(2019 + i),
          '24',
          new Date(2024 + i),
          statusVal,
          1,
          'system'
        ]
      )
      employees.push(employeeResult.rows[0])
    }
    for (let i = 1; i <= 2; i++) {
      const deptId = departments[i + 4]?.id || 1
      const posId = positions[i + 4]?.id || 1
      const shiftId = shifts[i + 4]?.id || 1
      const tier = 'intern'
      const statusVal = 'draft'

      const employeeResult = await client.query(
        `INSERT INTO "user" (
          "fullName", "userName", "email", "password", "roleType", 
          "employeeID", "phoneNumber", "placeOfBirth", "address", "gender", 
          "dateOfBirth", "employmentType", "monthlySalary", "departmentId", "position", "shift", 
          "startDate", "contractDuration", "endDate", "status", 
          "store", "createdBy"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
         RETURNING id`,
        [
          `Test Employee Draft ${i}`,
          `testuserdraft${i}`,
          `employeedraft${i}@test.com`,
          testUserPasswordHash,
          tier,
          `EMP${String(200 + i).padStart(3, '0')}`,
          `+62 824567890${i}`,
          `Surabaya, Indonesia`,
          `Draft test employee address ${i} (to be completed)`,
          'Laki-laki',
          new Date(1995 + i),
          'contract',
          4000000 + i * 800000,
          deptId,
          posId,
          shiftId,
          new Date(2022 + i),
          '12',
          new Date(2023 + i),
          statusVal,
          1,
          'system'
        ]
      )
      employees.push(employeeResult.rows[0])
    }

    console.log('   ✅ Employees created successfully!')
    console.log(
      '   ✅ Total Employees: 6 records (2 active, 2 inactive, 2 draft)'
    )

    await client.query('COMMIT')

    console.log('\n✅ Test data seeding completed successfully!')
    console.log('\n📊 Summary:')
    console.log(
      `   Categories: ${categories.length} records (2 active, 2 inactive, 2 draft)`
    )
    console.log(
      `   Suppliers: ${suppliers.length} records (2 active, 2 inactive, 2 draft)`
    )
    console.log(
      `   Member Tiers: ${memberTiers.length} records (2 active, 2 inactive, 2 draft)`
    )
    console.log(
      `   Departments: ${departments.length} records (2 active, 2 inactive, 2 draft)`
    )
    console.log(
      `   Positions: ${positions.length} records (2 active, 2 inactive, 2 draft)`
    )
    console.log(
      `   Shifts: ${shifts.length} records (2 active, 2 inactive, 2 draft)`
    )
    console.log(
      `   Members: ${members.length} records (2 active, 2 inactive, 2 draft)`
    )
    console.log(
      `   Users (Employees): 6 records (2 active, 2 inactive, 2 draft)`
    )
    console.log(
      `   Total: ${categories.length + suppliers.length + memberTiers.length + departments.length + positions.length + shifts.length + members.length + 6} records`
    )

    // DR-06: credentials are never printed. Super admin uses
    // SEED_SUPER_ADMIN_PASSWORD; test users use SEED_TEST_USER_PASSWORD.
    console.log('\n📝 Test logins: super_admin, testuser1, testuserinactive1, testuserdraft1')

    console.log('\n🎉 Setup and test data seeding completed successfully!')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('❌ Setup and seeding failed:', error.message)
    process.exit(1)
  } finally {
    await client.end()
  }
}

seedTestData()
