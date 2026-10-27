require('dotenv').config()
const db = require('../db/models')
const { duplicateInventoryCandidates } = require('../api/service/inventoryLinkService')

// BRD Harga Modal/HPP/BOM/Stok Q7: lists products that keep their own stock
// while an ingredient of the same name exists at an outlet that sells them
// (two balances for one physical item, e.g. Le Minerale). READ-ONLY — it
// changes nothing. The owner decides which balance is right, corrects the
// item by stock opname if needed, then links the product from the product
// form (Sumber stok: Item persediaan).
//   node scripts/report-inventory-duplicates.js            # every outlet
//   node scripts/report-inventory-duplicates.js --store 3  # one outlet
//   node scripts/report-inventory-duplicates.js --json
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

async function main() {
  const store = Number(arg('store', '')) || null
  const rows = await duplicateInventoryCandidates({ store })
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(rows, null, 2))
  } else {
    console.log(`${rows.length} product/ingredient pair(s) with two balances:`)
    for (const r of rows) {
      console.log(
        `  store ${r.store}: product#${r.productId} ${r.productName} [${r.inventoryMode}] stock=${r.productStock} min=${r.productMinStock} cost=${r.productCostPrice}` +
          `  |  ingredient#${r.ingredientId} ${r.ingredientName} stock=${r.ingredientStock} ${r.baseUnit} min=${r.ingredientMinStock} cost/${r.baseUnit}=${r.ingredientCostPerBaseUnit ?? '-'}`
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
