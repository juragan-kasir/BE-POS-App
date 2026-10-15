# Counter sale & QR order — client contract (idempotency, refusals, recovery)

Authority: BA §35.10 DR-23 §K (idempotency), §M (refusal outcomes), DR-17
(displayed = charged), DR-10 (failures observable and recoverable).
Applies to `POST /order/create` (counter sale), `POST /order/customer-create`
(public QR order) and the settlement path of `PUT /order/update-status`.

All additions are backward compatible: HTTP statuses and `message` / `error`
texts are unchanged; `code` and the new fields are additive.

## 1. Idempotency key lifecycle (client side)

- Mint one `idempotencyKey` (e.g. a UUID) per **logical sale attempt**.
- Reuse it for every retry of that attempt until a **definitive outcome**:
  `201` (created), `200` (replayed), or a `4xx` refusal.
- After an **unknown outcome** (timeout, network loss, `500`), retry with the
  **same key and the same payload**. If the first request committed, the
  server replays it (`200`, same order, no new effect); if not, it creates it
  once.
- Mint a new key only for a genuinely new sale — never because a checkout
  dialog was closed and reopened while an attempt was unresolved. Persisting
  the key across dialog close/reopen and page reloads is a client
  responsibility (FE/BISA follow-up; see "Not covered" below).
- Keys are scoped to the store: the same key in another store is a different
  sale.

## 2. Same key, different payload → `409 IDEMPOTENCY_MISMATCH`

```json
{
  "message": "idempotencyKey already used with a different payload",
  "code": "IDEMPOTENCY_MISMATCH",
  "fields": ["paymentMethod", "referenceNumber"],
  "existingOrder": { "id": 812, "orderNumber": "ORD…", "totalPrice": 11100, "paymentStatus": "paid" }
}
```

- The payload is the whole financial intent. The original request is not
  stored, so the server compares the retry against what the first request
  persisted (order header, lines, initial ledger row) and refuses only when
  that evidence **proves** a difference: lines (product/bundle, quantity,
  option and modifier names), admin price overrides, tender, cash
  received/change, non-cash reference, table, member, promo code, discount,
  redeemed points, tax mode (`useTax`), source, currency fields, and a stated
  `expectedTotal` that differs from the committed total.
- Equivalent serializations replay: line order, option order, numeric strings,
  tender spelling (`cash`/`Cash`), promo-code case and whitespace.
- Server-derived values (prices, totals, tax and discount amounts) and
  cosmetic fields (names, notes, `expectedPrice`) are not compared.
- `existingOrder` is returned on the authenticated counter path only (never
  on the public QR path). A client that receives it after an unknown outcome
  must treat that order as **already sold** and reconcile — never re-sell.
- QR (`/order/customer-create`) compares lines, table, member, payment intent
  (case-insensitive), `splitCount` and `session`.

**Fields that legitimately change after creation, and what that means for a
retry.** Where persisted evidence cannot tell the original request apart
from a later change, the retry is replayed (it never creates a second
effect), so a few differing retries are not detected:

| Field | Later change | Retry behaviour |
|---|---|---|
| Member (`customerId`) | Staff may attach a member into an empty slot (never replace or clear it). | A retry **naming** a member other than the stored one → 409. A retry naming **no** member → replays, even if the stored member was set by the original request. |
| QR payment intent | A non-split settlement overwrites it with the canonical tender (same value as its ledger row). | Compared until that settlement exists; afterwards not compared. Split payments do not overwrite it. |
| Tax mode (`useTax`) on a 0 % order | The store's PPN rows may be edited. | `useTax: true` against a 0 % order → 409 only while every active PPN row is unchanged since the order was created; otherwise replays. `useTax: false` against a taxed order → always 409. |
| Discount | A requested discount that did not resolve at creation is not stored. | A requested discount that already existed when the order was created (so it would have applied) → 409; otherwise replays. |

## 3. `expectedTotal` → `409 TOTAL_CHANGED`

Send the payable the customer was shown (e.g. the `totalPrice` of
`POST /order/quote`) as `expectedTotal` (integer rupiah). When the server's
payable differs — a promo or discount that stopped applying, a price or tax
change — the sale is refused **before any write**:

```json
{ "code": "TOTAL_CHANGED", "message": "…", "expectedTotal": 9990, "totalPrice": 11100,
  "subTotal": 10000, "discountAmount": 0, "taxAmount": 1100, "serviceChargeAmount": 0 }
```

