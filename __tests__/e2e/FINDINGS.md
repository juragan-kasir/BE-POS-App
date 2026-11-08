# E2E Business-Segment Test — Findings

Run date: 2026-11-08
Command: `npm run test:e2e` (from `BE-POS-App/`)
Harness: Jest 30 + Supertest against the real `cashier_app_test` Postgres DB
(`scripts/setup-test-db.js` truncates all tables once per run).

## Result

```
Test Suites: 8 passed, 8 total
Tests:       59 passed, 59 total
```

All segments run through real HTTP routes, real login (`POST /auth/login`), and
the real DB. Every world gets a unique suffix, so suites can share one run.

| Suite | Scenario | Tests |
|---|---|---|
| `segments/01-single-outlet-fnb.e2e.js` | 1 merchant, 1 outlet, owner + 6 staff | 8 |
| `segments/02-fnb-qr-order.e2e.js` | F&B + QR order, rush-hour bulk entry | 7 |
| `segments/03-multi-outlet-single-merchant.e2e.js` | 1 merchant, 3 outlets | 7 |
| `segments/04-multi-merchant.e2e.js` | 3 merchants, platform owner | 9 |
| `segments/05-multi-merchant-multi-outlet.e2e.js` | 2 merchants × 2 outlets | 8 |
| `segments/06-retail-kecil.e2e.js` | small retail, many tiny cash-outs | 7 |
| `segments/07-retail-grosir.e2e.js` | 3 outlets × 8 staff, per-outlet payroll | 8 |
| `isolation/cross-tenant.e2e.js` | cross-tenant read/write/approval leaks | 5 |

Each segment covers the same six business flows, in order:

1. **Roster** — owner sees exactly the outlet's employees (store-scoped).
2. **Daily expense** — create → appears in `expense/get-all` and in
   `expense/get-summary.data.periods.daily`; delete cleans both.
3. **Recurring expense** — template with overdue `nextDueDate`; the scheduler
   (`generateDueRecurringExpenses`) generates one child per missed period and
   advances `nextDueDate` exactly once per run.
4. **Monthly payroll** — `expense/generate-salary` creates one expense per
   employee, is idempotent on the same month, and rejects a cross-store outlet.
5. **Attendance** — staff check-in/check-out, duplicate same-day/same-type is
   `409`, out-of-geofence is `400`, poor GPS accuracy is accepted as
   `untrusted`, owner can read `/attendance/today` and `/attendance/by-shift`.
6. **Shift swap** — request → approve relocates both employees atomically;
   re-approve is `400`; requesting/approving across stores is `403`; a target
   who already has attendance that day is rejected `409`.

---

## Findings (all fixed)

### E2E-01 — HIGH: expenses with a custom category `accountCode` never posted accounting journals — FIXED

**Where:** `api/service/accountingService.js` (`findOrCreateAccount`)

**Root cause**

`expense_category.accountCode` is user-configurable through
`/expense-category`. Any code not present in
`accountingService.DEFAULT_ACCOUNTS` (only `6000` and `6100` are expense
accounts there) made journal posting throw:

```
Expense journal deferred to retry queue: Cannot read properties of undefined (reading 'description')
Recurring expense journal skipped:  Cannot read properties of undefined (reading 'description')
```

`findOrCreateAccount` skipped its `return null` guard because the caller always
supplies `overrides.name`, then dereferenced `defaults.description` while
`defaults` was `undefined`.

**Fix**

```js
const base = defaults || {}
...
name: overrides.name || base.name,
type: overrides.type || base.type,
normalBalance: overrides.normalBalance || base.normalBalance,
description: overrides.description || base.description || null,
```

**Regression tests**

- `__tests__/expense-accounting-outbox.test.js` — "posts a journal for a
  category whose accountCode is not a built-in account" (asserts the outbox
  job reaches `posted`, a journal exists, and the debit line uses account
  `6500`).
- `__tests__/e2e/segments/01-single-outlet-fnb.e2e.js` — "custom-coded expense
  posts its accounting journal" (previously `test.failing`, now a normal test).

---

### E2E-02 — LOW: recurring scheduler read the category outside the transaction — FIXED

**Where:** `api/service/expenseScheduler.js`

`db.expense_category.findOne(where, { transaction })` passed the transaction as
a second argument, which Sequelize ignores (`findOne` takes one options
object). The category read therefore ran outside the transaction that creates
the child expense and updates the template.

**Fix**

```js
const category = await db.expense_category.findOne({
  where: { id: tpl.category || null },
  transaction
})
```

**Regression test:** `__tests__/expense-scheduler-transaction.test.js` spies on
`findOne` and asserts the transaction is inside the single options object.

---

### E2E-03 — MEDIUM: usernames stored with uppercase letters could not log in — FIXED

**Where:** `db/models/user.js` (hook), `api/controller/auth.js` (login lookup)

**Root cause**

Login lowercased the submitted identifier, but `userName` was stored verbatim
(`beforeSave` only hashed the password). Postgres equality is case-sensitive,
so a row stored as `OwnerS01` was looked up as `owners01` and returned
`401 "User Name / Email Tidak Ditemukan"`.

**Fix (defense in depth)**

1. `user` model `beforeSave` now lowercases `userName` whenever it changes, so
   new/updated rows are stored normalized.
2. Login compares `lower(email|userName)` with the lowercased input, so rows
   written before the normalization are not locked out.

**Regression tests:** `__tests__/auth-username-case-normalization.test.js`
covers both a new mixed-case row and a legacy mixed-case row (simulated with a
raw `UPDATE`).

`helpers/world.js` still lowercases fixture usernames; that workaround is now
redundant but harmless.

---

### E2E-04 — LOW: inconsistent `store` vs `location` query contract on employee list — FIXED

**Where:** `api/controller/employee.js` (`getAllEmployee`)

`GET /employee/get-employee` only honored `?location=`. For a platform
(`super_admin`) owner, `?store=` was ignored and the endpoint returned employees
across **all tenants** (observed: 15 rows for a 1-outlet merchant world while
only 4 rows were expected). Store-bound admins happened to be safe because they
are pinned to their own store.

**Fix**

`store` is now accepted as an alias for `location`:

```js
const { location: rawLocation, store: rawStore } = req.query
const location = rawLocation ?? rawStore
```

Confined-actor checks and global-owner filtering are unchanged; both now see the
same value regardless of which parameter the client sends.

**Regression test:** `__tests__/e2e/segments/04-multi-merchant.e2e.js` —
"platform owner can filter the roster with the same store query used
elsewhere".

---

## Notes on the harness

- Schedulers are disabled by setting `process.env.VERCEL='true'` before loading
  `api/index.js`; recurring generation is invoked directly so tests are
  deterministic. The outbox worker is also not started, so immediate journal
  attempts happen inline.
- `scripts/setup-test-db.js` truncates **all** tables once per Jest run. Suites
  are isolated by a unique world suffix, not by per-suite truncation.
- The five legacy routes under test (`expense`, `attendance`, `shift`,
  `shift-swap`, `employee`) still authorize from `req.user.roleType` /
  `req.user.store`, not from the canonical `authContext` middleware. Behavior is
  consistent within these tests but differs from newer routes; tracked here as
  tech debt rather than a bug.
- Out of scope for this pass: QR-order creation/payment, inventory/PO flows, and
  accounting reports. The focus is the seven business segments' operating flows.
