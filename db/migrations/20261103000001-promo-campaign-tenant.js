'use strict'

// PGA-03 / ADR-02 (WAVE-0-DECISIONS, product owner 2026-11-03): a promo
// campaign belongs to the tenant that made it. `store: null` ("all outlets")
// means every outlet of THAT tenant, never every merchant on the platform.
//
// up adds promo_campaign."tenantId" (FK tenant, nullable) plus an index, then
// fills it for rows that have none yet:
//   1. from the campaign's own outlets, when they all belong to one tenant;
//   2. otherwise, for a campaign with no outlet, from its creator's outlet.
// A row that resolves to no tenant, or to several, stays NULL. The code
// treats a NULL campaign as tenant-less: it never applies to, and is never
// listed for, an outlet that belongs to a tenant (fail closed). The column
// stays nullable on purpose: stores without a tenant (pre-tenant
// deployments) still create campaigns, and an unresolvable legacy row must
// not block the batch.
//
// Replays safely (add-if-missing, fills NULLs only). down drops the index and
// the column; the values can be derived again by up.

const TABLE = 'promo_campaign'
const COLUMN = 'tenantId'
const INDEX = 'promo_campaign_tenant_id'

// Every outlet id a campaign row names, whatever JSONB shape `store` holds:
// a bare number (what the create endpoint writes), a numeric string, or an
// array of either.
const STORE_IDS_SQL = `
  CASE jsonb_typeof(pc.store)
    WHEN 'number' THEN ARRAY[(pc.store #>> '{}')::numeric::int]
    WHEN 'string' THEN CASE WHEN (pc.store #>> '{}') ~ '^[0-9]+$'
      THEN ARRAY[(pc.store #>> '{}')::int] ELSE ARRAY[]::int[] END
    WHEN 'array' THEN ARRAY(
      SELECT e::int FROM jsonb_array_elements_text(pc.store) AS e WHERE e ~ '^[0-9]+$'
    )
    ELSE ARRAY[]::int[]
  END`

async function hasColumn(queryInterface, transaction) {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ? AND column_name = ?`,
    { replacements: [TABLE, COLUMN], transaction }
  )
  return rows.length > 0
}

async function backfillTenant(queryInterface, transaction) {
  // 1. From the campaign's outlets — only when exactly one tenant owns them all.
  await queryInterface.sequelize.query(
    `WITH c AS (
       SELECT pc.id, ${STORE_IDS_SQL} AS stores
         FROM "${TABLE}" pc
        WHERE pc."${COLUMN}" IS NULL
     ), t AS (
       SELECT c.id,
              COUNT(DISTINCT l."tenantId") AS tenants,
              MIN(l."tenantId") AS tenant,
              COUNT(*) FILTER (WHERE l."tenantId" IS NULL) AS untenanted
         FROM c
         JOIN location l ON l.id = ANY (c.stores)
        WHERE cardinality(c.stores) > 0
        GROUP BY c.id
     )
     UPDATE "${TABLE}" pc
        SET "${COLUMN}" = t.tenant
       FROM t
      WHERE pc.id = t.id AND t.tenants = 1 AND t.untenanted = 0`,
    { transaction }
  )
  // 2. No outlet named: the creator's outlet decides.
  await queryInterface.sequelize.query(
    `UPDATE "${TABLE}" pc
        SET "${COLUMN}" = l."tenantId"
       FROM "user" u
       JOIN location l ON l.id = u.store
      WHERE pc."${COLUMN}" IS NULL
        AND u.id = pc."createdBy"
        AND l."tenantId" IS NOT NULL
        AND cardinality(${STORE_IDS_SQL}) = 0`,
    { transaction }
  )
}

async function addPromoCampaignTenant(queryInterface) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction })
    if (!(await hasColumn(queryInterface, transaction))) {
      await queryInterface.sequelize.query(
        `ALTER TABLE "${TABLE}" ADD COLUMN "${COLUMN}" INTEGER NULL
           REFERENCES "tenant"(id) ON UPDATE CASCADE ON DELETE SET NULL`,
        { transaction }
      )
    }
    await queryInterface.sequelize.query(
      `CREATE INDEX IF NOT EXISTS "${INDEX}" ON "${TABLE}" ("${COLUMN}")`,
      { transaction }
    )
    await backfillTenant(queryInterface, transaction)
  })
}

async function dropPromoCampaignTenant(queryInterface) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.sequelize.query("SET LOCAL lock_timeout = '5s'", { transaction })
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "${INDEX}"`, { transaction })
    if (!(await hasColumn(queryInterface, transaction))) return
    await queryInterface.sequelize.query(`ALTER TABLE "${TABLE}" DROP COLUMN "${COLUMN}"`, {
      transaction
    })
  })
}

module.exports = {
  STORE_IDS_SQL,
  backfillTenant,
  addPromoCampaignTenant,
  dropPromoCampaignTenant,
  async up(queryInterface) {
    await addPromoCampaignTenant(queryInterface)
  },
  async down(queryInterface) {
    await dropPromoCampaignTenant(queryInterface)
  }
}
