process.env.NODE_ENV = 'test'
process.env.VERCEL = 'true'

const request = require('supertest')
const { signSessionToken } = require('../test-helpers/authSession')
const app = require('../api/index')
const db = require('../db/models')
const { withTestTenant } = require('../test-helpers/fixtures')

const JWT_SECRET = process.env.JWT_SECRET_KEY || 'secret-key-user'

describe('MEDIUM: Unassigned Account Fail-Closed & Secondary Cookie Sweep', () => {
  let storeA = null
  let storeB = null
  let adminAToken = null
  let adminBToken = null
  let unassignedToken = null
  let superToken = null

  let category = null
  let productA = null
  let productB = null
  let orderA = null
  let orderB = null
  let poA = null
  let poB = null
  let prA = null
  let prB = null
  let taxA = null
  let taxB = null
  let bundleA = null
  let bundleB = null

  beforeAll(async () => {
    const suffix = Date.now()
    storeA = await db.location.create(await withTestTenant({ name: `MED_STORE_A_${suffix}`, status: 'active' }))
    storeB = await db.location.create(await withTestTenant({ name: `MED_STORE_B_${suffix}`, status: 'active' }))

    category = await db.category.create({ name: `MED_CAT_${suffix}`, status: 'active' })
    productA = await db.product.create({
      nameProduct: `MED_PROD_A_${suffix}`,
      category: category.id,
      price: 10000,
      status: 'active'
    })
    productB = await db.product.create({
      nameProduct: `MED_PROD_B_${suffix}`,
      category: category.id,
      price: 20000,
      status: 'active'
    })

    const userA = await db.user.create({
      id: 9821,
      userName: `med_admin_a_${suffix}`,
      roleType: 'admin',
      store: storeA.id,
      password: 'x'
    })
    const userB = await db.user.create({
      id: 9822,
      userName: `med_admin_b_${suffix}`,
      roleType: 'admin',
      store: storeB.id,
      password: 'x'
    })
    const userUnassigned = await db.user.create({
      id: 9823,
      userName: `med_unassigned_${suffix}`,
      roleType: 'admin',
      store: null,
      password: 'x'
    })
    const userSuper = await db.user.create({
      id: 9820,
      userName: `med_super_${suffix}`,
      roleType: 'super_admin',
      password: 'x'
    })

    adminAToken = await signSessionToken(
      { id: userA.id, userName: userA.userName, roleType: 'admin', store: storeA.id },
      JWT_SECRET
    )
    adminBToken = await signSessionToken(
      { id: userB.id, userName: userB.userName, roleType: 'admin', store: storeB.id },
      JWT_SECRET
    )
    unassignedToken = await signSessionToken(
      { id: userUnassigned.id, userName: userUnassigned.userName, roleType: 'admin', store: null },
      JWT_SECRET
    )
    superToken = await signSessionToken(
      { id: userSuper.id, userName: userSuper.userName, roleType: 'super_admin' },
      JWT_SECRET
    )

    // Kitchen orders fixtures
    orderA = await db.order.create({
      orderNumber: `MED-ORD-A-${suffix}`,
      store: storeA.id,
      status: 'paid',
      paymentStatus: 'paid',
      source: 'pos'
    })
    orderB = await db.order.create({
      orderNumber: `MED-ORD-B-${suffix}`,
      store: storeB.id,
      status: 'paid',
      paymentStatus: 'paid',
      source: 'pos'
    })
    await db.order_item.bulkCreate([
      { order: orderA.id, product: productA.id, quantity: 1, price: 10000, status: 'preparing' },
      { order: orderB.id, product: productB.id, quantity: 1, price: 20000, status: 'preparing' }
    ])

    // Purchase return fixtures
    poA = await db.purchase_order.create({
      store: storeA.id,
      orderNumber: `MED-PO-A-${suffix}`,
      status: 'received',
      totalAmount: 10000,
      finalAmount: 10000
    })
    poB = await db.purchase_order.create({
      store: storeB.id,
      orderNumber: `MED-PO-B-${suffix}`,
      status: 'received',
      totalAmount: 20000,
      finalAmount: 20000
    })
    prA = await db.purchase_return.create({
      purchaseOrder: poA.id,
      returnNumber: `MED-PR-A-${suffix}`,
      store: storeA.id,
      status: 'pending',
      reason: 'Defective item A'
    })
    prB = await db.purchase_return.create({
      purchaseOrder: poB.id,
      returnNumber: `MED-PR-B-${suffix}`,
      store: storeB.id,
      status: 'pending',
      reason: 'Defective item B'
    })

    // Product sales summary fixtures
    const today = new Date().toISOString().slice(0, 10)
    await db.product_sales_summary.bulkCreate([
      {
        store: storeA.id,
        product: productA.id,
        report_date: today,
        quantity_sold: 5,
        revenue: 50000,
        cost: 30000,
        profit: 20000
      },
      {
        store: storeB.id,
        product: productB.id,
        report_date: today,
        quantity_sold: 8,
        revenue: 160000,
        cost: 100000,
        profit: 60000
      }
    ])

    // Tax config fixtures
    taxA = await db.taxConfig.create({
      name: `MED_TAX_A_${suffix}`,
      rate: 10,
      type: 'ppn',
      status: 'active',
      store: storeA.id
    })
    taxB = await db.taxConfig.create({
      name: `MED_TAX_B_${suffix}`,
      rate: 15,
      type: 'ppn',
      status: 'active',
      store: storeB.id
    })

    // Product bundle fixtures
    bundleA = await db.product_bundle.create({
      name: `MED_BUNDLE_A_${suffix}`,
      sku: `BNDL-A-${suffix}`,
      store: storeA.id,
      status: 'active',
      bundlePrice: 15000
    })
    bundleB = await db.product_bundle.create({
      name: `MED_BUNDLE_B_${suffix}`,
      sku: `BNDL-B-${suffix}`,
      store: storeB.id,
      status: 'active',
      bundlePrice: 25000
    })
  })

  afterAll(async () => {
    const prodIds = [productA?.id, productB?.id].filter(Boolean)
    const storeIds = [storeA?.id, storeB?.id].filter(Boolean)
    if (prodIds.length > 0) {
      await db.bom_line.destroy({ where: { ingredientId: { [db.Sequelize.Op.ne]: null } }, force: true })
      await db.bom_header.destroy({ where: { productId: prodIds }, force: true })
      await db.product_bundle_item.destroy({ where: { product: prodIds }, force: true })
    }
    await db.product_bundle.destroy({ where: { id: [bundleA?.id, bundleB?.id].filter(Boolean) }, force: true })
    await db.taxConfig.destroy({ where: { id: [taxA?.id, taxB?.id].filter(Boolean) }, force: true })
    await db.product_sales_summary.destroy({ where: { store: storeIds }, force: true })
    await db.purchase_return.destroy({ where: { id: [prA?.id, prB?.id].filter(Boolean) }, force: true })
    await db.purchase_order.destroy({ where: { id: [poA?.id, poB?.id].filter(Boolean) }, force: true })
    await db.order_item.destroy({ where: { order: [orderA?.id, orderB?.id].filter(Boolean) }, force: true })
    await db.order.destroy({ where: { id: [orderA?.id, orderB?.id].filter(Boolean) }, force: true })
    await db.product.destroy({ where: { id: prodIds }, force: true })
    await db.category.destroy({ where: { id: category?.id }, force: true })
    await db.user.destroy({ where: { id: [9820, 9821, 9822, 9823] }, force: true })
    await db.location.destroy({ where: { id: storeIds }, force: true })
  })

  describe('1. GET /order/kitchen fail-closed & cookie immunity', () => {
    test('assigned Store A returns only Store A orders', async () => {
      const res = await request(app)
        .get('/order/kitchen')
        .set('Authorization', `Bearer ${adminAToken}`)
      expect(res.status).toBe(200)
      const nums = (res.body.data || []).map((o) => o.orderNumber)
      expect(nums).toContain(orderA.orderNumber)
      expect(nums).not.toContain(orderB.orderNumber)
    })

    test('assigned Store B returns only Store B orders', async () => {
      const res = await request(app)
        .get('/order/kitchen')
        .set('Authorization', `Bearer ${adminBToken}`)
      expect(res.status).toBe(200)
      const nums = (res.body.data || []).map((o) => o.orderNumber)
      expect(nums).toContain(orderB.orderNumber)
      expect(nums).not.toContain(orderA.orderNumber)
    })

    test('Store A with Cookie: store=Store B does not leak Store B orders', async () => {
      const res = await request(app)
        .get('/order/kitchen')
        .set('Cookie', `store=${storeB.id}`)
        .set('Authorization', `Bearer ${adminAToken}`)
      expect(res.status).toBe(200)
      const nums = (res.body.data || []).map((o) => o.orderNumber)
      expect(nums).toContain(orderA.orderNumber)
      expect(nums).not.toContain(orderB.orderNumber)
    })

    test('unassigned non-super-admin is rejected with 403 Store assignment required', async () => {
      const res = await request(app)
        .get('/order/kitchen')
        .set('Authorization', `Bearer ${unassignedToken}`)
      expect(res.status).toBe(403)
      expect(res.body.message).toMatch(/store assignment required/i)
    })

    test('super_admin sees both stores', async () => {
      const res = await request(app)
        .get('/order/kitchen')
        .set('Authorization', `Bearer ${superToken}`)
      expect(res.status).toBe(200)
      const nums = (res.body.data || []).map((o) => o.orderNumber)
      expect(nums).toContain(orderA.orderNumber)
      expect(nums).toContain(orderB.orderNumber)
    })
  })

  describe('2. GET /purchase-return/get-all fail-closed & cookie immunity', () => {
    test('assigned Store A returns only Store A purchase returns', async () => {
      const res = await request(app)
        .get('/purchase-return/get-all')
        .set('Authorization', `Bearer ${adminAToken}`)
      expect(res.status).toBe(200)
      const nums = (res.body.data || []).map((r) => r.returnNumber)
      expect(nums).toContain(prA.returnNumber)
      expect(nums).not.toContain(prB.returnNumber)
    })

    test('assigned Store B returns only Store B purchase returns', async () => {
      const res = await request(app)
        .get('/purchase-return/get-all')
        .set('Authorization', `Bearer ${adminBToken}`)
      expect(res.status).toBe(200)
      const nums = (res.body.data || []).map((r) => r.returnNumber)
      expect(nums).toContain(prB.returnNumber)
      expect(nums).not.toContain(prA.returnNumber)
    })

    test('Store A with Cookie: store=Store B does not leak Store B returns', async () => {
      const res = await request(app)
        .get('/purchase-return/get-all')
        .set('Cookie', `store=${storeB.id}`)
        .set('Authorization', `Bearer ${adminAToken}`)
      expect(res.status).toBe(200)
      const nums = (res.body.data || []).map((r) => r.returnNumber)
      expect(nums).toContain(prA.returnNumber)
      expect(nums).not.toContain(prB.returnNumber)
    })

    test('unassigned non-super-admin is rejected with 403 Store assignment required', async () => {
      const res = await request(app)
        .get('/purchase-return/get-all')
        .set('Authorization', `Bearer ${unassignedToken}`)
      expect(res.status).toBe(403)
      expect(res.body.message).toMatch(/store assignment required/i)
    })
  })

  describe('3. GET /reports/product-sales fail-closed & cookie immunity', () => {
    test('assigned Store A returns only Store A product sales', async () => {
      const res = await request(app)
        .get('/reports/product-sales')
        .set('Authorization', `Bearer ${adminAToken}`)
      expect(res.status).toBe(200)
      const rows = res.body.data || []
      const names = rows.map((r) => r.productData?.nameProduct)
      expect(names).toContain(productA.nameProduct)
      expect(names).not.toContain(productB.nameProduct)
    })

    test('assigned Store B returns only Store B product sales', async () => {
      const res = await request(app)
        .get('/reports/product-sales')
        .set('Authorization', `Bearer ${adminBToken}`)
      expect(res.status).toBe(200)
      const rows = res.body.data || []
      const names = rows.map((r) => r.productData?.nameProduct)
      expect(names).toContain(productB.nameProduct)
      expect(names).not.toContain(productA.nameProduct)
    })

    test('Store A with Cookie: store=Store B does not leak Store B product sales', async () => {
      const res = await request(app)
        .get('/reports/product-sales')
        .set('Cookie', `store=${storeB.id}`)
        .set('Authorization', `Bearer ${adminAToken}`)
      expect(res.status).toBe(200)
      const rows = res.body.data || []
      const names = rows.map((r) => r.productData?.nameProduct)
      expect(names).toContain(productA.nameProduct)
      expect(names).not.toContain(productB.nameProduct)
    })

    test('unassigned non-super-admin is rejected with 403 Store assignment required', async () => {
      const res = await request(app)
        .get('/reports/product-sales')
        .set('Authorization', `Bearer ${unassignedToken}`)
      expect(res.status).toBe(403)
      expect(res.body.message).toMatch(/store assignment required/i)
    })
  })

  describe('4. Secondary Cookie Sweep: taxConfig, productBundle, bom', () => {
    test('taxConfig.getAll: Store A with Cookie: store=Store B does not return Store B taxes', async () => {
      const res = await request(app)
        .get('/tax-config')
        .set('Cookie', `store=${storeB.id}`)
        .set('Authorization', `Bearer ${adminAToken}`)
      expect(res.status).toBe(200)
      const names = (res.body.data || []).map((t) => t.name)
      expect(names).toContain(taxA.name)
      expect(names).not.toContain(taxB.name)
    })

    test('taxConfig.getById: Store A cannot fetch Store B tax config using Cookie: store=Store B', async () => {
      const res = await request(app)
        .get(`/tax-config/get-tax-config/${taxB.id}`)
        .set('Cookie', `store=${storeB.id}`)
        .set('Authorization', `Bearer ${adminAToken}`)
      expect(res.status).toBe(404)
    })

    test('taxConfig.create: Store A creating tax config with Cookie: store=Store B binds to Store A', async () => {
      const res = await request(app)
        .post('/tax-config/add-new-tax-config')
        .set('Cookie', `store=${storeB.id}`)
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({
          name: `NEW_TAX_SEC_${Date.now()}`,
          rate: 7,
          type: 'ppn',
          status: 'active'
        })
      expect(res.status).toBe(201)
      expect(res.body.data.store).toBe(storeA.id)
      await db.taxConfig.destroy({ where: { id: res.body.data.id }, force: true })
    })

    test('productBundle.getAll: Store A with Cookie: store=Store B does not return Store B bundles', async () => {
      const res = await request(app)
        .get('/product-bundle/get-all')
        .set('Cookie', `store=${storeB.id}`)
        .set('Authorization', `Bearer ${adminAToken}`)
      expect(res.status).toBe(200)
      const items = res.body.data?.items || []
      const names = items.map((b) => b.name)
      expect(names).toContain(bundleA.name)
      expect(names).not.toContain(bundleB.name)
    })

    test('productBundle.create: Store A creating bundle with Cookie: store=Store B binds to Store A', async () => {
      const res = await request(app)
        .post('/product-bundle/create')
        .set('Cookie', `store=${storeB.id}`)
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({
          name: `NEW_BUNDLE_${Date.now()}`,
          bundlePrice: 12000,
          items: [{ product: productA.id, quantity: 1, unitPrice: 10000 }]
        })
      expect(res.status).toBe(201)
      expect(res.body.data.store).toBe(storeA.id)
      await db.product_bundle_item.destroy({ where: { bundleId: res.body.data.id }, force: true });
      await db.product_bundle.destroy({ where: { id: res.body.data.id }, force: true })
    })

    test('bom.create: Store A creating BOM with Cookie: store=Store B binds to Store A', async () => {
      const ing = await db.ingredient.create({
        name: `BOM_ING_${Date.now()}`,
        unit: 'pcs',
        cost: 500,
        stock: 100,
        store: storeA.id
      })
      const res = await request(app)
        .post('/bom/add')
        .set('Cookie', `store=${storeB.id}`)
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({
          productId: productA.id,
          name: `BOM_${Date.now()}`,
          lines: [{ ingredientId: ing.id, qty: 1, unit: 'pcs' }]
        })
      expect(res.status).toBe(201)
      const createdHeader = await db.bom_header.findOne({ where: { productId: productA.id } })
      expect(createdHeader).not.toBeNull()
      expect(createdHeader.store).toBe(storeA.id)
      await db.bom_line.destroy({ where: { bomHeaderId: createdHeader.id }, force: true })
      await db.bom_header.destroy({ where: { id: createdHeader.id }, force: true })
      await db.ingredient.destroy({ where: { id: ing.id }, force: true })
    })
  })
})
