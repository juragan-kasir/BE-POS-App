# Release Runbook — BE-POS-App

This repo does **not** deploy via GitHub Actions. Disabling that no-op `deploy`
job removed a fake release gate; the real release flow is the Vercel Git
integration below (`vercel.json` routes everything to the `@vercel/node`
serverless entry `api/index.js`).

## Production schema verification gate (W-01 / W-01.1 — mandatory)

Every production release MUST pass the read-only production-schema verifier
before it proceeds:

1. Run the verifier against the target production database:
   `npm run check:production-schema`
   (connects via the production configuration in `.env.production`; see
   `scripts/check-production-schema.js`).
2. Outcomes:
   - **PASS (exit `0`)**: every repository migration is recorded in
     `SequelizeMeta`; the approved disposition manifest is valid and fully
     recorded; no controlled apply is pending; no business decision is open;
     the November auth/tenant/audit critical schema is present.
   - **FAIL (exit `1`)**: any structural or schema problem. This includes an
     invalid or unapproved manifest, a manifest row not recorded, a
     repository migration not recorded, orphan/duplicate/misordered
     `SequelizeMeta` rows, a `CONTROLLED_APPLY_PENDING` row, or missing
     critical schema.
   - **BLOCKED (exit `2`)**: structurally sound, but at least one
     `BLOCKED_DECISION` remains. The open decision references are listed.
     BLOCKED is not PASS.
   All reads run inside a single `SET TRANSACTION READ ONLY` transaction, and
   `db/migration-baseline.txt` is still honoured as provenance.
3. If the verifier exits non-zero (FAIL **or** BLOCKED), the release STOPS.
   Do not merge, do not deploy, and do not retry with different flags.
4. The verifier NEVER stamps dispositions and NEVER applies migrations.
   **VERIFY** (this gate) is strictly read-only. **STAMP DISPOSITIONS** and
   **APPLY MIGRATIONS** are separate, explicitly authorized operational
   actions.
5. After any authorized production change, rerun the verifier and retain its
   output (stdout/stderr + exit status) as release evidence.

### What the verifier asserts

`SequelizeMeta` is the migration runner's **do-not-execute ledger** (D-02,
Model D): a recorded name must never be executed again by `sequelize-cli`.
A recorded row does **not** assert that the migration was executed; rows
recorded before W-01.1 have no verified execution provenance. The verifier
reports **recorded** state only, for example:

```
240/240 recorded in SequelizeMeta: runner-recorded N (execution provenance not asserted for pre-W-01.1 rows), attested X, excluded Y, controlled-applied Z, controlled-pending P, blocked B
```

It never reports that "all migrations were executed/applied".

### Disposition manifest

`db/migration-dispositions/production.json` is the reviewed record of **why**
production migrations are recorded without being executed by the runner. The
vocabulary and field rules are in `db/migration-dispositions/README.md`.

- It is approved as a whole (`approvedBy`/`approvedAt`). An unapproved
  manifest can only be dry-run: the verifier FAILs and the preflight refuses.
- Migrations meant to run normally are not listed.
- It is **not** `db/migration-baseline.txt`, which stays dev-snapshot
  provenance for the CI chain validator.

### Production migration order (each step separately authorized)

1. **Approve** the manifest (PR review sets `approvedBy`/`approvedAt`; the
   evidence it cites is retained durably).
2. **Stamp** dispositions. Dry run first:
   `node scripts/apply-migration-dispositions.js --target=production`
   Then apply:
   `node scripts/apply-migration-dispositions.js --target=production --apply --authorize-manifest-sha256=<sha256 of the approved manifest file>`
   - The stamp is one transaction that only inserts missing names.
   - It verifies the result before commit, and refuses an unapproved,
     malformed or orphaned manifest.
   - The sha256 binds the authorization to the reviewed file content. It is
     not a credential.
3. **Controlled applies.** Each `CONTROLLED_APPLY_PENDING` effect is applied
   by a reviewed operation, verified, and recorded as `CONTROLLED_APPLIED`
   with an `applyRef`. The migration file itself is never executed.
4. **Decisions.** Each `BLOCKED_DECISION` row needs the owner decision named
   in its `decisionRef`, recorded as `EXCLUDED_BY_DECISION` or carried out
   through the controlled-apply path. While any remain, the verifier is
   BLOCKED and G-02 cannot pass.
