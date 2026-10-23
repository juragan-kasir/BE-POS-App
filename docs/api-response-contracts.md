# Kontrak Response API — ERP & Akuntansi (BE → FE)

**Status:** berlaku untuk `BE-POS-App` master (`c9fe118`, 2026-10-23).
**Cakupan:** konvensi envelope & error global, modul akuntansi (COA, jurnal, laporan), expense, purchase (PO → goods receipt → purchase payment), sales return, dan order/tender kasir.
**Dokumen terkait:**
- `docs/order-create-client-contract.md` — siklus hidup idempotency key `POST /order/create` + jalur recovery (BE).
- `API_DOCUMENTATION.md` — katalog endpoint lengkap (BE).
- `SIMULATION_ERP_DEV_TEST_RESULTS.md` — bukti perilaku (46/46 check) di repo POS-APP.

> Dokumen ini fokus pada **bentuk response** (field, status, kode error) yang harus diandalkan FE. Semua contoh JSON diambil langsung dari kode BE. Bila terjadi perbedaan, kode BE adalah sumber kebenaran.

---

## 1. Konvensi umum

### 1.1 Base URL & auth
- Base URL dev/prod mengikuti konfigurasi FE (contoh dokumentasi: `https://api-bisa-nota.vercel.app`).
- Semua endpoint menggunakan header `Authorization: Bearer <JWT_TOKEN>`.
- Modul akuntansi (lihat `api/routes/accounting.js`) memakai `requireRole('super_admin', 'admin')` + `validateStoreAccess`.

### 1.2 Resolusi store
Server menentukan store aktif dari request dengan urutan (`getStore`):
`req.body.storeId` → `req.body.store` → `req.query.store` → cookie `store` → active store milik user.
Di semua endpoint ERP, kirim **salah satu** secara eksplisit (`query.store` untuk GET, `body.store`/`body.storeId` untuk POST/PUT) agar tidak bergantung cookie.

### 1.3 Format angka & tanggal
- Nominal uang = **integer rupiah** (BIGINT). `cashAmount`/`changeAmount` non-integer ditolak `422`.
- Field tanggal (`date`, `asOf`, `startDate`, `endDate`) memakai format `YYYY-MM-DD`; timestamp model (`createdAt`, dsb.) ISO-8601.
- Nilai agregat laporan dibulatkan 2 desimal oleh `toNumber` server.

### 1.4 Dua gaya envelope
| Gaya | Dipakai oleh | Bentuk sukses | Bentuk error |
|---|---|---|---|
| **A — standar** | sebagian besar controller (accounting, expense, sales return, purchase, dll.) | `{ success: true, message?, data? }` | `{ success: false, message }` (+ `errors[]` untuk validasi Zod) |
| **B — order** | `POST /order/create`, `POST /order/quote` (jalur kasir) | `{ message?, data }` — **tanpa** flag `success` | `{ error, code? }` |

Deteksi di FE: cek `typeof body.success === 'boolean'` dulu; kalau tidak ada, ini endpoint gaya B → baca `body.error` + `body.code`.

### 1.5 Dua gaya pagination
- Offsets: `{ count, limit, offset }` — `GET /accounting/journals` (`limit` default 50, maksimum 500).
- Objek pagination: `{ pagination: { total, page, limit, totalPages } }` — daftar lain (mis. `GET /sales-return/get-all`).

### 1.6 Idempotency
Endpoint tulis yang menerima `idempotencyKey` (order, sales return, goods receipt, purchase payment):
- Retry dengan key sama + payload sama → **replay** (200, tanpa efek baru).
- Key sama + payload beda → `409 IDEMPOTENCY_MISMATCH` dengan `fields[]`.
- Detail siklus hidup lengkap: `docs/order-create-client-contract.md`.

---

## 2. Envelope A — standar

### 2.1 Sukses
```json
// list
{ "success": true, "data": [ ... ] }

// single / create
{ "success": true, "message": "Account created", "data": { ... } }

// delete / aksi tanpa payload
{ "success": true, "message": "Account deleted" }
```

