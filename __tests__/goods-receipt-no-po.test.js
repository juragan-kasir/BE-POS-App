process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'
const SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

let store = null
let category = null
let ingredientCategory = null
let ingredient = null
let foreignStore = null
let foreignIngredientCategory = null
let foreignIngredient = null
let product = null
let admin = null
let adminToken = null
let globalSuper = null
let globalSuperToken = null

const createIngredientForStore = async (name) =>
  db.ingredient.create({
    store: store.id,
    category: ingredientCategory.id,
    name,
    stock: 0,
    minStock: 0,
    unit: 'gram',
    baseUnit: 'gram',
    conversionFactor: 1,
    costPrice: 0,
    status: 'active'
  })

const createNoPoReceipt = (token, body) =>
  request(app)
    .post('/goods-receipt/create')
    .set('Authorization', `Bearer ${token}`)
    .send(body)

const ingredientStock = async (id) =>
  Number((await db.ingredient.findByPk(id)).stock)

beforeAll(async () => {
  store = await db.location.create({
    name: `GR_NO_PO_STORE_${SUFFIX}`,
    status: 'active'
  })
  category = await db.category.create({ name: `GR_NO_PO_CAT_${SUFFIX}` })
  ingredientCategory = await db.ingredientCategory.create({
    store: store.id,
    name: `GR_NO_PO_ING_CAT_${SUFFIX}`,
    status: 'active'
  })
  ingredient = await createIngredientForStore(`GR_NO_PO_ING_${SUFFIX}`)
  foreignStore = await db.location.create({
    name: `GR_NO_PO_FOREIGN_STORE_${SUFFIX}`,
    status: 'active'
  })
  foreignIngredientCategory = await db.ingredientCategory.create({
    store: foreignStore.id,
    name: `GR_NO_PO_FOREIGN_ING_CAT_${SUFFIX}`,
    status: 'active'
  })
  foreignIngredient = await db.ingredient.create({
    store: foreignStore.id,
    category: foreignIngredientCategory.id,
    name: `GR_NO_PO_FOREIGN_ING_${SUFFIX}`,
    stock: 500,
    minStock: 0,
    unit: 'gram',
    baseUnit: 'gram',
    conversionFactor: 1,
    costPrice: 0,
    status: 'active'
  })
  product = await db.product.create({
    nameProduct: `GR_NO_PO_PROD_${SUFFIX}`,
    category: category.id,
    price: 9000,
    costPrice: 5000,
    stock: 0
  })
  admin = await db.user.create({
    userName: `admin_gr_no_po_${SUFFIX}`,
    email: `admin_gr_no_po_${SUFFIX}@test.com`,
    roleType: 'admin',
    userType: 'admin',
    store: store.id,
    status: 'active',
    fullName: 'GR_NO_PO_ADMIN'
  })
  adminToken = await signSessionToken(
    {
      id: admin.id,
      userName: admin.userName,
      roleType: 'admin',
      store: store.id
    },
    JWT_SECRET
  )
  globalSuper = await db.user.create({
    userName: `super_gr_no_po_${SUFFIX}`,
    email: `super_gr_no_po_${SUFFIX}@test.com`,
    roleType: 'super_admin',
    userType: 'admin',
    store: null,
    status: 'active',
    fullName: 'GR_NO_PO_SUPER'
  })
  globalSuperToken = await signSessionToken(
    {
      id: globalSuper.id,
      userName: globalSuper.userName,
      roleType: 'super_admin'
    },
    JWT_SECRET
  )
})

afterAll(async () => {
  if (!store) return
  const receiptIds = await db.goodsReceipt
    .findAll({ where: { store: store.id }, attributes: ['id'], raw: true })
    .then((rows) => rows.map((r) => r.id))
  const batchIds = product
    ? await db.product_batch
        .findAll({ where: { product: product.id }, attributes: ['id'], raw: true })
        .then((rows) => rows.map((r) => r.id))
    : []

  await db.accounting_outbox.destroy({ where: { store: store.id }, force: true })
  const journalIds = await db.journal_entry
    .findAll({ where: { store: store.id }, attributes: ['id'], raw: true })
    .then((rows) => rows.map((r) => r.id))
  if (journalIds.length) {
    await db.journal_entry_line.destroy({
      where: { journalEntry: journalIds },
      force: true
    })
  }
  await db.journal_entry.destroy({ where: { store: store.id }, force: true })
  if (batchIds.length) {
    await db.product_batch_stock.destroy({
      where: { batch: batchIds },
      force: true
    })
  }
  if (product) {
    await db.product_batch.destroy({ where: { product: product.id }, force: true })
  }
  await db.stock_history.destroy({ where: { store: store.id }, force: true })
  await db.product_store_stock.destroy({ where: { store: store.id }, force: true })
  if (receiptIds.length) {
    await db.goodsReceiptItem.destroy({
      where: { goodsReceipt: receiptIds },
      force: true
    })
  }
  await db.goodsReceipt.destroy({ where: { store: store.id }, force: true })
  await db.ingredient.destroy({ where: { store: store.id }, force: true })
  if (ingredientCategory) {
    await db.ingredientCategory.destroy({
      where: { store: store.id },
      force: true
    })
  }
  if (foreignIngredient) {
    await db.ingredient.destroy({
      where: { id: foreignIngredient.id },
      force: true
    })
  }
  if (foreignIngredientCategory) {
    await db.ingredientCategory.destroy({
      where: { store: foreignStore.id },
      force: true
    })
  }
  if (product) {
    await db.product.destroy({ where: { id: product.id }, force: true })
  }
  if (category) {
    await db.category.destroy({ where: { id: category.id }, force: true })
  }
  await db.user.destroy({
    where: { id: [admin?.id, globalSuper?.id].filter(Boolean) },
    force: true
  })
  await db.location.destroy({
    where: { id: [store.id, foreignStore?.id].filter(Boolean) },
    force: true
  })
})