5. **Run migrations** only with `npm run migrate`. It runs
   `scripts/check-migration-preflight.js` first (fail closed: manifest valid
   and approved, every disposition recorded, nothing blocked or pending, no
   orphan rows) and only then starts the pinned `sequelize-cli db:migrate`
   for the same `--env`. Flags that could retarget the runner are refused.
   - **D-08 E2 runs in bounded batches (Option C)**, one separately approved
     batch at a time:
     `npm run migrate -- --env production --batch B1` (then `B2`, then `B3`).
     The batches are defined in `scripts/migration-batches.js` and recorded
     in `docs/superpowers/evidence/d08-e2-batch-contract-record.md`:
     - **B1**: the original 13 E2 migrations;
     - **B2**: P1 M1 + M2 + M5;
     - **B3**: P1 M3 only, after P1 is live with canonical payment writes
       verified (gate P1-CANONICAL-WRITES-VERIFIED was resolved 2026-10-08
       and carries no open gate).
    - After the preflight, the runner refuses a batch whose members are
      missing or already recorded, when any pending migration outside the
      batch would run first, or when a governance gate is open (B3: P1
      canonical writes verified; B1's DR-22 gate was resolved 2026-10-07 and
      carries no open gate). It then runs
     `db:migrate --to <last member>` and re-reads `SequelizeMeta` to confirm
     exactly the batch was recorded.
   - While any batch member is pending, an unbatched `npm run migrate`
     against production or staging is refused.
    - A batch existing in the repository does not approve it. Each batch
      needs its own explicit execution approval, a restore point and fresh
      read-only preconditions. DR-22 resolution made B1 governance-eligible;
      it does not itself authorize B1 production execution.
   - **B1 resume (B1-D05).** The 2026-10-08 B1 run recorded B1 #1–#12, and
     D-05 aborted in its own preflight (SequelizeMeta 235). `--batch B1` now
     refuses. The only way to finish B1 is
     `npm run migrate -- --env production --resume B1-D05`.
     - It runs only from exactly that ledger: 235 rows, B1 #1–#12 recorded,
       D-05 unrecorded, nothing else pending before it.
     - Afterwards it requires exactly 236 rows with only D-05 added, checks
       the D-05 indexes and constraints read-only, and prints one
       `RESUME RECORD` JSON line.
     - Gate `D05-AFFECTED-ROWS-DISPOSITIONED` was resolved 2026-10-08 by
       formal gate review
       (`docs/superpowers/evidence/d08-b1-d05-gate-review-record.md`: owner
       TEST dispositions, authorized-reset supersession, 9+9 live fixture
       lifecycle, clean M08). Clearing the gate does not authorize
       execution.
     - See `docs/superpowers/evidence/d08-b1-d05-resume-record.md`.
6. **Verify**: `npm run check:production-schema` must PASS.

**Never run `sequelize-cli db:migrate` (or `npx sequelize-cli`) directly
against production before stamping is complete.** Unstamped migrations are
pending to the runner and would be replayed. Never delete a `SequelizeMeta`
row to "re-enable" a migration.

### Restore

A production backup taken before stamping restores a ledger without the
dispositions. The verifier then FAILs and the preflight refuses, so nothing
silently passes. Re-run the stamper (it is idempotent) before any migration
runs, then re-verify.

## Staging rehearsal (W-02R.4 — ephemeral, never production)

Before any production remediation, the migration plan is rehearsed against a
**disposable local PostgreSQL database**. The rehearsal proves the
disposition contract converges (stamping, controlled applies, the 17 E2
runner candidates, final verification) while open business decisions stay
isolated. A successful rehearsal does NOT approve the production manifest,
stamp production, authorize production migration, or pass G-02.

> **Correction (2026-10-07, D-08 E2 Option C).** This section previously
> said "13 E2" and "236 = 197 + 26 + 13". That described the repository
> before PR #168. PR #168 added four Payment P1 migrations, so the derived E2
> inventory is now 17 and the accounting is 240 = 197 + 26 + 17. Their
> presence in the repository did not approve them for production. Production
> executes E2 in the three separately approved batches B1/B2/B3 described in
> step 5 above and in `docs/superpowers/evidence/d08-e2-batch-contract-record.md`.
> The rehearsal still runs all 17 sequentially, in the B1 → B2 → B3 order,
> against its disposable database to prove convergence; that is not a
> production execution plan. Earlier evidence files keep their original
> "13 E2" figures because they describe the repository state they captured.

### Lifecycle

1. **Approve the staging manifest** (`db/migration-dispositions/staging.json`)
   in your working copy by setting `approvedBy`/`approvedAt` after review.
   Production approval is separate and untouched; staging approval never
   authorizes production.