### 2.2 Error bisnis
```json
{ "success": false, "message": "Store is required" }
```
Status yang dipakai: `400` (validasi/bisnis), `403` (role/akses store), `404` (tidak ditemukan), `409` (konflik status), `500` (tak terduga — controller yang menangkap error sendiri mengganti pesan menjadi `"Internal server error"`; fallback global memakai `err.message` atau `"Internal Server Error"`).

### 2.3 Error validasi Zod (umum di endpoint POST/PUT)
```json
{
  "success": false,
  "message": "amount: Required; paymentMethod: Invalid enum value",
  "errors": [
    { "field": "amount", "message": "Required" },
    { "field": "paymentMethod", "message": "Invalid enum value" }
  ]
}
```
- Status `400`. `message` adalah gabungan `field: message` dipisah `; `.
- Catatan: field `costPrice` relabel menjadi `Harga Beli` di `errors[].field`.
- Body multipart boleh mengirim JSON string di `body.data`; bila bukan JSON valid → `400 { success:false, message:"Invalid JSON in body.data" }`.

### 2.4 Fallback global
Error tak tertangani yang sampai ke error handler global (`api/index.js`) menjadi:
```json
{ "success": false, "message": "<err.message | Internal Server Error>" }
```
dengan status `err.status || 500`. Controller yang menangkap error sendiri selalu mengganti pesan internal menjadi `"Internal server error"` (tanpa detail SQL/stack).

---

## 3. Envelope B — order/tender kasir

### 3.1 `POST /order/quote` → 200
```json
{
  "data": {
    "subTotal": 50000, "discountAmount": 5000, "discountSource": "promo",
    "pointDiscountAmount": 0, "redeemedPoints": 0,
    "taxRate": 10, "taxAmount": 4500,
    "serviceChargeRate": 0, "serviceChargeAmount": 0,
    "totalPrice": 49500, "totalQuantity": 2
  }
}
```
Gagal → `{ "error": "...", "code"?: "..." }` dengan status `error.statusCode`.

### 3.2 `POST /order/create` → 201
```json
{ "message": "Order created successfully", "data": { "...order lengkap..." } }
```
- **Replay** (key sama, payload sama) → `200 { "message": "Order already exists for this idempotency key", "data": { ...order... } }`.
- `expectedTotal` opsional: bila dikirim dan tidak sama dengan total server → `409 TOTAL_CHANGED` **sebelum ada tulis apa pun**:
```json
{
  "code": "TOTAL_CHANGED",
  "message": "The order total changed. Please review the updated total and resubmit.",
  "expectedTotal": 49000, "totalPrice": 49500, "subTotal": 50000,
  "discountAmount": 5000, "taxAmount": 4500, "serviceChargeAmount": 0
}
```
- `409 IDEMPOTENCY_MISMATCH`:
```json
{
  "message": "idempotencyKey already used with a different payload",
  "code": "IDEMPOTENCY_MISMATCH",
  "fields": ["paymentMethod", "referenceNumber"],
  "existingOrder": { "id": 812, "orderNumber": "ORD-…", "totalPrice": 11100, "paymentStatus": "paid" }
}
```
- Kode error order lainnya: `422 PAYMENT_METHOD_REQUIRED` (tender tidak boleh diasumsikan cash), `422 INVALID_PAYMENT_METHOD` (metode tak dikenal), `422 REFERENCE_REQUIRED` (metode non-cash wajib `referenceNumber`), `409 STORE_ARCHIVED`, `500 INTERNAL_ERROR` (`{ "error": "Internal Server Error", "code": "INTERNAL_ERROR" }`).
- **Aturan tender cash** (semua `422`, tanpa `code`, pesan eksak dari server):
  - `cashAmount`/`changeAmount` hanya valid untuk CASH.
  - Kirim keduanya atau tidak sama sekali (fallback exact-tender).
  - Harus numerik **dan integer** rupiah; `changeAmount >= 0`.
  - `cashAmount >= amountDue` dan `cashAmount - changeAmount === amountDue` (persis).