Re-quote and show the new total before resubmitting. A malformed
`expectedTotal` is a `400` validation error. Omitting it keeps the legacy
behaviour (no check).

`TOTAL_CHANGED` always means **nothing was written**. A same-key retry whose
`expectedTotal` differs from an order that this key **already created** is
answered `409 IDEMPOTENCY_MISMATCH` (`fields: ["expectedTotal"]`, with
`existingOrder`) — never `TOTAL_CHANGED` — because that sale exists.

## 4. Refusal codes on `POST /order/create`

| Status | `code` | Meaning |
|---|---|---|
| 400 | `INVALID_QUANTITY` | A line quantity ≤ 0 |
| 400 | `PRODUCT_NOT_FOUND` | Unknown product, or not orderable in this store |
| 400 | `BUNDLE_NOT_FOUND` / `BUNDLE_NOT_AVAILABLE` | Bundle unknown, inactive, or a component unavailable |
| 400 | `INSUFFICIENT_STOCK` | Not enough stock for a line or bundle component |
| 400 | `INVALID_PRICE_OVERRIDE` / `PRICE_OVERRIDE_NOT_ALLOWED` | Malformed override / override on a bundle |
| 400 | `INVALID_EXPECTED_PRICE` | Malformed `items[].expectedPrice` |
| 400 | `TABLE_NOT_FOUND` / `TABLE_OCCUPIED` / `TABLE_NOT_AVAILABLE` | Dine-in table refusals |
| 403 | `FORBIDDEN` | Price override without admin capability; missing `payment.collect` |
| 409 | `PRICE_CHANGED` | A line's `expectedPrice` is stale (unchanged contract) |
| 409 | `REGISTER_STATE_CHANGED` | The resolved open register closed before commit; nothing was written. Body is `409 { error, code }`; retry against the current open register |
| 409 | `INGREDIENT_STOCK_CONFLICT` | Not enough ingredient stock for a BOM-backed product (also on the settlement path). Nothing written; not a key conflict. Other BOM refusals (missing/invalid BOM, unit or store mismatch) remain 409 without a code |
| 409 | `TOTAL_CHANGED` | See §3 |
| 409 | `IDEMPOTENCY_MISMATCH` | See §2 |
| 400 | `PPN_MISSING` | Required PPN configuration missing (unchanged) |
| 403 / 404 | `MEMBER_OUT_OF_SCOPE` / `MEMBER_NOT_FOUND` | Member not of this store / unknown (unchanged) |
| 422 | `REGISTER_REQUIRED`, `INVALID_PAYMENT_METHOD` | Unchanged |
| 500 | `INTERNAL_ERROR` | Unexpected error; body never contains internal detail |

A `500 INTERNAL_ERROR` is almost always a rolled-back request, but a
connection lost at COMMIT can leave the outcome unknown: recover with the
**same key** (§1). A failure *after* commit (re-read, notification, realtime
emit, immediate journal attempt) never turns a committed sale into an error:
the sale is reported `201`.

## 5. Settlement retry (`PUT /order/update-status`, `status: "paid"`)

A settlement whose response was lost and is retried finds the order already
settled and is refused with `409 OUTSTANDING_CHANGED` (no effect). The body
now carries the ledger-derived state, so the client does not parse messages:

```json
{ "error": "…", "code": "OUTSTANDING_CHANGED", "outstanding": 0,
  "financialState": "PAID", "netPayable": 11100, "collected": 11100 }
```

`financialState: "PAID"` with `outstanding: 0` means the order is fully
settled; do not collect again. It does **not** prove that this particular
request was the one that settled it — see "Not covered".

## Not covered (decision / migration / client work)

- **Settlement, split payment, void and refund idempotency keys** (DR-23 §K)
  need the key persisted on the ledger record with a uniqueness backstop — a
  schema change behind the production migration gate.
- **Requiring** `idempotencyKey` on `POST /order/create` (DR-23 §K) is
  approved; it is a separate change because ~130 test call sites must be
  updated (the POS FE already always sends a key).
- **Client key persistence** across dialog close/reopen and reloads (FE
  CheckoutModal; BISA per Q-QR-04 / TP-14).
- **Non-cash reference** required and unique per store and method on counter
  sale and settlement (DR-23 §D): needs the FE to collect the reference first,
  and a uniqueness index (migration gate).
