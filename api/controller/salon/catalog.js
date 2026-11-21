'use strict'

const { Op } = require('sequelize')
const db = require('../../../db/models')
const { salonRoute, withStatus } = require('./http')
const { SalonError } = require('../../service/salonContext')
const { generateSku } = require('../../service/productSku')
const { setProductStock } = require('../../service/stockMutationService')
const { ServiceInput, RetailProductInput } = require('../../validation/salonSchemas')
const {
  SALON_SERVICE,
  SALON_RETAIL,
  idParam,
  notFound,
  iEquals,
  tenantStoreIds,
  optionalStore,
  categoryFor
} = require('./shared')

// Salon catalog (SALON-BA §5): services and retail products are `product`
// rows of the salon tenant, so checkout (S2) reuses the POS order helpers.
//
//   service: tipeProduk 'salon_service', inventoryMode 'make_to_order' (a
//            service holds no stock), serviceConfig = { durationMin,
//            bufferMin, levelPrices, commission } (BR-SLN-005, DR-SLN-09).
//   retail : tipeProduk 'salon_retail', stocked per outlet
//            (product_store_stock, DR-14), serviceConfig = { commission }.
//
// Both are linked to every outlet of the tenant (product_store), and
// POST /salon/stores links them to a new outlet.

const RETAIL_CATEGORY = 'Produk'
// Appointment item statuses that still need the service (mock handler rule).
const UPCOMING_ITEM_STATUSES = ['booked', 'confirmed']

const serializeService = (p) => ({
  id: String(p.id),
  name: p.nameProduct,
  category: p.categoryData?.name || '',
  basePrice: Number(p.price) || 0,
  tipeProduk: 'service',
  serviceConfig: p.serviceConfig,
  active: p.status === 'active'
})

const serializeRetail = (p, stock) => ({
  id: String(p.id),
  name: p.nameProduct,
  price: Number(p.price) || 0,
  stock: Math.trunc(Number(stock) || 0),
  commission: p.serviceConfig?.commission || { type: 'percent', value: 0 },
  active: p.status === 'active'
})

const findProduct = async (salon, id, tipeProduk, message, transaction) => {
  const product = await db.product.findOne({
    where: { id: idParam(id, message), tenantId: salon.tenant.id, tipeProduk },
    // No include: FOR UPDATE cannot lock the nullable side of an outer join.
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined
  })
  if (!product) throw notFound(message)
  return product
}

const assertNameFree = async (salon, tipeProduk, name, excludeId, message, transaction) => {
  const clash = await db.product.findOne({
    where: {
      tenantId: salon.tenant.id,
      tipeProduk,
      ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}),
      [Op.and]: [iEquals('nameProduct', name)]
    },
    attributes: ['id'],
    transaction
  })
  if (clash) throw new SalonError('DUPLICATE', message, 409, { field: 'name' })
}

/** Insert the product, give it a SKU and link it to every tenant outlet. */
const insertProduct = async (salon, user, values, transaction) => {
  const product = await db.product.create(
    { ...values, tenantId: salon.tenant.id, createdBy: user.id },
    { transaction }
  )
  product.sku = await generateSku(product.id, salon.tenant.id, transaction)
  await product.save({ transaction })
  const storeIds = await tenantStoreIds(salon.tenant.id, transaction)
  if (storeIds.length) {
    await db.product_store.bulkCreate(
      storeIds.map((store) => ({ product: product.id, store, createdBy: user.id })),
      { transaction }
    )
  }
  return product
}

// ---------- services ----------

exports.listServices = salonRoute({ perm: ['catalog.read', 'appointment.read'] }, async ({ salon }) => {
  const rows = await db.product.findAll({
    where: { tenantId: salon.tenant.id, tipeProduk: SALON_SERVICE },
    include: [{ model: db.category, as: 'categoryData', attributes: ['id', 'name'] }],
    order: [['nameProduct', 'ASC']]
  })
  return { data: rows.map(serializeService) }
})

exports.createService = salonRoute({ perm: 'catalog.manage' }, async ({ salon, user, body }) => {
  const input = ServiceInput.parse(body)
  const product = await db.sequelize.transaction(async (t) => {
    await assertNameFree(salon, SALON_SERVICE, input.name, null, 'Nama layanan sudah ada', t)
    const category = await categoryFor(salon.tenant.id, input.category, user.id, t)
    const created = await insertProduct(
      salon,
      user,
      {
        nameProduct: input.name,
        category: category.id,
        price: input.basePrice,
        tipeProduk: SALON_SERVICE,
        inventoryMode: 'make_to_order',
        serviceConfig: input.serviceConfig,
        status: input.active ? 'active' : 'inactive',
        unit: 'layanan'
      },
      t
    )
    created.categoryData = category
    return created
  })
  return withStatus(201, serializeService(product))
})