### 3.3 Metode pembayaran kanonik
- Nilai tersimpan selalu kanonik: `CASH`, `CARD`, `BANK_TRANSFER`, `E_WALLET`, `QRIS`, `POINTS`, `OTHER` (input huruf kecil/alias dinormalisasi, mis. `qris` → `QRIS`).
- Wajib `referenceNumber`: `CARD`, `BANK_TRANSFER`, `E_WALLET`, `QRIS`, `OTHER`.
- Bucket jurnal: `CASH` → akun `1000` (Cash); `CARD`/`BANK_TRANSFER`/`E_WALLET`/`QRIS` → akun `1400` (Bank & E-Wallet).

---

## 4. Modul akuntansi (`/accounting/*`)

Semua endpoint: role `super_admin`/`admin`. GET memakai `?store=<id>`; POST/PUT memakai `body.store` atau `body.storeId`.

### 4.1 Akun / COA

**`GET /accounting/accounts?store=&status=`** → 200
```json
{ "success": true, "data": [ { "id": 1, "store": 1, "code": "1000", "name": "Cash", "type": "asset", "normalBalance": "debit", "...": "..." } ] }
```
- Diurutkan `code ASC`. `?status=active|inactive` opsional. Tanpa `store` (super_admin) → hasil dikonsolidasi unik per `code` lintas store.
- 15 COA default otomatis di-seed saat pertama dibaca (`ensureDefaultAccounts`), lihat tabel §4.5.

**`POST /accounting/accounts`** → 201
Body: `{ store, code, name, type, normalBalance, parentId?, description? }`
```json
{ "success": true, "data": { "...akun..." }, "message": "Account created" }
```
- `type` ∈ `asset|liability|equity|revenue|expense`; `normalBalance` ∈ `debit|credit`.
- 400: `"Code, name, type and normalBalance are required"`, `"Invalid type or normalBalance"`, ``"Account code <code> already exists"``.

**`PUT /accounting/accounts/:id`** → 200 `{ success: true, data: {...}, message: "Account updated" }`
- 404 `"Account not found"`; 400 jika code baru bentrok.

**`DELETE /accounting/accounts/:id`** → 200 `{ success: true, message: "Account deleted" }`
- 400 `"System accounts cannot be deleted"`; 400 `"Account has journal activity and cannot be deleted"`; 404 `"Account not found"`.

### 4.2 Jurnal

**`GET /accounting/journals?store=&sourceType=&startDate=&endDate=&limit=&offset=`** → 200
```json
{
  "success": true,
  "data": [
    {
      "id": 40, "store": 1, "entryNumber": "JE-…", "date": "2026-10-18",
      "description": "Penjualan …", "sourceType": "order", "referenceId": 91,
      "totalDebit": 60000, "totalCredit": 60000, "status": "posted",
      "lines": [
        { "id": 1, "account": 17, "debit": 60000, "credit": 0, "description": null,
          "accountData": { "id": 17, "code": "1000", "name": "Cash", "type": "asset", "normalBalance": "debit" } }
      ]
    }
  ],
  "count": 12, "limit": 50, "offset": 0
}
```
- Urut `date DESC, id DESC`. `sourceType` filter opsional. Tanpa `store` (super_admin) tiap entry mendapat tambahan `storeName`.

**`POST /accounting/journals`** (jurnal manual) → 201
Body: `{ store, date, description, lines: [ { account, debit, credit, description? }, … ] }`
```json
{ "success": true, "data": { "...entry..." }, "message": "Journal entry created" }
```
Validasi 400 (pesan eksak): `"Date and at least two lines are required"`, `"Account ID is required for each line"`, ``"Account <id> not found"`` (akun harus milik store & `status:active`), `"Each line needs a positive debit or credit"`, ``"Total debit (<d>) must equal total credit (<k>)"``.
Entry manual tersimpan dengan `sourceType: "manual"`.

**`DELETE /accounting/journals/:id`** → 200 `{ success: true, message: "Journal entry deleted" }`
- 400 `"Only manual journal entries can be deleted"` — jurnal hasil sistem (order/cogs/expense/…) tidak boleh dihapus.

