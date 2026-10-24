/**
 * Jest globalSetup for the isolated test database.
 *
 * The migration files only contain incremental 2026+ changes, so the test DB
 * cannot be bootstrapped with `sequelize-cli db:migrate`. Instead the schema is
 * cloned from the dev DB (`pg_dump --schema-only`), then every table is
 * truncated before each run so tests always start from deterministic, empty
 * state and never touch real data.
 *
 * Phase 33 R-4 contract: after provisioning, the test database holds the
 * complete required schema BEFORE any test connects through db/models, so
 * tests never depend on the runtime afterConnect auto-patch
 * (db/models/index.js) to repair missing tables/columns/indexes. Step 3b
 * below explicitly provisions every object previously owned only by runtime
 * (R-1 tables, R-2 columns, R-3 deviceId/index) with idempotent guarded DDL,
 * and step 3c verifies the full contract from PostgreSQL catalogs, failing
 * loudly before tests start when anything is still missing. The runtime
 * auto-patch itself is intentionally left untouched (R-5 removes it later).
 */
const { spawnSync } = require('child_process')

const DB_HOST = process.env.DB_DEV_HOST || '127.0.0.1'
const DB_PORT = process.env.DB_DEV_PORT || '5432'
const DB_USER = process.env.DB_DEV_USERNAME || 'postgres'
const DB_PASS = process.env.DB_DEV_PASSWORD
const SRC_DB = process.env.DB_DEV_DATABASE || 'cashier_app'
const TEST_DB = process.env.DB_TEST_DATABASE || 'cashier_app_test'

// D-05: the four product-grade member uniqueness indexes (migration
// 20261012000001) and the obsolete historical constraints they replace
// (20260620000004 raw global uniques; 20260913000001 C13 composite).
const D05_MEMBER_INDEXES = [
  'uq_member_store_name_ci',
  'uq_member_global_name_ci',
  'uq_member_phone_e164',
  'uq_member_email_ci'
]
const D05_OBSOLETE_MEMBER_CONSTRAINTS = [
  'uq_member_name',
  'uq_member_phoneNumber',
  'uq_member_email',
  'uq_member_store_name'
]

const run = (cmd, args, opts = {}) => {
  const res = spawnSync(cmd, args, {
    env: { ...process.env, PGPASSWORD: DB_PASS },
    encoding: 'utf8',
    ...opts
  })
  if (res.status !== 0) {
    throw new Error(`${cmd} failed: ${res.stderr || res.stdout}`)
  }
  return res.stdout
}