exports.updateService = salonRoute({ perm: 'catalog.manage' }, async ({ salon, user, body, params }) => {
  const input = ServiceInput.parse(body)
  const product = await db.sequelize.transaction(async (t) => {
    const row = await findProduct(salon, params.id, SALON_SERVICE, 'Layanan tidak ditemukan', t)
    await assertNameFree(salon, SALON_SERVICE, input.name, row.id, 'Nama layanan sudah ada', t)
    if (!input.active && row.status === 'active') {
      const upcoming = await db.salon_appointment_item.count({
        where: { tenantId: salon.tenant.id, productId: row.id, status: UPCOMING_ITEM_STATUSES },
        transaction: t
      })
      if (upcoming > 0) {
        throw new SalonError('IN_USE', 'Masih ada booking aktif yang memakai layanan ini', 409, { bookings: upcoming })
      }
    }
    const category = await categoryFor(salon.tenant.id, input.category, user.id, t)
    await row.update(
      {
        nameProduct: input.name,
        category: category.id,
        price: input.basePrice,
        serviceConfig: input.serviceConfig,
        status: input.active ? 'active' : 'inactive',
        modifiedBy: user.id
      },
      { transaction: t }
    )
    row.categoryData = category
    return row
  })
  return serializeService(product)
})

// ---------- retail products ----------

/**
 * Stock of each product: the outlet's row when one outlet is addressed,
 * else the sum over the actor's outlets.
 */
const stockByProduct = async (salon, store, productIds, transaction) => {
  if (!productIds.length) return new Map()
  const storeIds = store ? [store.id] : salon.stores.map((s) => s.id)
  if (!storeIds.length) return new Map()
  const rows = await db.product_store_stock.findAll({
    where: { product: productIds, store: storeIds },
    attributes: ['product', [db.sequelize.fn('SUM', db.sequelize.col('stock')), 'total']],
    group: ['product'],
    raw: true,
    transaction
  })
  return new Map(rows.map((r) => [Number(r.product), Number(r.total) || 0]))
}

const writeStock = async ({ salon, store, user, product, target, transaction }) => {
  const current = (await stockByProduct(salon, store, [product.id], transaction)).get(product.id) || 0
  if (current === target) return
  if (!store) {
    throw new SalonError('VALIDATION_FAILED', 'Pilih outlet untuk mengubah stok', 400, { field: 'stock' })
  }
  await setProductStock({
    productId: product.id,
    store: store.id,
    newQty: target,
    referenceType: 'adjustment',
    referenceId: product.id,
    notes: 'Stok produk salon diubah dari katalog',
    createdBy: user.id,
    transaction
  })
}

exports.listProducts = salonRoute({ perm: ['catalog.read', 'pos.sell'] }, async ({ salon, query }) => {
  const store = optionalStore(salon, query.store)
  const rows = await db.product.findAll({
    where: { tenantId: salon.tenant.id, tipeProduk: SALON_RETAIL },
    order: [['nameProduct', 'ASC']]
  })
  const stock = await stockByProduct(salon, store, rows.map((r) => r.id))
  return { data: rows.map((r) => serializeRetail(r, stock.get(r.id))) }
})

exports.createProduct = salonRoute({ perm: 'catalog.manage' }, async ({ salon, user, body, query }) => {
  const input = RetailProductInput.parse(body)
  const store = optionalStore(salon, query.store ?? body.store)
  if (input.stock > 0 && !store) {
    throw new SalonError('VALIDATION_FAILED', 'Pilih outlet untuk mengisi stok awal', 400, { field: 'stock' })
  }
  const product = await db.sequelize.transaction(async (t) => {
    await assertNameFree(salon, SALON_RETAIL, input.name, null, 'Nama produk sudah ada', t)
    const category = await categoryFor(salon.tenant.id, RETAIL_CATEGORY, user.id, t)
    const created = await insertProduct(
      salon,
      user,
      {
        nameProduct: input.name,
        category: category.id,
        price: input.price,
        tipeProduk: SALON_RETAIL,
        inventoryMode: 'stocked',
        serviceConfig: { commission: input.commission },
        status: input.active ? 'active' : 'inactive'
      },
      t
    )
    await writeStock({ salon, store, user, product: created, target: input.stock, transaction: t })
    return created
  })
  const stock = await stockByProduct(salon, store, [product.id])
  return withStatus(201, serializeRetail(product, stock.get(product.id)))
})

exports.updateProduct = salonRoute({ perm: 'catalog.manage' }, async ({ salon, user, body, params, query }) => {
  const input = RetailProductInput.parse(body)
  const store = optionalStore(salon, query.store ?? body.store)
  const product = await db.sequelize.transaction(async (t) => {
    const row = await findProduct(salon, params.id, SALON_RETAIL, 'Produk tidak ditemukan', t)
    await assertNameFree(salon, SALON_RETAIL, input.name, row.id, 'Nama produk sudah ada', t)
    await row.update(
      {
        nameProduct: input.name,
        price: input.price,
        serviceConfig: { ...(row.serviceConfig || {}), commission: input.commission },
        status: input.active ? 'active' : 'inactive',
        modifiedBy: user.id
      },
      { transaction: t }
    )
    await writeStock({ salon, store, user, product: row, target: input.stock, transaction: t })
    return row
  })
  const stock = await stockByProduct(salon, store, [product.id])
  return serializeRetail(product, stock.get(product.id))
})