describe('DR-15 — goods receipt without a purchase order', () => {
  test('completing an ingredient-only receipt without a PO posts stock and the purchase journal', async () => {
    const res = await createNoPoReceipt(adminToken, {
      store: store.id,
      status: 'completed',
      items: [
        {
          ingredient: ingredient.id,
          qtyReceived: 200,
          unit: 'gram',
          costPrice: 2500
        }
      ]
    })

    expect(res.status).toBe(201)
    expect(res.body.data.purchaseOrderId).toBeNull()
    expect(await ingredientStock(ingredient.id)).toBe(200)

    const entry = await db.journal_entry.findOne({
      where: {
        store: store.id,
        sourceType: 'purchase',
        referenceId: res.body.data.id
      }
    })
    expect(entry).not.toBeNull()
    expect(Number(entry.totalDebit)).toBe(200 * 2500)
    expect(Number(entry.totalCredit)).toBe(200 * 2500)
  })

  test('a draft without a PO posts nothing until it is completed', async () => {
    const created = await createNoPoReceipt(adminToken, {
      store: store.id,
      status: 'draft',
      items: [
        {
          ingredient: ingredient.id,
          qtyReceived: 75,
          unit: 'gram',
          costPrice: 2000
        }
      ]
    })
    expect(created.status).toBe(201)
    expect(await ingredientStock(ingredient.id)).toBe(200)

    const completed = await request(app)
      .patch(`/goods-receipt/status/${created.body.data.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'completed', store: store.id })
    expect(completed.status).toBe(200)
    expect(await ingredientStock(ingredient.id)).toBe(275)

    const entry = await db.journal_entry.findOne({
      where: {
        store: store.id,
        sourceType: 'purchase',
        referenceId: created.body.data.id
      }
    })
    expect(entry).not.toBeNull()
  })

  test('a metadata-only update that completes a draft posts the journal too', async () => {
    const created = await createNoPoReceipt(adminToken, {
      store: store.id,
      status: 'draft',
      items: [
        {
          ingredient: ingredient.id,
          qtyReceived: 25,
          unit: 'gram',
          costPrice: 1800
        }
      ]
    })
    expect(created.status).toBe(201)

    const updated = await request(app)
      .put(`/goods-receipt/update/${created.body.data.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'completed', notes: 'completed without editing lines' })
    expect(updated.status).toBe(200)
    expect(await ingredientStock(ingredient.id)).toBe(300)

    const entry = await db.journal_entry.findOne({
      where: {
        store: store.id,
        sourceType: 'purchase',
        referenceId: created.body.data.id
      }
    })
    expect(entry).not.toBeNull()
    expect(Number(entry.totalDebit)).toBe(25 * 1800)
  })

  test('a no-PO receipt rejects an ingredient owned by another store', async () => {
    const res = await createNoPoReceipt(adminToken, {
      store: store.id,
      status: 'completed',
      items: [
        {
          ingredient: foreignIngredient.id,
          ingredientName: foreignIngredient.name,
          qtyReceived: 10,
          unit: 'gram',
          costPrice: 1
        }
      ]
    })

    expect(res.status).toBe(400)
    expect(await ingredientStock(foreignIngredient.id)).toBe(500)
  })

  test('a no-PO receipt needs a store and rejects product lines', async () => {
    const noStore = await createNoPoReceipt(globalSuperToken, {
      status: 'completed',
      items: [
        {
          ingredient: ingredient.id,
          qtyReceived: 1,
          unit: 'gram',
          costPrice: 1000
        }
      ]
    })
    expect(noStore.status).toBe(400)

    const productLine = await createNoPoReceipt(adminToken, {
      store: store.id,
      status: 'completed',
      items: [
        {
          product: product.id,
          qtyReceived: 1,
          costPrice: 5000
        }
      ]
    })
    expect(productLine.status).toBe(400)
    expect(Number((await db.product.findByPk(product.id)).stock)).toBe(0)
  })
})
