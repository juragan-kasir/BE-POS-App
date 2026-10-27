require('dotenv').config()
const db = require('../db/models')
const { hybridProducts } = require('../api/service/inventoryLinkService')

// BRD Harga Modal/HPP/BOM/Stok phase 4F: lists the products still on the
// retired 'hybrid' mode (each sale deducts the product's own stock AND its
// recipe) with a suggested BRD kind. READ-ONLY — it changes nothing; the
// owner changes each product's mode from the product form.
//   node scripts/report-hybrid-products.js
//   node scripts/report-hybrid-products.js --json
async function main() {
  const rows = await hybridProducts()
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(rows, null, 2))
  } else {
    console.log(`${rows.length} hybrid product(s):`)
    for (const r of rows) {
      const stock = r.ownStock.map((s) => `store ${s.store}=${s.stock}`).join(', ') || '-'
      console.log(
        `  product#${r.productId} ${r.productName} [${r.status}] stores=${r.stores.join(',') || '-'} ownStock: ${stock}` +
          ` | recipe at: ${r.recipeStores.join(',') || '-'} | production orders: ${r.productionOrders} | suggested: ${r.suggestedMode}`
      )
    }
  }
  await db.sequelize.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('Error:', e.message)
  process.exit(1)
})
