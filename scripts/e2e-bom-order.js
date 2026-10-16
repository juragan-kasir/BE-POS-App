require('dotenv').config({
  path: require('path').join(__dirname, '..', '.env')
})
const path = require('path')
const { requireEnv } = require('../utils/seedCredential')
const http = require('http')
const db = require(path.join(__dirname, '..', 'db', 'models'))

const PORT = 5001
const STORE = 13
const USER_ID = 36
let token = ''
const sql = (q, opt) => db.sequelize.query(q, opt || {})

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, `http://localhost:${PORT}`)
    const data = body ? JSON.stringify(body) : null
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' }
    }
    if (token) opts.headers['Authorization'] = `Bearer ${token}`
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data)
    const req = http.request(opts, (res) => {
      let b = ''
      res.on('data', (c) => (b += c))
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(b) })
        } catch {
          resolve({ status: res.statusCode, data: b })
        }
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

async function main() {
  // 1. Login
  const login = await api('POST', '/auth/login', {
    userName: process.env.E2E_USER || 'dev',
    // DR-06: never a committed password.
    password: requireEnv('E2E_PASSWORD')
  })
  if (login.status !== 200)
    throw new Error('Login failed: ' + JSON.stringify(login.data))
  token = login.data.token
  console.log('✓ Logged in as dev')

  // 2. Ensure ingredient category
  let found = await sql(
    `SELECT id FROM ingredient_category WHERE name = 'Bahan Minuman' LIMIT 1`,
    { type: db.Sequelize.QueryTypes.SELECT }
  )
  let icId
  if (found.length) icId = found[0].id
  else {
    const r = await sql(
      `INSERT INTO ingredient_category (name, status, "createdAt", "updatedAt") VALUES ('Bahan Minuman', 'active', NOW(), NOW()) RETURNING id`,
      { type: db.Sequelize.QueryTypes.INSERT }
    )
    icId = r[0]?.id || r[0]?.[0]?.id
    console.log(`  + Created ingredient category id=${icId}`)
  }
  console.log(`✓ Ingredient category id=${icId}`)

  // 3. Ensure product category
  found = await sql(
    `SELECT c.id FROM category c WHERE c.name = 'Minuman' AND EXISTS (SELECT 1 FROM category_store cs WHERE cs.category = c.id AND cs.store = ${STORE} AND cs."deletedAt" IS NULL) LIMIT 1`,
    { type: db.Sequelize.QueryTypes.SELECT }
  )
  let pcId
  if (found.length) pcId = found[0].id
  else {
    const r = await sql(
      `INSERT INTO category (name, value, status, "createdBy", "createdAt", "updatedAt") VALUES ('Minuman', 'minuman', 'active', ${USER_ID}, NOW(), NOW()) RETURNING id`,
      { type: db.Sequelize.QueryTypes.INSERT }
    )
    pcId = r[0]?.id || r[0]?.[0]?.id
    await sql(
      `INSERT INTO category_store ("category", "store", "createdAt", "updatedAt") VALUES (${pcId}, ${STORE}, NOW(), NOW())`
    )
    console.log(`  + Created product category id=${pcId}`)
  }
  console.log(`✓ Product category id=${pcId}`)

  // 4. Create/reset ingredients
  const ings = [
    { name: 'Bubuk Matcha', unit: 'gram', stock: 5000, costPrice: 50 }, // 50/g = 50rb/kg
    { name: 'Susu Cair', unit: 'ml', stock: 20000, costPrice: 30 }, // 30/ml = 30rb/L
    { name: 'Air Galon', unit: 'ml', stock: 50000, costPrice: 1 }, // 1/ml
    { name: 'Sirup Gula', unit: 'ml', stock: 10000, costPrice: 100 }, // 100/ml
    { name: 'Es Batu', unit: 'gram', stock: 30000, costPrice: 2 }, // 2/g
    { name: 'Kopi (Espresso)', unit: 'ml', stock: 5000, costPrice: 200 }, // 200/ml
    { name: 'Gula Aren', unit: 'ml', stock: 10000, costPrice: 150 } // 150/ml
  ]
  const ingMap = {}
  for (const s of ings) {
    const rows = await sql(
      `SELECT id, stock FROM ingredient WHERE name = '${s.name.replace(/'/g, "''")}' AND store = ${STORE} LIMIT 1`,
      { type: db.Sequelize.QueryTypes.SELECT }
    )
    if (rows.length) {
      await sql(
        `UPDATE ingredient SET stock = ${s.stock}, "costPrice" = ${s.costPrice} WHERE id = ${rows[0].id}`
      )
      ingMap[s.name] = rows[0].id
      console.log(`  ~ Reset: ${s.name} (id=${rows[0].id}, stock=${s.stock})`)
    } else {
      const r = await sql(
        `INSERT INTO ingredient (store, name, "category", unit, stock, "minStock", "costPrice", status, "createdBy", "createdAt", "updatedAt", "baseUnit", "conversionFactor") VALUES (${STORE}, '${s.name.replace(/'/g, "''")}', ${icId}, '${s.unit}', ${s.stock}, 0, ${s.costPrice}, 'active', ${USER_ID}, NOW(), NOW(), '${s.unit}', 1) RETURNING id`,
        { type: db.Sequelize.QueryTypes.INSERT }
      )
      const id = r[0]?.id || r[0]?.[0]?.id
      ingMap[s.name] = id
      console.log(`  + Created: ${s.name} (id=${id})`)
    }
  }

  // 5. Create/reset products + store stock
  const prodSpecs = [
    { name: 'Matcha Latte', price: 25000, costPrice: 8000, stock: 50 },
    { name: 'Kopi Susu Gula Aren', price: 20000, costPrice: 6500, stock: 50 },
    { name: 'Cappuccino', price: 22000, costPrice: 7000, stock: 50 }
  ]
  const prodMap = {}
  for (const s of prodSpecs) {
    const rows = await sql(
      `SELECT id FROM product WHERE "nameProduct" = '${s.name.replace(/'/g, "''")}' LIMIT 1`,
      { type: db.Sequelize.QueryTypes.SELECT }
    )
    let pid
    if (rows.length) {
      pid = rows[0].id
      await sql(
        `UPDATE product SET stock = ${s.stock}, price = ${s.price}, "costPrice" = ${s.costPrice} WHERE id = ${pid}`
      )
    } else {
      const r = await sql(
        `INSERT INTO product ("nameProduct", price, "costPrice", category, status, "createdBy", unit, "createdAt", "updatedAt", stock) VALUES ('${s.name.replace(/'/g, "''")}', ${s.price}, ${s.costPrice}, ${pcId}, 'active', ${USER_ID}, 'pcs', NOW(), NOW(), ${s.stock}) RETURNING id`,
        { type: db.Sequelize.QueryTypes.INSERT }
      )
      pid = r[0]?.id || r[0]?.[0]?.id
      await sql(
        `INSERT INTO product_store ("product", "store", "createdAt", "updatedAt") VALUES (${pid}, ${STORE}, NOW(), NOW())`
      )
      console.log(`  + Created product: ${s.name} (id=${pid})`)
    }
    // upsert store stock
    const pss = await sql(
      `SELECT id FROM product_store_stock WHERE product = ${pid} AND store = ${STORE} LIMIT 1`,
      { type: db.Sequelize.QueryTypes.SELECT }
    )
    if (pss.length) {
      await sql(
        `UPDATE product_store_stock SET stock = ${s.stock} WHERE id = ${pss[0].id}`
      )
    } else {
      await sql(
        `INSERT INTO product_store_stock (product, store, stock, "createdAt", "updatedAt") VALUES (${pid}, ${STORE}, ${s.stock}, NOW(), NOW())`
      )
    }
    prodMap[s.name] = pid
  }

  // 6. Create BOMs via API
  const boms = [
    {
      name: 'BOM Matcha Latte',
      productId: prodMap['Matcha Latte'],
      notes: 'E2E test',
      lines: [
        { ingredientId: ingMap['Bubuk Matcha'], qty: 15 },
        { ingredientId: ingMap['Susu Cair'], qty: 200 },
        { ingredientId: ingMap['Sirup Gula'], qty: 20 },
        { ingredientId: ingMap['Es Batu'], qty: 100 },
        { ingredientId: ingMap['Air Galon'], qty: 50 }
      ]
    },
    {
      name: 'BOM Kopi Susu Gula Aren',
      productId: prodMap['Kopi Susu Gula Aren'],
      notes: 'E2E test',
      lines: [
        { ingredientId: ingMap['Kopi (Espresso)'], qty: 30 },
        { ingredientId: ingMap['Susu Cair'], qty: 150 },
        { ingredientId: ingMap['Gula Aren'], qty: 25 },
        { ingredientId: ingMap['Es Batu'], qty: 100 }
      ]
    },
    {
      name: 'BOM Cappuccino',
      productId: prodMap['Cappuccino'],
      notes: 'E2E test',
      lines: [
        { ingredientId: ingMap['Kopi (Espresso)'], qty: 30 },
        { ingredientId: ingMap['Susu Cair'], qty: 100 },
        { ingredientId: ingMap['Es Batu'], qty: 80 }
      ]
    }
  ]

  for (const bom of boms) {
    // delete existing
    const existing = await sql(
      `SELECT id FROM bom_header WHERE "productId" = ${bom.productId} LIMIT 1`,
      { type: db.Sequelize.QueryTypes.SELECT }
    )
    if (existing.length) {
      await sql(`DELETE FROM bom_line WHERE "bomHeaderId" = ${existing[0].id}`)
      await sql(`DELETE FROM bom_header WHERE id = ${existing[0].id}`)
    }
    const r = await api('POST', '/bom/add', bom)
    if (r.status === 201 || r.status === 200) {
      console.log(`  ✓ BOM created: ${bom.name}`)
    } else {
      console.log(
        `  ✗ BOM failed: ${bom.name} — ${r.status} ${JSON.stringify(r.data)}`
      )
    }
  }

  // 7. Snapshot
  const snap = {}
  for (const [name, id] of Object.entries(ingMap)) {
    const rows = await sql(`SELECT stock FROM ingredient WHERE id = ${id}`, {
      type: db.Sequelize.QueryTypes.SELECT
    })
    snap[name] = Number(rows[0].stock)
  }
  console.log('\n── Ingredient stock BEFORE ──')
  for (const [k, v] of Object.entries(snap))
    console.log(`  ${k.padEnd(18)} ${v}`)

  // 8. Create order: 2x Matcha Latte + 1x Kopi Susu Gula Aren
  const ord = {
    store: STORE,
    paymentMethod: 'cash',
    items: [
      {
        productId: prodMap['Matcha Latte'],
        productName: 'Matcha Latte',
        quantity: 2,
        price: 25000,
        subtotal: 50000
      },
      {
        productId: prodMap['Kopi Susu Gula Aren'],
        productName: 'Kopi Susu Gula Aren',
        quantity: 1,
        price: 20000,
        subtotal: 20000
      }
    ]
  }
  const orderRes = await api('POST', '/order/create', ord)
  if (orderRes.status >= 200 && orderRes.status < 300) {
    const oid =
      orderRes.data.data?.id || orderRes.data.order?.id || '(see above)'
    console.log(`\n✓ Order created! ID=${oid}`)
  } else {
    console.log(
      `\n✗ Order failed: ${orderRes.status} ${JSON.stringify(orderRes.data)}`
    )
  }

  // 9. Verify
  console.log('\n── Ingredient stock AFTER ──')
  const expected = {
    'Bubuk Matcha': 30,
    'Susu Cair': 550, // 2×200 + 1×150
    'Air Galon': 100,
    'Sirup Gula': 40,
    'Es Batu': 300, // 2×100 + 1×100
    'Kopi (Espresso)': 30,
    'Gula Aren': 25
  }
  let allOk = true
  for (const [name, id] of Object.entries(ingMap)) {
    const rows = await sql(`SELECT stock FROM ingredient WHERE id = ${id}`, {
      type: db.Sequelize.QueryTypes.SELECT
    })
    const now = Number(rows[0].stock)
    const diff = snap[name] - now
    const exp = expected[name]
    const ok = diff === exp
    if (!ok) allOk = false
    console.log(
      `  ${ok ? '✓' : '✗'} ${name.padEnd(18)} ${snap[name]} → ${now}  Δ-${diff}  expected Δ-${exp}`
    )
  }

  console.log(allOk ? '\n✅ ALL CHECKS PASSED' : '\n❌ SOME CHECKS FAILED')
  process.exit(allOk ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
