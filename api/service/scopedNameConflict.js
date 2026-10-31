'use strict'

const db = require('../../db/models')

const tenantKey = (tenantId) => (tenantId == null ? 'none' : `t:${tenantId}`)

const uniqueStoreIds = (storeIds) => [
  ...new Set(
    (Array.isArray(storeIds) ? storeIds : [])
      .map(Number)
      .filter((id) => Number.isInteger(id) && id > 0)
  )
]

const tenantKeysByStore = async (storeIds) => {
  if (storeIds.length === 0) return new Map()
  const rows = await db.location.findAll({
    where: { id: storeIds },
    attributes: ['id', 'tenantId'],
    paranoid: false,
    raw: true
  })
  return new Map(rows.map((r) => [Number(r.id), tenantKey(r.tenantId)]))
}

const findScopedNameConflict = async ({
  model,
  nameField,
  name,
  linkModel,
  linkField,
  storeIds,
  excludeId
}) => {
  if (!name) return null
  const where = { [nameField]: name }
  if (excludeId != null) where.id = { [db.Sequelize.Op.ne]: excludeId }
  const candidates = await model.findAll({ where, attributes: ['id'], raw: true })
  if (candidates.length === 0) return null

  const targetStores = uniqueStoreIds(storeIds)
  if (targetStores.length === 0 || !linkModel) return candidates[0]

  let links
  try {
    links = await linkModel.findAll({
      where: { [linkField]: candidates.map((c) => c.id) },
      attributes: [linkField, 'store'],
      raw: true
    })
  } catch {
    return candidates[0]
  }

  const linked = new Set(links.map((l) => Number(l[linkField])))
  const unassigned = candidates.find((c) => !linked.has(Number(c.id)))
  if (unassigned) return unassigned

  const targetKeys = new Set((await tenantKeysByStore(targetStores)).values())
  const linkKeys = await tenantKeysByStore(uniqueStoreIds(links.map((l) => l.store)))
  const hit = links.find((l) => targetKeys.has(linkKeys.get(Number(l.store)) ?? 'none'))
  return hit ? candidates.find((c) => Number(c.id) === Number(hit[linkField])) : null
}

module.exports = { findScopedNameConflict }
