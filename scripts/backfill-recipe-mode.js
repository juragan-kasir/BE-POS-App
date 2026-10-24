require('dotenv').config()
const db = require('../db/models')
const { backfillRecipeMode } = require('../api/service/recipeModeService')

// Moves 'stocked' products that already have an active BOM to
// 'make_to_order', the same rule saving a BOM applies since BE #265.
// Dry run by default; pass --apply to write, --product 1,2 to limit it.
//   node scripts/backfill-recipe-mode.js           # list what would change
//   node scripts/backfill-recipe-mode.js --apply   # switch them
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

async function main() {
  const apply = process.argv.includes('--apply')
  const productIds = arg('product', '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
  const { switched, skipped } = await backfillRecipeMode({ apply, productIds })
  console.log(apply ? `Switched ${switched.length} product(s) to make_to_order:` : `Dry run: ${switched.length} product(s) would switch to make_to_order:`)
  for (const p of switched) console.log(`  product#${p.id} ${p.name} stores=${p.stores.join(',')}`)
  if (skipped.length) {
    console.log(`Kept as stocked (${skipped.length}):`)
    for (const p of skipped) {
      const extra = p.missingStores?.length ? ` (no active BOM at store ${p.missingStores.join(',')})` : ''
      console.log(`  product#${p.id} ${p.name} ${p.reason}${extra}`)
    }
  }
  if (!apply && switched.length) console.log('Run again with --apply to write.')
  await db.sequelize.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('Error:', e.message)
  process.exit(1)
})
