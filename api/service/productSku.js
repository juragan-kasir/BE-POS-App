const { Op } = require('sequelize')
const db = require('../../db/models')

// Product SKU: typed by the user, or PRD-xxxxx when left empty.
// createProductSchema had no `sku`, so zod stripped it and every product got
// the generated code, whatever the retail form said. The SKU is unique per
// tenant (uq_product_tenant_sku) or among tenant-less products
// (uq_product_tenantless_sku); both indexes include soft-deleted rows.

const SKU_TAKEN = 'SKU_TAKEN'
const SKU_INDEXES = ['uq_product_tenant_sku', 'uq_product_tenantless_sku', 'product_sku_key']

const normalizeSku = (value) => {
  if (value === undefined) return undefined
  const sku = typeof value === 'string' ? value.trim() : ''
  return sku || null
}

class SkuTakenError extends Error {
  constructor(sku, deleted) {
    super(
      deleted
        ? `SKU "${sku}" masih dipakai produk yang sudah dihapus`
        : `SKU "${sku}" sudah dipakai produk lain`
    )
    this.code = SKU_TAKEN
    this.statusCode = 409
    this.sku = sku
  }
}

const skuTakenBody = (error) => ({
  success: false,
  code: SKU_TAKEN,
  field: 'sku',
  message: error.message
})

/** The product (deleted ones included) already holding this SKU in the tenant. */
const findSkuOwner = (sku, tenantId, { excludeId, transaction } = {}) =>
  db.product.findOne({
    where: {
      sku,
      tenantId: tenantId ?? null,
      ...(excludeId ? { id: { [Op.ne]: excludeId } } : {})
    },
    attributes: ['id', 'deletedAt'],
    paranoid: false,
    transaction
  })

const assertSkuFree = async (sku, tenantId, options) => {
  const owner = await findSkuOwner(sku, tenantId, options)
  if (owner) throw new SkuTakenError(sku, Boolean(owner.deletedAt))
}

/** PRD-00042, or PRD-00042-2 … when someone typed that code by hand. */
const generateSku = async (productId, tenantId, transaction) => {
  const base = `PRD-${String(productId).padStart(5, '0')}`
  for (let n = 1; n < 50; n += 1) {
    const candidate = n === 1 ? base : `${base}-${n}`
    if (!(await findSkuOwner(candidate, tenantId, { excludeId: productId, transaction }))) return candidate
  }
  return `${base}-${Date.now().toString(36)}`
}

/** A unique-index race on sku (two saves of the same code at once). */
const isSkuUniqueViolation = (error) =>
  error?.name === 'SequelizeUniqueConstraintError' &&
  (Object.keys(error.fields || {}).includes('sku') ||
    SKU_INDEXES.includes(error.parent?.constraint || error.original?.constraint))

module.exports = {
  SKU_TAKEN,
  SkuTakenError,
  skuTakenBody,
  normalizeSku,
  assertSkuFree,
  generateSku,
  isSkuUniqueViolation
}