### 4.3 Laporan
Semua laporan: `store` wajib untuk non-super_admin (400 `"Store is required"`), filter tanggal opsional.

**`GET /accounting/trial-balance?store=&startDate=&endDate=`** → 200
```json
{
  "success": true,
  "data": [ { "accountId": 17, "code": "1000", "name": "Cash", "type": "asset", "debit": 60000, "credit": 0, "net": 60000 } ],
  "totalDebit": 175000, "totalCredit": 175000, "balanced": true
}
```
- `net = debit - credit`. Total & `balanced` berada di **top-level**, bukan di dalam `data`.

**`GET /accounting/income-statement?store=&startDate=&endDate=`** → 200
```json
{
  "success": true,
  "data": {
    "revenues": [ { "code": "4000", "name": "Sales Revenue", "value": 40000 } ],
    "expenses": [ { "code": "5000", "name": "Cost of Goods Sold", "value": 18800 } ],
    "totalRevenue": 40000, "totalExpense": 43800, "netIncome": -3800
  }
}
```
- `value` per akun = jarak `|debit − credit|`; baris diurut `code ASC`.

**`GET /accounting/balance-sheet?store=&asOf=`** → 200
```json
{
  "success": true,
  "data": {
    "asOf": "2026-10-18",
    "assets": [ { "code": "1000", "name": "Cash", "normalBalance": "debit", "net": -105000 } ],
    "liabilities": [], 
    "equity": [
      { "code": "3100", "name": "Retained Earnings", "normalBalance": "credit", "net": 0 },
      { "code": "RETAINED", "name": "Current Period Net Income", "normalBalance": "credit", "net": 3800, "isComputed": true }
    ],
    "totalAssets": -7000, "totalLiabilities": 0, "totalEquity": 7000,
    "totalLiabilitiesEquity": 7000, "balanced": false
  }
}
```
- Laba periode berjalan otomatis di-close ke baris virtual `RETAINED` (`isComputed: true`) — FE **jangan** menampilkan/menyimpan baris ini sebagai akun COA.
- `net` per akun = `debit − credit` (bisa negatif). Total dihitung mengikuti `normalBalance`.
- `balanced` = `|totalAssets − totalLiabilitiesEquity| <= 0.01`.

**`GET /accounting/overview?store=&startDate=&endDate=`** → 200
```json
{
  "success": true,
  "data": {
    "cashBank": -125000, "totalRevenue": 40000, "totalExpense": 43800, "netIncome": -3800,
    "isProfit": false, "totalAssets": -7000, "totalLiabilities": 0, "totalEquity": 7000,
    "totalLiabilitiesEquity": 7000, "balanced": false, "journalEntryCount": 11
  }
}
```
- `cashBank` = net akun asset yang namanya mengandung "cash"/"bank" (`1000` + `1400`).
- `journalEntryCount` = jumlah `journal_entry` berstatus `posted` pada rentang filter.

### 4.4 Peta event → jurnal (otomatis, tidak boleh di-duplikasi FE)
| `sourceType` | Pemicu | Baris jurnal (Dr / Cr) |
|---|---|---|
| `order` | `POST /order/create` sukses | Dr `1000`/`1400` (sesuai tender); Cr `4000` (penjualan), `4100` (service charge, bila ada), `2100` (PPN, bila ada) |
| `cogs` | bersamaan dengan `order` | Dr `5000`; Cr `1200` (sebesar Σ `hppSnapshot × qty`) |
| `sales_return` | `PATCH /sales-return/approve/:id` | pembalik `order` (Dr `4000` dst.; Cr `1000`/`1400`) |
| `cogs_reversal` | bersamaan dengan `sales_return` | Dr `1200`; Cr `5000` |
| `expense` | `POST /expense/add` (status approved) / `PUT /expense/approve/:id` | Dr akun beban kategori (`6000`/`6100`/custom); Cr `1000`/`1400` (sesuai tender) |
| `purchase` | `POST /purchase-order/create` | Dr `1200` (net) + `1250` (PPN masukan, bila ada); Cr `2000` |
| `purchase_payment` | `POST /purchase-payment/create` | Dr `2000`; Cr `1000`/`1400` |
| `purchase_return` | retur pembelian (di luar cakupan dokumen ini) | membalik `purchase` |
| `overtime_payroll` | payroll lembur (di luar cakupan) | — |
| `manual` | `POST /accounting/journals` | sesuai input |

