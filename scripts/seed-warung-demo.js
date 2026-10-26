'use strict'

/**
 * Dedicated LOCAL demo fixture for the warung bakso menu.
 *
 * Safety contract:
 *   - refuses production/staging;
 *   - refuses any database whose name does not contain "demo";
 *   - requires WARUNG_DEMO_CONFIRM to equal that database name;
 *   - never truncates, resets, deletes or overwrites an existing row;
 *   - opening stock is written through the same audited service the API uses
 *     (stock_history), and only when no recording exists yet.
 *
 * The owner's written quantities are fixtures for the demo, not verified
 * physical counts. Pending recipe ambiguities stay visible in the BOM notes
 * and are never silently guessed.
 */

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

const db = require('../db/models')
// Keep the fixture transcript readable; this only affects this process.
db.sequelize.options.logging = false
const {
  adjustIngredientStock,
  getIngredientStockRecording
} = require('../api/service/stockMutationService')

const STORE_NAME = 'WARUNG BAKSO DEMO (LOCAL)'
const STORE_TIMEZONE = 'Asia/Jakarta'
const MENU_CATEGORY_NAME = 'WARUNG DEMO - MENU'
const DEMO_USERNAME = 'warung_demo_admin'
const DEMO_EMAIL = 'warung-demo-admin@local.test'

const fail = (message) => {
  console.error(`\n[warung-demo] REFUSED: ${message}`)
  process.exit(1)
}

const assertSafeTarget = () => {
  const env = String(process.env.NODE_ENV || 'development').toLowerCase()
  const database = String(process.env.DB_DEV_DATABASE || '')
  if (env === 'production' || env === 'staging') {
    fail(`NODE_ENV=${env} is not a demo environment`)
  }
  if (!/^[A-Za-z0-9_]+$/.test(database)) {
    fail('DB_DEV_DATABASE must be a plain database name')
  }
  if (database === 'cashier_app' || !/demo/i.test(database)) {
    fail(
      `DB_DEV_DATABASE="${database}" is not a dedicated demo database. ` +
        'Create the demo database and pass DB_DEV_DATABASE=<name containing "demo">.'
    )
  }
  if (process.env.WARUNG_DEMO_CONFIRM !== database) {
    fail(
      `Set WARUNG_DEMO_CONFIRM=${database} to acknowledge that the demo fixtures ` +
        'will be written to this dedicated database.'
    )
  }
  return database
}

// Owner's recipe notes, per portion, in individual pieces (base unit).
// Keys map to INGREDIENTS below.
const RECIPES = [
  { menu: 'BAKSO URAT', components: { halus: 2, urat: 2 } },
  { menu: 'URAT KSG', components: { urat: 2, halus: 3 } },
  { menu: 'BAKSO HALUS', components: { halus: 5 } },
  { menu: 'HALUS KSG', components: { halus: 6 } },
  { menu: 'BAKSO TELUR', components: { telur: 2, halus: 2 } },
  { menu: 'TELUR KSG', components: { telur: 2, halus: 3 } },
  { menu: 'BAKSO KOMPLIT', components: { telur: 1, urat: 1, halus: 2 } },
  { menu: 'MIE AYAM', components: { mie: 1 } },
  { menu: 'MIE AYAM CEKER', components: { mie: 1, ceker: 1 } },
  {
    menu: 'MIE AYAM CHEESE',
    components: { mie: 1 },
    notes:
      'PENDING KONFIRMASI: jumlah keju per porsi belum dikonfirmasi pemilik — ' +
      'keju belum dipotong, hanya mie yang dikonfirmasi'
  },
  { menu: 'MIE AYAM CHILLI', components: { mie: 1 } },
  {
    menu: 'MISO URAT',
    components: { urat: 1, halus: 1, mie: 1 },
    notes:
      'PENDING KONFIRMASI: catatan menulis "1 Urat + 1 Halus" dan "Polos" — ' +
      'dipetakan ke satu item Bakso Halus/Polos sesuai catatan stok pemilik'
  },
  { menu: 'MISO HALUS', components: { halus: 3, mie: 1 } },
  {
    menu: 'MISO TELUR',
    components: { telur: 1, halus: 1, mie: 1 },
    status: 'draft',
    notes:
      'PENDING KONFIRMASI: catatan "1 x 4" belum jelas — resep DRAFT, ' +
      'tidak memotong stok sampai pemilik mengonfirmasi'
  }
]

