'use strict'

// FG-SEC-05 / AUD-5: make auditLog append-only at the database boundary.
//
// The ORM hooks in db/models/auditLog.js already deny every application
// mutation path, but raw SQL and pg_dump restores can bypass them. This
// migration adds:
//   - tenantId backfill from location.tenantId (historical rows only),
//   - a real FK to tenant (NULL stays valid for platform/global events),
//   - a BEFORE UPDATE/DELETE trigger, plus a TRUNCATE guard,
//   - the tenant/createdAt index used by tenant-scoped audit reads.
//
// The trigger is bypassed only when the database session explicitly sets
// `app.audit_maintenance = 'on'`. Production leaves it unset; the isolated
// test database sets it at the database level so cleanup fixtures keep
// working. No client-controlled path can set this GUC.

const CONSTRAINT = 'auditLog_tenantId_fkey'
const UPDATE_TRIGGER = 'auditlog_no_mutation'
const TRUNCATE_TRIGGER = 'auditlog_no_truncate'
const GUARD_FN = 'audit_log_immutable_guard'
const TRUNCATE_FN = 'audit_log_truncate_guard'

const up = async (queryInterface) => {
  const query = queryInterface.sequelize

  // Historical rows are backfilled from their store; rows whose store has
  // no tenant stay NULL (unknown scope, never fabricated).
  await query.query(`
    UPDATE "auditLog" AS a
       SET "tenantId" = l."tenantId"
      FROM "location" AS l
     WHERE a.store = l.id
       AND a."tenantId" IS NULL
       AND l."tenantId" IS NOT NULL
  `)

  // Drop stale forward-compatible values that never referenced a real
  // tenant before adding the FK. This is a no-op on a clean deployment.
  await query.query(`
    UPDATE "auditLog" AS a
       SET "tenantId" = NULL
     WHERE a."tenantId" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "tenant" AS t WHERE t.id = a."tenantId")
  `)

  await query.query(
    'CREATE INDEX IF NOT EXISTS auditlog_tenant_createdat ON "auditLog" ("tenantId", "createdAt")'
  )

  await query.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = '${CONSTRAINT}'
          AND conrelid = 'public."auditLog"'::regclass
      ) THEN
        ALTER TABLE "auditLog"
          ADD CONSTRAINT "${CONSTRAINT}"
          FOREIGN KEY ("tenantId") REFERENCES "tenant"(id)
          ON UPDATE CASCADE ON DELETE SET NULL;
      END IF;
    END $$;
  `)

  await query.query(`
    CREATE OR REPLACE FUNCTION ${GUARD_FN}()
    RETURNS trigger AS $$
    BEGIN
      IF current_setting('app.audit_maintenance', true) = 'on' THEN
        RETURN COALESCE(NEW, OLD);
      END IF;
      RAISE EXCEPTION 'auditLog is append-only: % is not allowed', TG_OP;
    END;
    $$ LANGUAGE plpgsql;
  `)

  await query.query(`
    DROP TRIGGER IF EXISTS ${UPDATE_TRIGGER} ON "auditLog";
    CREATE TRIGGER ${UPDATE_TRIGGER}
      BEFORE UPDATE OR DELETE ON "auditLog"
      FOR EACH ROW EXECUTE FUNCTION ${GUARD_FN}();
  `)

  await query.query(`
    CREATE OR REPLACE FUNCTION ${TRUNCATE_FN}()
    RETURNS trigger AS $$
    BEGIN
      IF current_setting('app.audit_maintenance', true) = 'on' THEN
        RETURN NULL;
      END IF;
      RAISE EXCEPTION 'auditLog is append-only: TRUNCATE is not allowed';
    END;
    $$ LANGUAGE plpgsql;
  `)

  await query.query(`
    DROP TRIGGER IF EXISTS ${TRUNCATE_TRIGGER} ON "auditLog";
    CREATE TRIGGER ${TRUNCATE_TRIGGER}
      BEFORE TRUNCATE ON "auditLog"
      FOR EACH STATEMENT EXECUTE FUNCTION ${TRUNCATE_FN}();
  `)
}

const down = async (queryInterface) => {
  const query = queryInterface.sequelize
  await query.query(`DROP TRIGGER IF EXISTS ${UPDATE_TRIGGER} ON "auditLog"`)
  await query.query(`DROP TRIGGER IF EXISTS ${TRUNCATE_TRIGGER} ON "auditLog"`)
  await query.query(`DROP FUNCTION IF EXISTS ${GUARD_FN}()`)
  await query.query(`DROP FUNCTION IF EXISTS ${TRUNCATE_FN}()`)
  await query.query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = '${CONSTRAINT}'
          AND conrelid = 'public."auditLog"'::regclass
      ) THEN
        ALTER TABLE "auditLog" DROP CONSTRAINT "${CONSTRAINT}";
      END IF;
    END $$;
  `)
  await query.query('DROP INDEX IF EXISTS auditlog_tenant_createdat')
}

module.exports = { up, down }
module.exports.CONSTRAINT_NAME = CONSTRAINT
module.exports.UPDATE_TRIGGER = UPDATE_TRIGGER
module.exports.TRUNCATE_TRIGGER = TRUNCATE_TRIGGER