Sifat posting:
- **Sinkron saat request** — BE menulis jurnal langsung dalam request yang sama (bukan queue async). FE tidak perlu memicu apa pun.
- Bila percobaan sinkron gagal, job otomatis masuk **outbox retry queue** di server (safety net, tidak pernah hilang) — FE tidak melihat job; pantau lewat halaman jurnal bila perlu.
- Penulisan bersifat **exactly-once** per `(event, referenceId)` — retry request tidak menggandakan jurnal (terbukti di simulasi: 0 duplikat).

### 4.5 COA default (di-seed otomatis per store)
| Code | Name | Type | Normal |
|---|---|---|---|
| 1000 | Cash | asset | debit |
| 1100 | Accounts Receivable | asset | debit |
| 1200 | Inventory | asset | debit |
| 1250 | Input Tax (Purchases) | asset | debit |
| 1300 | Fixed Assets | asset | debit |
| 1400 | Bank & E-Wallet | asset | debit |
| 2000 | Accounts Payable | liability | credit |
| 2100 | Tax Payable | liability | credit |
| 2200 | Salaries Payable | liability | credit |
| 3000 | Owner Capital | equity | credit |
| 3100 | Retained Earnings | equity | credit |
| 4000 | Sales Revenue | revenue | credit |
| 4100 | Service Charge Revenue | revenue | credit |
| 5000 | Cost of Goods Sold | expense | debit |
| 6000 | Operating Expenses | expense | debit |
| 6100 | Salaries & Wages | expense | debit |

---

## 5. Expense (`/expense/*`)

**`POST /expense/add`** → 201
Body (non-draft wajib `categoryId` + `amount`; terbukti di simulasi): `{ store, categoryId, amount, description?, date?, paymentMethod: "cash"|"bank"|"e-wallet", status: "draft"|"pending"|"approved"|"rejected", notes? }`
```json
{ "success": true, "message": "Success create expense", "data": { "...expense..." } }
```
- Bila `status` langsung `approved` → jurnal langsung dibuat (event `expense`).
- Bulk: `POST /expense/bulk-create` → 201 `{ success: true, message: "Success create N expenses", data: ... }`.
- Gagal validasi → 400 envelope A (mis. `"Category and amount are required"`).

**`PUT /expense/approve/:id`** → 200 `{ success: true, message: "Success approve expense" }` (tanpa `data`)
- 400 `"Only pending expenses can be approved"`.
- **`PUT /expense/reject/:id`** → 200 envelope A (pola sama).

---

## 6. Purchase flow

### 6.1 `POST /purchase-order/create` → 201
Body inti: `{ store, status: "ordered", paymentMethod: "credit"|…, dueDate, supplier?, items: [ { ingredient|product, quantity, price, unit, … } ] }`
```json
{ "success": true, "message": "Success create purchase order", "data": { "...po..." } }
```
- **Wajib `dueDate` bila `paymentMethod: "credit"`** (temuan simulasi).
- Sukses → jurnal `purchase` (Dr `1200` [+ `1250`], Cr `2000`).
- Error tak terduga: 500 `{ success:false, message:"Internal server error" }`.

### 6.2 `POST /goods-receipt/create` → 201
Body: `{ store, purchaseOrderId, supplier, status: "completed", idempotencyKey, items: [ { ingredient, qtyReceived, price, costPrice, unit, conversionToBase? } ] }` (mendukung multipart dengan `body.data`).
```json
{ "success": true, "message": "Success create goods receipt", "data": { "...receipt..." } }
```
- Linkage item PO diselesaikan **di server** (FE tidak perlu mengirim id item PO).
- Idempotent: aman di-retry dengan key sama.
- Stok bertambah saat receipt `completed` (kolom `stockPosted`).