const INGREDIENTS = [
  {
    key: 'halus',
    name: 'Bakso Halus/Polos',
    opening: 83,
    notes:
      'Stok awal demo: catatan pemilik "Bakso polos/halus 83 pcs" — ' +
      'satu item kanonik, label mempertahankan alias halus/polos'
  },
  { key: 'urat', name: 'Bakso Urat', opening: 30, notes: 'Stok awal demo' },
  { key: 'telur', name: 'Bakso Telur', opening: 12, notes: 'Stok awal demo' },
  { key: 'mie', name: 'Mie', opening: 144, notes: 'Stok awal demo' },
  { key: 'ceker', name: 'Ceker', opening: 10, notes: 'Stok awal demo' },
  {
    key: 'keju',
    name: 'Keju (Cheese)',
    opening: 10,
    notes:
      'Stok awal demo: jumlah keju per porsi MIE AYAM CHEESE belum ' +
      'dikonfirmasi, jadi belum dipakai resep'
  },
  {
    key: 'cup',
    name: 'Cup',
    opening: 71,
    notes:
      'Stok awal demo: pemakaian cup per menu belum dikonfirmasi, ' +
      'jadi belum dipakai resep'
  },
  {
    key: 'jeruk',
    name: 'Jeruk',
    opening: 20,
    notes:
      'Stok awal demo: catatan "17 + 3 = 20"; belum dikonfirmasi apakah ' +
      'buah utuh, bahan minuman, atau unit jual'
  }
]

// Packaged items are finished goods, not recipes. Le Minerale/Rambak are
// demo fixtures; whether they are sellable units or ingredients is pending.
const PACKAGED_PRODUCTS = [
  {
    name: 'LE MINERALE',
    price: 5000,
    opening: 8,
    description: 'Demo fixture: 8 pcs — unit perlu verifikasi pemilik'
  },
  {
    name: 'RAMBAK',
    price: 2000,
    opening: 27,
    description: 'Demo fixture: 20 + 7 = 27 pcs — angka gabungan dari catatan'
  }
]

// No recipe was supplied. These stay draft with an empty draft BOM so they
// are visible/configurable, never silently deducted with guessed components.
const PENDING_PRODUCTS = [
  { name: 'ES TEH', note: 'PENDING KONFIRMASI: resep belum diberikan; catatan "1+1+3+1+3+1+1 = 11 pcs" belum jelas (bukan bukti stok awal)' },
  { name: 'TEH ANGET', note: 'PENDING KONFIRMASI: resep belum diberikan' },
  { name: 'ES JERUK', note: 'PENDING KONFIRMASI: resep belum diberikan; model konsumsi Jeruk belum jelas' },
  { name: 'JERUK ANGET', note: 'PENDING KONFIRMASI: resep belum diberikan; model konsumsi Jeruk belum jelas' },
  { name: 'ES KAMPUL', note: 'PENDING KONFIRMASI: resep belum diberikan' },
  { name: 'AIR ES', note: 'PENDING KONFIRMASI: resep belum diberikan' }
]

const findOrCreateBy = async (model, where, defaults, transaction) => {
  const existing = await model.findOne({ where, transaction })
  if (existing) return { row: existing, created: false }
  const row = await model.create(defaults, { transaction })
  return { row, created: true }
}