module.exports = async () => {
  // 1. Create the test database if it does not exist yet.
  const exists =
    run('psql', [
      '-h',
      DB_HOST,
      '-p',
      DB_PORT,
      '-U',
      DB_USER,
      '-d',
      'postgres',
      '-t',
      '-A',
      '-c',
      `SELECT 1 FROM pg_database WHERE datname = '${TEST_DB}'`
    ]).trim() === '1'

  if (!exists) {
    run('createdb', ['-h', DB_HOST, '-p', DB_PORT, '-U', DB_USER, TEST_DB])
  }

  // FG-SEC-05: the auditLog trigger is a production guard. Test fixtures
  // still need to clean audit rows from the isolated database, so the test
  // database — and only the test database — opts into the maintenance GUC.
  // The trigger test overrides it with SET LOCAL ... = 'off' inside a
  // transaction to prove the production path still denies raw mutations.
  run('psql', [
    '-h', DB_HOST, '-p', DB_PORT, '-U', DB_USER, '-d', 'postgres',
    '-c', `ALTER DATABASE "${TEST_DB}" SET app.audit_maintenance = 'on'`
  ])

  // 2. Clone the schema from the dev DB on first use.
  const tableCount = run('psql', [
    '-h',
    DB_HOST,
    '-p',
    DB_PORT,
    '-U',
    DB_USER,
    '-d',
    TEST_DB,
    '-t',
    '-A',
    '-c',
    "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
  ]).trim()

  if (parseInt(tableCount, 10) === 0) {
    const dump = run('pg_dump', [
      '-h',
      DB_HOST,
      '-p',
      DB_PORT,
      '-U',
      DB_USER,
      '-d',
      SRC_DB,
      '--schema-only',
      '--no-owner',
      '--no-privileges'
    ])
    run('psql', ['-h', DB_HOST, '-p', DB_PORT, '-U', DB_USER, '-d', TEST_DB], {
      input: dump
    })
  }

  // 3. D-05 product-grade member identity objects. CI clones the dev DB from
  // a committed dev-schema.sql snapshot; the explicit SQL below idempotently
  // guarantees the four D-05 target objects regardless of snapshot age.
  // Obsolete predecessors (global uq_member_name/phoneNumber/email from
  // 20260620000004; composite uq_member_store_name and partial
  // uq_member_global_name from C13/20260913000001) are removed if present so
  // the test DB never enforces stale raw/global semantics alongside the new
  // canonical objects. All statements are guarded so re-runs are safe, and
  // none of them swallows errors: a D-05 object that cannot be provisioned
  // fails setup loudly (step 3c re-verifies the result from the catalogs).
  // Leftover member rows from a previous run are cleared first (step 4
  // truncates every table anyway) so stale fixtures can never block the
  // unique index builds.
  run('psql', [
    '-h', DB_HOST, '-p', DB_PORT, '-U', DB_USER, '-d', TEST_DB,
    '-c', 'TRUNCATE TABLE "member" CASCADE'
  ])
  for (const obsolete of D05_OBSOLETE_MEMBER_CONSTRAINTS) {
    run('psql', [
      '-h', DB_HOST, '-p', DB_PORT, '-U', DB_USER, '-d', TEST_DB,
      '-c', `DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${obsolete}' AND conrelid = 'public.member'::regclass) THEN
          ALTER TABLE "member" DROP CONSTRAINT "${obsolete}";
        END IF;
      END $$;`
    ])
  }
  run('psql', [
    '-h', DB_HOST, '-p', DB_PORT, '-U', DB_USER, '-d', TEST_DB,
    '-c', `DROP INDEX IF EXISTS uq_member_global_name`
  ])
  for (const ddl of [
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_member_store_name_ci ON "member" (store, (LOWER(TRIM(name)))) WHERE store IS NOT NULL AND "deletedAt" IS NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_member_global_name_ci ON "member" ((LOWER(TRIM(name)))) WHERE store IS NULL AND "deletedAt" IS NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_member_phone_e164 ON "member" ("phoneNumber") WHERE "deletedAt" IS NULL AND "phoneNumber" NOT LIKE 'GUEST-%'`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_member_email_ci ON "member" ((LOWER(TRIM(email)))) WHERE "deletedAt" IS NULL AND email IS NOT NULL`
  ]) {
    run('psql', [
      '-h', DB_HOST, '-p', DB_PORT, '-U', DB_USER, '-d', TEST_DB,
      '-c', ddl
    ])
  }

  // 3b. Phase 33 R-4: explicitly provision every schema object previously
  // owned only by the runtime afterConnect auto-patch (db/models/index.js),
  // so tests never depend on runtime schema repair. All statements are
  // guarded (IF NOT EXISTS) and therefore safe to re-run; pre-existing
  // objects and their data are never touched. Column/table definitions match
  // the R-1/R-2 migrations, the current models, and scripts/dev-schema.sql.
  // NOTE: CREATE TABLE shells intentionally carry no FK constraints, matching
  // the R-1 migration contract (FKs exist on snapshot-derived databases via
  // the snapshot itself; a migrated-only database likewise has none).
  const psqlTest = (sql) =>
    run('psql', ['-h', DB_HOST, '-p', DB_PORT, '-U', DB_USER, '-d', TEST_DB, '-c', sql])

  const R4_TABLE_DDL = [
    `CREATE TABLE IF NOT EXISTS attendance (
      id SERIAL PRIMARY KEY,
      "userId" integer NOT NULL,
      store integer,
      "shiftId" integer,
      type character varying(20) DEFAULT 'check-in',
      "absenAt" timestamp with time zone,
      latitude double precision,
      longitude double precision,
      accuracy double precision,
      algorithm character varying(20) DEFAULT 'gps',
      status character varying(20) DEFAULT 'valid',
      note character varying(255),
      "createdBy" integer,
      "modifiedBy" integer,
      "createdAt" timestamp with time zone NOT NULL,
      "updatedAt" timestamp with time zone NOT NULL,
      "deletedAt" timestamp with time zone
    )`,
    `CREATE TABLE IF NOT EXISTS overtime (
      id SERIAL PRIMARY KEY,
      store integer,
      shift_id integer NOT NULL,
      employee_id integer NOT NULL,
      date date NOT NULL,
      start_time time without time zone NOT NULL,
      end_time time without time zone NOT NULL,
      duration_hours numeric(10,2) DEFAULT 0 NOT NULL,
      note text,
      status character varying(20) DEFAULT 'pending',
      "decidedBy" integer,
      "decidedAt" timestamp with time zone,
      status_history jsonb DEFAULT '[]'::jsonb,
      accounting_status character varying(20) DEFAULT 'unposted',
      "postedAt" timestamp with time zone,
      "journalId" integer,
      "createdBy" integer,
      "modifiedBy" integer,
      "createdAt" timestamp with time zone NOT NULL,
      "updatedAt" timestamp with time zone NOT NULL,
      "deletedAt" timestamp with time zone
    )`,
    // AUTH-1 (DR-01/DR-02/DR-12 foundation, migration 20261008000001): the
    // tenant/membership/assignment tables plus location.tenantId. The
    // committed dev-schema.sql snapshot predates that migration, so a fresh
    // CI clone is missing them. Same precedent as the shells above:
    // provision idempotently here (no FKs on shells, per the R-1 contract
    // note) and enroll in the catalog contract below. Column/types mirror
    // the migration exactly.
    `CREATE TABLE IF NOT EXISTS tenant (
      id SERIAL PRIMARY KEY,
      code character varying(50) NOT NULL UNIQUE,
      name character varying(100) NOT NULL,
      status character varying(20) NOT NULL DEFAULT 'active',
      "createdAt" timestamp with time zone NOT NULL,
      "updatedAt" timestamp with time zone NOT NULL,
      "deletedAt" timestamp with time zone
    )`,
    `CREATE TABLE IF NOT EXISTS tenant_membership (
      id SERIAL PRIMARY KEY,
      "userId" integer NOT NULL,
      "tenantId" integer NOT NULL,
      role character varying(30) NOT NULL,
      status character varying(20) NOT NULL DEFAULT 'ACTIVE',
      "createdAt" timestamp with time zone NOT NULL,
      "updatedAt" timestamp with time zone NOT NULL,
      "deletedAt" timestamp with time zone
    )`,
    `CREATE TABLE IF NOT EXISTS store_assignment (
      id SERIAL PRIMARY KEY,
      "userId" integer NOT NULL,
      "tenantId" integer NOT NULL,
      "storeId" integer NOT NULL,
      "createdAt" timestamp with time zone NOT NULL,
      "updatedAt" timestamp with time zone NOT NULL
    )`,
    // F5 (migration 20261009000001): server-side authorization context
    // sessions. Same R-4 precedent as the AUTH-1 shells above.
    `CREATE TABLE IF NOT EXISTS authorization_context_session (
      id SERIAL PRIMARY KEY,
      "sessionId" character varying(64) NOT NULL UNIQUE,
      "userId" integer NOT NULL,
      "activeTenantId" integer,
      "activeStoreId" integer,
      version integer NOT NULL DEFAULT 1,
      "expiresAt" timestamp with time zone NOT NULL,
      "revokedAt" timestamp with time zone,
      "createdAt" timestamp with time zone NOT NULL,
      "updatedAt" timestamp with time zone NOT NULL
    )`
  ]

  // [table, column, definition] — R-2 runtime-only columns (12) plus the R-3
  // deviceId column so stale dev clones converge without runtime repair.
  // Monetary types follow the current model/BIGINT contract, not the stale
  // runtime INTEGER patch (see 20261003000003 header).
  const R4_COLUMNS = [
    ['purchase_order', 'additionalCost', 'BIGINT DEFAULT 0'],
    ['purchase_order', 'overDeliveryTolerance', 'INTEGER DEFAULT 10'],
    ['purchase_order_item', 'conversionToBase', 'DECIMAL(10,4) DEFAULT 1'],
    ['goods_receipt_item', 'costPrice', 'BIGINT DEFAULT 0'],
    ['goods_receipt_item', 'landedCost', 'BIGINT DEFAULT 0'],
    ['goods_receipt_item', 'conversionToBase', 'DECIMAL(10,4) DEFAULT 1'],
    ['goods_receipt_item', 'qtyStock', 'DECIMAL(12,2) DEFAULT 0'],
    ['transaction', 'salesReturnId', 'INTEGER'],
    ['shift_swap', 'status_history', `JSONB DEFAULT '[]'::jsonb`],
    ['shift_swap', 'expires_at', 'TIMESTAMP'],
    ['user', 'overtimeRate', 'DECIMAL(15,2) DEFAULT 0'],
    ['user', 'overtimeFactor', 'DECIMAL(10,2) DEFAULT 1.5'],
    ['product_review', 'deviceId', 'VARCHAR(64)'],
    // goods_receipt.idempotencyKey is migration-owned (20261001000003) but the
    // committed dev-schema.sql snapshot predates that migration for this table,
    // so a fresh CI clone is missing it. Following the member-uniqueness
    // precedent (step 3 above, now the D-05 indexes), provision it idempotently here and
    // include it in the catalog contract so the post-R-5 test DB stays
    // self-sufficient without the retired runtime auto-patch.
    ['goods_receipt', 'idempotencyKey', 'VARCHAR(255)'],
    // Phase 39 Batch 1: stock_transfer.idempotencyKey is migration-owned
    // (20261006000001) but the committed dev-schema.sql snapshot predates
    // that migration, so a fresh CI clone is missing it. Same precedent as
    // goods_receipt.idempotencyKey above: provision idempotently here and
    // enroll in the catalog contract below.
    ['stock_transfer', 'idempotencyKey', 'VARCHAR(255)'],
    // AUD-1 (DR-20 audit foundation, migration 20261007000001): the committed
    // dev-schema.sql auditLog snapshot predates that migration, so a fresh CI
    // clone is missing the foundation columns just as it was missing
    // goods_receipt.idempotencyKey above. Same precedent: provision them
    // idempotently here and enroll in the catalog contract below so the
    // post-R-5 test DB stays self-sufficient without relying on the retired
    // runtime auto-patch. Column/types mirror the migration exactly and are
    // no-ops on any DB that already ran it.
    ['auditLog', 'actorType', "VARCHAR(20) NOT NULL DEFAULT 'USER'"],
    ['auditLog', 'tenantId', 'INTEGER'],
    ['auditLog', 'result', "VARCHAR(20) NOT NULL DEFAULT 'SUCCESS'"],
    ['auditLog', 'requestId', 'VARCHAR(64)'],
    ['auditLog', 'reason', 'TEXT'],
    ['auditLog', 'source', 'VARCHAR(30)'],
    ['auditLog', 'metadata', 'JSONB'],
    // AUTH-1 (migration 20261008000001): location.tenantId ownership slot.
    // Nullable first stage — same no-op-on-migrated-DB property as above.
    ['location', 'tenantId', 'INTEGER'],
    // P1-3 (migration 20261010000001): user.disabledAt account-disablement
    // state, separate from presence `status`. Same precedent as above:
    // provision idempotently here so fresh CI clones converge, no-op when
    // the migration already ran. NULL default = enabled for all rows.
    ['user', 'disabledAt', 'TIMESTAMP'],
    // T-03B (migration 20261011000001): tenant_membership.reactivatedAt
    // reactivation freshness marker. Same precedent: idempotent here, no-op
    // when the migration already ran. NULL = no freshness constraint.
    ['tenant_membership', 'reactivatedAt', 'TIMESTAMP WITH TIME ZONE'],
    // P1-3 (migrations 20261013000001/20261013000004): transaction
    // attribution columns + cash_register close-snapshot columns. Same
    // precedent as above: provision idempotently here so fresh CI clones
    // converge (Sequelize selects all model attributes, so a missing column
    // breaks every read of the table), no-op when the migration ran.
    // All NULL-able by contract — legacy rows stay NULL, never backfilled.
    ['transaction', 'cashRegisterId', 'INTEGER'],
    ['transaction', 'splitBillId', 'INTEGER'],
    ['cash_register', 'expectedCash', 'INTEGER'],
    ['cash_register', 'activeCashIn', 'INTEGER'],
    ['cash_register', 'activeCashOut', 'INTEGER'],
    ['cash_register', 'cashRefundsTotal', 'INTEGER'],
    ['cash_register', 'refundsTotal', 'INTEGER'],
    ['cash_register', 'refundCount', 'INTEGER'],
    ['cash_register', 'totalTransactions', 'INTEGER'],
    ['cash_register', 'closeSnapshot', 'JSONB'],
    // P1-5 (migration 20261016210748): goods_receipt.stockPosted posting
    // flag. Same precedent as above: provision idempotently here so fresh
    // CI clones converge, no-op when the migration already ran.
    // TRUE default = pre-existing rows posted at create (old behavior).
    ['goods_receipt', 'stockPosted', 'BOOLEAN NOT NULL DEFAULT TRUE'],
  ]

  // Phase 34: stock_opname_item's quantity columns are migration-owned
  // (20261004000001) but the committed dev-schema.sql snapshot predates
  // that migration, so a fresh CI clone still has them as INTEGER — which
  // silently rounds/rejects a fractional physical count before it can
  // reach product.stock/ingredient.stock (already DECIMAL(10,4)).
  // Following the goods_receipt.idempotencyKey precedent above, provision
  // the column TYPE change idempotently here so CI converges with a
  // migrated dev database without depending on the retired runtime patch.
  const R4_TYPE_CHANGES = [
    ['stock_opname_item', 'stokAwalJumlah', 'DECIMAL(10,4)'],
    ['stock_opname_item', 'barangMasukJumlah', 'DECIMAL(10,4)'],
    ['stock_opname_item', 'barangKeluarJumlah', 'DECIMAL(10,4)'],
    ['stock_opname_item', 'stokAkhirJumlah', 'DECIMAL(10,4)'],
    ['stock_opname_item', 'stokFisikJumlah', 'DECIMAL(10,4)'],
    ['stock_opname_item', 'selisihJumlah', 'DECIMAL(10,4)'],
    ['stock_opname_item', 'systemStock', 'DECIMAL(10,4)'],
    ['stock_opname_item', 'actualStock', 'DECIMAL(10,4)'],
    ['stock_opname_item', 'adjustment', 'DECIMAL(10,4)'],
    // stock_opname.totalAdjustment (header table) sums every item's
    // selisihJumlah on every create — discovered via TDD to crash with a
    // raw Postgres error the moment a fractional (e.g. negative) selisih
    // is summed into it while it remains INTEGER.
    ['stock_opname', 'totalAdjustment', 'DECIMAL(10,4)'],
    // Phase 39 Batch 1: stock_transfer_item.qty is migration-owned
    // (20261006000001, INTEGER -> DECIMAL(10,4)) but the committed
    // dev-schema.sql snapshot still has it as INTEGER — which would
    // silently round fractional transfer quantities before they reach
    // DECIMAL stock. Same precedent as the opname columns above.
    ['stock_transfer_item', 'qty', 'DECIMAL(10,4)']
  ]

  const R4_INDEXES = [
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_product_review_device ON "product_review" ("productId", "deviceId") WHERE "deviceId" IS NOT NULL`,
    // goods_receipt.idempotencyKey's partial unique index (migration
    // 20261001000003) is likewise absent from the committed dev-schema.sql
    // snapshot. The idempotency fast-path alone cannot serialise two
    // concurrent same-key creates — without this backstop both requests
    // insert (double stock/journal), which the F-IDEM-1 concurrency tests
    // assert can never happen. Provision it here exactly as the migration
    // does so CI converges with migrated dev databases.
    `CREATE UNIQUE INDEX IF NOT EXISTS goods_receipt_po_idempotency_unique ON "goods_receipt" ("purchaseOrderId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL`,
    // Phase 39 Batch 1: transfer-send idempotency backstop
    // (migration 20261006000001). The fast-path alone cannot serialise two
    // concurrent same-key sends — without this index both insert (duplicate
    // transfer + double deduction). Provisioned here exactly as the
    // migration does so CI converges with migrated dev databases.
    `CREATE UNIQUE INDEX IF NOT EXISTS stock_transfer_fromstore_idempotency_unique ON "stock_transfer" ("fromStore", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL`,
    // AUD-1 (DR-20 audit foundation, migration 20261007000001): the
    // auditlog_tenant_createdat partial/composite index backing the
    // tenant-scoped audit-list reads. Same retired-runtime-patch precedent as
    // the two idempotency indexes above — the committed dev-schema.sql
    // snapshot predates this migration, so provision idempotently so the
    // post-R-5 test DB converges with a migrated dev database. Column
    // provisioning for this index's fields lives in R4_COLUMNS above.
    `CREATE INDEX IF NOT EXISTS auditlog_tenant_createdat ON "auditLog" ("tenantId", "createdAt")`,
    // AUTH-1 (migration 20261008000001): uniqueness + lookup indexes for the
    // membership/assignment tables, mirroring the migration exactly.
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_membership_user_tenant ON "tenant_membership" ("userId", "tenantId")`,
    `CREATE INDEX IF NOT EXISTS ix_tenant_membership_tenant ON "tenant_membership" ("tenantId")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_store_assignment_user_store ON "store_assignment" ("userId", "storeId")`,
    `CREATE INDEX IF NOT EXISTS ix_store_assignment_tenant ON "store_assignment" ("tenantId")`,
    `CREATE INDEX IF NOT EXISTS ix_location_tenant ON "location" ("tenantId")`,
    // F5 session indexes (migration 20261009000001).
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_authorization_context_session_id ON "authorization_context_session" ("sessionId")`,
    `CREATE INDEX IF NOT EXISTS ix_authorization_context_session_user ON "authorization_context_session" ("userId")`
  ]

  for (const ddl of R4_TABLE_DDL) {
    try {
      psqlTest(ddl)
    } catch {}
  }
  for (const [table, column, definition] of R4_COLUMNS) {
    try {
      psqlTest(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${column}" ${definition}`)
    } catch {}
  }
  for (const [table, column, definition] of R4_TYPE_CHANGES) {
    try {
      psqlTest(
        `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE ${definition} USING "${column}"::${definition}`
      )
    } catch {}
  }
  for (const ddl of R4_INDEXES) {
    try {
      psqlTest(ddl)
    } catch {}
  }

  // BA DR-28 decision 4 (migration 20261025000001): supplier_product.minOrderQty
  // is INTEGER. Mirror it for snapshot-built test DBs; a no-op once INTEGER.
  try {
    psqlTest(`DO $$ BEGIN
      IF (SELECT data_type FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'supplier_product'
             AND column_name = 'minOrderQty') = 'character varying' THEN
        ALTER TABLE "supplier_product" ALTER COLUMN "minOrderQty" DROP DEFAULT;
        ALTER TABLE "supplier_product" ALTER COLUMN "minOrderQty" TYPE INTEGER
          USING COALESCE(NULLIF(btrim("minOrderQty"), ''), '1')::integer;
        ALTER TABLE "supplier_product" ALTER COLUMN "minOrderQty" SET DEFAULT 1;
      END IF;
    END $$`)
  } catch {}

  // FG-SEC-05: mirror the audit DB backstop migration for fresh CI clones
  // whose dev-schema snapshot predates it. The trigger is idempotent; the
  // UPDATE is a no-op on an empty test DB and repairs stale pre-run data.
  try {
    psqlTest(`
      UPDATE "auditLog" AS a
         SET "tenantId" = NULL
       WHERE a."tenantId" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM "tenant" AS t WHERE t.id = a."tenantId");
    `)
    psqlTest(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'auditLog_tenantId_fkey'
            AND conrelid = 'public."auditLog"'::regclass
        ) THEN
          ALTER TABLE "auditLog"
            ADD CONSTRAINT "auditLog_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenant"(id)
            ON UPDATE CASCADE ON DELETE SET NULL;
        END IF;
      END $$;
    `)
    psqlTest(`
      CREATE OR REPLACE FUNCTION audit_log_immutable_guard()
      RETURNS trigger AS $$
      BEGIN
        IF current_setting('app.audit_maintenance', true) = 'on' THEN
          RETURN COALESCE(NEW, OLD);
        END IF;
        RAISE EXCEPTION 'auditLog is append-only: % is not allowed', TG_OP;
      END;
      $$ LANGUAGE plpgsql;
    `)
    psqlTest(`
      DROP TRIGGER IF EXISTS auditlog_no_mutation ON "auditLog";
      CREATE TRIGGER auditlog_no_mutation
        BEFORE UPDATE OR DELETE ON "auditLog"
        FOR EACH ROW EXECUTE FUNCTION audit_log_immutable_guard();
    `)
    psqlTest(`
      CREATE OR REPLACE FUNCTION audit_log_truncate_guard()
      RETURNS trigger AS $$
      BEGIN
        IF current_setting('app.audit_maintenance', true) = 'on' THEN
          RETURN NULL;
        END IF;
        RAISE EXCEPTION 'auditLog is append-only: TRUNCATE is not allowed';
      END;
      $$ LANGUAGE plpgsql;
    `)
    psqlTest(`
      DROP TRIGGER IF EXISTS auditlog_no_truncate ON "auditLog";
      CREATE TRIGGER auditlog_no_truncate
        BEFORE TRUNCATE ON "auditLog"
        FOR EACH STATEMENT EXECUTE FUNCTION audit_log_truncate_guard();
    `)
  } catch (error) {
    throw new Error(
      `[setup-test-db] failed to provision the auditLog DB backstop: ${error.message}`
    )
  }

  // F5 session FK convergence: test DBs whose session table was created via
  // Model.sync() (rather than the FK-less shell above) carry a
  // RESTRICT-style userId FK that blocks hard-deleting users in pre-existing
  // suites (e.g. CRIT-1 cleanup after login now mints a session row).
  // Sessions are ephemeral — converge the constraint to ON DELETE CASCADE
  // idempotently; no-ops when the shell (no FKs) or an already-converged
  // table is present.
  try {
    psqlTest(`DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'authorization_context_session_userId_fkey'
          AND conrelid = 'public.authorization_context_session'::regclass
          AND confdeltype <> 'c'
      ) THEN
        ALTER TABLE "authorization_context_session"
          DROP CONSTRAINT "authorization_context_session_userId_fkey";
        ALTER TABLE "authorization_context_session"
          ADD CONSTRAINT "authorization_context_session_userId_fkey"
          FOREIGN KEY ("userId") REFERENCES "user"(id)
          ON UPDATE CASCADE ON DELETE CASCADE;
      END IF;
    EXCEPTION WHEN OTHERS THEN NULL; END $$;`)
  } catch {}

  // 3c. Phase 33 R-4: verify the full schema contract from PostgreSQL
  // catalogs BEFORE tests run. Any gap fails loudly here instead of being
  // silently repaired by afterConnect later. This is the R-4 guarantee.
  const R4_REQUIRED_TABLES = [
    'attendance',
    'overtime',
    'purchase_order',
    'purchase_order_item',
    'goods_receipt_item',
    'transaction',
    'shift_swap',
    'user',
    'product_review',
    // AUTH-1 foundation tables (migration 20261008000001).
    'tenant',
    'tenant_membership',
    'store_assignment',
    // F5 session table (migration 20261009000001).
    'authorization_context_session'
  ]
  const missingTables = []
  for (const table of R4_REQUIRED_TABLES) {
    const out = run('psql', [
      '-h', DB_HOST, '-p', DB_PORT, '-U', DB_USER, '-d', TEST_DB,
      '-t', '-A', '-c',
      `SELECT to_regclass('public.${table}') IS NOT NULL`
    ]).trim()
    if (out !== 't') missingTables.push(table)
  }
  const missingColumns = []
  for (const [table, column] of R4_COLUMNS.map(([t, c]) => [t, c])) {
    if (missingTables.includes(table)) continue
    const out = run('psql', [
      '-h', DB_HOST, '-p', DB_PORT, '-U', DB_USER, '-d', TEST_DB,
      '-t', '-A', '-c',
      `SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}' AND column_name = '${column}'`
    ]).trim()
    if (out !== '1') missingColumns.push(`${table}.${column}`)
  }
  // R-1 table shells: every model column must exist, not just the table.
  const R4_TABLE_COLUMNS = {
    attendance: ['id', 'userId', 'store', 'shiftId', 'type', 'absenAt', 'latitude', 'longitude', 'accuracy', 'algorithm', 'status', 'note', 'createdBy', 'modifiedBy', 'createdAt', 'updatedAt', 'deletedAt'],
    overtime: ['id', 'store', 'shift_id', 'employee_id', 'date', 'start_time', 'end_time', 'duration_hours', 'note', 'status', 'decidedBy', 'decidedAt', 'status_history', 'accounting_status', 'postedAt', 'journalId', 'createdBy', 'modifiedBy', 'createdAt', 'updatedAt', 'deletedAt'],
    // AUTH-1 foundation tables: every model column must exist, mirroring the
    // migration exactly (location.tenantId is covered by R4_COLUMNS above).
    tenant: ['id', 'code', 'name', 'status', 'createdAt', 'updatedAt', 'deletedAt'],
    tenant_membership: ['id', 'userId', 'tenantId', 'role', 'status', 'createdAt', 'updatedAt', 'deletedAt', 'reactivatedAt'],
    store_assignment: ['id', 'userId', 'tenantId', 'storeId', 'createdAt', 'updatedAt'],
    authorization_context_session: ['id', 'sessionId', 'userId', 'activeTenantId', 'activeStoreId', 'version', 'expiresAt', 'revokedAt', 'createdAt', 'updatedAt']
  }
  for (const [table, cols] of Object.entries(R4_TABLE_COLUMNS)) {
    if (missingTables.includes(table)) continue
    const out = run('psql', [
      '-h', DB_HOST, '-p', DB_PORT, '-U', DB_USER, '-d', TEST_DB,
      '-t', '-A', '-c',
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}'`
    ])
    const existing = new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))
    for (const col of cols) {
      if (!existing.has(col)) missingColumns.push(`${table}.${col}`)
    }
  }
  const missingIndexes = []
  const idxCount = run('psql', [
    '-h', DB_HOST, '-p', DB_PORT, '-U', DB_USER, '-d', TEST_DB,
    '-t', '-A', '-c',
    `SELECT count(*) FROM pg_indexes WHERE indexname = 'uq_product_review_device'`
  ]).trim()
  if (idxCount !== '1') missingIndexes.push('uq_product_review_device')
  const grIdxCount = run('psql', [
    '-h', DB_HOST, '-p', DB_PORT, '-U', DB_USER, '-d', TEST_DB,
    '-t', '-A', '-c',
    `SELECT count(*) FROM pg_indexes WHERE indexname = 'goods_receipt_po_idempotency_unique'`
  ]).trim()
  if (grIdxCount !== '1') missingIndexes.push('goods_receipt_po_idempotency_unique')
  const trIdxCount = run('psql', [
    '-h', DB_HOST, '-p', DB_PORT, '-U', DB_USER, '-d', TEST_DB,
    '-t', '-A', '-c',
    `SELECT count(*) FROM pg_indexes WHERE indexname = 'stock_transfer_fromstore_idempotency_unique'`
  ]).trim()
  if (trIdxCount !== '1') missingIndexes.push('stock_transfer_fromstore_idempotency_unique')
  const audIdxCount = run('psql', [
    '-h', DB_HOST, '-p', DB_PORT, '-U', DB_USER, '-d', TEST_DB,
    '-t', '-A', '-c',
    `SELECT count(*) FROM pg_indexes WHERE indexname = 'auditlog_tenant_createdat'`
  ]).trim()
  if (audIdxCount !== '1') missingIndexes.push('auditlog_tenant_createdat')
  // AUTH-1 foundation indexes (migration 20261008000001).
  for (const idx of [
    'uq_tenant_membership_user_tenant',
    'ix_tenant_membership_tenant',
    'uq_store_assignment_user_store',
    'ix_store_assignment_tenant',
    'ix_location_tenant',
    'uq_authorization_context_session_id',
    'ix_authorization_context_session_user'
  ]) {
    const c = run('psql', [
      '-h', DB_HOST, '-p', DB_PORT, '-U', DB_USER, '-d', TEST_DB,
      '-t', '-A', '-c',
      `SELECT count(*) FROM pg_indexes WHERE indexname = '${idx}'`
    ]).trim()
    if (c !== '1') missingIndexes.push(idx)
  }
  // D-05 member identity indexes (migration 20261012000001): present, and
  // every obsolete predecessor absent (no stale raw/global enforcement).
  for (const idx of D05_MEMBER_INDEXES) {
    const c = run('psql', [
      '-h', DB_HOST, '-p', DB_PORT, '-U', DB_USER, '-d', TEST_DB,
      '-t', '-A', '-c',
      `SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'member' AND indexname = '${idx}'`
    ]).trim()
    if (c !== '1') missingIndexes.push(idx)
  }
  const obsoleteObjects = []
  for (const name of [...D05_OBSOLETE_MEMBER_CONSTRAINTS, 'uq_member_global_name']) {
    const c = run('psql', [
      '-h', DB_HOST, '-p', DB_PORT, '-U', DB_USER, '-d', TEST_DB,
      '-t', '-A', '-c',
      `SELECT (SELECT count(*) FROM pg_constraint WHERE conname = '${name}' AND conrelid = 'public.member'::regclass) + (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = '${name}')`
    ]).trim()
    if (c !== '0') obsoleteObjects.push(name)
  }
  const wrongTypes = []
  for (const [table, column] of R4_TYPE_CHANGES.map(([t, c]) => [t, c])) {
    const out = run('psql', [
      '-h', DB_HOST, '-p', DB_PORT, '-U', DB_USER, '-d', TEST_DB,
      '-t', '-A', '-c',
      `SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}' AND column_name = '${column}'`
    ]).trim()
    if (out !== 'numeric') wrongTypes.push(`${table}.${column} (${out || 'missing'})`)
  }
  const problems = [...missingTables.map((t) => `table ${t}`), ...missingColumns.map((c) => `column ${c}`), ...missingIndexes.map((i) => `index ${i}`), ...obsoleteObjects.map((o) => `obsolete member uniqueness object ${o} still present`), ...wrongTypes.map((w) => `type ${w}`)]
  if (problems.length > 0) {
    throw new Error(
      `[setup-test-db] R-4 schema contract FAILED — test DB ${TEST_DB} is missing required schema and must not run tests: ${problems.join(', ')}. ` +
        `The test schema source (dev DB ${SRC_DB} / snapshot) needs reconciliation; runtime afterConnect must not be relied on to repair this.`
    )
  }

  // 4. Truncate every table so each run starts from clean state.
  run('psql', [
    '-h',
    DB_HOST,
    '-p',
    DB_PORT,
    '-U',
    DB_USER,
    '-d',
    TEST_DB,
    '-c',
    `DO $$
     DECLARE r RECORD;
     BEGIN
       FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
         EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' CASCADE';
       END LOOP;
     END $$;`
  ])

  console.log(`[setup-test-db] test DB ready: ${TEST_DB}`)
}