### 6.3 `POST /purchase-payment/create` → 201
Body: `{ purchaseOrder, supplier, amount, paymentMethod, paymentDate?, reference?, notes?, idempotencyKey? }`
```json
{ "success": true, "message": "Payment recorded successfully", "data": { "...payment..." } }
```
- **`supplier` wajib** di body (temuan simulasi). Sukses → jurnal `purchase_payment`.
- **Over-payment ditolak** 400:
```json
{ "success": false, "message": "Over-payment not allowed. Total paid: 0, remaining: 120000, attempting to pay: 150000" }
```
- Dua request dengan key sama: satu menang, yang kalah menerima data pembayaran pemenang (bukan 500).

---

## 7. Sales return

### 7.1 `POST /pos/order/:id/return` → 201 (membuat pengajuan)
Body: `{ store?, items: [ { orderItemId?, productId, qty, unit?, conversionToBase? } ], reason, refundMethod?, idempotencyKey? }`
```json
{ "success": true, "message": "Sales return request created (Pending approval)", "data": { "...sales_return..." } }
```
- Error memakai envelope A dengan `statusCode` (mis. 404 order tidak ada; 409 order belum lunas/sudah diretur; 409 idempotency mismatch).
- **Tidak ada efek stok/jurnal sebelum approve.**

### 7.2 `PATCH /sales-return/approve/:id` → 200
Body: `{ id }` (+ `refundReference` bila perlu).
```json
{ "success": true, "message": "Sales return approved", "data": { "...sales_return..." } }
```
- Efek: stok kembali, jurnal `sales_return` + `cogs_reversal` dibuat sinkron.
- Hanya status `pending` yang bisa di-approve (400 bila bukan).

### 7.3 `PATCH /sales-return/reject/:id` → 200
```json
{ "success": true, "message": "Sales return rejected", "data": { "...sales_return..." } }
```

---

## 8. Katalog kode error (envelope B / order)

| Status | `code` | Arti & aksi FE |
|---|---|---|
| 409 | `TOTAL_CHANGED` | Total berubah dari `expectedTotal`; **tidak ada** yang tertulis. Re-quote lalu minta konfirmasi kasir. |
| 409 | `IDEMPOTENCY_MISMATCH` | Key dipakai payload beda; tampilkan `fields` + `existingOrder`. Minta outcome definitif, jangan retry buta. |
| 409 | `STORE_ARCHIVED` | Store diarsipkan; hentikan transaksi. |
| 422 | `PAYMENT_METHOD_REQUIRED` | Tender tidak dikirim; kirim metode eksplisit. |
| 422 | `INVALID_PAYMENT_METHOD` | Metode tak dikenal; pakai daftar kanonik §3.3. |
| 422 | `REFERENCE_REQUIRED` | Metode non-cash tanpa `referenceNumber`. |
| 422 | — (tanpa code) | Pelanggaran aturan tender cash (§3.2); tampilkan `error`. |
| 500 | `INTERNAL_ERROR` | Outcome tak diketahui — retry dengan `idempotencyKey` **sama**. |

Envelope A memakai `message` (bukan `code`); andalkan status + pesan. Jangan parsing `message` untuk logika — gunakan `code` bila ada.

---

## 9. Catatan implementasi FE
1. **Jangan buat jurnal dari FE.** Semua posting otomatis & exactly-once di BE.
2. **Halaman akuntansi**: `trial-balance` menaruh total di top-level; `balance-sheet` menyisipkan baris `RETAINED` (`isComputed`); `income-statement` hanya `revenues`/`expenses`/`netIncome`.
3. **Polling vs socket**: outbox drain tidak terlihat FE; cukup baca ulang list/jurnal bila ingin data terbaru.
4. **Idempotency order**: persist `idempotencyKey` per percobaan penjualan (tahan reload dialog) sampai outcome definitif (201/200/4xx kecuali 5xx).
5. **Angka**: semua nominal integer; `net` pada laporan bisa negatif (arah `normalBalance`).