const main = async () => {
  const database = assertSafeTarget()
  const password = process.env.WARUNG_DEMO_ADMIN_PASSWORD
  console.log(`[warung-demo] target database: ${database}`)
  console.log('[warung-demo] no truncate/reset/delete will be performed')

  const summary = {
    store: null,
    user: null,
    ingredients: [],
    recipes: [],
    packaged: [],
    pending: []
  }

  await db.sequelize.transaction(async (t) => {
    // 1. Dedicated demo store.
    const storeResult = await findOrCreateBy(
      db.location,
      { name: STORE_NAME },
      {
        name: STORE_NAME,
        address: 'DEMO ONLY - dedicated local database',
        description: 'Dedicated warung demo store; safe to reset as a whole database.',
        status: 'active',
        timezone: STORE_TIMEZONE
      },
      t
    )
    const store = storeResult.row
    summary.store = { id: store.id, name: store.name, created: storeResult.created }

    // 2. Demo login. A store-bound super_admin bypasses menu permissions but
    // remains confined to this store by the backend's store isolation.
    let user = await db.user.scope('withCredentials').findOne({
      where: { userName: DEMO_USERNAME },
      paranoid: false,
      transaction: t
    })
    if (user && user.deletedAt) {
      throw new Error(
        `Demo user "${DEMO_USERNAME}" exists but is deleted; use the dedicated demo reset script.`
      )
    }
    if (!user) {
      if (!password) {
        throw new Error(
          'WARUNG_DEMO_ADMIN_PASSWORD is required to create the demo login.'
        )
      }
      user = await db.user.create(
        {
          userName: DEMO_USERNAME,
          fullName: 'Warung Demo Admin',
          email: DEMO_EMAIL,
          password,
          roleType: 'super_admin',
          userType: 'admin',
          store: store.id,
          status: 'active'
        },
        { transaction: t }
      )
      summary.user = { id: user.id, created: true }
    } else {
      if (Number(user.store) !== Number(store.id)) {
        throw new Error(
          `Demo user "${DEMO_USERNAME}" belongs to another store; refusing to move it.`
        )
      }
      if (password && process.env.WARUNG_DEMO_RESET_PASSWORD === '1') {
        user.password = password
        await user.save({ transaction: t })
      }
      summary.user = { id: user.id, created: false }
    }

    // 2b. An open register is required before the outlet can settle a sale.
    const openRegister = await db.cashRegister.findOne({
      where: { store: store.id, status: 'open' },
      transaction: t
    })
    if (!openRegister) {
      await db.cashRegister.create(
        {
          store: store.id,
          user: user.id,
          status: 'open',
          openingBalance: 0,
          openedAt: new Date(),
          notes: 'Demo fixture: open register for the local walkthrough'
        },
        { transaction: t }
      )
    }
    summary.cashRegister = { open: true, created: !openRegister }

    // 3. Menu category (product.category is required).
    const categoryResult = await findOrCreateBy(
      db.category,
      { name: MENU_CATEGORY_NAME },
      {
        name: MENU_CATEGORY_NAME,
        value: 'warung-demo-menu',
        status: 'active',
        createdBy: String(user.id)
      },
      t
    )
    const category = categoryResult.row
    const categoryStore = await db.category_store.findOne({
      where: { category: category.id, store: store.id },
      paranoid: false,
      transaction: t
    })
    if (categoryStore && categoryStore.deletedAt) {
      await categoryStore.restore({ transaction: t })
    } else if (!categoryStore) {
      await db.category_store.create(
        { category: category.id, store: store.id, createdBy: user.id },
        { transaction: t }
      )
    }

    // Active PPN is required before the outlet can sell. 11% is the fixture
    // rate used by the integration tests; the owner should confirm it.
    const tax = await db.taxConfig.findOne({
      where: { store: store.id, type: 'ppn', status: 'active' },
      transaction: t
    })
    if (!tax) {
      await db.taxConfig.create(
        {
          store: store.id,
          name: 'PPN Demo 11%',
          rate: 11,
          type: 'ppn',
          status: 'active',
          description: 'Demo fixture only - confirm the outlet PPN rate',
          createdBy: user.id
        },
        { transaction: t }
      )
    }
    summary.taxConfig = { rate: 11, created: !tax }

    // 4. Ingredients + recorded opening stock (fixtures only).
    const ingredientByKey = new Map()
    for (const spec of INGREDIENTS) {
      const result = await findOrCreateBy(
        db.ingredient,
        { store: store.id, name: spec.name },
        {
          store: store.id,
          name: spec.name,
          stock: 0,
          minStock: 0,
          unit: 'pcs',
          baseUnit: 'pcs',
          conversionFactor: 1,
          costPrice: 0,
          status: 'active',
          createdBy: user.id
        },
        t
      )
      const ingredient = result.row
      ingredientByKey.set(spec.key, ingredient)

      const recording = await getIngredientStockRecording([ingredient.id])
      let state = 'already-recorded'
      if (!recording.has(ingredient.id)) {
        if (Number(ingredient.stock) !== 0) {
          state = 'unrecorded-existing-value-left-untouched'
        } else {
          const outcome = await adjustIngredientStock({
            ingredientId: ingredient.id,
            store: store.id,
            mode: 'set',
            quantity: spec.opening,
            notes: spec.notes,
            createdBy: user.id,
            transaction: t
          })
          if (!outcome) throw new Error(`Could not record opening stock for ${spec.name}`)
          state = 'opening-stock-recorded'
        }
      }
      await ingredient.reload({ transaction: t })
      summary.ingredients.push({
        id: ingredient.id,
        name: ingredient.name,
        unit: ingredient.baseUnit || ingredient.unit,
        openingFixture: spec.opening,
        stock: Number(ingredient.stock),
        state
      })
    }

    const ensureProduct = async (name, price, inventoryMode, description, status) => {
      const result = await findOrCreateBy(
        db.product,
        { nameProduct: name },
        {
          nameProduct: name,
          category: category.id,
          price,
          stock: 0,
          unit: 'pcs',
          baseUnit: 'pcs',
          inventoryMode,
          status,
          description,
          createdBy: user.id
        },
        t
      )
      const product = result.row
      const assignment = await db.product_store.findOne({
        where: { product: product.id, store: store.id },
        paranoid: false,
        transaction: t
      })
      if (assignment && assignment.deletedAt) {
        await assignment.restore({ transaction: t })
      } else if (!assignment) {
        await db.product_store.create(
          { product: product.id, store: store.id },
          { transaction: t }
        )
      }
      return { product, created: result.created }
    }

    // 5. Recipe-driven menus (make_to_order). BOMs are only created when
    // missing; an existing recipe is never overwritten.
    for (const spec of RECIPES) {
      const { product, created } = await ensureProduct(
        spec.menu,
        15000,
        'make_to_order',
        spec.notes || '',
        spec.status || 'active'
      )
      const existingBom = await db.bom_header.findOne({
        where: { productId: product.id, store: store.id },
        transaction: t
      })
      if (!existingBom) {
        const bom = await db.bom_header.create(
          {
            store: store.id,
            productId: product.id,
            name: `Resep ${spec.menu}`,
            // totalQty is the recipe yield (portions); each recipe makes one.
            totalQty: 1,
            notes: spec.notes || '',
            status: spec.status || 'active',
            createdBy: user.id
          },
          { transaction: t }
        )
        await db.bom_line.bulkCreate(
          Object.entries(spec.components).map(([key, qty]) => ({
            bomHeaderId: bom.id,
            ingredientId: ingredientByKey.get(key).id,
            qty,
            unit: 'pcs'
          })),
          { transaction: t }
        )
      }
      const bom = await db.bom_header.findOne({
        where: { productId: product.id, store: store.id },
        include: [{ model: db.bom_line, as: 'lines' }],
        transaction: t
      })
      summary.recipes.push({
        productId: product.id,
        menu: spec.menu,
        productCreated: created,
        bomId: bom?.id || null,
        status: bom?.status || null,
        components: spec.components,
        notes: bom?.notes || '',
        lineCount: bom?.lines?.length || 0
      })
    }

    // 6. Packaged finished goods (stocked): their own outlet stock is
    // authoritative, so no recipe is involved.
    for (const spec of PACKAGED_PRODUCTS) {
      const { product, created } = await ensureProduct(
        spec.name,
        spec.price,
        'stocked',
        spec.description,
        'active'
      )
      const rowResult = await findOrCreateBy(
        db.product_store_stock,
        { product: product.id, store: store.id },
        { product: product.id, store: store.id, stock: spec.opening },
        t
      )
      if (created) {
        await product.update(
          { stock: spec.opening },
          { transaction: t }
        )
      }
      summary.packaged.push({
        productId: product.id,
        name: spec.name,
        productCreated: created,
        outletStock: Number(rowResult.row.stock),
        stockRowCreated: rowResult.created,
        openingFixture: spec.opening
      })
    }

    // 7. Drinks/add-ons without a recipe: draft product + empty draft BOM.
    // This is intentionally not sellable and never deducts guessed stock.
    for (const spec of PENDING_PRODUCTS) {
      const { product, created } = await ensureProduct(
        spec.name,
        0,
        'make_to_order',
        spec.note,
        'draft'
      )
      const existingBom = await db.bom_header.findOne({
        where: { productId: product.id, store: store.id },
        transaction: t
      })
      if (!existingBom) {
        await db.bom_header.create(
          {
            store: store.id,
            productId: product.id,
            name: `Resep ${spec.name} (belum dikonfirmasi)`,
            totalQty: 0,
            notes: spec.note,
            status: 'draft',
            createdBy: user.id
          },
          { transaction: t }
        )
      }
      summary.pending.push({
        productId: product.id,
        name: spec.name,
        productCreated: created,
        status: 'draft',
        note: spec.note
      })
    }

    summary.category = { id: category.id, name: category.name }
  })

  console.log('\n[warung-demo] FIXTURES READY (dedicated demo database only)')
  console.log(JSON.stringify(summary, null, 2))
  console.log('\n[warung-demo] Note: these are demo fixtures, not verified physical stock.')
  console.log('[warung-demo] Pending recipes remain draft/visible; no guessed deduction is enabled.')
  console.log(
    `[warung-demo] Run the app with DB_DEV_DATABASE=${database} and log in as ${DEMO_USERNAME}.`
  )
}

main()
  .catch((error) => {
    console.error('\n[warung-demo] FAILED:', error.message)
    if (error.errors) {
      for (const e of error.errors) console.error(`  - ${e.message}`)
    }
    process.exitCode = 1
  })
  .finally(async () => {
    await db.sequelize.close()
  })