2. **Dry run** (no database touched):
   `node scripts/rehearse-staging.js --staging-db=cashier_app_staging_rehearsal`
   Validates the manifest, approval state, and 240 = 197 + 26 + 17
   accounting, then prints the plan.
3. **Rehearse** (creates, uses, and drops the ephemeral database):
   ```
   node scripts/rehearse-staging.js --staging-db=cashier_app_staging_rehearsal --apply \
     --authorize-manifest-sha256=$(shasum -a 256 db/migration-dispositions/staging.json | cut -d' ' -f1)
   ```
   Stages: create → identity guard → baseline → snapshot + synthetic drift
   fixture → disposition stamping → controlled applies (missing effects
   only) → 17 E2 through the real runner (timed per migration) →
   verification → evidence bundle → teardown.
   The rehearsal database name must match
   `cashier_app_staging_rehearsal*` on a local host or the harness refuses
   before any mutation. Staging uses only `STAGING_DB_*` variables; it
   never reads `POSTGRES_*` or `.env.production`.
4. **Evidence** is written to `docs/superpowers/evidence/` (no secrets) and
   the expected terminal state is success-with-decisions-isolated
   (D-06/D-08 remain `BLOCKED_DECISION` by design; D-05 is resolved as
   `EXCLUDED_BY_DECISION` and its product-grade migration runs as E2).
5. Add `--keep-on-failure` to retain a failed rehearsal database for
   debugging; it is dropped explicitly afterwards, never left behind
   silently.

Rollback inside rehearsal is restore/teardown-based: controlled index
operations roll back via `DROP INDEX`, the split_bill `NOT NULL` via
`DROP NOT NULL`, and table-dropping migration `down()` methods are never
used as rollback. Teardown (`DROP DATABASE`) is the final boundary.

## Release flow

1. **Push / open a PR** against `master`. CI (`.github/workflows/ci.yml`)
   runs the full Jest suite against a real Postgres (`postgres:16` service)
   plus ESLint.
2. **Wait for CI checks to PASS.** Nothing goes out otherwise.
3. **Merge the PR to `master`.** The Vercel Git integration detects the push
   and builds + deploys the serverless function automatically (production
   branch `master`).
4. **Post-deploy health check** (production):
   - `curl -I https://api-bisa-nota.vercel.app` → expect an HTTP response
     (non-5xx) and the `no-cache, no-store, must-revalidate` headers.
5. **Smoke test** the critical flow from the FE: log in → cashier order →
   Kitchen Display → payment settlement, confirming writes through this API.

## Prerequisites on the platform

- Production env vars set in the Vercel project: `DATABASE_URL`,
  `JWT_SECRET_KEY`, `JWT_EXPIRED_IN`, and the optional `REDIS_*` /
  `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET`
  values (see `.env.example` for the full variable list).
- Only merge to `master` after CI is green; rollback is available from the
  Vercel dashboard.

## Fix workflow (routine fixes)

1. Start in the main repository checkout with a verified, up-to-date `master`
   baseline: `git fetch origin`, confirm `origin/master` is the intended
   baseline, and fast-forward-only when appropriate. Never assume the tree
   is clean.
2. Create or use a dedicated feature branch for implementation. Never commit
   directly to `master`.
3. Do not use nested worktrees (`.worktrees/`, `.claude/worktrees/`) for
   routine fixes. If a tool unexpectedly starts work in one, stop, return to
   the main checkout, and preserve existing worktrees unless separately
   authorized to modify them.
4. Before editing, inspect `git status`, `git stash list`, untracked files,
   and relevant local work. Never overwrite or delete unrelated work.
5. Keep scope explicit, stage only intended paths with
   `git add -- <path>`, and run `git diff --check`.
6. Push only the intended feature branch and follow the PR process above.
   Never force-push.
7. Distinguish local test results from remote CI results. After a merge,
   fetch and verify that `origin/master` contains the merged change.

### Required validation gates

As established by `.github/workflows/ci.yml`, every fix must pass:

- `npm test` (full sharded Jest suite against a real Postgres)
- `npx eslint api/ utils/ --max-warnings 0`
- `npm run guard:force-sync` (static destructive-sync guard)

### Test-database caveat (diagnostic guidance only)

The `cashier_app_test` database schema is cloned from the local dev database,
so a local checkout can carry foreign-key constraints (e.g. on `location`)
that CI's schema snapshot does not have. A local-only `afterAll` cleanup
failure must be investigated and evidenced against a pristine baseline; it
must not be used to dismiss a genuine failure or to justify weakening
cleanup code.