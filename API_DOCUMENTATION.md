# POS System - API Documentation

**Base URL:** `https://api-bisa-nota.vercel.app`
**Auth:** `Authorization: Bearer <JWT_TOKEN>` header
**Roles:** `super_admin`, `admin`, `kasir`, `user`
**Content-Type:** `application/json` (unless stated otherwise)
**Checkpoint:** reconciled against `master` `c9fe118` on 2026-10-23.

---

## Response Format

### Standard Success (list)
```json
{
  "success": true,
  "message": "Success",
  "data": [],
  "pagination": {
    "total": 0,
    "page": 1,
    "limit": 10,
    "totalPages": 0
  }
}
```

### Standard Success (single)
```json
{
  "success": true,
  "message": "Success",
  "data": {}
}
```

### Success with stats
```json
{
  "success": true,
  "message": "Success",
  "data": [],
  "pagination": { "total": 0, "page": 1, "limit": 10, "totalPages": 0 },
  "stats": {},
  "summary": {}
}
```

### Error
```json
{
  "success": false,
  "message": "Error message here"
}
```

### Text length (BA DR-28)
Typed text is limited per field kind (`api/validation/fieldLimits.js`): person name 100, business/entity name 150, short label 50, unit 20, region 50, postal code 10, address 255, phone 20, email 254, document number / code / barcode 50, payment reference 255, NPWP 20, NITKU 22, bank account 34, vehicle plate 15, hex color 9, URL / image / file path 2048, tenant name 150, notes and descriptions 255 (widened by batch B5, 2026-10-24). Columns that stay narrower keep their own length (account code 20, currency code 10). Text copied from master data (an order line's product name, the cashier name, a PO line's ingredient name) is not limited by field kind.

A longer value is refused with **400**, never cut. From a schema (`validate()`):
```json
{
  "success": false,
  "message": "name: maksimal 50 karakter",
  "errors": [{ "field": "name", "message": "maksimal 50 karakter" }]
}
```
From the database net (any VARCHAR column, any route) and the handlers outside `validate()` (QR order, customer review, account code):
```json
{
  "success": false,
  "code": "VALUE_TOO_LONG",
  "message": "customerName maksimal 100 karakter",
  "field": "customerName",
  "max": 100,
  "errors": [{ "field": "customerName", "message": "customerName maksimal 100 karakter" }]
}
```

---

---

## Auth

### POST `/auth/login`
No auth required. Rate limited: 30 attempts / 15 min.

**Request:**
```json
{
  "userName": "string (required)",
  "password": "string (required)"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Login successful",
  "token": "eyJhbGci...",
  "user": {
    "id": 1,
    "userName": "admin",
    "fullName": "Admin",
    "roleType": "super_admin",
    "store": [1, 2],
    "accessMenu": {}
  }
}
```

---

### POST `/auth/register`
No auth required. Public self-registration: the account is always created as `userType: "user"`, unassigned (`store`/`shift`/`position` are forced to `null`) and NO token is issued — an admin must assign a store via `PUT /auth/change-profile-user` before the account can log in.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `userName` | string | Required |
| `password` | string | Required, min 6 chars |
| `confirmPassword` | string | Required, must match `password` |
| `email` | string | Optional |
| `fullName` | string | Optional |
| `phoneNumber` | string | Optional |
| `gender` | string | Optional |
| `address` | string | Optional |
| `dateOfBirth` | string | Optional, ISO date |
| `placeOfBirth` | string | Optional |

**Response:**
```json
{
  "message": "Success Menyimpan User",
  "data": { "id": 1, "userName": "newuser", "userType": "user", "store": null, "shift": null, "position": null, "employeeID": "581342", "status": "active" }
}
```

---

### POST `/auth/reset-password`
No auth required (rate limited: 5 requests / 15 min). Step 2 of the flow: redeems the emailed one-time token and sets the new password; redeeming revokes every existing session of the account. Request the token via `POST /auth/reset-password/request` (step 1).

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `email` | string | Account email (required) |
| `token` | string | One-time token from the reset email (required) |
| `newPassword` | string | Required, min 6 chars |
| `confirmPassword` | string | Required, must match `newPassword` |

**Response:**
```json
{ "message": "Password berhasil direset. Silakan login dengan password baru." }
```

Key errors: 400 `Email, token, New Password, dan Confirm Password harus diisi`; 400 `New Password dan Confirm Password tidak cocok`; 400 `Password minimal 6 karakter`; 400 `Tautan atur ulang kata sandi tidak valid atau sudah kedaluwarsa...` (unknown/expired token).

---

### POST `/auth/logout`
Auth required.

**Response:**
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

---

### GET `/auth/get-user`
Auth required. Returns the user list of ONE store (each row gains `storeName`/`positionName`); a global `super_admin` must pass `location` (400 `Location wajib diisi`), any other caller always gets their own store and a differing `location` is rejected with 403.

**Query:** `location` (number, required for a global super_admin).

**Response:**
```json
{
  "message": "Success",
  "data": [
    { "id": 1, "userName": "kasir1", "fullName": "Kasir Satu", "roleType": "user", "store": 1, "storeName": "Toko A", "positionName": "Kasir", "status": "active" }
  ]
}
```

Key errors: 400 `Location wajib diisi` / `Location tidak valid`; 403 `Akun Anda belum ditetapkan ke toko`; 403 `Anda hanya dapat mengakses user di toko Anda`; 404 `Location not found` (with `data: []`).

---

### GET `/auth/get-all-user`
Auth required. No query filters and no pagination: returns the caller's full visible audience — global `super_admin`: everyone; store-bound `super_admin`/`admin`: own-store users with `super_admin` rows hidden.

**Response:**
```json
{
  "message": "Success",
  "data": [
    { "id": 1, "userName": "admin", "fullName": "Admin", "roleType": "admin", "store": 1 }
  ]
}
```

---

### GET `/auth/generate-employee-id`
Auth required.

**Response:**
```json
{
  "success": true,
  "data": { "employeeId": "581342" }
}
```

---

### PUT `/auth/change-profile-user`
Auth required (`super_admin` or `admin`). Also used to assign the store of a freshly registered (unassigned) user.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Target user id (required) |
| `store` | number | Store to assign |
| `userType` | string | `admin` or `user` |
| `position` | number | Position id |
| `roleId` | number | Role id (active roles only) |
| `roleType` | string | Role type spelling (alternative to `roleId`) |

**Response:**
```json
{
  "message": "User role updated successfully",
  "data": { "id": 7, "userName": "kasir1", "userType": "user", "store": 1, "position": 2, "roleId": 3, "roleType": "user" }
}
```

Key errors: 404 `User tidak ditemukan`; 404 `User not found or no changes made.`; 403 `Tidak dapat mengubah Super Admin`; 403 `Anda hanya dapat mengubah user di toko Anda`; 403 `Anda hanya dapat menetapkan user ke toko Anda sendiri`; 400 `Role tidak ditemukan`; 400 `Role tidak aktif dan tidak dapat diberikan`; 403 `Anda tidak memiliki izin untuk memberikan role Super Admin`.

---

### PUT `/auth/edit-user`
Auth required. Self-service only: the account is identified by `email` and a user may edit only their own profile (a different target returns 403). Content-Type: `multipart/form-data` when uploading an avatar.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `email` | string | Required; identifies the account (own profile only) |
| `userName` | string | Optional |
| `fullName` | string | Optional |
| `phoneNumber` | string | Optional |
| `gender` | string | Optional |
| `address` | string | Optional |
| `dateOfBirth` | string | Optional |
| `placeOfBirth` | string | Optional |
| `image` | file | Optional avatar upload (multipart field) |

**Response:**
```json
{
  "message": "Success Login",
  "user": { "id": 1, "fullName": "Updated Name", "storeName": "Toko A", "positionName": "Kasir" }
}
```

Key errors: 400 `Email wajib diisi`; 404 `User not found`; 403 `Anda hanya dapat mengubah profil Anda sendiri`.

---

### GET `/auth/context`
Returns the caller's current session plus the server-resolved canonical authorization context. Auth required (Bearer JWT + session); no role restriction.

**Response:**
```json
{
  "message": "Success",
  "data": {
    "session": { "activeTenantId": null, "activeStoreId": null, "version": 1, "expiresAt": "2026-10-20T08:00:00.000Z" },
    "context": {
      "activeTenantId": null,
      "activeStoreId": null,
      "activeRole": "platform_admin",
      "permissions": ["user.manage", "tenant.manage"],
      "assignedStoreIds": [],
      "isPlatformAdmin": true,
      "reason": null
    }
  }
}
```
Note: no `success` field; the session id is deliberately omitted.

Key errors: 401 `{ message: "User Belum Login", code: "UNAUTHENTICATED" }`; 403 `STALE_TENANT_CONTEXT` / `STALE_STORE_CONTEXT` (session names a tenant/store that no longer resolves).

---

### POST `/auth/context/tenant`
Atomically switches the session's active tenant; the active store selection is cleared. Auth required (Bearer JWT + session); the candidate is validated against persisted membership state.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `tenantId` | number | Target tenant id (required) |

**Response:**
```json
{
  "message": "Tenant context updated",
  "data": { "activeTenantId": 1, "activeStoreId": null, "version": 2, "activeRole": "tenant_admin" }
}
```

Key errors: 400 `INVALID_TENANT_ID`; 403 `FOREIGN_TENANT`; 401 `SESSION_REQUIRED`, `SESSION_INVALID`.

---

### POST `/auth/context/store`
Atomically switches the session's active store within the session's active tenant. Auth required (Bearer JWT + session); the store must belong to the tenant and satisfy assignment rules for the resolved role.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `storeId` | number | Target store id (required) |

**Response:**
```json
{
  "message": "Store context updated",
  "data": { "activeTenantId": 1, "activeStoreId": 5, "version": 3, "activeRole": "store_admin" }
}
```

Key errors: 400 `INVALID_STORE_ID`; 403 `FOREIGN_STORE`; 409 `TENANT_NOT_SELECTED` (select a tenant first); 401 `SESSION_REQUIRED`, `SESSION_INVALID`.

---

### DELETE `/auth/context`
Revokes the caller's selected authorization session, clears the `token` cookie and disconnects that session's live sockets. Auth required (Bearer JWT + session).

**Response:**
```json
{ "message": "Context cleared" }
```

Key errors: 401 `{ message: "User Belum Login", code: "UNAUTHENTICATED" }`.

---

### POST `/auth/reset-password/request`
No auth. Sends a one-time password-reset link (15-minute TTL) to the address if it is registered; always returns the same message so registered accounts are not disclosed. Rate limited: 5 requests / 15 min.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `email` | string | Account email (required) |

**Response:**
```json
{ "message": "Jika email terdaftar, tautan atur ulang kata sandi telah dikirim. Cek kotak masuk Anda." }
```

Key errors: 400 `{ "error": "Email wajib diisi" }`; 429 `{ "success": false, "message": "Too many reset requests, try again later." }`.

---

### PUT `/auth/change-user-status`
Activates or deactivates a user account. Auth required (`super_admin` or `admin`). `inactive` sets `disabledAt` and revokes every session of the target in the same transaction; `active` clears it. A store-bound super_admin/admin may only act on users of their own store; only a global super_admin may change a super_admin account.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Target user id (required) |
| `status` | string | `active` or `inactive` (required) |

**Response:**
```json
{
  "message": "Status user berhasil diubah",
  "data": { "id": 7, "userName": "kasir1", "status": "inactive", "disabledAt": "2026-10-19T08:00:00.000Z" }
}
```

Key errors: 400 `ID User wajib diisi`; 400 `Status harus active atau inactive`; 403 `Tidak dapat mengubah Super Admin`; 403 `Anda hanya dapat mengubah user di toko Anda`; 404 `User tidak ditemukan`.

---

---

## Product

### GET `/product/get-product`
Auth required. Products for cashier view.

**Query:**
| Param | Type | Description |
|-------|------|-------------|
| `store` | number | Store ID |
| `nameProduct` | string | Search by name |
| `category` | number | Category ID |
| `page` | number | Page number |
| `limit` | number | Items per page |

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "nameProduct": "Nasi Goreng",
      "category": 1,
      "price": 25000,
      "stock": 100,
      "unit": "pcs",
      "barcode": "8991234567890",
      "image": "https://...",
      "status": "active"
    }
  ]
}
```

---

### GET `/product/get-product-by-super-admin`
Auth required.

**Query:** `page`, `limit`, `search`, `store`.

**Response:** Same as above with pagination. Each product also carries `effectivePrice` (integer): the outlet price for the resolved store when one exists, otherwise the base `price`; `null` when no store is resolved. `price` stays the base price.

---

### GET `/product/get-product-all`
Auth required. Full product list for table.

**Query:** `page`, `limit`, `search`, `store`, `category`.

**Response:** Same as above with pagination.

---

### GET `/product/get-by-id/:id`
Auth required (super_admin/admin).

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "nameProduct": "Nasi Goreng",
    "category": 1,
    "status": "active",
    "price": 25000,
    "costPrice": 15000,
    "stock": 100,
    "minStock": 10,
    "unit": "pcs",
    "baseUnit": "pcs",
    "conversionFactor": "1",
    "barcode": "8991234567890",
    "brand": "Brand X",
    "stores": [1, 2],
    "supplier": 1,
    "tax": { "name": "PPN", "rate": 11 },
    "image": "https://..."
  }
}
```

---

### POST `/product/add-product`
Auth required (super_admin/admin). Content-Type: `multipart/form-data`.

**Request:**
| Field | Type | Required | Default |
|-------|------|----------|---------|
| `nameProduct` | string | **YES** | - |
| `category` | number | **YES** | - |
| `status` | string | No | `active` |
| `description` | string | No | `''` |
| `price` | number | No | `0` |
| `costPrice` | number | No | `0` |
| `stock` | number | No | `0` |
| `minStock` | number | No | `0` |
| `unit` | string | No | `pcs` |
| `baseUnit` | string | No | `pcs` |
| `conversionFactor` | string | No | `"1"` |
| `point` | number | No | `0` |
| `barcode` | string | No | null |
| `brand` | string | No | null |
| `hasModifiers` | boolean | No | `false` |
| `modifiers` | JSON array | No | `[]` |
| `isOption` | boolean | No | `false` |
| `options` | JSON array | No | `[]` |
| `isAvailable` | boolean | No | `true` |
| `stores` | array of numbers | No | null |
| `supplier` | number | No | null |
| `tax` | JSON object | No | null |
| `priceTiers` | JSON array | No | `[]` |
| `currencyId` | number | No | null |
| `currencyCode` | string | No | null |
| `tipeProduk` | string | No | `menu` |
| `composition` | JSON array | No | `[]` |
| `redeemPoints` | number | No | `0` |
| `image` | file | No | null |

**Response:**
```json
{
  "success": true,
  "message": "Product created",
  "data": { "id": 1, "nameProduct": "Nasi Goreng" }
}
```

---

### PUT `/product/edit-product`
Auth required (super_admin/admin). Content-Type: `multipart/form-data`. Same fields as add, all optional.

**Response:**
```json
{
  "success": true,
  "message": "Product updated",
  "data": { "id": 1, "nameProduct": "Nasi Goreng Updated" }
}
```

---

### DELETE `/product/delete-product/:id`
Auth required (super_admin/admin).

**Response:**
```json
{
  "success": true,
  "message": "Product deleted"
}
```

---

### GET `/product/template`
Auth required. Returns Excel template file.

### GET `/product/download`
Auth required. Returns Excel file with product data.

### POST `/product/import`
Auth required. Content-Type: `multipart/form-data`. Field: `file` (Excel).

**Response:**
```json
{
  "success": true,
  "message": "Import successful",
  "imported": 10,
  "failed": 2,
  "errors": ["Row 3: name is required", "Row 7: category not found"]
}
```

---

---

## Category

### GET `/category/get-category-all`
Auth required.

**Query:** `page`, `limit`, `search`.

**Response:**
```json
{
  "success": true,
  "data": [
    { "id": 1, "name": "Makanan", "status": "active", "store": [1, 2] }
  ],
  "pagination": { "total": 20, "page": 1, "limit": 10, "totalPages": 2 }
}
```

---

### GET `/category/get-category/:id`
Auth required.

**Response:**
```json
{
  "success": true,
  "data": { "id": 1, "name": "Makanan", "description": "All food items", "status": "active" }
}
```

---

### POST `/category/add-new-category`
Auth required (super_admin/admin).

**Request:**
```json
{
  "name": "string (required)",
  "description": "string (optional)",
  "image": "string (optional)",
  "icon": "string (optional)",
  "status": "active | inactive | draft (default: active)",
  "store": "array of numbers (optional)"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Category created",
  "data": { "id": 1, "name": "Makanan" }
}
```

---

### PUT `/category/edit-category/:id`
Auth required (super_admin/admin). Same fields, all optional.

### DELETE `/category/delete-category/:id`
Auth required (super_admin/admin).

### GET `/category/download-template`, GET `/category/download`, POST `/category/upload-excel`
Auth required (super_admin/admin). Import uses multipart/form-data with `file` field.

---

### GET `/category/download`
Auth required (super_admin/admin). Excel export of all categories.

**Response:** `.xlsx` attachment (`category-data.xlsx`); columns: ID, Name, Description, Value, isActive (`TRUE`/`FALSE`).

---

### POST `/category/upload-excel`
Auth required (super_admin/admin). Excel import (`multipart/form-data`, field `file`) from a sheet named `Category` with headers `No, Name, Description, Store, isActive`. Store names resolve against active locations (blank / "all stores" / "semua toko" → global); non-super_admin may only import into its own store; duplicates by name are skipped.

**Body (file columns):** No, Name, Description, Store, isActive.

**Response (201):**
```json
{
  "success": true,
  "message": "Berhasil upload 3 dari 4 kategori",
  "data": { "total": 4, "created": 3, "skipped": 1, "skippedNames": ["Kategori \"Makanan\" sudah terdaftar"] }
}
```

Key errors: 400 `Tidak ada file yang diupload`; 400 `Sheet "Category" tidak ditemukan`; 400 `Header tidak valid. Pastikan menggunakan template yang benar`; 400 `Tidak ada data yang valid untuk diupload`.

---

---

## Location (Store)

### GET `/location/get-location-public`
No auth. Returns active locations (for registration dropdown).

**Response:**
```json
{
  "success": true,
  "data": [
    { "id": 1, "name": "Store Jakarta", "address": "Jl. Sudirman 123" }
  ]
}
```

---

### GET `/location/get-location-all`
Auth required (`super_admin` sees all; `admin` is scoped to its own store by the controller).

**Query:** `page`, `limit`, `search`.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Store Jakarta",
      "address": "Jl. Sudirman 123",
      "city": "Jakarta",
      "province": "DKI Jakarta",
      "status": "active",
      "category": "restoran",
      "dailyTarget": 5000000
    }
  ],
  "pagination": { "total": 5, "page": 1, "limit": 10, "totalPages": 1 }
}
```

---

### GET `/location/get-location-detail/:locationId`
Auth required.

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "Store Jakarta",
    "address": "Jl. Sudirman 123",
    "detailLocation": "Lantai 2",
    "city": "Jakarta",
    "province": "DKI Jakarta",
    "district": "Setiabudi",
    "village": "Karet",
    "postalCode": "12190",
    "latitude": "-6.2088",
    "longitude": "106.8456",
    "mainBranch": true,
    "managerName": "Budi",
    "email": "jakarta@example.com",
    "phoneNumber": "08123456789",
    "category": "restoran",
    "status": "active",
    "openingHours": { "mon": "08:00-22:00" },
    "dailyTarget": 5000000
  }
}
```

---

### GET `/location/generate-id`
Auth required (super_admin).

**Response:**
```json
{
  "success": true,
  "data": "LOC-2026-001"
}
```

---

### POST `/location/add-new-location`
Auth required (super_admin).

**Request:**
```json
{
  "name": "string (required)",
  "address": "string (optional)",
  "detailLocation": "string (optional)",
  "city": "string (optional)",
  "province": "string (optional)",
  "district": "string (optional)",
  "village": "string (optional)",
  "postalCode": "string (optional)",
  "latitude": "string (optional)",
  "longitude": "string (optional)",
  "mainBranch": "boolean (default: false)",
  "description": "string (optional)",
  "openingHours": "JSON object (optional)",
  "managerName": "string (optional)",
  "email": "string (optional)",
  "phoneNumber": "string (optional)",
  "category": "string (optional)",
  "status": "active | inactive | draft (default: active)",
  "socialMedia": "JSON object (optional)",
  "dailyTarget": "number (default: 0)",
  "image": "string (optional)"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Location created",
  "data": { "id": 1, "name": "Store Jakarta", "locationId": "LOC-2026-001" }
}
```

---

### PUT `/location/edit-location`
Auth required (super_admin). Same fields, all optional.

### DELETE `/location/delete-location`
Auth required (super_admin).

---

### GET `/location/store-configuration`
Auth required via canonical permission `store.manage` against the persisted target (not the legacy `requireRole`). Lists the stores readable for the active tenant (platform super_admin without an active tenant reads platform-wide), with configuration fields.

**Query:**
| Param | Type | Description |
|-------|------|-------------|
| `page` | number | Default 1 |
| `limit` | number | Default 20, capped at 100 |

**Response:**
```json
{
  "success": true,
  "message": "Success",
  "data": [
    {
      "id": "loc-001",
      "storeId": "ST-001",
      "name": "Store Jakarta",
      "status": "active",
      "isActive": true,
      "description": null,
      "timezone": "Asia/Jakarta",
      "maxActiveParkedCarts": null,
      "parkedCartTtlMinutes": null
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

Key errors: 403 `{ "message": "Akses Ditolak - Anda tidak memiliki izin", "code": "FORBIDDEN" }` for a non-platform caller without an active tenant.

---

### GET `/location/store-configuration/:id`
Auth required via canonical permission `store.manage`. Reads one store's configuration; admissible exactly when configurable (terminal stores stay readable).

**Response:**
```json
{
  "success": true,
  "message": "Success",
  "data": {
    "id": "loc-001",
    "storeId": "ST-001",
    "name": "Store Jakarta",
    "status": "active",
    "description": "Cabang pusat",
    "timezone": "Asia/Jakarta",
    "maxActiveParkedCarts": 10,
    "parkedCartTtlMinutes": 120,
    "openingHours": [{ "day": "Monday", "open": "08:00", "close": "22:00", "is24Hours": false }],
    "socialMedia": []
  }
}
```

Key errors: 404 `Location not found.` (missing/soft-deleted); 403 `FORBIDDEN` (malformed, foreign, or tenantless-for-non-platform id — no existence disclosure). Response carries `Cache-Control: no-cache, no-store, must-revalidate`.

---

### PUT `/location/store-configuration`
Auth required via canonical permission `store.manage` (multipart-capable; `upload` runs before the gate only to parse the body). Strict schema: unknown keys are rejected and ownership/lifecycle keys (`store`, `tenantId`, `status`, ...) are not writable.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Required row selector, format `loc-N` |
| `name` | string | Optional |
| `phoneNumber`, `email`, `address`, `detailLocation`, `city`, `province`, `district`, `village`, `postalCode` | string | Optional |
| `description`, `category`, `managerName`, `latitude`, `longitude` | string | Optional |
| `openingHours`, `socialMedia` | JSON string/array/object | Optional; malformed JSON string → 400 |
| `timezone` | string | IANA timezone |
| `mainBranch` | boolean/string | Optional |
| `dailyTarget`, `maxActiveParkedCarts`, `parkedCartTtlMinutes` | number/null | Optional |
| `image` | file or string/null | Uploaded file wins; explicit value clears/replaces |

**Response:**
```json
{
  "success": true,
  "message": "Store configuration updated successfully.",
  "data": { "id": "loc-001", "name": "Store Jakarta", "status": "active", "timezone": "Asia/Jakarta" }
}
```

Key errors: 404 `Location not found.`; 422 `{ "code": "STORE_STATUS_IRREVERSIBLE", "field": "currentStatus" }` for closed/retired/quarantined stores; 409 `Gambar sudah digunakan oleh lokasi lain` (duplicate image).

---

### POST `/location/archive-location`
Auth required (super_admin/admin; a client admin acts on its own store only, the platform super_admin on any outlet). Reversible closure: turns the outlet status into `archived`.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `id` | string/number | Required; accepts `loc-N` or raw id |
| `reason` | string | Required |

**Response:**
```json
{ "success": true, "message": "Location archived", "data": { "id": 1, "status": "archived" } }
```

Key errors: 400 `LOCATION_ID_REQUIRED` / `INVALID_LOCATION_ID`; 400 `ARCHIVE_REASON_REQUIRED`; 400 `STORE_ALREADY_ARCHIVED`; 403 `STORE_SCOPE_DENIED`; 404 `LOCATION_NOT_FOUND`; 409 `STORE_HAS_OPEN_REGISTERS` / `STORE_HAS_UNSETTLED_ORDERS` / `STORE_HAS_IN_TRANSIT_TRANSFERS`.

---

### POST `/location/reactivate-location`
Auth required (super_admin/admin; same store scoping as archive). Reopens an archived outlet.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `id` | string/number | Required |
| `reason` | string | Required |

**Response:**
```json
{ "success": true, "message": "Location reactivated", "data": { "id": 1, "status": "active" } }
```

Key errors: 400 `REACTIVATE_REASON_REQUIRED`; 400 `STORE_NOT_ARCHIVED`; 403 `STORE_SCOPE_DENIED`; 404 `LOCATION_NOT_FOUND`.

---

---

## Member

### GET `/member/get-member`
Auth required.

**Query:** `page`, `limit`, `search`, `tier`, `status`, `sortBy`, `store`.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "nameMember": "John Doe",
      "phoneNumber": "08123456789",
      "email": "john@example.com",
      "point": 1500,
      "tier": { "id": 1, "name": "Gold", "discountPercent": 10 },
      "status": "active"
    }
  ],
  "pagination": { "total": 100, "page": 1, "limit": 10, "totalPages": 10 },
  "stats": { "total": 100, "active": 80, "draft": 10, "inactive": 10 }
}
```

---

### GET `/member/get-member/:id`
Auth required.

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "nameMember": "John Doe",
    "phoneNumber": "08123456789",
    "email": "john@example.com",
    "point": 1500,
    "tier": { "id": 1, "name": "Gold" },
    "birthDate": "1990-01-01",
    "gender": "male",
    "address": "Jl. Melati 5",
    "status": "active"
  }
}
```

---

### POST `/member/add-new-member`
Auth required (super_admin/admin).

**Request:**
```json
{
  "nameMember": "string (required)",
  "phoneNumber": "string (optional)",
  "email": "string (optional)",
  "point": "number (default: 0)",
  "tier": "number (optional)",
  "birthDate": "string (optional)",
  "gender": "string (optional)",
  "address": "string (optional)",
  "store": "number (optional)",
  "status": "string (default: active)"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Member created",
  "data": { "id": 1, "nameMember": "John Doe" }
}
```

---

### PUT `/member/edit-member/:id`
Auth required (super_admin/admin). Same fields, all optional.

### DELETE `/member/delete-member/:id`
Auth required (super_admin/admin).

### PUT `/member/edit-point-member/:phoneNumber`
Auth required.

**Request:**
```json
{ "point": "number (required)" }
```

**Response:**
```json
{
  "success": true,
  "message": "Points updated",
  "data": { "point": 2000 }
}
```

---

---

## Member Tier

### GET `/member-tier/get-all`
Auth required.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Gold",
      "minPoints": 1000,
      "maxPoints": 5000,
      "discountPercent": 10,
      "benefits": "Free shipping, Priority service",
      "members": 25
    }
  ]
}
```

---

### GET `/member-tier/detail/:id`
Auth required.

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "Gold",
    "minPoints": 1000,
    "maxPoints": 5000,
    "discountPercent": 10,
    "benefits": "Free shipping",
    "members": 25
  }
}
```

---

### GET `/member-tier/get-by-points`
Auth required. **Query:** `points` (number).

**Response:**
```json
{
  "success": true,
  "data": { "id": 1, "name": "Gold", "discountPercent": 10 }
}
```

---

### POST `/member-tier/add`
Auth required (super_admin/admin).

**Request:**
```json
{
  "name": "string (required)",
  "minPoints": "number (default: 0)",
  "maxPoints": "number (optional)",
  "discountPercent": "number (default: 0)",
  "benefits": "string (default: '')"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Tier created",
  "data": { "id": 1, "name": "Gold" }
}
```

---

### PUT `/member-tier/edit/:id`
Auth required (super_admin/admin). Same fields, all optional.

### DELETE `/member-tier/delete/:id`
Auth required (super_admin/admin).

### POST `/member-tier/update-members`
Auth required (super_admin/admin). Batch update member tier assignments.

---

---

## Order

### POST `/order/create`
Auth required.

**Request:**
```json
{
  "store": "number (required)",
  "tableId": "number (optional)",
  "customerId": "number (optional)",
  "customerName": "string (optional)",
  "customerPhone": "string (optional)",
  "items": [
    {
      "product": "number (required)",
      "quantity": "number (required)",
      "price": "number (default: 0)",
      "notes": "string (default: '')",
      "modifiers": "array (default: [])",
      "variant": "string (optional)"
    }
  ],
  "discountId": "number (optional)",
  "promoCode": "string (optional)",
  "discountType": "none | percent | nominal (default: none)",
  "discountValue": "number (default: 0)",
  "notes": "string (default: '')",
  "source": "pos | online | qr | waiter (default: pos)",
  "cashierId": "number (optional)",
  "cashierName": "string (optional)",
  "shiftId": "number (optional)",
  "paymentMethod": "cash | qris | debit | credit | transfer | e-wallet | points | other (required)",
  "idempotencyKey": "string (required — retries with the same key never create a second sale)",
  "referenceNumber": "string (optional; required by some tenders)"
}
```

**Response:** `201` (no `success` flag)
```json
{
  "message": "Order created successfully",
  "data": {
    "id": 1,
    "orderNumber": "ORD-20260711-001",
    "store": 1,
    "status": "pending",
    "items": [...],
    "subTotal": 50000,
    "total": 55500
  }
}
```

Key errors: 422 `{"error":"An idempotencyKey is required for a counter sale","code":"IDEMPOTENCY_KEY_REQUIRED"}`; 422 `{"error":"A payment method is required for a counter sale","code":"PAYMENT_METHOD_REQUIRED"}`.

---

### GET `/order/get-orders`
Auth required.

**Query:** `store` (number), `page` (number), `limit` (number), `status` (string), `startDate`, `endDate`.

**Response:**
```json
{
  "message": "Success",
  "data": [
    {
      "id": 1,
      "orderNumber": "ORD-20260711-001",
      "store": 1,
      "status": "paid",
      "total": 55500,
      "items": [...],
      "createdAt": "2026-07-11T10:30:00Z"
    }
  ],
  "pagination": { "total": 50, "page": 1, "limit": 10, "totalPages": 5 }
}
```

---

### GET `/order/get-order/:id`
Auth required.

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "orderNumber": "ORD-20260711-001",
    "store": 1,
    "tableId": 5,
    "customerId": 1,
    "customerName": "John",
    "status": "served",
    "items": [
      { "product": 1, "productName": "Nasi Goreng", "quantity": 2, "price": 25000, "status": "served" }
    ],
    "subTotal": 50000,
    "discountValue": 5000,
    "taxRate": 11,
    "total": 50500,
    "paymentMethod": "cash",
    "createdAt": "2026-07-11T10:30:00Z"
  }
}
```

---

### GET `/order/kitchen`
Auth required. **Query:** `store` (number).

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "orderNumber": "ORD-20260711-001",
      "tableNumber": "5",
      "items": [
        { "product": 1, "productName": "Nasi Goreng", "quantity": 2, "status": "pending", "notes": "pedas" }
      ],
      "source": "pos"
    }
  ]
}
```

---

### PUT `/order/update-status`
Auth required.

**Request:**
```json
{
  "id": "number (required)",
  "store": "number (optional, store scope)",
  "status": "pending | confirmed | preparing | ready | served | paid | cancelled | void (required)",
  "changedBy": "number (optional)",
  "changedByName": "string (optional)",
  "notes": "string (default: '')",
  "paymentMethod": "cash | qris | debit | credit | transfer | e-wallet | points | other (settlement, see below)",
  "cashAmount": "number (cash settlement only)",
  "changeAmount": "number (cash settlement only)",
  "reason": "string (required when cancelling a paid order)"
}
```

**Paid settlement (DR-04):** when `status` is `paid`, the transition settles
with a complete tender. The settlement reuses the order's existing payment
method when one is already stored (e.g. a QR order created with a method);
otherwise `paymentMethod` is required in the request and must be one of the
canonical 8 values above. `cashAmount`/`changeAmount` are accepted only for
`cash`: omitting both means exact tender (`cashReceived` = amount due,
`changeGiven` = 0); supplying one requires the other, both must be integer
rupiah, `cashAmount` must cover the amount due, and
`cashAmount - changeAmount` must exactly equal the amount due. Supplying cash
detail for a non-cash method is rejected. The order's register attribution is
reused when already set; otherwise the server resolves the store's currently
open register. If no valid register is available, settlement fails closed.
Tender validation runs inside the same database transaction as the paid
transition (order update, payment row, status history, stock deduction), so a
failed settlement leaves the order unpaid with no partial payment row or
drawer attribution. When a payment row already exists for the order
(e.g. split-bill flows), the existing settlement behavior is kept and no new
tender is required. The stored/validated value is `e-wallet` (hyphenated);
`points` is a legitimate method used when loyalty points cover the total.

**Points settlement (DR-04 P2-1):** `paymentMethod: points` is a valid
paid-settlement method (also when it is the order's stored method and the
request omits one). It redeems the order's final payable `totalPrice` in full
from the member attached to the order — 1 point = Rp1, no partial redemption,
no recomputation of tax/service/discount. The member is resolved server-side
from the order's own `customerId` only: the request carries just
`paymentMethod: "points"`, and any client-supplied `customerId`, `memberId` or
`redeemedPoints` is ignored. Guest (no-member) orders cannot settle with
points. Inside the settlement transaction the member row is locked, its store
is checked against the settlement store (a member with no store is accepted),
and the balance is checked under that lock before exactly `-totalPrice` is
deducted; when `totalPrice` > 0, one `member_point_history` row is written
(`pointsChange` = `-totalPrice`, `transactionId` = order id), while a
zero-total order settles with no point movement and no history row. The
deduction, point history,
payment row (`typePayment: points`, `cashReceived: null`, `changeGiven: 0`),
register attribution and order settlement commit or roll back together, so a
failure leaves the order unpaid with no payment row, no deduction and no point
history. A replay of an already-settled order (an existing payment row, or an
order already `paid`) does not deduct points again. Settlement never awards
earned points. Create-order `redeemedPoints` semantics are unchanged.

**Response:**
```json
{ "success": true, "message": "Status updated" }
```

**Errors:** unknown `paymentMethod` values and malformed bodies fail request
validation with `400`. Business validation failures return `422`, including a
missing paid-settlement tender
(`paymentMethod is required to settle an order to paid`), invalid cash tender
(`cashAmount/changeAmount are only valid for cash payments`,
`Both cashAmount and changeAmount are required when either is supplied`,
`cashAmount/changeAmount must be numeric`,
`cashAmount/changeAmount must be integer rupiah amounts`,
`changeGiven cannot be negative`,
`cashAmount is less than the amount due`,
`cashAmount minus changeAmount must exactly equal the amount due`), and
missing register attribution
(`No store context to resolve an open cash register for settlement`,
`No open cash register for this store; open a register before settling`), and
points settlement failures (`Order has no attached member; points settlement requires a member`
for a guest order or a missing member,
`Member does not belong to this store`,
`Insufficient point balance`).

---

### PUT `/order/update-item-status`
Auth required.

**Request:**
```json
{
  "id": "number (required)",
  "itemId": "number (required)",
  "itemStatus": "string (required)"
}
```

**Response:**
```json
{ "success": true, "message": "Item status updated" }
```

---

### GET `/order/customer-menu`
No auth. **Query:** `store` (number).

#### ~~GET `/order/customer-member`~~ (removed)
**Removed 2026-10-23.** The endpoint is no longer mounted; use staff-verified member lookup at settlement. QR `customer-create` rejects a client-supplied `customerId` with `MEMBER_ATTACH_REQUIRES_STAFF`.

### POST `/order/customer-create`
No auth. Same structure as `/order/create`, except `customerId` is rejected with `MEMBER_ATTACH_REQUIRES_STAFF`; staff attach a verified member at settlement. Closed/archived outlets return `STORE_CLOSED`/`STORE_ARCHIVED`. The charged totals come from the same pricing as `/order/customer-quote`: the best automatic promo campaign for the outlet is applied, and PPN is computed on the discounted subtotal.

### POST `/order/customer-quote`
No auth; rate-limited (200 / 15 min per store + IP). Read-only quote for the diner's summary — nothing is written and stock is not checked. Uses the same item pricing, campaign and PPN resolver as `/order/customer-create`, so the quoted total is the total the order will charge.

**Request:**
```json
{ "store": 1, "items": [{ "productId": 7, "quantity": 2, "options": [], "modifiers": [] }, { "bundleId": 3, "quantity": 1 }] }
```

**Response:**
```json
{
  "success": true,
  "data": {
    "subTotal": 100000,
    "discountAmount": 10000,
    "discountApplied": [{ "campaignId": 4, "name": "Diskon 10%", "amount": 10000 }],
    "taxRate": 11,
    "taxAmount": 9900,
    "serviceChargeAmount": 0,
    "totalPrice": 99900,
    "items": [{ "index": 0, "productId": 7, "bundleId": null, "quantity": 2, "unitPrice": 50000, "subtotal": 100000 }]
  }
}
```

Key errors: 400 `store and items are required` / non-positive quantity / product or bundle not available (`PRODUCT_NOT_AVAILABLE`); 403 price override; 404 `Store not found`; 409 `STORE_ARCHIVED`; 400 `PPN_MISSING` when the outlet has no PPN configured.

---

### POST `/order/quote`
Read-only server quote for the counter checkout — prices the exact payload `/order/create` would charge (items, discounts, promo, member tier, redeemed points, PPN, service charge). Auth required; store scope: `super_admin` names the store in the body, any other role is pinned to its own store (a supplied store that differs is rejected). No `success` flag in this envelope.

**Body:** validated with the same schema as `/order/create`. Fields read by the quote:
| Field | Type | Description |
|-------|------|-------------|
| `store` | number | Required for super_admin; other roles must match their own store |
| `items` | object[] | Required, min 1. Each item: `product` / `productId`, `quantity`, optional `price`, `expectedPrice` (client price echo), `priceOverride` (admin only), `notes`, `modifiers`, `variant`, `bundleId` + `bundleName` for bundles |
| `discountId` | number | Optional explicit discount |
| `promoCode` | string | Optional promo code (active, in date window) |
| `customerId` | number | Optional member; store-scoped (404 `MEMBER_NOT_FOUND`, 403 `MEMBER_OUT_OF_SCOPE`) |
| `redeemedPoints` | number | Optional points redemption (requires `customerId`) |

**Response:**
```json
{
  "data": {
    "subTotal": 50000,
    "discountAmount": 5000,
    "discountSource": "discount",
    "pointDiscountAmount": 0,
    "redeemedPoints": 0,
    "taxRate": 11,
    "taxAmount": 4950,
    "serviceChargeRate": 0,
    "serviceChargeAmount": 0,
    "totalPrice": 49950,
    "totalQuantity": 2
  }
}
```

Key errors: 400 invalid/missing store authorization (`{"message":"Invalid or missing store authorization"}`); 401 `{"message":"Unauthorized store access"}` (non-super_admin supplied a different store); 400 request-shape errors use the standard `{"success":false,"message","errors"}` envelope, business refusals use `{"message","code"}` or `{"error","code"}`; 400 with codes `INVALID_QUANTITY`, `PRODUCT_NOT_FOUND`, `PRODUCT_NOT_AVAILABLE`, `INSUFFICIENT_STOCK`, `BUNDLE_NOT_FOUND`, `BUNDLE_NOT_AVAILABLE`, `INVALID_EXPECTED_PRICE`, `INVALID_PRICE_OVERRIDE`, `PRICE_OVERRIDE_NOT_ALLOWED`; 403 `FORBIDDEN` (price override by non-admin); 409 `PRICE_CHANGED` `{"code":"PRICE_CHANGED","message":...,"items":[{ "index","productId","expectedPrice","currentPrice" }]}`; 404 `MEMBER_NOT_FOUND`; 403 `MEMBER_OUT_OF_SCOPE`; 400 `customerId is required when redeeming points` / `Insufficient point balance` / `redeemedPoints must be a non-negative integer`.

---

### GET `/order/customer-orders`
No auth. Lists QR orders (`source: "qr"`) for one table of one store, newest first.

**Query:**
| Field | Type | Description |
|-------|------|-------------|
| `store` | number | Required |
| `tableId` | number | Required, must belong to the store |
| `session` | string | Optional session filter (applied when the order table has the column) |
| `page` | number | Default 1 |
| `limit` | number | Default 20 |

**Response:**
```json
{
  "success": true,
  "message": "Success",
  "data": [
    {
      "id": 1, "orderNumber": "ORD-20261018-001", "status": "pending",
      "subTotal": 50000, "discountAmount": 0, "taxRate": 11, "taxAmount": 5500,
      "serviceChargeAmount": 0, "totalPrice": 55500, "totalQuantity": 2,
      "customerName": "John", "paymentMethod": "qris", "paymentStatus": "unpaid",
      "source": "qr", "createdAt": "2026-10-18T10:00:00.000Z", "tableId": 5, "splitCount": 0,
      "items": [{ "id": 9, "product": 3, "productName": "Nasi Goreng", "quantity": 2, "price": 25000, "totalPrice": 50000, "notes": "", "options": null, "modifiers": [], "status": "pending", "bundleId": null, "bundleName": null }],
      "table": { "name": "Meja 5" }
    }
  ],
  "pagination": { "total": 1, "page": 1, "limit": 20, "totalPages": 1 }
}
```

Key errors: 400 `{"message":"store is required"}` / `"Invalid store value"` / `"tableId is required"` / `"Invalid table value"` / `"Table not found"`.

---

### GET `/order/customer-order/:token`
No auth. Public order status by the order's opaque `publicToken` (never the database id). Envelope has no `success` flag.

**Response:**
```json
{
  "data": {
    "id": 1, "orderNumber": "ORD-20261018-001", "status": "pending",
    "totalPrice": 55500, "totalQuantity": 2, "customerName": "John",
    "createdAt": "2026-10-18T10:00:00.000Z", "tableId": 5,
    "paymentMethod": "qris", "paymentStatus": "unpaid", "splitCount": 0,
    "items": [{ "id": 9, "productName": "Nasi Goreng", "quantity": 2, "price": 25000, "totalPrice": 50000, "status": "pending" }],
    "table": { "name": "Meja 5" }
  }
}
```

Key errors: 404 `{"message":"Order not found"}` (unknown token or missing param); 500 `{"error":"Internal Server Error"}`.

---

### GET `/order/customer-reviews`
No auth. Published reviews for a product, newest first.

**Query:**
| Field | Type | Description |
|-------|------|-------------|
| `productId` | number | Required |
| `store` | number | Optional store filter |

**Response:**
```json
{
  "success": true,
  "message": "Success",
  "data": {
    "productId": "3",
    "reviews": [
      { "id": 1, "productId": 3, "store": 1, "userName": "Anonim", "rating": 5, "comment": "Enak", "orderId": null, "deviceId": null, "status": "published", "createdAt": "2026-10-18T10:00:00.000Z" }
    ],
    "averageRating": 5,
    "totalReviews": 1
  }
}
```

Key errors: 400 `{"success":false,"message":"productId is required"}`.

---

### POST `/order/customer-review`
No auth. Submits a product review; auto-publishes unless `REVIEW_AUTO_PUBLISH=false` (then `status: "pending"`).

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `productId` | number | Required |
| `rating` | number | Required, integer 1–5 |
| `name` / `userName` | string | Optional display name (default `Anonim`, max 100) |
| `comment` | string | Optional (max 2000) |
| `store` / `storeId` | number | Optional; when present the product must be orderable at that store |
| `orderId` | number | Optional; must exist, belong to the same store and contain the reviewed product |
| `deviceId` | string | Optional; one review per (productId, deviceId) — a repeat returns the earlier review |

**Response:** `201`
```json
{ "success": true, "message": "Review submitted", "data": { "id": 1, "productId": 3, "userName": "Anonim", "rating": 5, "comment": "Enak", "status": "published" } }
```

Key errors: 400 `productId and rating are required`; 400 `rating must be an integer between 1 and 5`; 400 `Product is not available at this store`; 400 `Invalid order for this review`; 400 `This product is not part of the claimed order`; 404 `Product not found`; duplicate same-device submission returns `200 {"success":true,"message":"Review already submitted","data":{...}}`.

---

### GET `/order/customer-tax-rate`
No auth. Resolves the active PPN rate (and service-charge rate) the customer channel is charged.

**Query:**
| Field | Type | Description |
|-------|------|-------------|
| `store` | number | Required |
| `channel` | string | `counter` (default) or `qr` — `qr` never charges service charge and returns `serviceChargeRate: null` |

**Response:**
```json
{ "data": { "rate": 11, "serviceChargeRate": 5 } }
```
For `channel=qr`: `{"data":{"rate":11,"serviceChargeRate":null}}`.

Key errors: 400 `{"message":"store is required"}`; 400 `{"message":"channel must be counter or qr"}`; 400 `PPN_MISSING` `{"message":"PPN tax configuration is missing for this outlet (store 1); configure an active PPN rate before selling","code":"PPN_MISSING"}`.

---

### GET `/order/receipt-html/:token`
No auth. Returns a printable HTML receipt (invoice settings applied: logo, store header, footer) for the order identified by its `publicToken`.

**Response:** `200` with `Content-Type: text/html; charset=utf-8` (HTML document, not JSON).

Key errors: 404 sends HTML `<h1>Order not found</h1>`; 500 sends HTML `<h1>Internal Server Error</h1>`.

---

---

## Table

### GET `/table/get-tables`
Auth required. **Query:** `store` (number).

**Response:**
```json
{
  "success": true,
  "data": [
    { "id": 1, "tableNumber": "T1", "capacity": 4, "status": "available", "store": 1 },
    { "id": 2, "tableNumber": "T2", "capacity": 2, "status": "occupied", "store": 1 }
  ]
}
```

---

### GET `/table/get-tables-with-orders`
Auth required. **Query:** `store` (number).

### GET `/table/get-availability`
Auth required. **Query:** `store`, `date`, `time`.

### POST `/table/create`
Auth required (super_admin/admin).

**Request:**
```json
{
  "tableNumber": "string (required)",
  "capacity": "number (default: 4)",
  "status": "available | occupied | reserved | maintenance (default: available)",
  "description": "string (optional)",
  "store": "number (optional)"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Table created",
  "data": { "id": 1, "tableNumber": "T1", "capacity": 4, "status": "available" }
}
```

---

### PUT `/table/update/:id`
Auth required (super_admin/admin). Same fields, all optional.

### DELETE `/table/delete/:id`
Auth required (super_admin/admin).

### PUT `/table/update-status/:id`
Auth required.

**Request:**
```json
{ "status": "available | occupied | reserved | maintenance (required)" }
```

---

---

## Discount

### GET `/discount/get-discount-by-location`
Auth required. **Query:** `store` (number).

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Diskon Lebaran",
      "type": "percent",
      "value": 10,
      "maximumDiscount": 50000,
      "minimumOrder": 100000,
      "code": "LEBARAN10",
      "status": true,
      "startDate": "2026-04-01",
      "endDate": "2026-04-30"
    }
  ]
}
```

---

### GET `/discount/get-discount`
Auth required. **Query:** `page`, `limit`, `search`, `store`.

**Response:**
```json
{
  "success": true,
  "data": [...],
  "pagination": { "total": 10, "page": 1, "limit": 10, "totalPages": 1 }
}
```

---

### GET `/discount/get-discount/:id`
Auth required.

### GET `/discount/lookup-by-code/:code`
No auth.

**Response:**
```json
{
  "success": true,
  "data": { "id": 1, "name": "Diskon Lebaran", "type": "percent", "value": 10, "code": "LEBARAN10" }
}
```

---

### POST `/discount/add-new-discount`
Auth required (super_admin/admin).

**Request:**
```json
{
  "name": "string (required)",
  "type": "percent | nominal (required)",
  "value": "number (required)",
  "store": "number (optional)",
  "maximumDiscount": "number (default: 0)",
  "minimumOrder": "number (default: 0)",
  "startDate": "string (optional, ISO date)",
  "endDate": "string (optional, ISO date)",
  "code": "string (optional)",
  "conditions": "JSON object (optional, default: {})",
  "status": "boolean (default: true)",
  "description": "string (optional)"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Discount created",
  "data": { "id": 1, "name": "Diskon Lebaran" }
}
```

---

### PUT `/discount/edit-discount/:id`
Auth required (super_admin/admin). Same fields, all optional.

### DELETE `/discount/delete-discount/:id`
Auth required (super_admin/admin).

### GET `/discount/template`, GET `/discount/download`, POST `/discount/import`
Auth required. Import uses multipart/form-data with `file` field.

---

### GET `/discount/download`
Auth required (super_admin only). Exports discounts as an `.xlsx` attachment; columns: ID, Name, Type, Value, Start Date, End Date, Minimum Purchase, Description, Is Active, Created At.

**Query:**
| Field | Type | Description |
|-------|------|-------------|
| `store` | number | Optional filter |

**Response:** `200` binary xlsx with `Content-Disposition: attachment; filename=discounts-data.xlsx` (no JSON envelope).

Key errors: 500 `{"success":false,"message":"Terjadi Kesalahan Internal Server"}`.

---

### POST `/discount/import`
Auth required (super_admin only). Multipart Excel import (`.xlsx`). Columns: Name, Type (`percentage` / `nominal`), Value, Start Date, End Date, Min Purchase, Description, Is Active. Duplicates by name in the same store are skipped, not updated.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `file` | file | Required multipart field (Excel workbook) |

**Response:** `201`
```json
{ "success": true, "message": "Successfully imported 2 from 2 discounts", "data": { "total": 2, "created": 2, "skipped": 0 } }
```
`data.skippedNames` (string array) is present only when at least one row was skipped.

Key errors: 400 `{"success":false,"message":"No file uploaded"}`; 400 `{"success":false,"message":"Validation errors occurred","errors":["Row 3: Invalid type. Must be 'percentage' or 'nominal'"]}`.

---

---

## Shift

### GET `/shift/get-shift`
Auth required. **Query:** `page`, `pageSize`, `status` (default `all`), `search`, `store`.

**Response:**
```json
{
  "success": true,
  "message": "Success",
  "data": [
    { "id": 1, "nama_shift": "Pagi", "jam_mulai": "08:00", "jam_selesai": "16:00", "status": "active" }
  ],
  "pagination": { "currentPage": 1, "pageSize": 10, "totalItems": 5, "total": 5, "totalPages": 1 },
  "stats": { "total": 5, "active": 4, "draft": 1, "inactive": 0 }
}
```

---

### GET `/shift/dropdown`
Auth required. Non-standard envelope: `{ status: 200, data }`.

**Response:**
```json
{
  "status": 200,
  "data": [
    { "id": 1, "storeId": 1, "shiftName": "Pagi", "startTime": "08:00", "endTime": "16:00", "karyawan": [], "statusShift": "active" }
  ]
}
```

---

### POST `/shift/add-new-shift`
Auth required (super_admin/admin).

**Request:**
```json
{
  "nama_shift": "string (required)",
  "jam_mulai": "string (required, e.g. 08:00)",
  "jam_selesai": "string (required, e.g. 16:00)",
  "tipe_shift": "string (default: '')",
  "tanggal_mulai": "string (optional)",
  "tanggal_selesai": "string (optional)",
  "karyawan": "JSON array (default: [])",
  "status": "active | inactive | draft (default: active)",
  "store": "number (optional)"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Shift created",
  "data": { "id": 1, "nama_shift": "Pagi" }
}
```

---

### PUT `/shift/edit-shift/:id`
Auth required (super_admin/admin). Same fields, all optional.

### DELETE `/shift/delete-shift/:id`
Auth required (super_admin/admin).

---

### GET `/shift/get-shift/:id`
Auth required (any authenticated role, store access). Get one shift by ID; non-super_admin is confined to their own store (otherwise 404).

**Response:**
```json
{
  "success": true,
  "message": "Success",
  "data": {
    "id": 1,
    "store": 1,
    "nama_shift": "Pagi",
    "tipe_shift": "reguler",
    "jam_mulai": "08:00:00",
    "jam_selesai": "16:00:00",
    "tanggal_mulai": "2026-10-01",
    "tanggal_selesai": "2026-12-31",
    "karyawan": [10, 11],
    "status": "active",
    "createdBy": 1,
    "modifiedBy": null,
    "createdByUser": null,
    "modifiedByUser": null,
    "createdAt": "2026-10-01T00:00:00.000Z",
    "updatedAt": "2026-10-01T00:00:00.000Z"
  }
}
```

Key errors: 404 `Shift Tidak Ditemukan`.

---

---

## Type Payment

### GET `/type-payment/get-type-payment`
Auth required. Returns active payment types only.

**Response:**
```json
{
  "success": true,
  "data": [
    { "id": 1, "namePayment": "Cash", "icon": "money", "isActive": true, "isShowInCashier": true }
  ]
}
```

---

### GET `/type-payment/get-list-type-payment`
Auth required. Returns all payment types (active + inactive).

### GET `/type-payment/get-by-id/:id`
Auth required.

### POST `/type-payment/add-new-type-payment`
Auth required (super_admin/admin).

**Request:**
```json
{
  "namePayment": "string (required)",
  "icon": "string (default: '')",
  "isActive": "boolean (default: true)",
  "isEditable": "boolean (default: true)",
  "paymentCategory": "string (default: '')",
  "isShowInCashier": "boolean (default: true)"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Payment type created",
  "data": { "id": 1, "namePayment": "Cash" }
}
```

---

### PUT `/type-payment/edit-type-payment/:id`
Auth required (super_admin/admin). Same fields, all optional.

### DELETE `/type-payment/delete-type-payment/:id`
Auth required (super_admin/admin).

### GET `/type-payment/template`, GET `/type-payment/download`, POST `/type-payment/import`
Auth required (super_admin/admin). Import uses multipart/form-data.

---

### GET `/type-payment/download`
Auth required (super_admin/admin). Exports payment types as an `.xlsx` attachment; columns: ID, Name, Type, Status, Created At. Non-super-admin is silently pinned to their own store.

**Query:**
| Field | Type | Description |
|-------|------|-------------|
| `store` | number | Optional filter (honored for super_admin only) |

**Response:** `200` binary xlsx with `Content-Disposition: attachment; filename=type-payment-data.xlsx` (no JSON envelope).

Key errors: 500 `{"success":false,"message":"Internal server error"}`.

---

### POST `/type-payment/import`
Auth required (super_admin/admin). Multipart Excel import (`.xlsx`). Columns: Name, Type, Description, Status. Type aliases map to canonical values (`tunai`→`cash`, `non-tunai`/`transfer`→`other`, etc., default `cash`). Duplicates by name are skipped.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `file` | file | Required multipart field (Excel workbook) |

**Response:** `201`
```json
{ "success": true, "message": "Successfully imported 2 from 2 type payments", "data": { "total": 2, "created": 2, "skipped": 0 } }
```
`data.skippedNames` is present only when something was skipped.

Key errors: 400 `{"success":false,"message":"No file uploaded"}`; 400 `{"success":false,"message":"Validation errors","errors":["Row 2: Name is required"]}`.

---

---

## Supplier

### GET `/supplier/`
Auth required. **Query:** `page` (number), `limit` (number), `store` (number), `search` (string).

**Response:**
```json
{
  "success": true,
  "message": "Success get suppliers",
  "data": [
    { "id": 1, "name": "PT Sumber Rejeki", "phone": "021-1234", "email": "info@sumber.com", "status": "active", "store": [{ "id": 1, "name": "Toko A" }], "productCount": 3, "categoryData": null }
  ],
  "pagination": { "page": 1, "limit": 10, "total": 1, "totalPages": 1 },
  "stats": { "total": 1, "active": 1, "inactive": 0, "draft": 0 }
}
```

---

### GET `/supplier/detail/:id`
Auth required.

**Response:**
```json
{
  "success": true,
  "message": "Success get supplier detail",
  "data": {
    "id": 1,
    "name": "PT Sumber Rejeki",
    "phone": "021-1234",
    "email": "info@sumber.com",
    "contactPerson": "Budi",
    "address": "Jl. Industri 10",
    "status": "active",
    "store": [{ "id": 1, "name": "Toko A" }],
    "productCount": 3,
    "products": [],
    "contacts": [],
    "bankAccounts": [],
    "categoryData": null
  }
}
```

---

### GET `/supplier/:id`
Auth required. Same as detail.

### POST `/supplier/`
Auth required (super_admin/admin).

**Request:**
```json
{
  "name": "string (required)",
  "store": "array of numbers (optional)",
  "phone": "string (optional)",
  "email": "string (optional)",
  "contactPerson": "string (optional)",
  "address": "string (optional)",
  "description": "string (optional)",
  "status": "active | inactive | draft (default: active)"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Supplier created",
  "data": { "id": 1, "name": "PT Sumber Rejeki" }
}
```

---

### PUT `/supplier/:id`
Auth required (super_admin/admin). Same fields, all optional.

### DELETE `/supplier/:id`
Auth required (super_admin/admin).

### GET `/supplier/template`, GET `/supplier/download`, POST `/supplier/import`
Auth required (super_admin/admin). Import uses multipart/form-data.

---

### GET `/supplier/compare`
Auth required. Side-by-side price/catalog comparison of active suppliers for a product or a product name (whole catalog; handler adds no store filter of its own).

**Query:**
| Param | Type | Description |
|-------|------|-------------|
| `productId` | number | Compare by product id |
| `search` | string | Compare by product name (`iLike`) |

At least one of `productId` / `search` is required.

**Response:**
```json
{
  "success": true,
  "message": "Success compare suppliers",
  "data": {
    "product": { "id": 10, "name": "Indomie Goreng", "sku": "SKU-10", "unit": "pcs" },
    "suppliers": [
      {
        "supplierProductId": 1,
        "supplierId": 2,
        "supplierName": "PT Sumber Rejeki",
        "supplierPhone": "021-1234",
        "supplierEmail": "info@sumber.com",
        "productName": "Indomie Goreng",
        "price": 3300,
        "unit": "pcs",
        "leadTime": 1,
        "leadTimeUnit": "hari",
        "qualityRating": 4,
        "minOrderQty": 10,
        "notes": "Rasa original",
        "lastPrice": 3400
      }
    ],
    "summary": { "lowestPrice": 3300, "highestPrice": 3500, "avgPrice": 3400, "supplierCount": 2 }
  }
}
```

Key errors: 400 `productId or search query is required`. If the `supplier_product` table is absent the endpoint answers 200 with `"data": []`.

---

### GET `/supplier/download`
Auth required (super_admin/admin). Excel export of suppliers.

**Query:** `store` (number, optional) — when present, includes suppliers assigned to that store plus global ones (`store` null / `[]`).

**Response:** `.xlsx` attachment (`suppliers-data.xlsx`); columns: ID, Name, Contact Person, Phone, Email, Address, Status, Created At.

---

### GET `/supplier/product-template`
Auth required (super_admin). Excel product-catalog template for one supplier.

**Query:** `supplier` (number, optional) — when given, existing `supplier_product` rows are prefilled; otherwise a single `Contoh:` example row.

**Response:** `.xlsx` attachment (`supplier-product-template.xlsx`); columns: Nama Produk, Harga, Satuan, Lead Time, Satuan Lead Time, Kualitas (0-5), Min Order, Catatan (dropdowns for unit and lead-time unit).

---

### POST `/supplier/import`
Auth required (super_admin/admin). Bulk supplier import from Excel (`multipart/form-data`, field `file`). Created under the importing user's store; duplicates by name are skipped.

**Body (file columns):** Name, Contact Person, Phone, Email, Address, Status (`Active` / `Non-Active` / `Draft`).

**Response (201):**
```json
{
  "success": true,
  "message": "Successfully imported 3 from 4 suppliers",
  "data": { "total": 4, "created": 3, "skipped": 1, "skippedNames": ["PT Sumber Rejeki"] }
}
```

Key errors: 400 No file uploaded; 400 Validation errors (per-row list).

---

### POST `/supplier/:id/import-products`
Auth required (super_admin). Replace a supplier's product catalog from Excel (`multipart/form-data`, field `file`). Passing `preview` as `:id` parses and returns the rows without checking the supplier or persisting anything.

**Body (file columns):** Nama Produk, Harga, Satuan, Lead Time, Satuan Lead Time, Kualitas (0-5), Min Order, Catatan.

**Response:**
```json
{
  "success": true,
  "message": "Successfully imported 2 products",
  "data": [
    { "name": "Indomie Goreng", "price": 3500, "unit": "pcs", "leadTime": 1, "leadTimeUnit": "hari", "qualityRating": 4, "minOrderQty": 10, "notes": "Rasa original" }
  ]
}
```

`minOrderQty` is a whole number (BA DR-28 decision 4): digits or a number, empty = 1; anything else is refused (`products.N.minOrderQty: harus angka bulat`, or `Row N: minOrderQty must be a whole number` on import).

Key errors: 400 No file uploaded; 400 Validation errors; 404 Supplier not found (non-preview id).

---

---

## Ingredient

### GET `/ingredient/get-all`
Auth required. **Query:** `store` (number), `limit` (number), `search` (string).

**Response:**
```json
{
  "success": true,
  "data": [
    { "id": 1, "name": "Beras Premium", "stock": 500, "minStock": 50, "unit": "kg", "costPrice": 12000, "status": "active" }
  ]
}
```

---

### GET `/ingredient/get-by-id/:id`
Auth required.

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "Beras Premium",
    "stock": 500,
    "minStock": 50,
    "unit": "kg",
    "baseUnit": "kg",
    "conversionFactor": "1",
    "costPrice": 12000,
    "store": 1,
    "category": 1,
    "supplier": 1,
    "status": "active"
  }
}
```

---

### POST `/ingredient/add`
Auth required (super_admin/admin).

**Request:**
```json
{
  "name": "string (required)",
  "store": "number (optional)",
  "category": "number (optional)",
  "supplier": "number (optional)",
  "stock": "number (default: 0)",
  "minStock": "number (default: 0)",
  "unit": "string (default: pcs)",
  "baseUnit": "string (default: pcs)",
  "conversionFactor": "string (default: 1)",
  "costPrice": "number (default: 0)",
  "status": "active | inactive | draft (default: active)"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Ingredient created",
  "data": { "id": 1, "name": "Beras Premium" }
}
```

---

### PUT `/ingredient/edit/:id`
Auth required (super_admin/admin). Same fields, all optional.

### PUT `/ingredient/adjust-stock/:id`
Auth required (super_admin/admin).

**Request:**
```json
{ "stock": "number (required)", "notes": "string (optional)" }
```

### GET `/ingredient/stock-summary`
Auth required (super_admin/admin, store-scoped). Per-ingredient stock movement summary for a period, bucketed from `stock_history`. Dates are business days in the store's timezone.

**Query:** `startDate`, `endDate` (optional, `YYYY-MM-DD`; omit for all time), `store` (super_admin selector).

**Response:**
```json
{
  "success": true,
  "message": "Success get ingredient stock summary",
  "data": {
    "store": 1, "startDate": "2026-10-01T00:00:00.000Z", "endDate": "2026-10-23T16:59:59.999Z",
    "items": [{
      "id": 7, "name": "Daging sapi", "unit": "gram", "status": "active", "minStock": 500,
      "openingStockRecorded": true, "stockState": "recorded | unrecorded | uninitialized", "lastRecordedAt": "…", "lastCountedAt": "…",
      "openingBalance": 10000, "consumed": 2500, "restored": 0, "adjusted": 0, "counted": 0,
      "received": 5000, "other": 0, "closingBalance": 12500, "currentStock": 12500
    }],
    "menuSold": [{ "productId": 3, "productName": "Bakso urat", "quantity": 40 }]
  }
}
```
`consumed` is shown positive; `menuSold` counts paid/refunded, non-cancelled orders (gross, returns not subtracted).

Key errors: 400 `store is required`; 400 `startDate/endDate must be YYYY-MM-DD`.

### DELETE `/ingredient/delete/:id`
Auth required (super_admin/admin).

### GET `/ingredient/download-template`, GET `/ingredient/download`, POST `/ingredient/import`
Auth required (super_admin/admin). Import uses multipart/form-data.

---

### GET `/ingredient/download`
Auth required (super_admin/admin). Excel export of ingredients for the resolved store.

**Response:** `.xlsx` attachment (`data-bahan-baku.xlsx`); columns: No, Nama Bahan Baku, Kategori, Supplier, Unit Pembelian, Base Unit, Faktor Konversi, Stok, Minimal Stok, Harga Beli, Status.

---

### GET `/ingredient/product-names`
Auth required. Supplier-catalog product names (deduplicated by name) used as reference data.

**Query:**
| Param | Type | Description |
|-------|------|-------------|
| `supplier` | number | Required |

**Response:**
```json
{
  "success": true,
  "message": "Success get product names",
  "data": [
    {
      "id": 1,
      "supplier": 2,
      "productId": 10,
      "name": "Indomie Goreng",
      "price": 3300,
      "unit": "pcs",
      "leadTime": 1,
      "leadTimeUnit": "hari",
      "qualityRating": 4,
      "minOrderQty": 10,
      "notes": "Rasa original",
      "lastPrice": 3400
    }
  ]
}
```

Key errors: 400 `Supplier is required`.

---

### POST `/ingredient/import`
Auth required (super_admin/admin). Excel import into the caller's store (`multipart/form-data`, field `file`). Requires a sheet named `Template` with the exact template header; category/supplier names resolve against store-or-global records; duplicates per store are skipped.

**Body (file columns):** No, Nama Bahan Baku, Kategori, Supplier, Unit Pembelian, Base Unit, Faktor Konversi, Stok Awal, Minimal Stok, Harga Beli (Rp), Status.

**Response (201):**
```json
{
  "success": true,
  "message": "Berhasil import 5 dari 6 bahan baku",
  "data": { "total": 6, "created": 5, "skipped": 1, "skippedNames": ["\"Beras Premium\" sudah terdaftar"] }
}
```

Key errors: 400 `Tidak ada file yang diupload`; 400 `Store tidak ditemukan`; 400 `Sheet "Template" tidak ditemukan`; 400 `Header file tidak sesuai dengan template`.

---

---

## Ingredient Category

### GET `/ingredient-category/get-all`
Auth required.

**Response:**
```json
{
  "success": true,
  "data": [{ "id": 1, "name": "Bahan Pokok", "description": "" }]
}
```

---

### GET `/ingredient-category/get-by-id/:id`
Auth required.

### POST `/ingredient-category/add`
Auth required (super_admin/admin).

**Request:**
```json
{ "name": "string (required)", "description": "string (default: '')" }
```

### PUT `/ingredient-category/edit/:id`
Auth required (super_admin/admin). Same fields, all optional.

### DELETE `/ingredient-category/delete/:id`
Auth required (super_admin/admin).

### GET `/ingredient-category/template`, GET `/ingredient-category/download`, POST `/ingredient-category/import`
Auth required (super_admin/admin). Import uses multipart/form-data.

---

### GET `/ingredient-category/download`
Auth required (super_admin/admin). Excel export of all ingredient categories (no store filter).

**Response:** `.xlsx` attachment (`ingredient-categories.xlsx`); columns: ID, Name, Status, Created At.

---

### POST `/ingredient-category/import`
Auth required (super_admin/admin). Excel import (`multipart/form-data`, field `file`); duplicates by name are skipped.

**Body (file columns):** column B = name, column C = status (`Draft` / `Non-Active` / anything else → `active`).

**Response (201):**
```json
{
  "success": true,
  "message": "Successfully imported 3 from 4 ingredient categories",
  "data": { "total": 4, "created": 3, "skipped": 1, "skippedNames": ["Bahan Pokok"] }
}
```

Key errors: 400 No file uploaded; 400 Validation errors.

---

---

## Stock History

### GET `/stock-history/get-all`
Auth required.

**Query:**
| Param | Type | Description |
|-------|------|-------------|
| `page` | number | Page number |
| `limit` | number | Items per page |
| `product` | number | Product ID. With `itemType=ingredient`: the ingredient rows of that menu's recipe sales |
| `itemType` | string | `ingredient` (rows with an ingredient, including recipe-sale rows that also carry the menu product) or `product` (finished-product rows only). Anything else → 400 |
| `ingredient` | number | Ingredient ID (ignored with `itemType=product`) |
| `referenceType` | string | Filter by type (e.g. `sale`, `purchase`, `adjustment`) |
| `startDate` | string | ISO date |
| `endDate` | string | ISO date |
| `store` | number | Store ID |

Each row carries `productData` (the menu, also on recipe-sale ingredient rows) and `storeData` (`id`, `name` of the row's store).

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 11,
      "store": 1,
      "product": 1,
      "ingredient": 2,
      "ingredientName": "Bakso Alus",
      "referenceType": "sale",
      "referenceId": 7,
      "quantityBefore": "100.0000",
      "quantityChange": "-3.0000",
      "quantityAfter": "97.0000",
      "unit": "pcs",
      "notes": "Penjualan: ORD42683323LR2T",
      "createdBy": 16,
      "createdAt": "2026-10-24T12:30:00.000Z",
      "productData": { "id": 1, "nameProduct": "Bakso Urat" },
      "storeData": { "id": 1, "name": "Bakso ABC" }
    }
  ],
  "pagination": { "total": 500, "page": 1, "limit": 20, "totalPages": 25 }
}
```

---

### GET `/stock-history/get-by-product/:productId`
Auth required.

### GET `/stock-history/low-stock`
Auth required. **Query:** `store` (number).

### GET `/stock-history/low-stock-all`
Auth required (super_admin/admin). Returns low stock across all stores (store access applies).

---

### POST `/stock-history/auto-generate-po`
Auth required (super_admin/admin). Creates draft purchase orders from active ingredients with `stock <= minStock`, grouped per supplier; ingredients without a supplier are grouped into one extra PO. Store scope: `super_admin` may pass `store` (query/body) or use the selected store; other roles are pinned to their own store.

**Query / Body:**
| Field | Type | Description |
|-------|------|-------------|
| `store` | number | Optional store selector (super_admin only) |

**Response:** `201`
```json
{
  "success": true,
  "message": "Berhasil generate 2 PO draft dari 5 bahan baku low stock",
  "data": {
    "purchaseOrders": [{ "id": 12, "orderNumber": "PO-20261018-0042", "store": 1, "status": "draft", "finalAmount": 250000, "items": [{ "ingredient": 7, "ingredientName": "Beras", "quantity": 10, "unit": "kg", "price": 25000 }] }],
    "totalItems": 5,
    "withSupplier": 1,
    "withoutSupplier": 1
  }
}
```
When nothing is low stock: `200 {"success":true,"message":"Tidak ada bahan baku yang stoknya menipis","data":{"purchaseOrders":[],"totalItems":0}}`.

Key errors: 500.

---

---

## Stock Opname

### GET `/stock-opname/get-all`
Auth required.

**Query:** `page`, `limit`, `search`, `warehouse` (store ID), `status`.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "auditDate": "2026-07-11",
      "auditor": "Budi",
      "status": "completed",
      "store": 1,
      "items": [...]
    }
  ],
  "pagination": { "total": 10, "page": 1, "limit": 10, "totalPages": 1 },
  "stats": { "total": 10, "draft": 2, "completed": 7, "cancelled": 1, "totalItems": 150 }
}
```

---

### GET `/stock-opname/get-by-id/:id`
Auth required.

### GET `/stock-opname/check-exists`
Auth required. **Query:** `store` (number).

### GET `/stock-opname/composition-items`
Auth required. **Query:** `store` (number).

### POST `/stock-opname/create`
Auth required (super_admin/admin).

**Request:**
```json
{
  "auditDate": "string (optional, ISO date)",
  "auditor": "string (optional)",
  "notes": "string (default: '')",
  "status": "active | inactive | draft (default: active)",
  "items": "array of objects (default: [])",
  "store": "number (optional)"
}
```

### PUT `/stock-opname/update/:id`
Auth required (super_admin/admin). Same fields, all optional.

### DELETE `/stock-opname/delete/:id`
Auth required (super_admin/admin).

### PATCH `/stock-opname/status/:id`
Auth required (super_admin/admin).

**Request:**
```json
{ "status": "active | inactive | draft (required)" }
```

### GET `/stock-opname/download-excel`, POST `/stock-opname/export-selected`, POST `/stock-opname/upload-excel`
Auth required (super_admin/admin).

---

### POST `/stock-opname/export-selected`
Auth required (super_admin/admin). Downloads the selected stock opnames (with their items) as an `.xlsx` attachment. Rows outside the caller's store scope are silently excluded.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `ids` | number[] | Required, non-empty array of stock opname IDs |

**Response:** `200` binary xlsx with `Content-Disposition: attachment; filename=stock-opname-export-selected.xlsx` (no JSON envelope).

Key errors: 400 `{"success":false,"message":"ids harus berupa array dan tidak boleh kosong"}`; 404 `{"success":false,"message":"Stock opname tidak ditemukan"}` (none of the ids resolve within scope).

---

### POST `/stock-opname/upload-excel`
Auth required (super_admin/admin). Multipart Excel upload that creates a **draft** stock opname from the sheet. The workbook must contain a sheet named `Stock Opname` with the exact header row: No., Kode Barang, Nama Barang, Satuan, Lokasi, Stok Awal, Barang Masuk, Barang Keluar, Stok Akhir, Stok Fisik, Selisih, Keterangan.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `file` | file | Required multipart field; `.xlsx`/`.xls`, max 10 MB |
| `date` / `auditDate` / `auditor` / `notes` | string | Optional metadata for the created opname |

**Response:** `201`
```json
{ "success": true, "message": "Berhasil upload 12 item stock opname", "data": { "id": 4, "store": 1, "opnameNumber": "SO-20261018-001", "status": "draft", "totalAdjustment": -3, "items": [{ "kodeBarang": "BRG-001", "namaBarang": "Beras", "satuan": "kg", "systemStock": 10, "actualStock": 9, "adjustment": -1 }] } }
```

Key errors: 400 `{"success":false,"message":"Tidak ada file yang diupload"}`; 400 `Sheet "Stock Opname" tidak ditemukan`; 400 `Header tidak valid. Pastikan menggunakan template yang benar`; 400 `{"success":false,"message":"Terdapat kesalahan","errors":["Baris 4: Nama barang wajib diisi"]}`; 400 `Tidak ada data yang valid untuk diupload`; 400 `Tidak dapat menentukan store/lokasi. Pastikan lokasi sudah terdaftar.`

---

---

## Expense

### GET `/expense/get-all`
Auth required.

**Query:** `page`, `limit`, `search`, `status` (pending|approved|rejected), `store`.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "categoryId": 1,
      "categoryName": "Operasional",
      "amount": 500000,
      "description": "Listrik bulanan",
      "date": "2026-07-11",
      "status": "approved",
      "store": 1
    }
  ],
  "pagination": { "total": 30, "page": 1, "limit": 10, "totalPages": 3 },
  "summary": { "total": 5000000, "count": 15 },
  "stats": { "draft": 2, "pending": 5, "approved": 7, "rejected": 1 }
}
```

---

### GET `/expense/get-by-id/:id`
Auth required.

### GET `/expense/get-summary`
Auth required. **Query:** `store`, `startDate`, `endDate`.

**Response:**
```json
{
  "success": true,
  "data": { "total": 5000000, "count": 15, "byCategory": [...] }
}
```

---

### POST `/expense/add`
Auth required (super_admin/admin).

**Request:**
```json
{
  "categoryId": "number (required)",
  "amount": "number (required)",
  "description": "string (optional)",
  "date": "string (optional, ISO date)",
  "notes": "string (default: '')",
  "status": "pending | approved | rejected (default: pending)",
  "store": "number (optional)"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Expense created",
  "data": { "id": 1, "amount": 500000, "status": "pending" }
}
```

---

### PUT `/expense/edit/:id`
Auth required (super_admin/admin). Same fields, all optional.

### DELETE `/expense/delete/:id`
Auth required (super_admin/admin).

### PUT `/expense/approve/:id`
Auth required (super_admin/admin).

### PUT `/expense/reject/:id`
Auth required (super_admin/admin).

---

### GET `/expense/upcoming-payments`
Auth required. Upcoming recurring payments: approved, active, unpaid expenses with a `frequency` and `nextDueDate` between now and now+`days`; max 20 rows ordered by due date. Store-scoped to the caller's resolved store.

**Query:**
| Param | Type | Description |
|-------|------|-------------|
| `days` | number | Horizon in days, default 7 |

**Response:**
```json
{
  "success": true,
  "message": "Success get upcoming payments",
  "data": [
    {
      "id": 12,
      "expenseNumber": "EXP-20261019-0007",
      "description": "Sewa ruko",
      "amount": 5000000,
      "date": "2026-10-01",
      "nextDueDate": "2026-11-01",
      "frequency": "monthly",
      "paymentMethod": "bank",
      "payee": "Pak Slamet",
      "store": 1,
      "storeName": "Store Jakarta",
      "categoryName": "Sewa",
      "employeeName": null
    }
  ],
  "count": 1
}
```

---

### POST `/expense/bulk-create`
Auth required (super_admin/admin). Atomic bulk creation (single transaction); items with `status: "approved"` also enqueue an accounting journal sync.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `store` | number | Optional; defaults to the caller's store |
| `items` | array | Required, min 1 |
| `items[].categoryId` / `items[].category` | number | Required unless item status is `draft` |
| `items[].amount` | number | Required unless item status is `draft` |
| `items[].description` | string | Optional |
| `items[].date` | string | Default now |
| `items[].notes` | string | Default `''` |
| `items[].payee` / `items[].employeeId` | string / number | Optional |
| `items[].paymentMethod` | string | `cash` \| `bank` \| `e-wallet` |
| `items[].frequency` | string | `once` (→ null) \| `daily` \| `weekly` \| `monthly` \| `yearly` |
| `items[].recurringEndDate` | string | Optional |
| `items[].status` | string | `draft` \| `pending` \| `approved` \| `rejected`, default `pending` |

**Response (201):**
```json
{
  "success": true,
  "message": "Success create 2 expenses",
  "data": [
    {
      "id": 21,
      "expenseNumber": "EXP-20261019-0011",
      "category": 3,
      "amount": 500000,
      "status": "pending",
      "categoryData": { "id": 3, "name": "Operasional", "accountCode": "6100" }
    }
  ],
  "count": 2
}
```

Key errors: 400 `Expense items are required` (also schema-invalid `items` rejected with 400); a non-draft item missing category/amount throws and the transaction rolls back (500).

---

### POST `/expense/generate-salary`
Auth required (super_admin/admin). Generates approved "Gaji" expenses for all active employees with a `monthlySalary` in the target store, creating the `Gaji`/6100 category if needed and skipping employees who already have a salary expense in that month.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `store` | number | Required in effect (body `store`/`storeId` or the caller's resolved store) |
| `month` | string | `YYYY-MM`, default current month |
| `employeeIds` | number[] | Optional; default all eligible employees |
| `paymentMethod` | string | `cash` \| `bank` \| `e-wallet`, default `cash` |

**Response (201):**
```json
{
  "success": true,
  "message": "Penggajian 10/2026: 3 dibuat, 1 dilewati (sudah ada)",
  "data": { "created": 3, "skipped": 1, "categoryId": 7 }
}
```

Key errors: 400 `Store is required`.

---

### PUT `/expense/mark-paid/:id`
Auth required (super_admin/admin). Records an `expense_payment` for the full amount. For recurring expenses the next due date is advanced and `isPaid` stays `false` until the schedule ends.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `paymentDate` | string | Default now |
| `paymentMethod` | string | `cash` \| `bank` \| `e-wallet`; defaults to the expense's method |
| `note` | string | Optional |

**Response:**
```json
{ "success": true, "message": "Success mark expense as paid", "data": { "id": 12, "isPaid": true, "nextDueDate": null } }
```

Key errors: 404 Expense not found; 400 `Rejected expenses cannot be marked as paid`.

---

### PUT `/expense/mark-unpaid/:id`
Auth required (super_admin/admin). No body. Clears `isPaid`/`paidAt` (payment rows are not deleted).

**Response:**
```json
{ "success": true, "message": "Success mark expense as unpaid", "data": { "id": 12, "isPaid": false } }
```

Key errors: 404 Expense not found.

---

### PUT `/expense/set-active/:id`
Auth required (super_admin/admin). Archives/activates an expense (`isActive`) and re-syncs its accounting journal.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `isActive` | boolean | Required |

**Response:**
```json
{ "success": true, "message": "Success archive expense", "data": { "id": 12, "isActive": false } }
```

Key errors: 400 `isActive must be a boolean`; 404 Expense not found.

---

---

## Expense Category

### GET `/expense-category/get-all`
Auth required.

**Response:**
```json
{
  "success": true,
  "data": [{ "id": 1, "name": "Operasional", "description": "" }]
}
```

---

### POST `/expense-category/add`
Auth required (super_admin/admin).

**Request:**
```json
{ "name": "string (required)", "description": "string (default: '')" }
```

### PUT `/expense-category/edit/:id`
Auth required (super_admin/admin). Same fields, all optional.

### DELETE `/expense-category/delete/:id`
Auth required (super_admin/admin).

---

---

## Cash Register

### POST `/cash-register/open`
Auth required (super_admin/admin). The store comes from the resolved store context (`req.storeId`) — an explicit selection is required, otherwise 400 `Store not selected`.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `openingBalance` | number | Optional, default `0` |
| `shift` | number | Optional shift id |
| `notes` | string | Optional |
| `confirmTableReset` | boolean | Optional, default `false` — also resets stale OCCUPIED tables that have no active order |

**Response:** `201`
```json
{
  "success": true,
  "message": "Cash register opened",
  "data": { "id": 1, "store": 1, "openingBalance": 500000, "status": "open", "openedAt": "2026-10-19T08:00:00.000Z", "storeData": { "id": 1, "name": "Toko A" } },
  "tableCleanupResult": { "attempted": true, "succeeded": 1, "failed": 0 }
}
```

---

### PUT `/cash-register/close/:id`
Auth required (super_admin/admin). Closes the register and returns the full closing report (same shape as a frozen Z report).

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `closingBalance` | number | Optional, nullable |
| `notes` | string | Optional |

**Response:**
```json
{
  "success": true,
  "message": "Cash register closed",
  "data": {
    "register": { "id": 1, "shift": 2, "status": "closed", "openedAt": "2026-10-19T08:00:00.000Z", "closedAt": "2026-10-19T17:00:00.000Z", "notes": "", "openingBalance": 500000, "closingBalance": 1500000 },
    "store": { "id": 1, "name": "Toko A", "address": "Jl. Mawar 1", "city": "Jakarta", "phone": null, "timezone": "Asia/Jakarta" },
    "cashier": { "id": 10, "fullName": "Budi" },
    "summary": { "totalTransactions": 12, "subtotal": 450000, "discount": 0, "tax": 49500, "serviceCharge": 0, "totalSales": 499500, "totalExpenses": 50000, "cashSalesReceived": 300000, "expectedCash": 750000, "variance": 0, "varianceApprovalStatus": null },
    "payments": [],
    "expenses": [],
    "salesByProduct": []
  }
}
```

---

### GET `/cash-register/current`
Auth required. **Query:** `store` (number).

**Response:**
```json
{
  "success": true,
  "message": "Success get current register",
  "data": {
    "register": { "id": 1, "store": 1, "openingBalance": 500000, "status": "open", "openedAt": "2026-07-11T08:00:00Z" },
    "currentSales": 350000,
    "cashSalesReceived": 200000,
    "totalExpenses": 50000,
    "activeCashIn": 0,
    "activeCashOut": 0,
    "totalTransactions": 12,
    "expectedCash": 650000
  }
}
```

---

### GET `/cash-register/history`
Auth required. **Query:** `page`, `limit`, `store`, `search`.

---

### GET `/cash-register/table-reset-preview`
Auth required. Counts tables that register-open cleanup would reset (stale `occupied` with no active order) for the selected store, before the cashier confirms the reset.

**Response:**
```json
{ "success": true, "message": "Success", "data": { "eligibleCount": 2 } }
```

Key errors: 400 `Store not selected`.

---

### GET `/cash-register/open-registers`
Auth required (super_admin/admin). Lists all registers with `status: "open"`, oldest first; optional store filter scopes the list (super_admin without one sees all stores).

**Query:**
| Field | Type | Description |
|-------|------|-------------|
| `store` | number | Optional store filter |

**Response:**
```json
{
  "success": true,
  "message": "Success get open registers",
  "data": [
    { "id": 1, "store": 1, "user": 3, "status": "open", "openedAt": "2026-10-18T08:00:00.000Z", "storeData": { "id": 1, "name": "Toko A" }, "userData": { "id": 3, "fullName": "Budi" } }
  ]
}
```

Key errors: 500.

---

### GET `/cash-register/:id/movements`
Auth required. Lists a register's cash movements, newest first (`id DESC`). The register lookup is store-scoped, so another store's register reads as 404 rather than 403.

**Response:**
```json
{
  "success": true,
  "message": "Cash movements retrieved",
  "data": [
    { "id": 6, "store": 1, "cashRegisterId": 1, "type": "cash_in", "reasonCode": "correction", "amount": 50000, "notes": "Reversal of movement #5", "status": "active", "reversalOfId": 5, "createdBy": 3, "approvedBy": null, "approvedAt": null, "idempotencyKey": null }
  ]
}
```

Key errors: 404 `{"success":false,"message":"Cash register not found"}`.

---

### GET `/cash-register/x-report`
Auth required. Mid-shift (X) report for the caller's own open register in the selected store — a live, read-only snapshot; it does not close the register. When the caller has no open register it answers `200 {"success":true,"message":"No open cash register","data":null}`.

**Response:**
```json
{
  "success": true,
  "message": "X report generated",
  "data": {
    "register": { "id": 1, "shift": null, "status": "open", "openedAt": "2026-10-18T08:00:00.000Z", "closedAt": null, "notes": null, "openingBalance": 500000, "closingBalance": 0 },
    "store": { "id": 1, "name": "Toko A", "address": "Jl. ...", "city": "Jakarta", "phone": "021-1234", "timezone": "Asia/Jakarta" },
    "cashier": { "id": 3, "fullName": "Budi" },
    "summary": { "totalTransactions": 10, "totalQuantity": 25, "totalCovers": 0, "subtotal": 500000, "discount": 0, "tax": 55000, "serviceCharge": 0, "totalSales": 555000, "totalExpenses": 0, "totalCashPayment": 200000, "totalNonCashPayment": 355000, "activeCashIn": 0, "activeCashOut": 0, "expectedCash": 700000, "cashRefundsTotal": 0, "refundsTotal": 0, "refundCount": 0, "variance": null },
    "payments": [{ "type": "CASH", "amount": 200000, "count": 4 }],
    "salesByProduct": [{ "productName": "Nasi Goreng", "sku": "NG-01", "quantity": 10, "unitPrice": 25000, "totalSales": 250000 }],
    "expenses": [{ "category": "Operasional", "amount": 50000, "count": 1 }]
  }
}
```
`payments[].type` is the canonical reporting bucket (e.g. `CASH`, `QRIS`, `TRANSFER`).

Key errors: 400 `{"success":false,"message":"Store not selected"}`.

---

### GET `/cash-register/z-report/:id`
Auth required. Closing (Z) report for a specific register; non-super_admin may only read a register of their own store (cross-store → 403). A closed register with a persisted close snapshot serves frozen close-time figures; a legacy register without one falls back to live recomputation. Every response carries an additive `data.reconciliation` explaining which transactions fed the summary and which were excluded.

**Response:**
```json
{
  "success": true,
  "message": "Z report generated",
  "data": {
    "register": { "id": 1, "status": "closed", "openedAt": "2026-10-18T08:00:00.000Z", "closedAt": "2026-10-18T20:00:00.000Z", "openingBalance": 500000, "closingBalance": 1480000 },
    "store": { "id": 1, "name": "Toko A", "timezone": "Asia/Jakarta" },
    "cashier": { "id": 3, "fullName": "Budi" },
    "summary": { "totalTransactions": 30, "totalSales": 1050000, "totalCashPayment": 600000, "totalNonCashPayment": 450000, "expectedCash": 1100000, "variance": 380000, "varianceApprovalStatus": "pending_approval" },
    "payments": [{ "type": "CASH", "amount": 600000, "count": 12 }],
    "expenses": [{ "category": "Operasional", "amount": 50000, "count": 1 }],
    "salesByProduct": [{ "productName": "Nasi Goreng", "sku": "NG-01", "quantity": 20, "unitPrice": 25000, "totalSales": 500000 }],
    "reconciliation": {
      "window": { "openedAt": "2026-10-18T08:00:00.000Z", "endAt": "2026-10-18T20:00:00.000Z" },
      "sales": { "eligible": { "count": 30, "total": 1050000, "orderIds": [1, 2], "byPaymentMethod": [{ "type": "CASH", "orders": 12, "amount": 600000 }] }, "excluded": [{ "code": "UNPAID", "reason": "Order is not paid yet ...", "count": 0, "total": 0, "orderIds": [] }] },
      "expenses": { "includedCash": { "count": 1, "total": 50000, "expenseIds": [4] }, "records": [{ "id": 4, "amount": 50000, "category": "Operasional", "date": "2026-10-18" }], "excluded": [] },
      "movements": { "cashIn": { "count": 0, "total": 0 }, "cashOut": { "count": 0, "total": 0 }, "pending": { "count": 0, "total": 0 } }
    }
  }
}
```
Summary fields are a subset; the full object also carries `totalQuantity`, `totalCovers`, `subtotal`, `discount`, `tax`, `serviceCharge`, `totalExpenses`, `activeCashIn/Out`, `cashRefundsTotal`, `refundsTotal`, `refundCount`. `varianceApprovalStatus` and `cashSalesReceived` appear in `summary` only on the frozen close-snapshot path; the legacy live path also returns `variance: null` unless the register is closed.

Key errors: 404 `{"success":false,"message":"Cash register not found"}`; 403 `{"success":false,"message":"Forbidden"}` (register belongs to another store).

---

### POST `/cash-register/:id/movement`
Auth required (super_admin/admin). Records a cash movement against an open register. A `cash_out` above the store's `cashOutApprovalThreshold` (location setting, default 500000) is created as `pending_approval`; everything else is `active`. Store is always derived from the register row.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Required: `cash_in` or `cash_out` |
| `reasonCode` | string | Required: `float_topup`, `bank_drop`, `petty_cash`, `owner_draw`, `change_fund`, `correction`, `other` |
| `amount` | number | Required, positive integer rupiah |
| `notes` | string | Required when `reasonCode` is `other` |
| `idempotencyKey` | string | Optional; same key + same type/amount replays the original movement |

**Response:** `201`
```json
{ "success": true, "message": "Cash movement recorded", "data": { "id": 5, "store": 1, "cashRegisterId": 1, "type": "cash_out", "reasonCode": "petty_cash", "amount": 50000, "notes": "Beli gas", "status": "active", "reversalOfId": null, "createdBy": 3, "idempotencyKey": "uuid-123" } }
```
Idempotent replay returns `200 {"success":true,"message":"Movement already recorded","data":{...}}`. The same key with a different type/amount is `409 idempotencyKey already used with a different payload`.

Key errors: 400 request-shape errors (validate middleware envelope); 422 `amount must be positive`; 422 `notes is required when reasonCode is other`; 404 `Cash register not found`; 409 `Cannot record a cash movement against a closed register`; 409 idempotency mismatch.

---

### POST `/cash-register/movement/:id/decide`
Auth required (super_admin/admin). Approves (`pending_approval` → `active`) or rejects (`→ rejected`) a movement. Only allowed while its register is open and the movement is still `pending_approval`.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `decision` | string | Required: `approve` or `reject` |

**Response:**
```json
{ "success": true, "message": "Movement approved", "data": { "id": 5, "status": "active", "approvedBy": 3, "approvedAt": "2026-10-18T21:00:00.000Z" } }
```
The message is the literal template `` `Movement ${decision}d` `` — `approve` → `Movement approved`, `reject` → `Movement rejectd` (sic, code-side typo).

Key errors: 400 invalid decision; 404 `Cash movement not found`; 409 `Cannot decide a movement on a closed register`; 409 `Cannot approve a movement in status rejected` (message echoes the requested decision and current status).

---

### POST `/cash-register/movement/:id/reverse`
Auth required (super_admin/admin). Reverses an `active` movement on an open register: marks the original `reversed` and creates an offsetting `active` movement (`cash_in` ↔ `cash_out`, `reasonCode: "correction"`, `reversalOfId` set to the original).

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `notes` | string | Optional; defaults to `Reversal of movement #<id>` |

**Response:** `201`
```json
{ "success": true, "message": "Movement reversed", "data": { "id": 6, "type": "cash_in", "reasonCode": "correction", "amount": 50000, "status": "active", "reversalOfId": 5 } }
```

Key errors: 404 `Cash movement not found`; 409 `Cannot reverse a movement on a closed register`; 409 `Cannot reverse a movement in status pending_approval` (only `active` can be reversed).

---

### PUT `/cash-register/:id/decide-variance`
Auth required (super_admin only). Decides the variance approval of a **closed** register whose `varianceApprovalStatus` is `pending_approval`. Rejecting only records the decision — it does not reopen the register or change the variance.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `decision` | string | Required: `approve` or `reject` |

**Response:**
```json
{ "success": true, "message": "Variance approved", "data": { "id": 1, "status": "closed", "varianceApprovalStatus": "approved", "approvedBy": 2, "approvedAt": "2026-10-19T09:00:00.000Z" } }
```
The message is the literal template `` `Variance ${decision}d` `` — `reject` → `Variance rejectd` (sic, same code-side typo as the movement decide).

Key errors: 404 `Cash register not found`; 409 `Cannot decide variance for a register in status open/null` (message includes the current status/varianceApprovalStatus).

---

---

## Purchase Order

### GET `/purchase-order/get-all`
Auth required.

**Query:** `page`, `limit`, `search`, `store`, `status` (draft|pending|ordered|received|cancelled).

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "poNumber": "PO-20260711-001",
      "store": 1,
      "supplier": { "id": 1, "name": "PT Sumber" },
      "status": "ordered",
      "total": 5000000,
      "orderDate": "2026-07-11",
      "dueDate": "2026-07-18",
      "items": [...]
    }
  ],
  "pagination": { "total": 20, "page": 1, "limit": 10, "totalPages": 2 },
  "stats": { "draft": 3, "pending": 5, "ordered": 8, "received": 3, "cancelled": 1 },
  "paymentStats": { "unpaid": 10, "partial": 3, "paid": 7 }
}
```

---

### GET `/purchase-order/get-by-id/:id`
Auth required.

### POST `/purchase-order/create`
Auth required (super_admin/admin).

**Request:**
```json
{
  "store": "number (required)",
  "supplier": "number (optional)",
  "items": [
    {
      "ingredient": "number (optional)",
      "ingredientName": "string (optional)",
      "product": "number (optional)",
      "productName": "string (optional)",
      "quantity": "number (required)",
      "price": "number (default: 0)",
      "unit": "string (default: pcs)"
    }
  ],
  "notes": "string (default: '')",
  "discount": "number (default: 0)",
  "pic": "number (optional)",
  "status": "draft | pending | ordered | received | cancelled (default: draft)",
  "orderDate": "string (optional)",
  "dueDate": "string (optional)"
}
```

**Response:**
```json
{
  "success": true,
  "message": "PO created",
  "data": { "id": 1, "poNumber": "PO-20260711-001", "status": "draft" }
}
```

---

### PUT `/purchase-order/update/:id`
Auth required (super_admin/admin). Same fields, all optional.

### DELETE `/purchase-order/delete/:id`
Auth required (super_admin/admin).

### PUT `/purchase-order/receive/:id`
Auth required (super_admin/admin). Marks PO as received, updates stock.

### PUT `/purchase-order/cancel/:id`
Auth required (super_admin/admin).

### GET `/purchase-order/template`, GET `/purchase-order/download`, POST `/purchase-order/import`
Auth required (super_admin only). Import uses multipart/form-data.

---

### GET `/purchase-order/download`
Auth required (super_admin). Excel export of purchase orders, store-pinned server-side (`req.storeId`).

**Response:** `.xlsx` attachment (`purchase-orders.xlsx`); columns: Order No, Supplier, Total Amount, Discount, Final Amount, Status, Order Date, Created At.

---

### POST `/purchase-order/import`
Auth required (super_admin). Imports one draft PO per Excel row (`multipart/form-data`, field `file`); the supplier name is matched case-insensitively (unmatched → item supplier `null`).

**Body (file columns):** Supplier, Product item, Quantity, Unit, Price, Notes.

**Response:**
```json
{
  "success": true,
  "message": "Imported 2 purchase orders",
  "data": { "total": 2, "created": 2 }
}
```

Key errors: 400 No file uploaded; 400 Validation errors (per-row list).

---

### PUT `/purchase-order/send-to-supplier/:id`
Auth required (super_admin/admin). Moves a PO from `pending` to `ordered`, store-scoped via `req.storeId`.

**Response:**
```json
{
  "success": true,
  "message": "Purchase order sent to supplier",
  "data": { "id": 1, "orderNumber": "PO-20261019-0001", "status": "ordered" }
}
```

Key errors: 404 Purchase order not found; 400 `Only pending PO can be sent to supplier. Current status: <status>`.

---

---

## Purchase Payment

### GET `/purchase-payment/list`
Auth required. **Query:** `page`, `limit`.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "purchaseOrderId": 1,
      "poNumber": "PO-20260711-001",
      "paymentMethod": "transfer",
      "paymentAmount": 2500000,
      "paymentDate": "2026-07-11",
      "notes": ""
    }
  ],
  "pagination": { "total": 15, "page": 1, "limit": 10, "totalPages": 2 }
}
```

---

### GET `/purchase-payment/detail/:id`
Auth required.

### GET `/purchase-payment/by-po/:poId`
Auth required.

### GET `/purchase-payment/by-supplier/:supplierId`
Auth required.

### GET `/purchase-payment/ap-dashboard`
Auth required.

**Response:**
```json
{
  "success": true,
  "data": {
    "totalAP": 50000000,
    "paid": 30000000,
    "unpaid": 20000000,
    "overdue": 5000000,
    "bySupplier": [...]
  }
}
```

---

### POST `/purchase-payment/create`
Auth required (super_admin/admin).

**Request:**
```json
{
  "purchaseOrderId": "number (required)",
  "paymentMethod": "string (required)",
  "paymentAmount": "number (required)",
  "paymentDate": "string (optional, ISO date)",
  "notes": "string (default: '')"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Payment recorded",
  "data": { "id": 1, "paymentAmount": 2500000 }
}
```

---

### DELETE `/purchase-payment/delete/:id`
Auth required (super_admin/admin).

---

---

## Purchase Return

### GET `/purchase-return/get-all`
Auth required. **Query:** `page`, `limit`, `search`, `store`, `status`.

### GET `/purchase-return/get-by-id/:id`
Auth required.

### GET `/purchase-return/by-po/:poId`
Auth required.

### POST `/purchase-return/create`
Auth required (super_admin/admin).

**Request:**
```json
{
  "purchaseOrderId": "number (required)",
  "items": "array of objects (required, min 1)",
  "notes": "string (default: '')"
}
```

### PATCH `/purchase-return/approve/:id`
Auth required (super_admin/admin).

### PATCH `/purchase-return/reject/:id`
Auth required (super_admin/admin).

---

---

## Goods Receipt

### GET `/goods-receipt/get-all`
Auth required. **Query:** `page`, `limit`, `search`, `status`, `store`.

### GET `/goods-receipt/get-by-id/:id`
Auth required.

### GET `/goods-receipt/by-po/:poId`
Auth required.

### GET `/goods-receipt/export`
Auth required. Returns Excel file.

### POST `/goods-receipt/create`
Auth required (super_admin/admin).

**Request:**
```json
{
  "store": "number (required)",
  "purchaseOrderId": "number (optional)",
  "supplier": "number (optional)",
  "items": [
    {
      "product": "number (required)",
      "quantity": "number (required)",
      "price": "number (default: 0)",
      "unit": "string (default: pcs)"
    }
  ],
  "notes": "string (default: '')",
  "receiptDate": "string (optional, ISO date)"
}
```

### PUT `/goods-receipt/update/:id`
Auth required (super_admin/admin). Same fields, all optional.

### DELETE `/goods-receipt/delete/:id`
Auth required (super_admin/admin).

### PATCH `/goods-receipt/status/:id`
Auth required (super_admin/admin).

**Request:**
```json
{ "status": "active | inactive | draft (required)" }
```

---

---

## BOM (Bill of Materials)

### GET `/bom/get-all`
Auth required (super_admin/admin).

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "productId": 1,
      "productName": "Nasi Goreng",
      "name": "Resep Nasi Goreng",
      "status": "active",
      "lines": [
        { "ingredientId": 1, "ingredientName": "Beras", "qty": 0.5, "unit": "kg" }
      ]
    }
  ]
}
```

---

### GET `/bom/get-by-id/:id`
Auth required.

### POST `/bom/add`
Auth required (super_admin/admin).

**Request:**
```json
{
  "productId": "number (required)",
  "name": "string (default: '')",
  "notes": "string (default: '')",
  "status": "string (default: active)",
  "lines": [
    {
      "ingredientId": "number (required)",
      "qty": "number (required)",
      "unit": "string (default: pcs)",
      "notes": "string (default: '')"
    }
  ]
}
```

**Response (201):** `{ "success": true, "message": "BOM created", "data": { ...bom, "lines": [...] }, "recipeModeAdopted": false }`

`recipeModeAdopted: true` means saving this active BOM moved the product from `inventoryMode` `stocked` to `make_to_order`, so its sales now deduct the recipe ingredients (audited as a product update). This happens only when every store selling the product has an active BOM and the product has no production order that was not cancelled. `hybrid` and `make_to_order` are never changed.

### PUT `/bom/edit/:id`
Auth required (super_admin/admin). Same fields, all optional. The response carries the same `recipeModeAdopted` flag (for example, when a draft BOM is activated).

### DELETE `/bom/delete/:id`
Auth required (super_admin/admin).

---

### GET `/bom/get-by-product/:productId`
Auth required (super_admin/admin). Existence check used by the product-edit page: returns the store's BOM header for a product; lines are returned as ids only. Store scope: the caller's pinned store (store-less callers see any store's BOM).

**Response:**
```json
{
  "success": true,
  "message": "Success",
  "data": { "id": 1, "store": 1, "productId": 10, "name": "Resep Nasi Goreng", "totalQty": 2, "notes": null, "status": "active", "lines": [{ "id": 1 }] }
}
```

Key errors: 404 `{"success":false,"message":"BOM not found for this product"}`.

---

---

## Production Order

### GET `/production-order/get-all`
Auth required. **Query:** `page`, `limit`, `search`, `status`.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "productItem": { "id": 1, "name": "Nasi Goreng" },
      "plannedQty": 100,
      "producedQty": 0,
      "status": "planned",
      "scheduledDate": "2026-07-12"
    }
  ],
  "pagination": { "total": 10, "page": 1, "limit": 10, "totalPages": 1 }
}
```

---

### GET `/production-order/get-by-id/:id`
Auth required.

### POST `/production-order/create`
Auth required (super_admin/admin).

**Request:**
```json
{
  "productItemId": "number (required)",
  "plannedQty": "number (required)",
  "scheduledDate": "string (optional)",
  "notes": "string (default: '')",
  "status": "planned | in_progress | completed | cancelled | draft (default: planned)",
  "store": "number (optional)"
}
```

### PUT `/production-order/update/:id`
Auth required (super_admin/admin). Same fields, all optional.

### DELETE `/production-order/delete/:id`
Auth required (super_admin/admin).

### PATCH `/production-order/status/:id`
Auth required (super_admin/admin).

**Request:**
```json
{ "status": "planned | in_progress | completed | cancelled | draft (required)" }
```

### POST `/production-order/start/:id`
Auth required (super_admin/admin). Sets status to `in_progress`.

### POST `/production-order/complete/:id`
Auth required (super_admin/admin). Sets status to `completed`, deducts ingredients, adds product stock.

---

---

## Sales Return

### GET `/sales-return/get-all`
Auth required. **Query:** `page`, `limit`, `search`, `store`, `status`.

### GET `/sales-return/get-by-id/:id`
Auth required.

### PATCH `/sales-return/approve/:id`
Auth required (super_admin/admin).

### PATCH `/sales-return/reject/:id`
Auth required (super_admin/admin).

---

---

## Employee

### GET `/employee/get-employee`
Auth required. **Query:** `search` (string), `location` (store filter, honored for a global super_admin), `status`, `page`, `limit`.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "employeeID": "EMP-2026-001",
      "fullName": "Budi Santoso",
      "userName": "budi",
      "store": 1,
      "storeData": { "id": 1, "name": "Toko A" },
      "positionData": { "id": 1, "name": "Kasir" },
      "departmentData": { "id": 1, "name": "Front Office" },
      "status": "active"
    }
  ]
}
```

Key errors: 403 for confined actors (admin / store-bound super_admin) when the account has no store or `location` names another store.

---

### GET `/employee/get-employee/:id`
Auth required. Get by DB ID.

### GET `/employee/get-employee-detail/:employeeID`
Auth required. Get by employee ID string.

### POST `/employee/add-employee`
Auth required (super_admin/admin). Content-Type: `multipart/form-data`.

**Request:**
| Field | Type | Required | Default |
|-------|------|----------|---------|
| `userName` | string | **YES** | - |
| `password` | string | **YES** | - |
| `confirmPassword` | string | **YES** | - |
| `fullName` | string | No | `''` |
| `email` | string | No | - |
| `phoneNumber` | string | No | `''` |
| `gender` | string | No | `''` |
| `address` | string | No | `''` |
| `dateOfBirth` | string | No | null |
| `placeOfBirth` | string | No | `''` |
| `store` | number | No | null |
| `shift` | number | No | null |
| `position` | number | No | null |
| `roleId` | number | No | null |
| `department` | string | No | null |
| `departmentId` | number | No | null |
| `employmentType` | string | No | null |
| `startDate` | string | No | null |
| `status` | string | No | `active` |
| `monthlySalary` | string | No | null |
| `dailySalary` | string | No | null |
| `image` | file | No | null |
| `documents` | file[] | No | null |

### PUT `/employee/edit-employee`
Auth required (super_admin/admin). Same fields, all optional.

### DELETE `/employee/delete-employee/:id`
Auth required (super_admin/admin).

---

### GET `/employee/performance`
Auth required (any authenticated role, store access). Paginated daily cashier performance rows for the active store.

**Query:**
| Field | Type | Description |
|-------|------|-------------|
| `startDate` / `endDate` | date | Optional `report_date` range. |
| `page` | number | Default 1. |
| `limit` | number | Default 30. |

**Response:**
```json
{
  "success": true,
  "data": [
    { "id": 1, "store": 1, "cashier": 10, "report_date": "2026-10-19", "total_sales": "1500000.00", "transactions": 42, "avg_transaction": "35714.29", "items_sold": 88, "accuracy_rate": "99.50", "cashierData": { "id": 10, "fullName": "Budi" }, "storeData": { "id": 1, "name": "Toko A" } }
  ],
  "pagination": { "total": 1, "page": 1, "limit": 30, "totalPages": 1 }
}
```

Key errors: 403 `Store assignment required` (non-super_admin with no store).

---

### GET `/employee/:id/performance`
Auth required (any authenticated role, store access). One employee's (`:id` = cashier DB user ID) performance history with summary.

**Query:** `startDate`, `endDate`, `page` (default 1), `limit` (default 30).

**Response:**
```json
{
  "success": true,
  "summary": { "employeeId": 10, "employeeName": "Budi", "totalRecords": 1, "avgSales": 1500000, "avgTransactions": 42, "avgAccuracy": "99.50" },
  "data": [
    { "id": 1, "store": 1, "cashier": 10, "report_date": "2026-10-19", "total_sales": "1500000.00", "transactions": 42, "accuracy_rate": "99.50", "cashierData": { "id": 10, "fullName": "Budi", "userName": "budi" }, "storeData": { "id": 1, "name": "Toko A" } }
  ],
  "pagination": { "total": 1, "page": 1, "limit": 30 }
}
```

Key errors: 403 `Store assignment required`; 404 `No performance data found`.

---

### GET `/employee/top-performers`
Auth required (any authenticated role, store access). Ranked performers by total sales for the store.

**Query:**
| Field | Type | Description |
|-------|------|-------------|
| `startDate` / `endDate` | date | Optional `report_date` range. |
| `limit` | number | Default 10, capped at 100. |

**Response:**
```json
{
  "success": true,
  "data": [
    { "cashier": 10, "total_sales": "9500000", "avg_transaction": "36000", "avg_accuracy": "99", "days_worked": "6", "cashierData": { "id": 10, "fullName": "Budi", "userName": "budi" } }
  ]
}
```

Key errors: 403 `Store assignment required`.

---

---

## Department

### GET `/department/get-department`
Auth required. Returns all departments (dropdown).

**Response:**
```json
{
  "success": true,
  "data": [{ "id": 1, "name": "Front Office", "status": "active" }]
}
```

---

### GET `/department/get-department-all`
Auth required. **Query:** `page`, `limit`, `search`.

### GET `/department/get-department/:id`
Auth required.

### POST `/department/add-new-department`
Auth required (super_admin/admin).

**Request:**
```json
{
  "name": "string (required)",
  "description": "string (optional)",
  "status": "active | inactive | draft (default: active)",
  "store": "number (optional)"
}
```

### PUT `/department/edit-department/:id`
Auth required (super_admin/admin). Same fields, all optional.

### DELETE `/department/delete-department/:id`
Auth required (super_admin/admin).

### GET `/department/download-template`, GET `/department/download`, POST `/department/upload`
Auth required (super_admin/admin). Import uses multipart/form-data.

---

### GET `/department/download`
Auth required (super_admin/admin, store access). Downloads all departments as an Excel file. Note: the query is not store-filtered by the controller.

**Query:**
| Field | Type | Description |
|-------|------|-------------|
| `status` | string | `all` (default) \| `active` \| `inactive` \| `draft`. |

**Response:** binary `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `Content-Disposition: attachment; filename=departemen-data.xlsx` (columns: id, name, description, status).

Key errors: 500 only (no JSON on success).

---

### POST `/department/upload`
Auth required (super_admin/admin, store access). Bulk import departments from an Excel file (multipart/form-data, field `file`; `.xlsx`/`.xls`, max 10 MB). Template sheet name: `Departemen`; header row: `No. | Nama Departemen (Wajib) | Deskripsi | Status (Aktif/Nonaktif)`. Status values accepted: `draft`, `nonaktif`/`nonactive`/`false` → `inactive`, otherwise `active`. Existing department names are skipped.

**Response:**
```json
{
  "success": true,
  "message": "Berhasil memproses 3 dari 4 departemen",
  "data": { "total": 4, "created": 3, "skipped": 1 }
}
```

Key errors: 400 `Tidak ada file yang diupload`; 400 `Sheet "Departemen" tidak ditemukan`; 400 invalid header template; 400 `Terdapat kesalahan pada data` (with `errors` array); 400 duplicate names within the uploaded file.

---

---

## Position

### GET `/position/get-position`
Auth required. Returns all positions (dropdown).

### GET `/position/get-position/:id`
Auth required.

### GET `/position/get-position-all`
Auth required. **Query:** `page`, `limit`, `search`.

### POST `/position/add-new-position`
Auth required (super_admin/admin).

**Request:**
```json
{
  "name": "string (required)",
  "description": "string (optional)",
  "status": "active | inactive | draft (default: active)",
  "store": "number (optional)"
}
```

### PUT `/position/edit-position/:id`
Auth required (super_admin/admin). Same fields, all optional.

### DELETE `/position/delete-position/:id`
Auth required (super_admin/admin).

### GET `/position/download-template`, GET `/position/download`, POST `/position/upload`
Auth required (super_admin/admin). Import uses multipart/form-data.

---

### GET `/position/download`
Auth required (super_admin/admin, store access). Downloads all positions (with department name) as an Excel file. Note: the query is not store-filtered by the controller.

**Query:**
| Field | Type | Description |
|-------|------|-------------|
| `status` | string | `all` (default) \| `active` \| `inactive` \| `draft`. |

**Response:** binary xlsx, `Content-Disposition: attachment; filename=jabatan-data.xlsx`.

Key errors: 500 only.

---

### GET `/position/get-position-by-department/:departmentId`
Auth required (any authenticated role, store access). Positions belonging to one department. Note: filtered by `departmentId` only — no store filter in the controller.

**Response:**
```json
{
  "success": true,
  "message": "Success",
  "data": [
    { "id": 1, "name": "Kasir", "departmentId": 2, "departmentData": { "id": 2, "name": "Front Office" }, "description": null, "status": "active" }
  ]
}
```

Key errors: 400 `Department ID wajib diisi` (empty path value).

---

### POST `/position/upload`
Auth required (super_admin/admin, store access). Bulk import positions from an Excel file (multipart/form-data, field `file`). Template sheet name: `Jabatan`; header row: `No. | Nama Jabatan (Wajib) | Departemen | Deskripsi Jabatan | Status (Aktif/Nonaktif)`. `Departemen` is required and must match an existing department (name, `id.name`, or numeric id). Status: `draft`, `aktif`/`active`/`true` → `active`, `nonaktif`/`nonactive`/`false` → `inactive`. Existing position names are skipped.

**Response:**
```json
{
  "success": true,
  "message": "Berhasil memproses 2 dari 2 jabatan",
  "data": { "total": 2, "created": 2, "skipped": 0 }
}
```

Key errors: 400 no file / sheet `Jabatan` missing / invalid header template / row errors (`errors` array, e.g. missing department or unknown department) / duplicate names in file.

---

---

## Role

### GET `/role/get-role`
No auth. Returns roles for dropdown.

**Response:**
```json
{
  "success": true,
  "data": [
    { "id": 1, "name": "Super Admin", "permissions": {} },
    { "id": 2, "name": "Admin", "permissions": {} }
  ]
}
```

---

### GET `/role/get-role-all`
Auth required (super_admin). **Query:** `page` (number).

### GET `/role/get-role-by-id/:id`
Auth required.

### POST `/role/add-new-role`
Auth required (super_admin).

**Request:**
```json
{
  "name": "string (required)",
  "permissions": "JSON object (default: {})"
}
```

### PUT `/role/edit-role/:id`
Auth required (super_admin). Same fields, all optional.

### DELETE `/role/delete-role/:id`
Auth required (super_admin).

### PUT `/role/update-user-role`
Auth required (super_admin).

**Request:**
```json
{ "userId": "number (required)", "roleId": "number (required)" }
```

### GET `/role/get-users-by-role`
Auth required. **Query:** `roleId` (number).

### PUT `/role/update-access-menu`
Auth required (super_admin).

**Request:**
```json
{
  "roleId": "number (required)",
  "accessMenu": "JSON object (required)"
}
```

---

---

## Report

### GET `/report/daily`
Auth required. **Query:** `store` (number), `startDate` (ISO date), `endDate` (ISO date).

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "tanggal": "2026-07-11",
      "totalTransaksi": 50,
      "totalPenjualanBersih": 4500000,
      "totalHpp": 1800000,
      "foodCostPersen": 40,
      "grossProfit": 2700000,
      "netProfit": 2200000,
      "totalCovers": 80
    }
  ]
}
```

---

### GET `/report/cash-flow`
Auth required. **Query:** `store`, `startDate`, `endDate`.

**Response:**
```json
{
  "success": true,
  "data": {
    "penerimaanTunai": 30000000,
    "penerimaanQris": 10000000,
    "penerimaanTransfer": 5000000,
    "totalKasMasuk": 45000000,
    "totalPengeluaran": 10000000,
    "netCashFlow": 35000000
  }
}
```

---

### GET `/report/sales-summary`
Auth required. **Query:** `store`, `startDate`, `endDate`, `filter` (today|weekly|monthly).

**Response:**
```json
{
  "success": true,
  "data": {
    "totalSales": 50000000,
    "totalOrders": 500,
    "avgTransaction": 100000,
    "totalCustomers": 200,
    "totalStores": 5,
    "salesChart": [{ "date": "2026-07-11", "sales": 5000000, "orders": 50 }],
    "storeSalesChart": [{ "storeId": 1, "storeName": "Jakarta", "data": [...] }],
    "stores": [{ "id": 1, "name": "Jakarta", "sales": 5000000, "transactions": 50 }]
  }
}
```

---

### GET `/report/best-seller`
Auth required. **Query:** `store`, `startDate`, `endDate`, `limit`.

**Response:**
```json
{
  "success": true,
  "data": {
    "bestSellers": [{ "id": 1, "name": "Nasi Goreng", "image": "...", "sold": 100, "revenue": 2500000 }],
    "summary": { "totalUnitsSold": 500, "totalRevenue": 25000000, "activeProducts": 50 }
  }
}
```

---

### GET `/report/profit-per-product`
Auth required. **Query:** `store`, `startDate`, `endDate`.

**Response:**
```json
{
  "success": true,
  "data": [
    { "productId": 1, "productName": "Nasi Goreng", "qtySold": 100, "totalSales": 2500000, "totalHpp": 1000000, "profit": 1500000, "margin": 60 }
  ]
}
```

---

### GET `/report/export/:key`
Export one report definition as a downloadable file. Non-super_admin must have a store assignment.

**Query:** `format` (required: `excel`, `pdf`, `csv`), `store` (number, super_admin selector), plus the report's own filters (e.g. `startDate`, `endDate`). Report keys: `daily`, `sales`, `cashFlow`, `profitPerProduct`, `bestSeller`, `productSales`, `categorySales`, `kasirPerformance`. Saved layout/branding from `report_config` is applied.

**Response:** binary file download (not JSON) — `Content-Type` `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` / `application/pdf` / `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="<report-name>.<ext>"`.

Key errors: 404 `Report tidak ditemukan` (unknown key); 400 `Format tidak didukung`; 403 `Store assignment required`.

### GET `/report/data/:key`
Auth required (store-scoped, 20 requests / 15 min per user, shared with export). Returns the same report definition as `/report/export/:key` as JSON, with the saved `report_config` layout applied, so the on-screen table, the export and the settings page show the same columns. Audited as `REPORT_EXPORT`.

**Query:** same as export, without `format`.

**Response:**
```json
{
  "success": true,
  "data": {
    "key": "sales", "title": "Laporan Penjualan", "subtitle": "…", "accentColor": "#…",
    "columns": [{ "key": "orderNumber", "label": "No. Order", "type": "text", "align": "left" }],
    "rows": [],
    "totals": {}
  }
}
```

Key errors: 404 `Report tidak ditemukan`; 403 `Store assignment required`.

---

---

## Promo Campaign

### GET `/promo/campaigns`
Auth required. **Query:** `store` (number).

### GET `/promo/campaigns/stats`
Auth required. **Query:** `store`.

### GET `/promo/campaigns/:id`
Auth required.

### POST `/promo/campaigns`
Auth required (super_admin/admin). Create promo campaign with rules & rewards.

**Request:**
| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `store` | number | YES | - | Store ID |
| `name` | string | YES | - | Campaign name |
| `type` | string | YES | - | `happy_hour`, `birthday`, `buy_x_get_y`, `spend_get`, `manual`, `automatic` |
| `discountType` | string | No | `percentage` | `percentage`, `fixed`, `free_item`, `buy_x_get_y` |
| `discountValue` | number | No | `0` | Discount amount/percentage |
| `maxDiscount` | number | No | null | Cap for percentage discounts |
| `minPurchase` | number | No | `0` | Minimum cart subtotal |
| `startDate` | date | YES | - | ISO date |
| `endDate` | date | YES | - | ISO date |
| `startTime` | string | No | null | HH:mm:ss |
| `endTime` | string | No | null | HH:mm:ss |
| `daysOfWeek` | number[] | No | null | 0-6 (Sun-Sat) |
| `applicableTo` | string | No | `all` | `all`, `specific_products`, `specific_categories`, `specific_members` |
| `applicableIds` | number[] | No | null | Product/category/member IDs |
| `maxUsageTotal` | number | No | null | Global usage cap |
| `maxUsagePerMember` | number | No | null | Per-member usage cap |
| `priority` | number | No | `0` | Higher = evaluated first |
| `isCombinable` | boolean | No | `false` | Can stack with other promos |
| `rules` | object[] | No | - | Array of `{ ruleType, condition, priority }` |
| `rewards` | object[] | No | - | Array of `{ rewardType, rewardValue, maxRewardValue, productId, quantity, condition }` |

**Rules ruleType:** `time`, `birthday`, `buy_x_get_y`, `spend_threshold`, `member_tier`, `first_purchase`, `custom`
**Rewards rewardType:** `discount_percentage`, `discount_fixed`, `free_item`, `buy_x_get_y`, `points_multiplier`, `cashback`

### PUT `/promo/campaigns/:id`
Auth required (super_admin/admin). Same fields, all optional.

### PUT `/promo/campaigns/:id/status`
Auth required (super_admin/admin). Toggle campaign status.

### DELETE `/promo/campaigns/:id`
Auth required (super_admin/admin).

### POST `/promo/apply`
Auth required. Apply promo to cart.

**Request:**
```json
{
  "store": "number (required)",
  "memberId": "number (optional)",
  "code": "string (optional)",
  "cartItems": [{ "productId": 1, "quantity": 2, "price": 25000 }],
  "subtotal": 50000
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "applicablePromos": [{ "campaignId": 1, "name": "Happy Hour", "discountAmount": 5000 }],
    "bestPromo": { "campaignId": 1, "name": "Happy Hour", "discountAmount": 5000 }
  }
}
```

### POST `/promo/usage`
Auth required (admin/cashier). Record promo usage event.

### POST `/promo/auto-activate`
Auth required (super_admin). Auto-activate campaigns based on schedule.

---

### GET `/promo/customer-active`
No auth. Public active-promo list for the customer app: at most 10 campaigns, highest `priority` first, currently inside their date window and (when set) today's time window and day-of-week list (`daysOfWeek` is 0 = Sunday … 6 = Saturday). The cap is applied after the time/day filter.

**Query:**
| Field | Type | Description |
|-------|------|-------------|
| `store` | number | Optional; matches promos whose JSONB store list contains it, plus global (`store: null`) promos |

**Response:**
```json
{
  "success": true,
  "message": "Success get customer active promos",
  "data": [
    { "id": 1, "name": "Happy Hour", "description": null, "code": null, "type": "happy_hour", "discountType": "percentage", "discountValue": 10, "maxDiscount": 50000, "minPurchase": 0, "startDate": "2026-10-01", "endDate": "2026-10-31", "startTime": "15:00:00", "endTime": "18:00:00", "daysOfWeek": ["mon"], "applicableTo": "all", "priority": 5 }
  ]
}
```

Key errors: 500.

---

---

## Product Bundle / Combo

### GET `/product-bundle/get-all`
Auth required. **Query:** `store`, `status`, `search`, `page`, `limit`.

**Response:**
```json
{
  "message": "success",
  "data": {
    "items": [
      {
        "id": 1, "name": "Paket Hemat A", "sku": "BNDL-20260718-0042",
        "bundlePrice": 75000, "originalPrice": 100000,
        "discountAmount": 25000, "discountPercentage": 25.0,
        "status": "active",
        "items": [{ "product": 10, "quantity": 2, "unitPrice": 30000, "productData": { "nameProduct": "Kopi Susu", "stock": 100 } }]
      }
    ],
    "total": 25, "pagination": { "page": 1, "limit": 10, "totalPages": 3 },
    "stats": { "active": 10, "draft": 5, "inactive": 10, "total": 25 }
  }
}
```

### GET `/product-bundle/get-by-id/:id`
Auth required.

### POST `/product-bundle/create`
Auth required (super_admin/admin).

**Request:**
| Field | Type | Required | Default |
|-------|------|----------|---------|
| `name` | string | YES | - |
| `description` | string | No | - |
| `bundlePrice` | number | No | `0` |
| `items` | object[] | YES | - |
| `items[].product` | number | YES | - |
| `items[].quantity` | No | `1` |
| `items[].unitPrice` | No | product price |
| `isAvailable` | boolean | No | `true` |
| `status` | string | No | `draft` |
| `validFrom` | date | No | null |
| `validUntil` | date | No | null |

### PUT `/product-bundle/update/:id`
Auth required (super_admin/admin). Same fields, all optional.

### DELETE `/product-bundle/delete/:id`
Auth required (super_admin/admin).

### PATCH `/product-bundle/status/:id`
Auth required (super_admin/admin). Toggle bundle status.

---

### GET `/product-bundle/customer-active`
No auth. Public customer-facing list of active, available bundles for one store (required — "public" is still store-scoped; bundles are only returned when their store list contains the requested store and they are inside their validity window).

**Query:**
| Field | Type | Description |
|-------|------|-------------|
| `store` | number | Required |

**Response:**
```json
{
  "success": true,
  "message": "Success get customer active bundles",
  "data": {
    "items": [
      {
        "id": 1, "store": [1], "name": "Paket Hemat A", "sku": "BNDL-20261018-0042", "description": null, "image": null,
        "bundlePrice": 75000, "originalPrice": 100000, "discountAmount": 25000, "discountPercentage": 25,
        "minQuantity": 1, "maxQuantity": null, "isAvailable": true, "status": "active", "validFrom": null, "validUntil": null,
        "items": [{ "id": 1, "bundleId": 1, "product": 10, "quantity": 2, "unitPrice": 30000, "isOptional": false, "productData": { "id": 10, "nameProduct": "Kopi Susu", "price": 30000, "image": null, "stock": 100 } }]
      }
    ]
  }
}
```

Key errors: 400 `{"message":"store is required"}`; 400 `{"message":"Invalid store value"}`.

---

---

## Delivery Management

### GET `/delivery/orders`
Auth required. **Query:** `store`, `status`, `page`, `limit`.

### GET `/delivery/orders/stats`
Auth required. **Query:** `store`.

**Response:**
```json
{
  "success": true,
  "data": { "total": 100, "pending": 10, "assigned": 5, "inTransit": 8, "delivered": 70, "cancelled": 7 }
}
```

### GET `/delivery/orders/:id`
Auth required.

### POST `/delivery/orders`
Auth required (super_admin/admin).

**Request:**
| Field | Type | Required |
|-------|------|----------|
| `store` | number | YES |
| `customerName` | string | YES |
| `customerPhone` | string | No |
| `deliveryAddress` | string | YES |
| `deliveryNotes` | string | No |
| `destinationLat` | number | No |
| `destinationLng` | number | No |
| `deliveryFee` | number | No |
| `totalDistance` | number | No |
| `source` | string | No (`pos`, `gofood`, `grabfood`, `shopeefood`) |

### PUT `/delivery/orders/status`
Auth required (super_admin/admin). Update delivery status.

### PUT `/delivery/orders/:orderId/assign-driver`
Auth required (super_admin/admin).

### PUT `/delivery/orders/:id/cancel`
Auth required (super_admin/admin).

### GET `/delivery/drivers`
Auth required. **Query:** `store`, `status`.

### GET `/delivery/drivers/:id`
Auth required.

### POST `/delivery/drivers`
Auth required (super_admin/admin).

**Request:**
| Field | Type | Required |
|-------|------|----------|
| `name` | string | YES |
| `store` | number[] | No |
| `phone` | string | No |
| `email` | string | No |
| `vehicleType` | string | No |
| `vehiclePlate` | string | No |
| `status` | string | No (`active`, `inactive`, `busy`, `offline`, `draft`) |

### PUT `/delivery/drivers/:id`
Auth required (super_admin/admin). Same fields, all optional.

### DELETE `/delivery/drivers/:id`
Auth required (super_admin/admin).

### PUT `/delivery/drivers/:id/status`
Auth required (super_admin/admin). Update driver availability.

### GET `/delivery/marketplace-config`
Auth required (super_admin). **Query:** `store`.

**Response:**
```json
{
  "success": true,
  "data": {
    "store": 1,
    "gofood": { "enabled": false, "merchantId": null, "apiKey": null },
    "grabfood": { "enabled": false, "merchantId": null, "apiKey": null },
    "shopeefood": { "enabled": false, "merchantId": null, "apiKey": null }
  }
}
```

### POST `/delivery/marketplace-config`
Auth required (super_admin). Save marketplace config.

### GET `/delivery/stats`
Auth required. **Query:** `store`.

---

### GET `/delivery/drivers/stats`
Auth required. Delivery counters for the selected store (super_admin may pass `store`; everyone else is pinned to their own store). Same handler as `GET /delivery/orders/stats` and `GET /delivery/stats`.

**Query:**
| Param | Type | Description |
|-------|------|-------------|
| `store` | number | super_admin store selector |

**Response:**
```json
{
  "success": true,
  "message": "Success get delivery stats",
  "data": {
    "total": 100,
    "pending": 10,
    "assigned": 5,
    "pickedUp": 8,
    "inTransit": 12,
    "delivered": 58,
    "cancelled": 7,
    "totalDrivers": 6,
    "activeDrivers": 4
  }
}
```

---

---

## Queue Management

### GET `/queue/`
Auth required. **Query:** `store`, `status`, `page`, `limit`.

### GET `/queue/stats`
Auth required. **Query:** `store`.

**Response:**
```json
{
  "success": true,
  "data": { "totalToday": 42, "waitingNow": 5, "seatedToday": 30, "cancelledToday": 3, "avgWaitMinutes": 12 }
}
```

### GET `/queue/:id`
Auth required.

### POST `/queue/`
Auth required (super_admin/admin/cashier).

**Request:**
| Field | Type | Required | Default |
|-------|------|----------|---------|
| `store` | number | YES | - |
| `customerName` | string | YES | - |
| `customerPhone` | string | No | null |
| `partySize` | number | No | `1` |
| `priority` | string | No | `normal` (`normal`, `vip`, `elderly`, `pregnant`, `disabled`) |
| `estimatedWaitMinutes` | number | No | null |
| `notes` | string | No | null |

**Response:** Queue entry with auto-generated `queueNumber` (format: `QHHMM-XXX`).

### PUT `/queue/:id`
Auth required (super_admin/admin/cashier). Same fields, all optional.

### PUT `/queue/:id/status`
Auth required (super_admin/admin/cashier). Update queue status (`waiting`, `seated`, `completed`, `cancelled`).

### DELETE `/queue/:id`
Auth required (super_admin/admin).

---

---

## Supplier Performance

### GET `/supplier-performance/scores`
Auth required. **Query:** `store`, `search`, `period` (monthly|quarterly|yearly|all_time), `grade` (A-F), `page`, `limit`.

**Response:**
```json
{
  "success": true,
  "data": [{
    "id": 1, "supplierId": 5, "period": "monthly",
    "periodStart": "2026-06-01", "periodEnd": "2026-06-30",
    "totalOrders": 15, "completedOrders": 14, "cancelledOrders": 1,
    "onTimeDeliveries": 12, "lateDeliveries": 2, "onTimeRate": "85.71",
    "totalReceivedQty": 500, "defectiveQty": 5, "defectRate": "1.00",
    "totalPurchaseAmount": 5000000, "avgPricePerItem": 10000,
    "priceCompetitivenessScore": 90, "overallScore": "88.14", "grade": "B",
    "supplier": { "id": 5, "name": "PT Sumber Jaya" }
  }],
  "pagination": { "page": 1, "limit": 10, "total": 30, "totalPages": 3 }
}
```

### GET `/supplier-performance/scores/top`
Auth required. **Query:** `store`.

### GET `/supplier-performance/scores/:id`
Auth required.

### GET `/supplier-performance/performance/:supplierId`
Auth required. Detailed performance summary.

### POST `/supplier-performance/scores/calculate`
Auth required (super_admin/admin). Recalculate supplier score.

**Request:**
| Field | Type | Required |
|-------|------|----------|
| `store` | number | YES |
| `supplierId` | number | YES |
| `period` | string | YES (`monthly`, `quarterly`, `yearly`, `all_time`) |
| `periodStart` | date | No (auto-calculated) |
| `periodEnd` | date | No (auto-calculated) |

**Score formula:** onTime(40%) + (100-defectRate)(30%) + priceCompetitiveness(30%)
**Grade:** A (>=90), B (>=80), C (>=70), D (>=60), F (<60)

### PUT `/supplier-performance/scores/:id/notes`
Auth required (super_admin/admin). Update notes.

---

---

## Best Selling

### GET `/best-selling/get-chart-by-year`
Auth required (super_admin/admin). **Query:** `store`, `year`.

### GET `/best-selling/get-chart-by-month`
Auth required (super_admin/admin). **Query:** `store`, `year`, `month`.

### GET `/best-selling/get-chart-current-and-two-days-before`
Auth required. **Query:** `store`.

### GET `/best-selling/get-chart-current-and-seven-days-before`
Auth required. **Query:** `store`.

### GET `/best-selling/get-earning-today`
Auth required. **Query:** `store`.

**Response:**
```json
{
  "success": true,
  "data": { "total": 5000000, "orders": 50, "avgOrder": 100000 }
}
```

---

---

## Overview (Dashboard)

All require auth. **Query:** `store` (number).

| Endpoint | Response `data` |
|----------|-----------------|
| GET `/overview/product` | `{ total, active, inactive }` |
| GET `/overview/category` | `{ total }` |
| GET `/overview/location` | `{ total, active }` |
| GET `/overview/member` | `{ total, active }` |
| GET `/overview/user` | `{ total, active }` |
| GET `/overview/best-selling` | Array of top products |
| GET `/overview/members/latest` | Array of recent members |
| GET `/overview/categories/latest` | Array of recent categories |
| GET `/overview/locations/latest` | Array of recent locations |
| GET `/overview/products/latest` | Array of recent products |

---

### GET `/overview/product`
Product count summary.

**Query:** `store` (number, super_admin selector).

**Response:**
```json
{ "success": true, "message": "Success get product summary", "data": { "total": 120, "active": 110, "inactive": 10 } }
```

Key errors: 500.

---

### GET `/overview/category`
Category count summary.

**Query:** `store` (number, super_admin selector).

**Response:**
```json
{ "success": true, "message": "Success get category summary", "data": { "total": 14, "active": 12, "inactive": 2 } }
```

Key errors: 500.

---

### GET `/overview/location`
Location count summary (scoped to the single store id when one is resolved).

**Query:** `store` (number, super_admin selector).

**Response:**
```json
{ "success": true, "message": "Success get location summary", "data": { "total": 1, "active": 1, "inactive": 0 } }
```

Key errors: 500.

---

### GET `/overview/member`
Member count for the store.

**Query:** `store` (number, super_admin selector).

**Response:**
```json
{ "success": true, "message": "Success get member summary", "data": { "total": 320 } }
```

Key errors: 500.

---

### GET `/overview/user`
Staff (user) count for the store.

**Query:** `store` (number, super_admin selector).

**Response:**
```json
{ "success": true, "message": "Success get user summary", "data": { "total": 8 } }
```

Key errors: 500.

---

### GET `/overview/best-selling`
Top best-selling rows ordered by `totalSelling` DESC.

**Query:** `store` (number, super_admin selector), `limit` (number, default 5).

**Response:**
```json
{
  "success": true,
  "message": "Success get best selling",
  "data": [{ "id": 1, "store": 3, "productId": 7, "nameProduct": "Kopi Susu", "image": "kopi.jpg", "totalSelling": 320 }]
}
```

Key errors: 500.

---

### GET `/overview/members/latest`
Most recently updated members.

**Query:** `store` (number, super_admin selector), `limit` (number, default 5).

**Response:**
```json
{
  "success": true,
  "message": "Success get latest members",
  "data": [{ "id": 45, "store": 3, "name": "Siti", "phoneNumber": "0812...", "email": null, "tier": 2, "totalPoints": 120, "status": "active", "updatedAt": "2026-10-19T04:00:00.000Z" }]
}
```

Key errors: 500.

---

### GET `/overview/categories/latest`
Most recently updated categories.

**Query:** `store` (number, super_admin selector), `limit` (number, default 5).

**Response:**
```json
{
  "success": true,
  "message": "Success get latest categories",
  "data": [{ "id": 14, "name": "Snack", "image": null, "status": "active", "updatedAt": "2026-10-19T03:00:00.000Z" }]
}
```

Key errors: 500.

---

### GET `/overview/locations/latest`
Most recently updated locations (scoped to the resolved store id).

**Query:** `store` (number, super_admin selector), `limit` (number, default 5).

**Response:**
```json
{
  "success": true,
  "message": "Success get latest locations",
  "data": [{ "id": 3, "name": "Cabang Jakarta", "status": "active", "updatedAt": "2026-10-18T09:00:00.000Z" }]
}
```

Key errors: 500.

---

### GET `/overview/products/latest`
Most recently updated products.

**Query:** `store` (number, super_admin selector), `limit` (number, default 5).

**Response:**
```json
{
  "success": true,
  "message": "Success get latest products",
  "data": [{ "id": 7, "nameProduct": "Kopi Susu", "sku": "KS-01", "stock": 40, "status": "active", "updatedAt": "2026-10-19T02:00:00.000Z" }]
}
```

Key errors: 500.

---

---

## POS Extended

### GET `/pos/lookup-barcode`
Auth required. **Query:** `barcode` (string), `store` (number).

**Response:**
```json
{
  "success": true,
  "data": { "id": 1, "nameProduct": "Nasi Goreng", "price": 25000, "stock": 100 }
}
```

---

### POST `/pos/transfer`
Auth required (super_admin/admin).

**Request:**
```json
{
  "fromStore": "number (required)",
  "toStore": "number (required)",
  "items": [
    { "product": "number (required)", "quantity": "number (required)", "notes": "string (default: '')" }
  ],
  "notes": "string (default: '')",
  "transferredBy": "number (optional)"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Stock transfer created",
  "data": { "id": 1, "transferNumber": "TRF-1717234567890", "status": "pending" }
}
```

---

### GET `/pos/transfer-history`
Auth required. **Query:** `page`, `limit`, `status`, `startDate`, `endDate`, `store`.

### GET `/pos/transfer/:id`
Auth required.

### PUT `/pos/transfer/:id/receive`
Auth required (super_admin/admin). Confirms transfer, moves stock.

### PUT `/pos/transfer/:id/cancel`
Auth required (super_admin/admin).

### POST `/pos/adjust`
Auth required (super_admin/admin).

**Request:**
```json
{
  "productId": "number (required)",
  "qty": "number (optional)",
  "sign": "+ | - (optional)",
  "value": "number (optional)",
  "reason": "string (default: '')",
  "storeId": "number (optional)"
}
```

### POST `/pos/purchase-order/:id/return`
Auth required (super_admin/admin).

**Request:**
```json
{
  "items": "array of { productId, quantity, reason } (required, min 1)",
  "reason": "string (default: '')",
  "returnedBy": "number (optional)"
}
```

### POST `/pos/order/:id/return`
Auth required (super_admin/admin). Same structure as PO return.

### GET `/pos/member/:id/point-history`
Auth required. **Query:** `page`, `limit`.

**Response:**
```json
{
  "success": true,
  "data": [
    { "id": 1, "type": "earn", "points": 100, "description": "Order #100", "createdAt": "2026-07-11" },
    { "id": 2, "type": "redeem", "points": -50, "description": "Discount redemption", "createdAt": "2026-07-10" }
  ],
  "pagination": { "total": 20, "page": 1, "limit": 10, "totalPages": 2 }
}
```

---

### GET `/pos/dashboard/summary`
Auth required. **Query:** `store` (number).

**Response:**
```json
{
  "success": true,
  "message": "Success",
  "data": {
    "totalSales": 5000000,
    "dailyTarget": 10000000,
    "averageOrderValue": 100000,
    "netSales": 4900000,
    "totalOrders": 50,
    "totalProducts": 120,
    "totalMembers": 200,
    "paymentMethods": [],
    "storeInfo": { "id": 1, "name": "Toko A" },
    "salesChart": [],
    "bestSellers": [],
    "recentOrders": [],
    "totalExpense": 100000,
    "recentExpenses": [],
    "lowStock": [],
    "filter": {}
  }
}
```

---

### GET `/pos/product/price-by-store`
Auth required (super_admin/admin). **Query:** `productId` (number).

### PUT `/pos/product/update-price-by-store`
Auth required (super_admin/admin).

**Request:**
```json
{
  "productId": "number (required)",
  "storePrices": [
    { "storeId": 1, "price": 25000 },
    { "storeId": 2, "price": 27000 }
  ]
}
```

### GET `/pos/invoice/wa-text/:orderId`
Auth required (store-scoped; another store's order → 404). Returns the receipt as WhatsApp text — same sections and invoice-setting switches as the printed receipt. Nothing is sent: the client opens `https://wa.me/<number>?text=<text>` on the cashier's own WhatsApp.

**Response:**
```json
{ "success": true, "data": { "orderId": 42, "text": "*WARUNG A*\n…\n*TOTAL: Rp20.000*" } }
```

### GET `/pos/tables/status`
Auth required (super_admin/admin/kasir, store-scoped). Cashier "Meja" panel: every table of the store with its unpaid open orders and whether the caller may release it (BA C-16, BR-TBL-008).

**Response:**
```json
{
  "success": true, "message": "Success",
  "data": [{
    "id": 4, "name": "Meja 4", "status": "occupied", "capacity": 4,
    "unpaidOrders": [{ "id": 120, "orderNumber": "ORD-…", "source": "qr", "status": "pending", "paymentStatus": "unpaid", "totalPrice": 45000 }],
    "canRelease": false, "blockedReason": "TABLE_HAS_UNPAID_ORDER"
  }]
}
```
`blockedReason`: `ALREADY_AVAILABLE` · `TABLE_IN_MAINTENANCE` (kasir only) · `TABLE_HAS_UNPAID_ORDER` (kasir only) · `null`.

Key errors: 400 `STORE_REQUIRED`.

### PUT `/pos/tables/:id/release`
Auth required (super_admin/admin/kasir, store-scoped). Puts a table back to `available` and completes its pending/confirmed reservations. Idempotent; every release is audited with the reason.

**Request:**
```json
{ "reason": "string (required)" }
```

**Response:**
```json
{ "success": true, "message": "Meja tersedia kembali", "data": { "id": 4, "name": "Meja 4", "status": "available", "changed": true } }
```
`changed: false` with message `Meja sudah tersedia` when the table was already available.

Key errors: 400 `VALIDATION_ERROR` (bad id); 400 `RELEASE_REASON_REQUIRED`; 404 `TABLE_NOT_FOUND`; 409 `TABLE_IN_MAINTENANCE` (kasir); 409 `TABLE_HAS_UNPAID_ORDER` with `data.unpaidOrders` (kasir — admin may release).

### POST `/pos/invoice/send-email`
Auth required.

**Request:**
```json
{ "orderId": "number (required)", "email": "string (required, valid email)" }
```

### POST `/pos/product/add-batch`
Auth required (super_admin/admin).

**Request:**
```json
{
  "productId": "number (required)",
  "batchCode": "string (required)",
  "expiryDate": "string (optional)",
  "qty": "number (required)",
  "store": "number (required)"
}
```

### GET `/pos/product/batches`
Auth required. **Query:** `productId`, `store`.

---

### GET `/pos/dashboard/super-admin`
Auth required (super_admin; other roles receive 403). Global multi-store dashboard for a date range (defaults to the current month). Optional `store` scopes all figures to one store; omitted means all active stores.

**Query:**
| Field | Type | Description |
|-------|------|-------------|
| `startDate` | string | Optional ISO date; default = 1st of current month |
| `endDate` | string | Optional ISO date; default = last day of current month |
| `store` | number | Optional store filter |

**Response:**
```json
{
  "success": true,
  "message": "Success",
  "data": {
    "meta": { "storeId": null, "startDate": "2026-10-01T00:00:00.000Z", "endDate": "2026-10-31T23:59:59.999Z", "storeCount": 3 },
    "summary": {
      "revenue": 150000000, "orders": 500, "avgOrderValue": 300000, "itemsSold": 1200,
      "discount": 5000000, "tax": 15000000, "serviceCharge": 0,
      "totalExpense": 40000000, "netRevenue": 110000000, "netMargin": 73.3,
      "totalMembers": 200, "newMembers": 15, "activeProducts": 0, "lowStockCount": 4,
      "apOutstanding": 10000000, "arOutstanding": 2000000, "pendingOrders": 0,
      "growth": { "revenue": 12, "orders": 8, "expense": -3, "newMembers": 100 }
    },
    "kpiTrend": [{ "date": "2026-10-01", "revenue": 5000000, "orders": 20, "itemsSold": 45, "expense": 0, "inflow": 5000000, "outflow": 0 }],
    "storePerformance": [{ "storeId": 1, "storeName": "Toko A", "city": "Jakarta", "province": "DKI", "managerName": "Budi", "revenue": 90000000, "orders": 300, "avgOrderValue": 300000, "itemsSold": 800, "discount": 0, "tax": 0, "expense": 30000000, "net": 60000000, "members": null, "lowStock": null, "target": 5000000, "targetPercent": 999, "sharePercent": 60 }],
    "paymentBreakdown": { "byMethod": [{ "method": "cash", "count": 200, "amount": 60000000, "bucket": "CASH" }], "byType": [{ "type": "CASH", "count": 200, "amount": 60000000 }], "totalPayments": 150000000 },
    "finance": {
      "revenue": 150000000, "totalExpense": 40000000, "netRevenue": 110000000, "netMargin": 73.3,
      "discount": 5000000, "tax": 15000000,
      "ap": { "outstanding": 10000000, "count": 3, "paidInRange": 5000000 },
      "ar": { "outstanding": 2000000, "count": 4 },
      "expenseByCategory": [{ "category": "Operasional", "amount": 20000000, "count": 10 }],
      "arByCustomer": [{ "customer": "John", "outstanding": 2000000, "count": 1 }],
      "apOutstandingPOs": [{ "id": 12, "orderNumber": "PO-20261018-0042", "store": 1, "storeName": "Toko A", "finalAmount": 250000, "paid": 0, "outstanding": 250000, "dueDate": null }],
      "cashFlow": [{ "date": "2026-10-01", "inflow": 5000000, "outflow": 0, "net": 5000000 }]
    },
    "operations": {
      "lowStockCount": 4, "lowStockItems": [{ "type": "product", "id": 7, "name": "Beras", "stock": 2, "minStock": 10, "unit": "kg", "store": 1, "storeName": "Toko A" }],
      "stockValue": 10000000, "productStockValue": 6000000, "ingredientStockValue": 4000000,
      "production": {}, "cashRegister": { "open": 1, "closed": 2, "totalSales": 0 },
      "queueWaiting": 0, "reservationsToday": 0
    },
    "customers": { "totalMembers": 200, "newMembers": 15, "memberGrowth": 100, "tierDistribution": [{ "tier": "Gold", "count": 30 }], "topMembers": [{ "id": 5, "name": "John", "phoneNumber": "628...", "totalSpend": 2000000, "orderCount": 12 }] },
    "activity": { "recentOrders": [{ "id": 1, "orderNumber": "ORD-20261018-001", "store": 1, "storeName": "Toko A", "cashierName": "Budi", "totalPrice": 55500, "status": "paid", "paymentMethod": "cash", "createdAt": "2026-10-18T10:00:00.000Z" }], "recentPayments": [], "recentAudit": [] },
    "stores": [{ "id": 1, "name": "Toko A", "city": "Jakarta", "province": "DKI", "dailyTarget": 5000000, "managerName": "Budi", "status": "active" }],
    "storesWithSales": []
  }
}
```
`kpiTrend` is one row per day (revenue/orders/itemsSold/expense/inflow/outflow); `byType` is the canonical reporting buckets; `storePerformance`/`storesWithSales` share the same row shape.

Key errors: 403 `{"success":false,"message":"Forbidden"}` (non-super_admin); 500.

---

---

## Accounts Receivable

### GET `/accounts-receivable/list`
Auth required. **Query:** `page`, `limit`, `status` (pending|partial|paid), `store`.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "orderId": 100,
      "customerName": "PT Maju",
      "totalAmount": 5000000,
      "paidAmount": 2000000,
      "remainingAmount": 3000000,
      "dueDate": "2026-07-31",
      "status": "partial"
    }
  ],
  "pagination": { "total": 10, "page": 1, "limit": 10, "totalPages": 1 }
}
```

---

### GET `/accounts-receivable/aging`
Auth required. **Query:** `store` (number).

**Response:**
```json
{
  "success": true,
  "data": {
    "current": 10000000,
    "days1To30": 5000000,
    "days31To60": 2000000,
    "days61To90": 1000000,
    "over90": 500000
  }
}
```

---

### GET `/accounts-receivable/:id`
Auth required.

### POST `/accounts-receivable/create`
Auth required (super_admin/admin).

**Request:**
```json
{
  "orderId": "number (required)",
  "customerName": "string (default: '')",
  "totalAmount": "number (required)",
  "paidAmount": "number (default: 0)",
  "dueDate": "string (optional, ISO date)",
  "notes": "string (default: '')"
}
```

### POST `/accounts-receivable/:id/pay`
Auth required.

**Request:**
```json
{ "amount": "number (required)", "paymentMethod": "string (optional)", "notes": "string (optional)" }
```

### PUT `/accounts-receivable/:id`
Auth required (super_admin/admin). Same fields, all optional.

### DELETE `/accounts-receivable/:id`
Auth required (super_admin/admin).

---

---

## Tax Config

### GET `/tax-config/`
Auth required. **Query:** `page`, `limit`, `search`.

**Response:**
```json
{
  "success": true,
  "data": [
    { "id": 1, "name": "PPN 11%", "rate": 11, "type": "ppn", "status": "active" }
  ],
  "pagination": { "total": 5, "page": 1, "limit": 10, "totalPages": 1 }
}
```

---

### GET `/tax-config/get-tax-config/:id`
Auth required.

### POST `/tax-config/add-new-tax-config`
Auth required (super_admin/admin).

**Request:**
```json
{
  "name": "string (required)",
  "rate": "number (required)",
  "type": "ppn | service_charge | other (default: ppn)",
  "status": "active | inactive | draft (default: active)",
  "description": "string (optional)",
  "store": "number (optional)"
}
```

### PUT `/tax-config/edit-tax-config/:id`
Auth required (super_admin/admin). Same fields, all optional.

### DELETE `/tax-config/delete-tax-config/:id`
Auth required (super_admin/admin).

### GET `/tax-config/template`, GET `/tax-config/download`, POST `/tax-config/import`
Auth required (super_admin only). Import uses multipart/form-data.

### POST `/tax-config/seed`
Auth required. Seeds default PPh 2026 tax configuration.

---

### GET `/tax-config/public`
No auth. Public tax rows of one store (used by the customer/checkout surfaces).

**Query:**
| Param | Type | Description |
|-------|------|-------------|
| `store` | number | Required |
| `status` | string | Optional; omit or `all` to disable the status filter |

**Response:**
```json
{
  "success": true,
  "message": "Success get tax configs",
  "data": [
    { "id": 5, "name": "PPN 11%", "rate": 11, "type": "ppn", "status": "active", "store": 1, "description": null }
  ]
}
```

Key errors: 400 `store is required`; 400 `Invalid store value` (the error body carries `message` only, no `success:false`).

---

### GET `/tax-config/effective`
Auth required. Read-only effective-tax summary for one evaluated scope, using the same resolution as checkout. Store scoping: `?store=<id>` for super_admin, otherwise the caller's own store (validateStoreAccess blocks cross-outlet reads), and a super_admin with no store/query gets the global scope (`store: null`). Only ONE applied PPN row is ever charged (never a sum): an outlet row overrides the global default; the response flags it — `applied: true` marks the charged row, and `findings` describes duplicates/override/zero-rate. Service charge is resolved for `channel=counter` and is `not_applicable` for `qr`.

**Query:**
| Param | Type | Description |
|-------|------|-------------|
| `store` | number | Optional scope selector |
| `channel` | string | `counter` (default) \| `qr` |

**Response:**
```json
{
  "success": true,
  "message": "Success get effective tax",
  "data": {
    "store": 1,
    "channel": "counter",
    "ppn": {
      "status": "configured",
      "rate": 11,
      "rows": [
        { "id": 5, "name": "PPN 11%", "rate": 11, "scope": "outlet", "applied": true },
        { "id": 2, "name": "PPN 11% (global)", "rate": 11, "scope": "global", "applied": false }
      ]
    },
    "serviceCharge": { "status": "configured", "rate": 5, "rows": [{ "id": 7, "name": "Service 5%", "rate": 5, "scope": "outlet" }] },
    "findings": [
      { "code": "GLOBAL_AND_OUTLET_COMBINED", "severity": "info", "message": "the outlet PPN row overrides the global default; the global row is not charged", "policyRef": "D3", "decision": "decided" }
    ]
  }
}
```

Key errors: 400 `INVALID_STORE`; 400 `INVALID_CHANNEL`; 400 `PPN_MISSING` (fail-closed when the scope has no active PPN row).

---

### GET `/tax-config/download`
Auth required (super_admin). Excel export, store-pinned server-side (`req.storeId` / user store; query `store` is not consulted by the handler).

**Response:** `.xlsx` attachment (`tax-configs.xlsx`); columns: ID, Name, Type (`PPN` / `Non-Pajak` / `PPh`), Rate, Description, Status, Created At.

---

### POST `/tax-config/import`
Auth required (super_admin). Excel import (`multipart/form-data`, field `file`) into the server-pinned store; duplicates by name are skipped. Type mapping: `ppn` → `ppn`, `pph` → `other`, `non-pajak` / `service_charge` → `service_charge`, anything else → `ppn`.

**Body (file columns):** ID, Name, Type, Rate, Description, Status (`Active` / `Draft` / else `inactive`).

**Response (201):**
```json
{
  "success": true,
  "message": "Successfully imported 3 from 4 tax configs",
  "data": { "total": 4, "created": 3, "skipped": 1, "skippedNames": ["PPN 11%"] }
}
```

Key errors: 400 No file uploaded; 400 Validation errors (per-row list).

---

### PUT `/tax-config/apply/:id`
Auth required (super_admin/admin). No body. "Gunakan di Kasir & BISA": makes this PPN row the applied rate of its scope. Store scoping: the target must be visible to the caller — own-store rows plus global (`store: null`) rows when the caller has a store; a global row is only applicable by a global super_admin (no store), otherwise 403. On success the row is set `active` and every other active PPN row in the SAME scope (`tax.store ?? null`) is deactivated, so exactly one PPN row per scope stays applied; an outlet row therefore overrides the global default for that outlet.

**Response:**
```json
{
  "success": true,
  "message": "Pajak dipakai di kasir & aplikasi QR",
  "data": {
    "applied": { "id": 5, "name": "PPN 11%", "rate": 11, "type": "ppn", "status": "active", "store": 1 },
    "deactivated": 1
  }
}
```

Key errors: 404 `Tax config not found`; 403 `Anda hanya dapat mengakses data di toko Anda` (global row, non-global caller); 400 `TAX_APPLY_PPN_ONLY` (type is not `ppn`).

---

---

## Invoice

### GET `/invoice/setting`
Auth required. **Query:** `store` (number).

**Response:**
```json
{
  "success": true,
  "data": {
    "store": 1,
    "showStoreName": true,
    "showAddress": true,
    "showMemberInfo": true,
    "showLogo": true,
    "showSocialMedia": true,
    "socialMediaVisibility": { "instagram": true, "facebook": true },
    "logo": "https://..."
  }
}
```

---

### PUT `/invoice/setting`
Auth required (super_admin/admin). Content-Type: `multipart/form-data`.

**Request:**
| Field | Type | Required |
|-------|------|----------|
| `store` | number | **YES** |
| `showStoreName` | boolean | No |
| `showAddress` | boolean | No |
| `showMemberInfo` | boolean | No |
| `showLogo` | boolean | No |
| `showSocialMedia` | boolean | No |
| `socialMediaVisibility` | JSON object | No |
| `removeLogo` | boolean | No |
| `logo` | file | No |

### POST `/invoice/setting/reset`
Auth required (super_admin/admin). Resets to defaults.

---

---

## Notification

### GET `/notification/`
Auth required. **Query:** `page` (number).

**Response:**
```json
{
  "success": true,
  "data": [
    { "id": 1, "title": "Low Stock", "message": "Beras stock below minimum", "type": "warning", "isRead": false, "createdAt": "2026-07-11T10:00:00Z" }
  ],
  "pagination": { "total": 20, "page": 1, "limit": 20, "totalPages": 1 }
}
```

---

### GET `/notification/unread`
Auth required.

**Response:**
```json
{ "success": true, "data": { "count": 5 } }
```

---

### PUT `/notification/:id/read`
Auth required. Marks single notification as read.

### PUT `/notification/read-all`
Auth required. Marks all notifications as read.

---

---

## Currency

### GET `/currency/`
Auth required.

**Response:**
```json
{
  "success": true,
  "data": [
    { "id": 1, "code": "IDR", "name": "Indonesian Rupiah", "symbol": "Rp", "exchangeRate": 1, "isDefault": true }
  ]
}
```

---

### GET `/currency/:id`
Auth required.

### POST `/currency/`
Auth required (super_admin/admin).

**Request:**
```json
{
  "code": "string (required, max 10)",
  "name": "string (required)",
  "symbol": "string (default: '')",
  "exchangeRate": "number (default: 1)",
  "isDefault": "boolean (default: false)"
}
```

### PUT `/currency/:id`
Auth required (super_admin/admin). Same fields, all optional.

### DELETE `/currency/:id`
Auth required (super_admin/admin).

### PUT `/currency/:id/default`
Auth required (super_admin/admin). Sets this currency as default, unsets others.

---

---

## Audit Log

### GET `/audit-log/`
Auth required (super_admin). **Query:** `page`, `limit`.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "entity": "product",
      "entityId": 10,
      "action": "update",
      "userId": 1,
      "userName": "admin",
      "changes": { "price": { "old": 20000, "new": 25000 } },
      "createdAt": "2026-07-11T10:30:00Z"
    }
  ],
  "pagination": { "total": 500, "page": 1, "limit": 20, "totalPages": 25 }
}
```

---

### GET `/audit-log/:entity/:entityId`
Auth required (super_admin). Returns audit trail for specific entity.

---

---

## Social Media

### GET `/social-media/get-social-media`
Auth required.

**Response:**
```json
{
  "success": true,
  "data": [
    { "id": 1, "name": "Instagram", "url": "https://instagram.com/mystore", "icon": "instagram", "isActive": true }
  ]
}
```

---

### POST `/social-media/add-social-media`
Auth required (super_admin/admin).

**Request:**
```json
{
  "name": "string (required)",
  "url": "string (required)",
  "icon": "string (default: '')",
  "isActive": "boolean (default: true)"
}
```

### PUT `/social-media/edit-social-media/:id`
Auth required (super_admin/admin). Same fields, all optional.

### DELETE `/social-media/delete-social-media/:id`
Auth required (super_admin/admin).

---

---

## Reservation

### GET `/reservation/`
Auth required. **Query:** `page`, `limit`, `date`, `status` (pending|confirmed|completed|cancelled|no_show), `store`.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "customerName": "John",
      "customerPhone": "08123456789",
      "reservationDate": "2026-07-12",
      "startTime": "19:00",
      "endTime": "21:00",
      "guestCount": 4,
      "table": { "id": 1, "tableNumber": "T1" },
      "status": "confirmed"
    }
  ],
  "pagination": { "total": 15, "page": 1, "limit": 10, "totalPages": 2 }
}
```

---

### GET `/reservation/available-tables/list`
Auth required. **Query:** `store`, `date`, `time`, `guestCount`.

### GET `/reservation/:id`
Auth required.

### POST `/reservation/`
Auth required.

**Request:**
```json
{
  "store": "number (required)",
  "customerName": "string (required)",
  "customerPhone": "string (optional)",
  "customerEmail": "string (optional)",
  "reservationDate": "string (required, ISO date)",
  "startTime": "string (required)",
  "endTime": "string (optional)",
  "guestCount": "number (default: 1)",
  "tableId": "number (optional)",
  "notes": "string (default: '')",
  "status": "pending | confirmed | completed | cancelled | no_show (default: pending)"
}
```

### PUT `/reservation/:id`
Auth required (super_admin/admin). Same fields, all optional.

### DELETE `/reservation/:id`
Auth required (super_admin/admin). Cancels reservation.

---

---

## Split Bill

### POST `/split-bill/create`
Auth required (super_admin/admin).

**Request:**
```json
{
  "orderId": "number (required)",
  "items": [
    { "idProduct": "number (required)", "qty": "number (required)" }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "message": "Split bill created",
  "data": { "id": 1, "orderId": 100, "items": [...], "total": 25000 }
}
```

---

### GET `/split-bill/get-by-order/:orderId`
Auth required.

### PUT `/split-bill/pay/:id`
Auth required (super_admin/admin).

### DELETE `/split-bill/cancel/:id`
Auth required (super_admin/admin).

### POST `/split-bill/merge`
Auth required (super_admin/admin).

**Request:**
```json
{ "orderId": "number (required)" }
```

---

---

## Export

### GET `/export/master-data`
Auth required (super_admin/admin). **Query:** `store` (number). Returns Excel file with all master data.

---

---

## Receipt

### GET `/receipt/order/:orderId`
Auth required.

**Response:**
```json
{
  "success": true,
  "data": {
    "orderNumber": "ORD-20260711-001",
    "store": { "name": "Store Jakarta", "address": "Jl. Sudirman 123" },
    "items": [...],
    "subTotal": 50000,
    "tax": 5500,
    "total": 55500,
    "paymentMethod": "cash",
    "paymentAmount": 60000,
    "change": 4500,
    "createdAt": "2026-07-11T10:30:00Z"
  }
}
```

---

---

## Accounting


All require auth (super_admin/admin) and store scope via `validateStoreAccess` (non-super-admin pinned to own store; `super_admin` may pass `?store` for one store or omit it for all stores). Accounts are auto-provisioned (default chart of accounts) whenever a store is resolved.

### GET `/accounting/accounts`
List chart of accounts for the store, ordered by `code` (super_admin without store: consolidated by `code` across all stores).

**Query:** `store` (number, super_admin selector), `status` (string, optional filter).

**Response:**
```json
{
  "success": true,
  "data": [
    { "id": 1, "store": 3, "code": "1000", "name": "Cash", "type": "asset", "normalBalance": "debit", "parentId": null, "description": "Kas dan setara kas", "isSystem": true, "status": "active" }
  ]
}
```

Key errors: 400 `Store is required` (non-super_admin without store); 403 role/store access denied.

---

### POST `/accounting/accounts`
Create a chart-of-accounts entry.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `code` | string | Required account code (unique per store) |
| `name` | string | Required account name |
| `type` | string | Required: `asset`, `liability`, `equity`, `revenue`, `expense` |
| `normalBalance` | string | Required: `debit` or `credit` |
| `parentId` | number | Optional parent account |
| `description` | string | Optional description |

**Response:** `201`
```json
{ "success": true, "data": { "id": 21, "store": 3, "code": "1500", "name": "Petty Cash", "type": "asset", "normalBalance": "debit", "isSystem": false, "status": "active" }, "message": "Account created" }
```

Key errors: 400 `Store is required`; 400 `Code, name, type and normalBalance are required`; 400 `Invalid type or normalBalance`; 400 `Account code 1500 already exists`.

---

### PUT `/accounting/accounts/:id`
Update an account (all body fields optional).

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `code` | string | New code (rejected if already used in store) |
| `name` | string | New name |
| `type` | string | New type |
| `normalBalance` | string | `debit` or `credit` |
| `parentId` | number | Parent account |
| `description` | string | Description |
| `status` | string | e.g. `active` / `inactive` |

**Response:**
```json
{ "success": true, "data": { "id": 21, "code": "1500", "name": "Petty Cash Updated", "type": "asset", "normalBalance": "debit", "status": "active" }, "message": "Account updated" }
```

Key errors: 404 `Account not found`; 400 `Account code 1500 already exists`; 400 `Store is required`.

---

### DELETE `/accounting/accounts/:id`
Delete an account. System accounts and accounts already used in journal lines cannot be deleted.

**Response:**
```json
{ "success": true, "message": "Account deleted" }
```

Key errors: 404 `Account not found`; 400 `System accounts cannot be deleted`; 400 `Account has journal activity and cannot be deleted`; 400 `Store is required`.

---

### GET `/accounting/journals`
List journal entries (header + `lines` with joined `accountData`), ordered by `date` DESC.

**Query:** `store` (number, super_admin selector), `sourceType` (string), `startDate` (ISO date), `endDate` (ISO date), `limit` (number, default 50, max 500), `offset` (number, default 0).

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 12,
      "store": 3,
      "entryNumber": "JV-0003-000012",
      "date": "2026-10-15",
      "description": "Manual adjustment",
      "sourceType": "manual",
      "totalDebit": 100000,
      "totalCredit": 100000,
      "status": "posted",
      "lines": [
        { "id": 30, "account": 1, "debit": 100000, "credit": 0, "description": null, "accountData": { "id": 1, "code": "1000", "name": "Cash" } }
      ]
    }
  ],
  "count": 1,
  "limit": 50,
  "offset": 0
}
```
When `super_admin` omits `store`, each row additionally carries `storeName`.

Key errors: 400 `Store is required` (non-super_admin without store).

---

### POST `/accounting/journals`
Create a manual journal entry (header + lines committed atomically). `entryNumber` comes from the same per-store counter (`journal_entry_sequence`) as automatic postings.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `date` | date | Required entry date |
| `description` | string | Optional description |
| `lines` | array | Required, min 2 items: `{ account` (id, required), `debit` (number), `credit` (number), `description` (string) `}` — each line needs a positive debit or credit, and total debit must equal total credit |

**Response:** `201`
```json
{ "success": true, "data": { "id": 13, "store": 3, "entryNumber": "JV-0003-000013", "date": "2026-10-16", "sourceType": "manual", "totalDebit": 100000, "totalCredit": 100000 }, "message": "Journal entry created" }
```

Key errors: 400 `Store is required`; 400 `Date and at least two lines are required`; 400 `Account ID is required for each line`; 400 `Account 99 not found`; 400 `Each line needs a positive debit or credit`; 400 `Total debit (100000) must equal total credit (90000)`.

---

### DELETE `/accounting/journals/:id`
Reverse a manual journal entry (FG-ACC-03). Nothing is removed: the original stays with `status: "reversed"`, and a mirror entry (each line's debit and credit swapped) is posted with `sourceType: "manual_reversal"`, `referenceId` = the original id, dated the store's local today (or the original date if that is later). Trial balance, income statement, balance sheet and overview read both `posted` and `reversed` entries, so the pair nets to zero while each period keeps its own history. The reversal is audited (`action: "delete"`, entity `journal_entry`, with the reversal number and reason). Only entries with `sourceType: "manual"` can be reversed; automatic entries are corrected through their source document.

**Body (optional):** `{ "reason": "salah input" }` (string, max 500 chars; also accepted as `?reason=`). Appended to the reversal's description: `Reversal of JV-0003-000012: salah input`.

**Response:**
```json
{
  "success": true,
  "message": "Journal entry reversed",
  "data": {
    "original": { "id": 12, "entryNumber": "JV-0003-000012", "sourceType": "manual", "status": "reversed" },
    "reversal": { "id": 14, "entryNumber": "JV-0003-000014", "sourceType": "manual_reversal", "referenceId": 12, "status": "posted", "totalDebit": 100000, "totalCredit": 100000 }
  }
}
```

Key errors: 404 `Journal entry not found`; 400 `JOURNAL_NOT_MANUAL` (`Only manual journal entries can be reversed` — also returned for a `manual_reversal` entry); 409 `JOURNAL_ALREADY_REVERSED`; 400 `Store is required`.

---

### GET `/accounting/overview`
Financial summary for the period (revenue/expense/net income, balance-sheet totals, cash+bank balance, journal count — `posted` and `reversed` entries).

**Query:** `store` (number, super_admin selector), `startDate` (ISO date), `endDate` (ISO date).

**Response:**
```json
{
  "success": true,
  "data": {
    "cashBank": 12500000,
    "totalRevenue": 50000000,
    "totalExpense": 18000000,
    "netIncome": 32000000,
    "isProfit": true,
    "totalAssets": 80000000,
    "totalLiabilities": 15000000,
    "totalEquity": 65000000,
    "totalLiabilitiesEquity": 80000000,
    "balanced": true,
    "journalEntryCount": 42
  }
}
```

Key errors: 400 `Store is required` (non-super_admin without store).

---

### GET `/accounting/trial-balance`
Trial balance rows aggregated per account code (balances from `posted` journal entries only).

**Query:** `store` (number, super_admin selector), `startDate` (ISO date), `endDate` (ISO date).

**Response:**
```json
{
  "success": true,
  "data": [
    { "accountId": 1, "code": "1000", "name": "Cash", "type": "asset", "debit": 1500000, "credit": 200000, "net": 1300000 }
  ],
  "totalDebit": 1500000,
  "totalCredit": 1500000,
  "balanced": true
}
```

Key errors: 400 `Store is required` (non-super_admin without store).

---

### GET `/accounting/income-statement`
Revenue and expense breakdown for the period.

**Query:** `store` (number, super_admin selector), `startDate` (ISO date), `endDate` (ISO date).

**Response:**
```json
{
  "success": true,
  "data": {
    "revenues": [{ "code": "4000", "name": "Sales Revenue", "value": 50000000 }],
    "expenses": [{ "code": "5000", "name": "Cost of Goods Sold", "value": 18000000 }],
    "totalRevenue": 50000000,
    "totalExpense": 18000000,
    "netIncome": 32000000
  }
}
```

Key errors: 400 `Store is required` (non-super_admin without store).

---

### GET `/accounting/balance-sheet`
Assets, liabilities and equity as of a date; current-period net income is added as a computed equity row (`code: "RETAINED"`).

**Query:** `store` (number, super_admin selector), `asOf` (ISO date; omitted = all time).

**Response:**
```json
{
  "success": true,
  "data": {
    "asOf": "2026-10-19",
    "assets": [{ "code": "1000", "name": "Cash", "normalBalance": "debit", "net": 1300000 }],
    "liabilities": [{ "code": "2000", "name": "Accounts Payable", "normalBalance": "credit", "net": 500000 }],
    "equity": [
      { "code": "3000", "name": "Owner Capital", "normalBalance": "credit", "net": 10000000 },
      { "code": "RETAINED", "name": "Current Period Net Income", "normalBalance": "credit", "net": 3200000, "isComputed": true }
    ],
    "totalAssets": 80000000,
    "totalLiabilities": 15000000,
    "totalEquity": 65000000,
    "totalLiabilitiesEquity": 80000000,
    "balanced": true
  }
}
```

Key errors: 400 `Store is required` (non-super_admin without store).

---

---

## Reports


All require auth and store scope via `validateStoreAccess` (`store` is a super_admin selector; other roles are pinned to their own store). Non-super_admin without a store assignment: 403 `Store assignment required`.

### GET `/reports/sales-summary`
Paginated daily sales-summary rows.

**Query:** `startDate` (ISO date), `endDate` (ISO date), `page` (number, default 1), `limit` (number, default 30), `store` (number, super_admin selector).

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 5, "store": 3, "report_date": "2026-10-15",
      "total_sales": "4250000.00", "total_transactions": 48, "total_items": 132,
      "average_transaction": "88541.67", "total_discount": "50000.00", "total_tax": "425000.00",
      "payment_cash": "2000000.00", "payment_card": "2250000.00",
      "storeData": { "id": 3, "name": "Cabang Jakarta" }
    }
  ],
  "pagination": { "total": 120, "page": 1, "limit": 30, "totalPages": 4 }
}
```

Key errors: 403 `Store assignment required` (non-super_admin without store); 500.

---

### GET `/reports/product-sales`
Paginated per-product sales rows, ordered by `revenue` DESC.

**Query:** `startDate` (ISO date), `endDate` (ISO date), `page` (number, default 1), `limit` (number, default 50), `store` (number, super_admin selector).

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 9, "store": 3, "product": 7, "report_date": "2026-10-15",
      "quantity_sold": 40, "revenue": "1200000.00", "cost": "480000.00", "profit": "720000.00", "transactions": 25,
      "productData": { "id": 7, "nameProduct": "Kopi Susu" },
      "storeData": { "id": 3, "name": "Cabang Jakarta" }
    }
  ],
  "pagination": { "total": 55, "page": 1, "limit": 50 }
}
```

Key errors: 403 `Store assignment required`; 500.

---

### GET `/reports/category-sales`
Paginated per-category sales rows, ordered by `revenue` DESC.

**Query:** `startDate` (ISO date), `endDate` (ISO date), `page` (number, default 1), `limit` (number, default 20), `store` (number, super_admin selector).

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 4, "store": 3, "category": 2, "report_date": "2026-10-15",
      "quantity_sold": 80, "revenue": "2400000.00", "cost": "900000.00", "profit": "1500000.00",
      "categoryData": { "id": 2, "name": "Minuman" },
      "storeData": { "id": 3, "name": "Cabang Jakarta" }
    }
  ],
  "pagination": { "total": 18, "page": 1, "limit": 20 }
}
```

Key errors: 403 `Store assignment required`; 500.

---

### GET `/reports/kasir-performance`
Paginated cashier performance rows, ordered by `total_sales` DESC.

**Query:** `startDate` (ISO date), `endDate` (ISO date), `page` (number, default 1), `limit` (number, default 30), `store` (number, super_admin selector).

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 3, "store": 3, "cashier": 11, "report_date": "2026-10-15",
      "total_sales": "1500000.00", "transactions": 20, "avg_transaction": "75000.00",
      "items_sold": 55, "accuracy_rate": "98.50",
      "cashierData": { "id": 11, "fullName": "Budi", "userName": "budi" },
      "storeData": { "id": 3, "name": "Cabang Jakarta" }
    }
  ],
  "pagination": { "total": 12, "page": 1, "limit": 30 }
}
```

Key errors: 403 `Store assignment required`; 500.

---

---

## Report Configuration


Report layout/branding config keyed by report definition. Keys: `daily`, `sales`, `cashFlow`, `profitPerProduct`, `bestSeller`, `productSales`, `categorySales`, `kasirPerformance`. Reads require auth; writes require super_admin/admin.

### GET `/report-config`
List all saved configs.

**Response:**
```json
{
  "success": true,
  "data": [
    { "key": "daily", "config": { "selectedColumns": ["date", "totalTransaksi"], "accentColor": "#0f172a", "branding": { "showLogo": true, "showAddress": true, "showPhone": true } } }
  ]
}
```

Key errors: 500.

---

### GET `/report-config/meta`
List report definitions with label, default columns, archetype and layout.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "key": "daily",
      "label": "Laporan Harian",
      "columns": [{ "key": "date", "label": "Tanggal", "type": "date", "width": 14, "align": "left" }],
      "archetype": "summary",
      "layout": { "kpis": ["totalTransaksi", "totalPenjualanBersih", "grossProfit", "netProfit"] }
    }
  ]
}
```

Key errors: 500.

---

### GET `/report-config/:key`
Get the saved config for one report key. Always 200 — `config` is `null` when nothing has been saved for that key.

**Response:**
```json
{ "success": true, "data": { "key": "daily", "config": null } }
```

Key errors: 500.

---

### PUT `/report-config/:key`
Create or replace the config for a report key (super_admin/admin only). Sent config is merged over defaults `{ selectedColumns: null, accentColor: "#0f172a", branding: { showLogo: true, showAddress: true, showPhone: true } }`.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `config` | object | Required config object (e.g. `selectedColumns`, `accentColor`, `branding`) |

**Response:**
```json
{
  "success": true,
  "data": { "key": "daily", "config": { "selectedColumns": ["date"], "accentColor": "#0f172a", "branding": { "showLogo": true, "showAddress": true, "showPhone": true } } }
}
```

Key errors: 404 `Report tidak ditemukan` (unknown key); 400 `config wajib diisi`; 403 role access denied (non super_admin/admin).

---

---

## Inventory


Most endpoints require auth + `validateStoreAccess` (store pinned to caller's own store; super_admin may target one store or omit for global). Writes (`/forecast/run`, `/batch/writeoff`, `/reconcile/fix`) and `/reconcile` additionally require super_admin/admin.

### GET `/inventory/forecast`
Stored stock forecasts ordered by nearest stockout.

**Query:** `productId` (number), `limit` (number, default 50), `store` (number, super_admin selector).

**Response:** each row is a `stock_forecast` record plus camelCase aliases.
```json
{
  "success": true,
  "data": [
    {
      "id": 12, "product": 7, "store": 3,
      "current_quantity": 40, "daily_consumption_rate": 5.2, "safety_stock": 16, "reorder_point": 52,
      "days_until_stockout": 4, "forecasted_stockout_date": "2026-11-02", "confidence_level": 90, "forecast_date": "2026-10-19T02:00:00.000Z",
      "productData": { "id": 7, "nameProduct": "Kopi Susu", "sku": "KS-01" },
      "storeData": { "id": 3, "name": "Cabang Jakarta" },
      "currentStock": 40, "dailyConsumption": 5.2, "safetyStock": 16, "reorderPoint": 52,
      "forecastedStockoutDate": "2026-11-02", "confidence": 90, "forecastDate": "2026-10-19T02:00:00.000Z"
    }
  ]
}
```

Key errors: 400 `Store required` (non-super_admin without store).

---

### POST `/inventory/forecast/run`
Recompute and persist forecasts (super_admin/admin). With `productId`: single product; without: all active products (bulk).

**Query:** `productId` (number, optional), `store` (number, super_admin selector).

**Response (single product):**
```json
{
  "success": true,
  "data": { "productId": 7, "productName": "Kopi Susu", "storeId": 3, "currentStock": 40, "dailyConsumption": 5.2, "minStock": 10, "safetyStock": 16, "reorderPoint": 52, "daysUntilStockout": 4, "forecastedStockoutDate": "2026-11-02", "confidence": 90, "status": "low" }
}
```

**Response (bulk):** `{ success: true, data: [ ...forecast objects, same shape as single-product response... ], total: 120 }`.

Key errors: 403 role access denied; 500 `Product 99 not found` (via error message).

---

### GET `/inventory/dead-stock`
Active products with stock but no sales within `threshold` days; also refreshes `dead_stock_alert` rows.

**Query:** `threshold` (number of days, default 60), `store` (number, super_admin selector).

**Response:**
```json
{
  "success": true,
  "total": 1,
  "data": [
    { "productId": 15, "productName": "Teh Kotak", "productData": { "id": 15, "nameProduct": "Teh Kotak" }, "quantity": 60, "stock": 60, "costPrice": 5000, "daysWithoutSale": 90, "lastSaleDate": "2026-07-20", "alertLevel": "high" }
  ]
}
```

Key errors: 400 `storeId/store required` (no store resolved); 500.

---

### GET `/inventory/expiring-soon`
Active batches expiring within `days`.

**Query:** `days` (number, default 30), `store` (number, super_admin selector).

**Response:**
```json
{
  "success": true,
  "total": 1,
  "data": [
    { "id": 8, "productId": 7, "productName": "Kopi Susu", "productData": { "id": 7, "nameProduct": "Kopi Susu" }, "batchCode": "BAT-7-17000000", "expiryDate": "2026-11-05", "qty": 12, "stock": 12, "storeId": 3, "daysLeft": 17 }
  ]
}
```

Key errors: 500.

---

### GET `/inventory/valuation`
Inventory COGS valuation. With `productId`: per-batch valuation (also writes an `inventory_valuation` snapshot). Without: aggregate valuation per active product.

**Query:** `method` (string, default `FIFO`; `SPECIFIC_ID`; anything else = weighted average), `productId` (number, optional), `store` (number, super_admin selector).

**Response (single product):**
```json
{
  "success": true,
  "data": {
    "productId": 7, "storeId": 3, "method": "FIFO", "totalQuantity": 40, "totalCost": 480000, "averageCost": 12000,
    "batches": [{ "id": 8, "batchCode": "BAT-7-17000000", "qty": 12, "costPerUnit": 12000, "expiryDate": "2026-11-05" }]
  }
}
```

**Response (aggregate):**
```json
{
  "success": true,
  "data": {
    "storeId": 3, "method": "FIFO", "totalValue": 12500000, "totalProducts": 45, "avgCost": 8500,
    "products": [{ "id": 7, "nameProduct": "Kopi Susu", "stock": 40, "costPrice": 12000 }]
  }
}
```

Key errors: 500.

---

### GET `/inventory/supplier-performance`
Supplier performance for a month, computed from purchase orders and stored into `supplier_performance` (replaces the month's rows).

**Query:** `month` (`YYYY-MM`, default current month), `store` (number, super_admin selector).

**Response:**
```json
{
  "success": true,
  "total": 1,
  "data": [
    { "id": 4, "supplier": 2, "month": "2026-10-01", "total_orders": 10, "on_time_deliveries": 8, "late_deliveries": 2, "total_value": 25000000, "total_quantity": 0, "avg_lead_time_days": 5.5, "score": 68 }
  ]
}
```

Key errors: 500.

---

### GET `/inventory/batch`
List product batches (with `productData`, `storeData`, `supplierData`, `stocks`), ordered by `expiryDate` ASC.

**Query:** `productId` (number), `status` (string, e.g. `active`), `store` (number, super_admin selector).

**Response:**
```json
{
  "success": true,
  "total": 1,
  "data": [
    {
      "id": 8, "product": 7, "batchCode": "BAT-7-17000000", "expiryDate": "2026-11-05", "qty": 12, "store": 3, "status": "active",
      "productData": { "id": 7, "nameProduct": "Kopi Susu" },
      "storeData": { "id": 3, "name": "Cabang Jakarta" },
      "supplierData": { "id": 2, "name": "PT Sumber Kopi" },
      "stocks": [{ "id": 8, "batch": 8, "store": 3, "quantity": 12, "reserved_quantity": 0, "allocated_quantity": 0 }]
    }
  ]
}
```

Key errors: 500.

---

### GET `/inventory/batch/:id`
Get one batch with product/store/supplier/stock details, scoped to the caller's store.

**Response:** same shape as a single row of `GET /inventory/batch`.

Key errors: 404 `Batch not found`; 500.

---

### POST `/inventory/batch/writeoff`
Write off expired batches (super_admin/admin): marks batches `expired`, deducts remaining qty from `product.stock` and `product_store_stock`, logs `stock_history` (`referenceType: "writeoff"`).

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `productId` | number | Optional — limit write-off to one product |

**Response:**
```json
{
  "success": true,
  "total": 12,
  "affected": [{ "batchId": 8, "batchCode": "BAT-7-17000000", "product": 7, "store": 3, "qty": 12 }]
}
```

Key errors: 403 role access denied; 500.

---

### GET `/inventory/reconcile`
List products whose global `product.stock` differs from the sum of per-store stock (super_admin/admin).

**Query:** `productId` (number), `minDiff` (number, default 1), `store` (number, super_admin selector).

**Response:**
```json
{
  "success": true,
  "total": 1,
  "data": [{ "productId": 7, "nameProduct": "Kopi Susu", "globalStock": 40, "perStoreTotal": 35, "diff": 5 }]
}
```

Key errors: 403 role access denied; 500.

---

### POST `/inventory/reconcile/fix`
Fix stock discrepancies in one direction (super_admin/admin), logging `stock_history` (`referenceType: "reconcile"`).

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `productId` | number | Optional — fix one product |
| `direction` | string | `store-to-global` (default; set `product.stock` = sum of per-store) or `global-to-store` (redistribute `product.stock` across store rows) |

**Response:**
```json
{
  "success": true,
  "direction": "store-to-global",
  "changes": [{ "productId": 7, "field": "product.stock", "before": 40, "after": 35 }],
  "total": 1
}
```

Key errors: 400 `direction must be store-to-global or global-to-store`; 403 role access denied; 500.

---

---

## Parked Cart


### POST `/parked-cart`
Auth required (any authenticated store staff; no role restriction). Parks the current cart for a store; expiry is `now + parkedCartTtlMinutes` (location setting, default 120 min, cap 1440). Per-store active cap: `maxActiveParkedCarts` (default 20).

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `cart` | object | Required: `{ items: [...], totalCovers?, orderType? }`; `items` must be non-empty (display-only snapshot, never re-priced here) |
| `tableId` | number | Optional; must exist in the same store |
| `customerId` / `customerName` / `customerPhone` | number / string / string | Optional customer info |
| `discountId` / `promoCode` | number / string | Optional discount references |
| `notes` | string | Optional |
| `idempotencyKey` | string | Optional; same key + identical payload replays the original |

**Response:** `201`
```json
{
  "success": true,
  "message": "Cart parked",
  "data": {
    "id": 1, "store": 1, "createdBy": 3, "tableId": 5, "customerId": null, "customerName": "John", "customerPhone": null,
    "discountId": null, "promoCode": null, "notes": null,
    "cartPayload": { "items": [{ "productId": 3, "count": 2, "totalPrice": 50000 }], "orderType": "dine-in" },
    "displayTotalItems": 2, "displayTotalPrice": 50000,
    "status": "active", "expiresAt": "2026-10-18T12:00:00.000Z",
    "resumedBy": null, "resumedAt": null, "cancelledBy": null, "cancelledAt": null,
    "idempotencyKey": null, "table": { "id": 5, "name": "Meja 5" }
  }
}
```
Idempotent replay returns `200 {"success":true,"message":"Parked cart already recorded","data":{...}}`; the same key with a different payload is 409.

Key errors: 400 `{"success":false,"message":"Store not selected"}`; 422 `cart.items must not be empty`; 404 `Table not found for this store`; 409 `Active parked cart limit reached for this store`; 409 `idempotencyKey already used with a different payload`.

---

### GET `/parked-cart`
Auth required. Lists parked carts, newest first. `super_admin` may omit the store to list across all stores; other roles need a resolvable store. Rows expose a computed `status` (`expired` is derived from `expiresAt`, the physical column may still read `active`).

**Query:**
| Field | Type | Description |
|-------|------|-------------|
| `status` | string | `active` (default), `expired`, `resumed` or `cancelled` |
| `page` | number | Default 1 |
| `limit` | number | Default 50 |

**Response:**
```json
{
  "success": true,
  "message": "Success get parked carts",
  "data": [
    { "id": 1, "store": 1, "status": "active", "displayTotalItems": 2, "displayTotalPrice": 50000, "expiresAt": "2026-10-18T12:00:00.000Z", "createdAt": "2026-10-18T10:00:00.000Z", "table": { "id": 5, "name": "Meja 5" } }
  ],
  "pagination": { "total": 1, "page": 1, "limit": 50, "totalPages": 1 }
}
```

Key errors: 400 `Store not selected` (non-super_admin without store); 400 `Invalid status filter`.

---

### GET `/parked-cart/:id`
Auth required. Returns one store-scoped parked cart with its table name.

**Response:**
```json
{ "success": true, "message": "Success get parked cart", "data": { "id": 1, "store": 1, "status": "active", "cartPayload": { "items": [] }, "displayTotalItems": 2, "displayTotalPrice": 50000, "expiresAt": "2026-10-18T12:00:00.000Z", "table": { "id": 5, "name": "Meja 5" } } }
```
`cartPayload` is the full cart snapshot as parked; rows for other stores read as 404.

Key errors: 404 `Parked cart not found`.

---

### POST `/parked-cart/:id/resume`
Auth required. Atomically resumes a parked cart (compare-and-set: `status='active'` AND `expiresAt > NOW()`). Only one concurrent resume/cancel can win; an expired-but-unswept row cannot be resumed.

**Response:**
```json
{ "success": true, "message": "Parked cart resumed", "data": { "id": 1, "store": 1, "status": "resumed", "resumedBy": 3, "resumedAt": "2026-10-18T10:30:00.000Z", "table": { "id": 5, "name": "Meja 5" } } }
```

Key errors: 404 `Parked cart not found` (nonexistent or another store); 409 `Parked cart is no longer active` (already resumed/cancelled or expired).

---

### POST `/parked-cart/:id/cancel`
Auth required. Atomically cancels a parked cart with the same compare-and-set semantics as resume.

**Response:**
```json
{ "success": true, "message": "Parked cart cancelled", "data": { "id": 1, "store": 1, "status": "cancelled", "cancelledBy": 3, "cancelledAt": "2026-10-18T10:30:00.000Z" } }
```

Key errors: 404 `Parked cart not found`; 409 `Parked cart is no longer active`.

---

---

## Memberships


All routes below require a Bearer JWT plus the canonical authorization context; the actor and its scope are always resolved server-side (never from request input). Canonical roles: `platform_admin`, `tenant_admin`, `store_admin`, `cashier`, `staff`; membership statuses: `ACTIVE`, `DEACTIVATED`, `RETIRED`. Success envelope: `{ success: true, message: "Success", data }`.

### GET `/memberships`
Lists memberships visible to the actor: platform actor = all; `tenant_admin` = active tenant; `store_admin` = roles below `store_admin` (plus own rows); everyone else = own rows only. Auth required.

**Query:**
| Param | Type | Description |
|-------|------|-------------|
| `page` | number | Page (default 1) |
| `limit` | number | Items per page (default 20, max 100) |
| `userId` | number | Filter by user id (malformed value matches nothing) |
| `tenantId` | number | Filter by tenant id (malformed value matches nothing) |

**Response:**
```json
{
  "success": true,
  "message": "Success",
  "data": [ { "id": 11, "userId": 7, "tenantId": 1, "role": "cashier", "status": "ACTIVE" } ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

Key errors: 401 `UNAUTHENTICATED`; 403 `STALE_TENANT_CONTEXT` / `STALE_STORE_CONTEXT`; 500 `INTERNAL_ERROR`.

---

### GET `/memberships/:id`
Returns one membership visible to the actor. Auth required; a self-only actor (cashier/staff) gets 403 for any row that is not their own — invisible and nonexistent rows are otherwise the same 404.

**Response:**
```json
{
  "success": true,
  "message": "Success",
  "data": { "id": 11, "userId": 7, "tenantId": 1, "role": "cashier", "status": "ACTIVE" }
}
```

Key errors: 403 `FORBIDDEN`; 404 `RESOURCE_NOT_FOUND`.

---

### GET `/memberships/available-roles`
Lists the canonical roles the actor may grant (UX metadata only; every mutation re-authorizes). Auth required. Registered before `/:id` so it is never read as an id.

**Response:**
```json
{
  "success": true,
  "message": "Success",
  "data": { "roles": [ { "code": "cashier", "name": "Cashier" }, { "code": "staff", "name": "Staff" } ] }
}
```
`platform_admin` may grant all roles; `tenant_admin` only roles strictly below `tenant_admin`.

Key errors: 403 `FORBIDDEN` (actor may grant no roles).

---

### POST `/memberships`
Creates or reactivates a membership. Auth required (`platform_admin` or `tenant_admin`; `tenant_admin` limited to its own tenant and roles below `tenant_admin`); actors may not mutate their own membership. Reactivation never changes the persisted role — a mismatched `role` is a conflict. `201` when created, `200` when reactivated or already in the desired state (no-op).

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `userId` | number | Target user id (required) |
| `tenantId` | number | Target tenant; defaults to the actor's active tenant |
| `role` | string | Canonical role (required) |
| `reason` | string | Optional audit reason (max 500 chars) |
| `requestId` | string | Optional audit/idempotency correlation id (max 64 chars) |

**Response:**
```json
{
  "success": true,
  "message": "Success",
  "data": {
    "membership": { "id": 11, "userId": 7, "tenantId": 1, "role": "cashier", "status": "ACTIVE" },
    "created": true,
    "reactivated": false,
    "noOp": false,
    "auditId": 100,
    "revokedSessionCount": 0,
    "requestId": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
  }
}
```

Key errors: 400 `INVALID_ROLE` / `INVALID_REASON` / `INVALID_REQUEST_ID`; 403 `FORBIDDEN` / `ROLE_CEILING`; 404 `RESOURCE_NOT_FOUND` (`userId`/`tenantId`); 409 `TRANSITION_FORBIDDEN` (retired membership); 409 `ASSIGNMENT_CONFLICT` (different role on the existing row).

---

### PATCH `/memberships/:id`
Applies exactly one membership operation per call: `status` (`DEACTIVATED` = deactivate, `ACTIVE` = reactivate, `RETIRED` = retire), `role` (change role), or `toTenantId` (move tenant; `platform_admin` only, optionally with `role` as the target role). Auth required (`platform_admin`/`tenant_admin`); `reason` is required for deactivate, retire, role change and move; reductions revoke the sessions the membership authorized and report the count.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `status` | string | `ACTIVE` \| `DEACTIVATED` \| `RETIRED` (exactly one of status/role/toTenantId) |
| `role` | string | Canonical role for a role change, or the target role with `toTenantId` |
| `toTenantId` | number | Move the membership to another tenant (`platform_admin` only) |
| `reason` | string | Required for reductions/move (max 500 chars) |
| `requestId` | string | Optional correlation id (max 64 chars) |

**Response** (deactivate/retire; reactivate is the same without a revocation count):
```json
{
  "success": true,
  "message": "Success",
  "data": {
    "membership": { "id": 11, "userId": 7, "tenantId": 1, "role": "cashier", "status": "DEACTIVATED" },
    "noOp": false,
    "auditId": 101,
    "revokedSessionCount": 1,
    "requestId": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
  }
}
```
A `role` change adds `downgrade`; a `toTenantId` move returns `{ source, target, created, reactivated, noOp, auditIds, revokedSessionCount, requestId }` instead of `membership`/`auditId`.

Key errors: 400 `INVALID_OPERATION` (not exactly one of status/role/toTenantId), `INVALID_ROLE`, `INVALID_REASON`, `INVALID_REQUEST_ID`; 403 `FORBIDDEN` / `ROLE_CEILING`; 404 `RESOURCE_NOT_FOUND`; 409 `TRANSITION_FORBIDDEN`; 409 `ASSIGNMENT_CONFLICT`.

---

---

## Tenants


All routes require a Bearer JWT, the canonical authorization context and the platform capability `tenant.manage` (held only by platform actors with no selected tenant). Mutations write their audit row in the same transaction and return `{ success: true, message, data }`; `code` is the stable business identifier and is immutable.

### GET `/tenants`
Lists tenants with their store and active-membership counts.

**Query:**
| Param | Type | Description |
|-------|------|-------------|
| `status` | string | `active` \| `suspended` \| `all` (default all) |
| `search` | string | Case-insensitive match on `name` or `code` |
| `page` | number | Page (default 1) |
| `limit` | number | Items per page (default 20, max 100) |

**Response:**
```json
{
  "success": true,
  "message": "Success",
  "data": [
    {
      "id": 1, "code": "toko-utama", "name": "Toko Utama", "status": "active",
      "storeCount": 3, "activeMemberCount": 12,
      "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

Key errors: 400 `INVALID_STATUS`; 401 `UNAUTHENTICATED` / `INELIGIBLE_ACCOUNT`; 403 `FORBIDDEN`.

---

### GET `/tenants/:id`
Returns one tenant with its store / active-member counts.

**Response:**
```json
{
  "success": true,
  "message": "Success",
  "data": {
    "id": 1, "code": "toko-utama", "name": "Toko Utama", "status": "active",
    "storeCount": 3, "activeMemberCount": 12,
    "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"
  }
}
```

Key errors: 404 `RESOURCE_NOT_FOUND`; 401/403 as above.

---

### POST `/tenants`
Creates a tenant with status `active`. Codes are never reused (retired/soft-deleted tenants still own theirs).

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `code` | string | 1-50 lowercase letters/digits/inner hyphens (required) |
| `name` | string | Display name (required, max 100 chars) |

**Response** (201):
```json
{
  "success": true,
  "message": "Tenant created",
  "data": { "id": 2, "code": "toko-baru", "name": "Toko Baru", "status": "active", "storeCount": 0, "activeMemberCount": 0, "createdAt": "2026-10-19T08:00:00.000Z", "updatedAt": "2026-10-19T08:00:00.000Z" }
}
```

Key errors: 400 `INVALID_CODE` / `INVALID_NAME`; 409 `TENANT_CODE_TAKEN`.

---

### PATCH `/tenants/:id`
Renames or suspends/resumes a tenant. Suspending makes the tenant authorize nothing (rows are untouched and resume with it). Idempotent: a no-op when the desired state already holds.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `name` | string | New name (max 100 chars) |
| `status` | string | `active` \| `suspended` |

**Response:**
```json
{
  "success": true,
  "message": "Tenant updated",
  "data": { "id": 1, "code": "toko-utama", "name": "Toko Utama", "status": "suspended", "storeCount": 3, "activeMemberCount": 12, "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-10-19T08:00:00.000Z" }
}
```

Key errors: 400 `CODE_IMMUTABLE`; 400 `INVALID_NAME`; 400 `INVALID_STATUS`; 400 `INVALID_OPERATION` (neither name nor status given); 404 `RESOURCE_NOT_FOUND`.

### DELETE `/tenants/:id`
Same gate as the other tenant routes. Deletes an empty tenant: retires its memberships and clears any session that had it selected (avoids `STALE_TENANT_CONTEXT`). Audited.

**Response:**
```json
{ "success": true, "message": "Tenant deleted", "data": { "id": 1, "code": "toko-utama", "name": "Toko Utama", "status": "active" } }
```

Key errors: 404 `RESOURCE_NOT_FOUND`; 409 `TENANT_HAS_STORES` (move or delete its stores first); 409 `TENANT_HAS_MEMBERS` (other active members remain).

---

---

## Assignments


All routes require a Bearer JWT plus the canonical authorization context. Assignment has no status: grant = create, revoke = hard delete; both are idempotent. Actors (`platform_admin`, `tenant_admin`, `store_admin`) may only manage targets ranked below their own persisted role and may never mutate their own assignments. Success envelope: `{ success: true, message: "Success", data }`.

### GET `/assignments`
Lists store assignments visible to the actor (platform = all; tenant = active tenant; store = own assigned stores and visible users; others = own rows). Auth required.

**Query:**
| Param | Type | Description |
|-------|------|-------------|
| `page` | number | Page (default 1) |
| `limit` | number | Items per page (default 20, max 100) |
| `userId` | number | Filter by user id |
| `storeId` | number | Filter by store id |
| `tenantId` | number | Filter by tenant id |

**Response:**
```json
{
  "success": true,
  "message": "Success",
  "data": [ { "id": 3, "userId": 7, "tenantId": 1, "storeId": 5 } ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

Key errors: 401 `UNAUTHENTICATED`; 403 `STALE_TENANT_CONTEXT` / `STALE_STORE_CONTEXT`; 500 `INTERNAL_ERROR`.

---

### POST `/assignments`
Grants a store assignment (idempotent). The target must have an `ACTIVE` membership in the store's tenant. `201` when created, `200` when already present.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `userId` | number | Target user id (required) |
| `storeId` | number | Target store id (required) |
| `reason` | string | Optional audit reason (max 500 chars) |
| `requestId` | string | Optional correlation id (max 64 chars) |

**Response:**
```json
{
  "success": true,
  "message": "Success",
  "data": {
    "assignment": { "id": 3, "userId": 7, "tenantId": 1, "storeId": 5 },
    "created": true,
    "noOp": false,
    "auditId": 102,
    "revokedSessionCount": 0,
    "requestId": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
  }
}
```

Key errors: 400 `INVALID_REASON` / `INVALID_REQUEST_ID`; 403 `FORBIDDEN` / `ROLE_CEILING` (invisible target answers as 404 below); 404 `RESOURCE_NOT_FOUND` (`userId`/`storeId`); 409 `MEMBERSHIP_REQUIRED`; 409 `STORE_TENANT_UNRESOLVED`; 409 `ASSIGNMENT_CONFLICT`.

---

### DELETE `/assignments`
Revokes a store assignment (hard delete, idempotent). Sessions that selected the store are revoked. `reason` is required.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `userId` | number | Target user id (required) |
| `storeId` | number | Target store id (required) |
| `reason` | string | Audit reason (required, max 500 chars) |
| `requestId` | string | Optional correlation id (max 64 chars) |

**Response:**
```json
{
  "success": true,
  "message": "Success",
  "data": {
    "assignment": { "id": 3, "userId": 7, "tenantId": 1, "storeId": 5 },
    "revoked": true,
    "noOp": false,
    "auditId": 103,
    "revokedSessionCount": 1,
    "requestId": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
  }
}
```
When the assignment was already absent: `assignment: null`, `revoked: false`, `noOp: true`, `revokedSessionCount: 0`.

Key errors: 400 `INVALID_REASON` / `INVALID_REQUEST_ID`; 403 `FORBIDDEN` / `ROLE_CEILING`; 404 `RESOURCE_NOT_FOUND`; 409 `MEMBERSHIP_REQUIRED` / `STORE_TENANT_UNRESOLVED` / `ASSIGNMENT_CONFLICT`.

---

---

## Effective Scope


### GET `/effective-scope`
Returns the caller's own canonical scope, or a visible target user's scope. Auth required (Bearer JWT + canonical authorization context). Omitting `userId` — or passing the caller's own id — is the self view; any other id requires a platform/tenant/store viewer (invisible and nonexistent targets both answer 404; a self-only actor always gets 403).

**Query:**
| Param | Type | Description |
|-------|------|-------------|
| `userId` | number | Target user id; omit for own scope |

**Response** (self view):
```json
{
  "success": true,
  "message": "Success",
  "data": {
    "user": { "id": 7, "userName": "kasir1" },
    "memberships": [ { "tenantId": 1, "role": "cashier", "status": "ACTIVE" } ],
    "assignments": [ { "tenantId": 1, "storeId": 5, "effective": true } ],
    "context": { "activeTenantId": 1, "activeStoreId": 5, "role": "cashier", "permissions": [] }
  }
}
```
A target view returns the same `user` / `memberships` / `assignments` fields without `context`.

Key errors: 403 `FORBIDDEN` (self-only actor viewing another user); 404 `RESOURCE_NOT_FOUND` (`userId` invisible or nonexistent).

---

---

## Internal (Scheduler)


All `/internal` endpoints are GET routes for an external scheduler (e.g. Vercel Cron), authenticated with `Authorization: Bearer $CRON_SECRET` — NOT JWT. Without a configured `CRON_SECRET` (min 32 chars) every call fails closed with 503 `{ "code": "CRON_NOT_CONFIGURED", "message": "Internal scheduler endpoints are not configured" }`; a wrong secret gets 401 `{ "code": "UNAUTHORIZED", "message": "Unauthorized" }`. Responses are plain JSON, not the standard success envelope.

### GET `/internal/accounting-outbox/drain`
Drains up to 50 pending accounting-outbox jobs (oldest first, `FOR UPDATE SKIP LOCKED`), guarded by the shared `accounting-outbox` lease.

**Response** (200):
```json
{
  "skipped": false, "processed": 3, "posted": 3, "failed": 0,
  "health": { "pending": 0, "retrying": 0, "failed": 0, "oldestPendingAgeSeconds": null, "maxAttempts": 5, "failedJobs": [] }
}
```
When another worker holds the lease: `{ "skipped": true, "reason": "LEASE_HELD" }`.

Key errors: 500 `{ "code": "INTERNAL_ERROR", "message": "Drain failed" }`.

---

### GET `/internal/accounting-outbox/health`
Returns the accounting-outbox operational snapshot (counts and ages only; `failedJobs` carries up to 20 sample rows with `id`, `jobType`, `referenceType`, `referenceId`, `attempts`, `updatedAt`).

**Response** (200, unwrapped):
```json
{ "pending": 0, "retrying": 0, "failed": 0, "oldestPendingAgeSeconds": null, "maxAttempts": 5, "failedJobs": [] }
```

Key errors: 500 `{ "code": "INTERNAL_ERROR", "message": "Health check failed" }`.

---

### GET `/internal/qr-orders/expire`
Sweeps unpaid pending QR orders older than `QR_PENDING_EXPIRY_MINUTES` (cancels them, releases the table when no other open order holds it). No-op unless the expiry window env var is set.

**Response** (200):
```json
{ "success": true, "enabled": true, "expiryMinutes": 30, "expired": 2, "orders": [101, 102] }
```
When expiry is disabled: `{ "success": true, "enabled": false, "expired": 0 }`.

Key errors: 500 `{ "success": false, "code": "QR_EXPIRY_FAILED" }`.

---

### GET `/internal/backup/run`
Runs the stored backup schedule if it matches the current minute; catches up (runs anyway) when the stored schedule is enabled but the last scheduled backup is older than 20h. Guarded by the shared `backup` lease.

**Response** (200), one of:
```json
{ "skipped": false, "ran": true }
{ "skipped": false, "ran": true, "catchUp": true }
{ "skipped": false, "ran": false, "reason": "SCHEDULE_DISABLED" }
{ "skipped": false, "ran": false, "reason": "NOT_DUE" }
{ "skipped": true, "reason": "LEASE_HELD" }
```

Key errors: 500 `{ "code": "INTERNAL_ERROR", "message": "Backup failed" }`.

---

### GET `/internal/expense-recurrence/run`
Generates due recurring expenses (the in-process scheduler does not run on Vercel — FG-PLAT-04). Guarded by the shared `expense` lease.

**Response** (200): `{ "skipped": false, "generated": 2 }` · `{ "skipped": true, "reason": "LEASE_HELD" }`.

Key errors: 500 `{ "code": "INTERNAL_ERROR", "message": "Run failed" }`.

---

### GET `/internal/shift-swaps/expire`
Expires pending shift-swap requests whose swap dates (`tanggal_mulai`/`tanggal_selesai`) are in the past or whose `expires_at` has passed. Guarded by the shared `shift-swap` lease.

**Response** (200): `{ "skipped": false, "expired": 1 }` · `{ "skipped": true, "reason": "LEASE_HELD" }`.

Key errors: 500 `{ "code": "INTERNAL_ERROR", "message": "Run failed" }`.

---

### GET `/internal/ap-reminders/run`
Creates accounts-payable due-date reminders (up to 200 per run, duplicates skipped). Guarded by the shared `ap-reminder` lease.

**Response** (200): `{ "skipped": false, "evaluated": 10, "eligible": 3, "created": 2, "skippedDuplicate": 1 }` · `{ "skipped": true, "reason": "LEASE_HELD" }`.

Key errors: 500 `{ "code": "INTERNAL_ERROR", "message": "Run failed" }`.

**Schedule:** all six `/internal/*` jobs are declared in `vercel.json` as daily crons (`0 0 * * *`, 00:00 UTC).

---

---

## Backup


All routes require a Bearer JWT and are platform-global operations executable only by a GLOBAL super_admin (`roleType` `super_admin` with no store); a store-bound super_admin gets 403 `{ "success": false, "message": "Hanya super admin global yang dapat mengatur jadwal backup sistem" }`. Backup artifacts are full pg_dump dumps of the shared database (the store label is metadata, never authority).

### GET `/backup/schedule`
Returns the stored backup schedule. Auth required (global super_admin).

**Response:**
```json
{
  "success": true,
  "data": { "enabled": false, "cron": "0 0 * * *", "retention": 7 }
}
```

Key errors: 403 (not a global super_admin); 500.

---

### PUT `/backup/schedule`
Stores the backup schedule. Auth required (global super_admin). A 5-field cron (`m h dom mon dow`) is validated when `enabled` is true.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable/disable the schedule |
| `cron` | string | 5-field cron expression |
| `retention` | number | Days to keep backups (min 0) |

**Response:**
```json
{
  "success": true,
  "message": "Jadwal backup disimpan",
  "data": { "enabled": true, "cron": "0 2 * * *", "retention": 7 }
}
```

Key errors: 400 `Cron expression tidak valid (format: m h dom mon dow)`; 403 (not a global super_admin).

---

### POST `/backup/create`
Runs `pg_dump` and records a `db_backup` row. Auth required (global super_admin). `trigger` records why the backup ran; an explicit store may be chosen only as metadata (the dump is always the whole shared database).

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `trigger` | string | `scheduled` or anything else → `manual` (default `manual`) |
| `store` / `storeId` | number | Optional store label for the artifact |

**Response** (201):
```json
{
  "success": true,
  "message": "Backup berhasil dibuat",
  "data": {
    "id": 4, "filename": "backup_2026-10-19T08-00-00-000Z.dump", "size": 1048576,
    "format": "custom", "status": "success", "trigger": "manual", "store": 5, "createdBy": 1,
    "metadata": { "storeName": "Toko Utama", "globalDump": false }
  }
}
```

Key errors: 403 (not a global super_admin); 500 `Backup gagal: ...`.

---

### GET `/backup/list`
Lists backup records (newest first). Auth required (global super_admin). Each row includes an `exists` flag; the server `filepath` is never returned.

**Query:**
| Param | Type | Description |
|-------|------|-------------|
| `limit` | number | Items per page (default 50, max 200) |
| `offset` | number | Offset (default 0) |

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 4, "filename": "backup_2026-10-19T08-00-00-000Z.dump", "size": 1048576,
      "format": "custom", "status": "success", "trigger": "manual", "store": 5,
      "createdBy": 1, "metadata": { "storeName": "Toko Utama", "globalDump": false },
      "exists": true
    }
  ],
  "pagination": { "total": 1 }
}
```

Key errors: 403 (not a global super_admin); 500.

---

### GET `/backup/download/:id`
Streams the backup file as a download. Auth required (global super_admin). Response is binary (`Content-Type: application/octet-stream`, `Content-Disposition: attachment`), not JSON.

Key errors: 404 `Backup tidak ditemukan`; 404 `File backup tidak ada di server`; 403 (not a global super_admin).

---

### POST `/backup/restore/:id`
Runs `pg_restore`/`psql` against the database from the stored artifact and marks the record `status: "restored"`. Auth required (global super_admin); destructive platform-global operation.

**Response:**
```json
{ "success": true, "message": "Restore berhasil dilakukan" }
```

Key errors: 404 `Backup tidak ditemukan`; 404 `File backup tidak ada di server`; 403 (not a global super_admin); 500 `Restore gagal: ...`.

---

### DELETE `/backup/delete/:id`
Deletes the artifact file and its database record. Auth required (global super_admin).

**Response:**
```json
{ "success": true, "message": "Backup dihapus" }
```

Key errors: 404 `Backup tidak ditemukan`; 403 (not a global super_admin).

---

---

## Regions


Reference data for Indonesian administrative regions. All routes require a Bearer JWT (any authenticated role) and are not store-scoped. Every row is returned as `{ code, name, postalCode?, latitude?, longitude? }` (optional fields omitted when absent), sorted by name.

### GET `/regions/provinces`
Lists all provinces.

**Response:**
```json
{
  "success": true,
  "message": "Success",
  "data": [ { "code": "11", "name": "ACEH" } ]
}
```

Key errors: 401; 500 `Terjadi Kesalahan Internal Server`.

---

### GET `/regions/regencies`
Lists cities/regencies of a province. Auth required.

**Query:**
| Param | Type | Description |
|-------|------|-------------|
| `province_code` | string | Parent province code |

**Response:**
```json
{ "success": true, "message": "Success", "data": [ { "code": "11.01", "name": "KABUPATEN SIMEULUE" } ] }
```

Key errors: 500.

---

### GET `/regions/districts`
Lists districts of a regency. Auth required.

**Query:**
| Param | Type | Description |
|-------|------|-------------|
| `regency_code` | string | Parent regency/city code |

**Response:**
```json
{ "success": true, "message": "Success", "data": [ { "code": "11.01.01", "name": "TEUPAH SELATAN" } ] }
```

Key errors: 500.

---

### GET `/regions/villages`
Lists villages of a district. Auth required.

**Query:**
| Param | Type | Description |
|-------|------|-------------|
| `district_code` | string | Parent district code |

**Response:**
```json
{ "success": true, "message": "Success", "data": [ { "code": "11.01.01.2001", "name": "LATIUNG" } ] }
```

Key errors: 500.

---

### GET `/regions/postal-codes`
Returns the village row(s) matching a village code, including the postal code. Auth required.

**Query:**
| Param | Type | Description |
|-------|------|-------------|
| `village_code` | string | Village code |

**Response:**
```json
{ "success": true, "message": "Success", "data": [ { "code": "11.01.01.2001", "name": "LATIUNG", "postalCode": "23894" } ] }
```

Key errors: 500.

---

### GET `/regions/regions`
Generic region search. Auth required.

**Query:**
| Param | Type | Description |
|-------|------|-------------|
| `level` | string | `provinces` \| `regencies` \| `districts` \| `villages` (mapped to the stored level) |
| `parentCode` | string | Filter by parent code |
| `search` | string | Case-insensitive name match |

**Response:**
```json
{ "success": true, "message": "Success", "data": [ { "code": "11.01.01.2001", "name": "LATIUNG", "postalCode": "23894", "latitude": 2.5, "longitude": 96.1 } ] }
```
At most 1000 rows are returned.

Key errors: 500.

---

---

## Thermal Printer


All routes require a Bearer JWT and pass `validateStoreAccess` (callers are pinned to their own store; a global super_admin may select one). Roles per route as noted. Responses use the legacy envelope: `{ success: true, ... }`.

### GET `/thermal-printer/status`
Returns the current printer connection status. Auth required (`super_admin` or `admin`).

**Response:**
```json
{
  "success": true,
  "data": { "connected": true, "type": "usb", "devicePath": "/dev/usb/lp0", "ipAddress": null }
}
```
On a connection failure the endpoint still answers 200 with `{ "success": true, "data": { "connected": false, "error": "..." } }`.

---

### POST `/thermal-printer/configure`
Creates a new printer instance with the given configuration and attempts to connect. Auth required (`super_admin` only).

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `type` | string | `auto` (default) \| `usb` \| `serial` \| `network` \| `bluetooth` \| `file` |
| `devicePath` | string | Device path for usb/serial/file |
| `ipAddress` | string | Network printer address |
| `port` | number | Network printer port |
| `macAddress` | string | Bluetooth address |
| `columns` | number | Paper width in characters (default 32) |

**Response:**
```json
{
  "success": true,
  "message": "Printer terhubung",
  "data": { "connected": true, "type": "usb" }
}
```
When the printer cannot be reached: message `Printer konfigurasi tersimpan (belum terhubung)` with `connected: false`.

Key errors: 500 (`error.message`).

---

### POST `/thermal-printer/print`
Prints a receipt for an order. Auth required (`super_admin`, `admin` or `kasir`). When `testPrint` is true a built-in sample receipt is printed and `orderId` is not required.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `orderId` | number/string | Order to print (required unless `testPrint`) |
| `testPrint` | boolean | Print the built-in sample receipt instead of an order |
| `printerConfig` | object | Optional printer overrides (same keys as configure) |
| `storeId` | number | Optional store; falls back to the request store context / token store |

**Response:**
```json
{
  "success": true,
  "message": "Struk berhasil dicetak",
  "data": { "success": true, "message": "Printed to USB" }
}
```

Key errors: 400 `orderId atau testPrint diperlukan`; 400 `Store ID diperlukan`; 404 `Order tidak ditemukan`; 500 (`error.message` / `Gagal mencetak struk`).

---

### POST `/thermal-printer/test-print`
Prints the built-in sample receipt. Auth required (`super_admin` or `admin`). Runs the same handler as `/thermal-printer/print`, so the body must include `testPrint: true` to get the sample receipt; otherwise it behaves exactly like `/print` (and then requires `orderId`).

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `testPrint` | boolean | Set `true` to print the sample receipt |
| `printerConfig` | object | Optional printer overrides |

**Response:**
```json
{
  "success": true,
  "message": "Test print berhasil",
  "data": { "success": true, "message": "Printed to USB" }
}
```

Key errors: 400 `orderId atau testPrint diperlukan`; 400 `Store ID diperlukan`; 500.

---

---

## Shift Template


### GET `/shift-template/get-shift-template`
Auth required (any authenticated role, store access). Returns active shift templates for dropdowns.

**Query:**
| Field | Type | Description |
|-------|------|-------------|
| `store` | number | Optional. When sent, returns global templates (`store: null`) plus templates of that store. When omitted, returns all active templates. |

**Response:**
```json
{
  "success": true,
  "message": "Success",
  "data": [
    { "id": 1, "store": 1, "name": "Pagi", "startTime": "08:00:00", "endTime": "16:00:00", "description": null, "status": "active" }
  ]
}
```

---

### GET `/shift-template/get-shift-template-all`
Auth required (any authenticated role, store access). Paginated table view of shift templates. Note: the query itself is not store-filtered by the controller.

**Query:**
| Field | Type | Description |
|-------|------|-------------|
| `page` | number | Default 1. |
| `limit` | number | Default 10. |
| `status` | string | `active` \| `inactive` \| `draft`, or `all` (default). |
| `search` | string | Case-insensitive match on `name`. |

**Response:**
```json
{
  "success": true,
  "message": "Success",
  "data": [
    { "id": 1, "store": 1, "name": "Pagi", "startTime": "08:00:00", "endTime": "16:00:00", "description": null, "status": "active", "createdBy": 1, "modifiedBy": null, "createdByUser": null, "modifiedByUser": null }
  ],
  "pagination": { "totalItems": 1, "total": 1, "totalPages": 1, "currentPage": 1, "limit": 10 },
  "stats": { "total": 1, "totalActive": 1, "totalInactive": 0, "totalDraft": 0 }
}
```

---

### GET `/shift-template/get-shift-template/:id`
Auth required (any authenticated role, store access). Get one shift template. Note: the lookup is by ID only — no store filter in the controller.

**Response:**
```json
{
  "success": true,
  "message": "Success",
  "data": {
    "id": 1,
    "store": 1,
    "name": "Pagi",
    "startTime": "08:00:00",
    "endTime": "16:00:00",
    "description": null,
    "status": "active",
    "createdByUser": null,
    "modifiedByUser": null
  }
}
```

Key errors: 404 `Template shift tidak ditemukan`.

---

### POST `/shift-template/add-new-shift-template`
Auth required (super_admin/admin, store access).

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `store` | number \| null | Optional (validated by Zod, nullable). |
| `name` | string | **Required.** |
| `startTime` | string | **Required** (e.g. `08:00`). |
| `endTime` | string | **Required** (e.g. `16:00`). |
| `description` | string \| null | Optional. |
| `status` | string | `active` \| `inactive` \| `draft` (default `active`). |

**Response:**
```json
{
  "success": true,
  "message": "Template shift berhasil dibuat",
  "data": { "id": 1, "store": 1, "name": "Pagi", "startTime": "08:00:00", "endTime": "16:00:00", "description": null, "status": "active" }
}
```

Key errors: 400 Zod validation; 403 `Template shift dengan nama tersebut sudah ada` (duplicate name within the same store scope).

---

### PUT `/shift-template/edit-shift-template/:id`
Auth required (super_admin/admin, store access). Non-super_admin is scoped to their own store.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `id` | number | **Required by the Zod schema** (controller also accepts the `:id` path param). |
| `store` | number \| null | Optional. |
| `name` | string | Optional. |
| `startTime` | string | Optional. |
| `endTime` | string | Optional. |
| `description` | string \| null | Optional. |
| `status` | string | Optional, `active` \| `inactive` \| `draft`. |

**Response:**
```json
{
  "success": true,
  "message": "Template shift berhasil diperbarui",
  "data": { "id": 1, "store": 1, "name": "Pagi", "startTime": "08:00:00", "endTime": "16:00:00", "description": null, "status": "active" }
}
```

Key errors: 400 Zod validation; 403 duplicate name; 404 `Template shift tidak ditemukan`.

---

### DELETE `/shift-template/delete-shift-template/:id`
Auth required (super_admin/admin, store access). Non-super_admin is scoped to their own store.

**Response:**
```json
{ "success": true, "message": "Template shift berhasil dihapus" }
```

Key errors: 404 `Template shift tidak ditemukan`.

---

---

## Shift Swap


### GET `/shift-swap/get-swap`
Auth required (super_admin/admin/user, store access). List shift-swap (ubah jadwal) requests.

**Query:**
| Field | Type | Description |
|-------|------|-------------|
| `page` | number | Default 1. |
| `pageSize` | number | Default 10. |
| `status` | string | `pending` \| `approved` \| `rejected` \| `cancelled` \| `expired`. |
| `mine` | any | When truthy, only swaps where the caller is requester or target. |
| `from` / `to` | date | `createdAt` range (`to` covers through 23:59:59.999). |

**Response:**
```json
{
  "success": true,
  "message": "Berhasil mengambil data ubah jadwal",
  "data": [
    {
      "id": 1,
      "store": 1,
      "requesterId": 10,
      "targetId": 11,
      "requesterShiftId": 2,
      "targetShiftId": 3,
      "tanggal_mulai": "2026-10-20",
      "tanggal_selesai": "2026-10-20",
      "note": null,
      "status": "pending",
      "decidedBy": null,
      "decidedAt": null,
      "expires_at": "2026-10-21T08:00:00.000Z",
      "status_history": [{ "status": "pending", "by": 10, "at": "2026-10-19T08:00:00.000Z" }],
      "requesterUser": { "id": 10, "fullName": "Budi", "positionData": { "id": 1, "name": "Kasir" }, "departmentData": { "id": 1, "name": "Front Office" }, "storeData": { "id": 1, "name": "Toko A" } },
      "targetUser": { "id": 11, "fullName": "Ani" },
      "requesterShift": { "id": 2, "name": "Pagi" },
      "targetShift": { "id": 3, "name": "Siang" },
      "decidedByUser": null
    }
  ],
  "pagination": { "page": 1, "pageSize": 10, "totalPage": 1, "total": 1 },
  "stats": { "pending": 1, "approved": 0, "rejected": 0, "expired": 0, "total": 1 }
}
```

State values visible in code: `status` is `pending` on create; decided to `approved`/`rejected` by admins, `cancelled` by requester/target/admin, or `expired` (pending swaps get `expires_at` = now + 48 h).

---

### POST `/shift-swap/create-swap`
Auth required (any authenticated role; no `requireRole`, store access). Create a shift-swap request; store scope enforced in controller.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `store` | number \| null | Optional; honored for super_admin. |
| `requesterId` | number \| null | Optional; defaults to caller. |
| `targetId` | number | **Required.** The other employee. |
| `requesterShiftId` | number | **Required.** |
| `targetShiftId` | number | **Required.** |
| `tanggal_mulai` | string \| null | Optional (YYYY-MM-DD). |
| `tanggal_selesai` | string \| null | Optional (YYYY-MM-DD). |
| `note` | string \| null | Optional. |

**Response:**
```json
{
  "success": true,
  "message": "Permintaan ubah jadwal berhasil diajukan",
  "data": {
    "id": 1,
    "store": 1,
    "requesterId": 10,
    "targetId": 11,
    "requesterShiftId": 2,
    "targetShiftId": 3,
    "tanggal_mulai": "2026-10-20",
    "tanggal_selesai": "2026-10-20",
    "note": null,
    "status": "pending",
    "status_history": [{ "status": "pending", "by": 10, "at": "2026-10-19T08:00:00.000Z" }],
    "expires_at": "2026-10-21T08:00:00.000Z"
  }
}
```

Key errors: 400 Zod validation / missing `targetId`/`requesterShiftId`/`targetShiftId` / self-swap / pending duplicate for the same employee pair; 403 caller cannot create swaps for another store (`Anda hanya dapat membuat permintaan ubah jadwal di toko Anda`); 404 target employee or shift not found; 400 requester and target must be in the same store; 409 target/requester already has another shift or attendance on the requested dates.

---

### PUT `/shift-swap/update-swap-status/:id`
Auth required (super_admin/admin, store access). Approve or reject a pending swap; on approval both employees are actually relocated between the two shifts (transactional).

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `status` | string | **Required.** `approved` \| `rejected` (Zod enum). |

**Response:**
```json
{
  "success": true,
  "message": "Permintaan disetujui",
  "data": { "id": 1, "status": "approved", "decidedBy": 1, "decidedAt": "2026-10-19T09:00:00.000Z" }
}
```

Key errors: 400 `Status harus approved atau rejected`; 400 `Permintaan ini sudah diputuskan sebelumnya` (only `pending` can be decided); 404 not found.

---

### PUT `/shift-swap/cancel/:id`
Auth required (super_admin/admin/user, store access). Cancel a pending swap; caller must be super_admin/admin or the requester/target.

**Response:**
```json
{
  "success": true,
  "message": "Permintaan dibatalkan",
  "data": { "id": 1, "status": "cancelled", "decidedBy": 10, "decidedAt": "2026-10-19T09:00:00.000Z" }
}
```

Key errors: 400 `Permintaan ini sudah diputuskan sebelumnya`; 403 `Anda tidak berhak membatalkan permintaan ini`; 404 not found.

---

---

## Attendance


### GET `/attendance/by-shift`
Auth required (any authenticated role, store access). List attendance records for a shift; non-super_admin is scoped to their store.

**Query:**
| Field | Type | Description |
|-------|------|-------------|
| `shiftId` | number | **Required.** 400 `Parameter shiftId wajib diisi` when absent. |

**Response:**
```json
{
  "success": true,
  "message": "Success",
  "data": [
    {
      "id": 1,
      "userId": 10,
      "store": 1,
      "shiftId": 2,
      "type": "check-in",
      "absenAt": "2026-10-19T01:00:00.000Z",
      "latitude": -6.2,
      "longitude": 106.8,
      "accuracy": 12.5,
      "algorithm": "gps",
      "status": "valid",
      "note": "Lokasi terverifikasi",
      "createdAt": "2026-10-19T01:00:00.000Z",
      "userData": { "id": 10, "fullName": "Budi", "userName": "budi" },
      "storeData": { "id": 1, "name": "Toko A" },
      "shiftData": { "id": 2, "name": "Pagi", "jam_mulai": "08:00:00", "jam_selesai": "16:00:00" }
    }
  ],
  "total": 1
}
```

---

### GET `/attendance/my`
Auth required (any authenticated role; own records only, no store-access middleware).

**Query:**
| Field | Type | Description |
|-------|------|-------------|
| `date` | string | Optional `YYYY-MM-DD`; defaults to today. |

**Response:** same record shape as `/attendance/by-shift`, plus `"total"` (userData/storeData/shiftData nullable).

```json
{
  "success": true,
  "message": "Success",
  "data": [
    { "id": 1, "userId": 10, "store": 1, "shiftId": 2, "type": "check-in", "absenAt": "2026-10-19T01:00:00.000Z", "latitude": -6.2, "longitude": 106.8, "accuracy": 12.5, "algorithm": "gps", "status": "valid", "note": "Lokasi terverifikasi", "userData": null, "storeData": null, "shiftData": null }
  ],
  "total": 1
}
```

---

### GET `/attendance/today`
Auth required (any authenticated role, store access). Today's attendance for the resolved store, including `userData.roleType`.

**Query:**
| Field | Type | Description |
|-------|------|-------------|
| `date` | string | Optional `YYYY-MM-DD`; defaults to today. |

**Response:**
```json
{
  "success": true,
  "message": "Success",
  "data": [
    { "id": 1, "userId": 10, "store": 1, "shiftId": 2, "type": "check-in", "absenAt": "2026-10-19T01:00:00.000Z", "latitude": -6.2, "longitude": 106.8, "accuracy": 12.5, "algorithm": "gps", "status": "valid", "note": "Lokasi terverifikasi", "userData": { "id": 10, "fullName": "Budi", "userName": "budi" }, "storeData": { "id": 1, "name": "Toko A" }, "shiftData": { "id": 2, "name": "Pagi", "jam_mulai": "08:00:00", "jam_selesai": "16:00:00" } }
  ],
  "total": 1
}
```

Note: `store` is taken from the resolved store (`req.storeId`).

---

### POST `/attendance/clock`
Auth required (any authenticated role; own clock only, no store-access middleware — store is derived from the authenticated user, not the client).

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `type` | string | `check-in` \| `check-out` (default `check-in`). |
| `latitude` | number | **Required**, valid coordinate (-90..90). |
| `longitude` | number | **Required**, valid coordinate (-180..180). |
| `accuracy` | number | GPS accuracy in meters; ≤ 150 to be trusted. |
| `algorithm` | string | Default `gps`. |
| `shiftId` | number | Optional. |

**Response (201):**
```json
{
  "success": true,
  "message": "Absen masuk berhasil",
  "data": {
    "id": 1,
    "userId": 10,
    "store": 1,
    "shiftId": 2,
    "type": "check-in",
    "absenAt": "2026-10-19T01:00:00.000Z",
    "latitude": -6.2,
    "longitude": 106.8,
    "accuracy": 12.5,
    "algorithm": "gps",
    "status": "valid",
    "note": "Lokasi terverifikasi",
    "createdAt": "2026-10-19T01:00:00.000Z",
    "userData": null,
    "storeData": null,
    "shiftData": null
  }
}
```

State values visible in code: `status` is `valid` when the coordinate is sane and `accuracy` ≤ 150 m; otherwise `untrusted` with a reason in `note` (record is still stored). `type` values: `check-in` | `check-out`.

Key errors: 400 `Tipe absensi harus check-in atau check-out`; 400 invalid/out-of-range/(0,0) coordinates; 409 already clocked in/out today (one record per type per day); 500 on create failure.

---

---

## Overtime


### GET `/overtime/get-overtime`
Auth required (super_admin/admin/user, store access). List overtime requests.

**Query:**
| Field | Type | Description |
|-------|------|-------------|
| `page` | number | Default 1. |
| `pageSize` | number | Default 10. |
| `store` | number | Only meaningful for super_admin. |
| `status` | string | `pending` \| `approved` \| `rejected` \| `cancelled`. |
| `mine` | any | When truthy, only the caller's own records. |
| `from` / `to` | date | `date` range (YYYY-MM-DD). |

**Response:**
```json
{
  "success": true,
  "message": "Berhasil mengambil data lembur",
  "data": [
    { "id": 1, "store": 1, "shift_id": 2, "employee_id": 10, "date": "2026-10-19", "start_time": "16:00", "end_time": "18:00", "duration_hours": "2.00", "note": null, "status": "pending", "decidedBy": null, "decidedAt": null, "status_history": [{ "status": "pending", "by": 10, "at": "2026-10-19T08:00:00.000Z" }], "accounting_status": "unposted", "employee": { "id": 10, "fullName": "Budi", "userName": "budi" }, "shift": { "id": 2, "name": "Pagi", "startTime": "08:00:00", "endTime": "16:00:00" }, "decidedByUser": null }
  ],
  "pagination": { "page": 1, "pageSize": 10, "totalPage": 1, "total": 1 },
  "stats": { "pending": 1, "approved": 0, "rejected": 0, "cancelled": 0 }
}
```

State values visible in code: `status` `pending` → `approved`/`rejected` or `cancelled`; `accounting_status` `unposted` → `posted` after payroll posting.

---

### POST `/overtime/create-overtime`
Auth required (any authenticated role, store access). A regular user can only submit for themselves; super_admin/admin may pass `employee_id` for another employee.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `store` | number \| null | Optional; honored for super_admin. |
| `shift_id` | number | **Required.** Employee must be a member of this shift. |
| `employee_id` | number \| null | Optional; defaults to caller (others need admin/super_admin). |
| `date` | string | **Required**, `YYYY-MM-DD`. |
| `start_time` | string | **Required**, `HH:MM` (or `HH:MM:SS`). |
| `end_time` | string | **Required**, `HH:MM` (or `HH:MM:SS`); end after start (overnight handled). |
| `note` | string \| null | Optional. |

**Response (201):**
```json
{
  "success": true,
  "message": "Pengajuan lembur berhasil dibuat",
  "data": {
    "id": 1,
    "store": 1,
    "shift_id": 2,
    "employee_id": 10,
    "date": "2026-10-19",
    "start_time": "16:00",
    "end_time": "18:00",
    "duration_hours": 2,
    "note": null,
    "status": "pending",
    "status_history": [{ "status": "pending", "by": 10, "at": "2026-10-19T08:00:00.000Z" }],
    "accounting_status": "unposted"
  }
}
```

Key errors: 400 Zod validation; 403 `Anda hanya dapat mengajukan lembur untuk diri sendiri`; 404 employee or shift not found; 400 employee not registered on that shift; 400 overtime date outside the shift's `tanggal_mulai`/`tanggal_selesai` range; 400 invalid duration; 409 already a pending/approved overtime that date; 409 overlapping shift time.

---

### PUT `/overtime/update-status/:id`
Auth required (super_admin/admin, store access). Approve/reject a pending overtime (store-scoped).

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `status` | string | **Required.** `approved` \| `rejected` (Zod enum). |
| `note` | string \| null | Optional decision note. |

**Response:**
```json
{
  "success": true,
  "message": "Pengajuan lembur disetujui",
  "data": { "id": 1, "status": "approved", "decidedBy": 1, "decidedAt": "2026-10-19T09:00:00.000Z" }
}
```

Key errors: 400 already decided (only `pending`); 403 `Anda hanya dapat menyetujui lembur di toko Anda`; 400 `Lembur sudah diposting ke akuntansi dan tidak dapat diubah`; 404 not found.

---

### PUT `/overtime/cancel/:id`
Auth required (super_admin/admin/user, store access). Cancel a pending overtime; caller must be admin or the employee on the record.

**Response:**
```json
{
  "success": true,
  "message": "Pengajuan dibatalkan",
  "data": { "id": 1, "status": "cancelled", "decidedBy": 10, "decidedAt": "2026-10-19T09:00:00.000Z" }
}
```

Key errors: 400 already decided; 403 `Anda tidak berhak membatalkan pengajuan ini` / `Anda hanya dapat membatalkan lembur di toko Anda`; 404 not found.

---

### POST `/overtime/post-payroll`
Auth required (super_admin/admin, store access). Closing: aggregates `approved` overtimes of the month per employee (hours × `overtimeRate`, falling back to `dailySalary / 8`), posts the accounting journal and flags rows `accounting_status: "posted"`. Deduplicated per store/period.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `store` | number \| null | Optional; honored for super_admin. |
| `month` | string | **Required**, `YYYY-MM`. |

**Response:**
```json
{
  "success": true,
  "message": "Berhasil memposting 3 lembur ke akuntansi",
  "data": { "posted": 3, "totalAmount": 450000, "journalId": 12, "entryNumber": "JV-2026-0012" }
}
```

When nothing to post: `200` with `{ "success": true, "message": "Tidak ada lembur disetujui pada periode tersebut", "data": { "posted": 0, "totalAmount": 0 } }`.

Key errors: 400 `Bulan tidak valid (format YYYY-MM)`.

---

---

## Business Trip


### GET `/business-trip/get-all`
Auth required (any authenticated role, store access). Paginated business trips.

**Query:**
| Field | Type | Description |
|-------|------|-------------|
| `page` | number | Default 1. |
| `limit` | number | Default 10. |
| `status` | string | `draft` \| `pending` \| `approved` \| `rejected` (create default `draft`; PATCH also accepts `cancelled`). |
| `search` | string | Matches `tripNumber`, `employeeName`, `destination`, store name. |
| `queryStore` | number | Super_admin only; otherwise the store scope wins. |

**Response:**
```json
{
  "success": true,
  "message": "Success",
  "data": [
    {
      "id": 1,
      "tripNumber": "BT-20261019-0001",
      "status": "draft",
      "employeeName": "Budi",
      "destination": "Jakarta",
      "departureDate": "2026-10-20",
      "returnDate": "2026-10-22",
      "budget": "2000000.00",
      "employees": [{ "id": 1, "employeeId": 10, "employeeName": "Budi", "employeePosition": "Kasir", "employeeUser": null }],
      "budgetItems": [{ "id": 1, "komponen": "Transport", "qty": 1, "satuan": "trip", "tarif": 500000, "total": 500000, "catatan": "" }],
      "budgetTotal": 500000,
      "store": { "id": 1, "name": "Toko A" },
      "createdByUser": null,
      "modifiedByUser": null,
      "approvedByUser": null,
      "createdAt": "2026-10-19T00:00:00.000Z",
      "updatedAt": "2026-10-19T00:00:00.000Z"
    }
  ],
  "pagination": { "page": 1, "limit": 10, "total": 1, "totalPages": 1 },
  "stats": { "total": 1, "pending": 0, "approved": 0, "rejected": 0 }
}
```

---

### GET `/business-trip/get-by-id/:id`
Auth required (any authenticated role, store access). Non-super_admin scoped to own store.

**Response:** full business-trip row (all columns above plus `employeeId`, `employeePosition`, `tripPurpose`, `notes`, `approvedBy`, `approvedAt`) with includes `storeData`, `employeeUser`, `approvedByUser`, `createdByUser`, `modifiedByUser`, `employees[]`, `budgetItems[]`.

Key errors: 404 `Business trip not found`.

---

### POST `/business-trip/create`
Auth required (super_admin/admin, store access). Creates with generated `tripNumber` (`BT-YYYYMMDD-XXXX`) and initial `status: "draft"`.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `store` | number | Honored for super_admin; others pinned to own store. |
| `employeeId` | number | Optional single employee. |
| `employeeName` / `employeePosition` | string | Optional. |
| `employees` | array | Optional list of `{ employeeId, employeeName, employeePosition }`. |
| `budgetItems` | array | Optional list of `{ komponen, qty, satuan, tarif, catatan }`; `total` computed as `qty * tarif`. |
| `destination` | string | **Required.** |
| `departureDate` | string | **Required** (YYYY-MM-DD). |
| `returnDate` | string | **Required** (YYYY-MM-DD). |
| `tripPurpose` | string | Optional. |
| `budget` | number | Optional. |
| `notes` | string | Optional. |

**Response (201):**
```json
{
  "success": true,
  "message": "Success create business trip",
  "data": { "id": 1, "tripNumber": "BT-20261019-0001", "status": "draft", "destination": "Jakarta", "departureDate": "2026-10-20", "returnDate": "2026-10-22" }
}
```

Key errors: 400 `destination, departureDate and returnDate are required`; 404 `Employee not found`; 400 `Selected employee does not belong to the selected store`.

---

### PUT `/business-trip/update/:id`
Auth required (super_admin/admin, store access). Only `draft`, `pending`, or `rejected` trips can be updated; a rejected trip is reset to `draft`. Sending `employees` or `budgetItems` arrays replaces the existing children.

**Body:** any of `employeeId`, `employeeName`, `employeePosition`, `destination`, `tripPurpose`, `departureDate`, `returnDate`, `budget`, `notes`, plus `store` (super_admin) and the `employees`/`budgetItems` arrays.

**Response:**
```json
{
  "success": true,
  "message": "Success update business trip",
  "data": { "id": 1, "tripNumber": "BT-20261019-0001", "status": "draft", "destination": "Bandung", "departureDate": "2026-10-20", "returnDate": "2026-10-21" }
}
```

Key errors: 404 `Business trip not found`; 400 `Only draft, pending or rejected business trip can be updated`; 404 `Employee not found`; 400 employee store mismatch.

---

### DELETE `/business-trip/delete/:id`
Auth required (super_admin/admin, store access). Only `draft`, `pending`, or `rejected` trips can be deleted.

**Response:**
```json
{ "success": true, "message": "Success delete business trip", "data": { "id": 1 } }
```

Key errors: 404 `Business trip not found`; 400 `Only draft, pending or rejected business trip can be deleted`.

---

### PATCH `/business-trip/status/:id`
Auth required (super_admin/admin, store access). Change status/decision.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `status` | string | **Required.** `approved` \| `rejected` \| `cancelled` \| `pending`. |

**Response:**
```json
{ "success": true, "message": "Business trip approved", "data": { "id": 1, "status": "approved" } }
```

Setting `approved` records `approvedBy` (caller) and `approvedAt`. Any other status clears them.

Key errors: 400 `Invalid status`; 404 `Business trip not found`; 400 `Approved business trip cannot be cancelled`.

---

---

## Waiter Request


### GET `/waiter-request`
Auth required (any authenticated role, store access). Paginated waiter requests for the store.

**Query:**
| Field | Type | Description |
|-------|------|-------------|
| `status` | string | `pending` \| `approved` \| `rejected` \| `done`, or `all` (default). |
| `page` | number | Default 1. |
| `limit` | number | Default 20. |
| `store` | number | Optional store override (falls back to caller's store). |

**Response:**
```json
{
  "success": true,
  "message": "Success get waiter requests",
  "data": [
    { "id": 1, "store": [1], "requestNumber": "WR0815-0042", "tableId": 3, "orderId": null, "type": "tisu", "notes": null, "customerName": null, "status": "pending", "resolvedAt": null, "resolvedBy": null, "table": { "id": 3, "name": "Meja 3" }, "order": null }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

State values visible in code: `status` `pending` → `approved` \| `rejected` \| `done` (via PUT `/:id/status`).

---

### GET `/waiter-request/customer-list`
No auth (public, customer-facing). Customers list their own table's requests.

**Query:**
| Field | Type | Description |
|-------|------|-------------|
| `store` | number | **Required.** |
| `tableId` | number | **Required**; must belong to `store`. |
| `limit` | number | Default 50. |

**Response:**
```json
{
  "success": true,
  "message": "Success get customer waiter requests",
  "data": [
    { "id": 1, "store": [1], "requestNumber": "WR0815-0042", "tableId": 3, "type": "tisu", "status": "pending", "table": { "id": 3, "name": "Meja 3" }, "order": { "id": 9, "orderNumber": "ORD-001" } }
  ]
}
```

Key errors: 400 `Invalid store value`; 400 `tableId is required`; 400 `Table not found`.

---

### GET `/waiter-request/pending`
Auth required (any authenticated role, store access). Pending requests only, oldest first.

**Query:**
| Field | Type | Description |
|-------|------|-------------|
| `page` | number | Default 1. |
| `limit` | number | Default 50. |
| `store` | number | Optional store override. |

**Response:** same item shape as `GET /waiter-request` (pending only) with `pagination` `{ page, limit, total, totalPages }`.

---

### POST `/waiter-request/customer-create`
No auth (public, customer-facing). Creates a waiter call; the store is derived from the table (`tableId` must belong to `store`). Emits socket events `waiter-request:new` and `new-notification`.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `store` | number | **Required.** |
| `tableId` | number | **Required**; must belong to `store`. |
| `type` | string | **Required.** `sendok` \| `tisu` \| `refill` \| `bill` \| `call`. |
| `orderId` | number | Optional. |
| `notes` | string | Optional. |
| `customerName` | string | Optional. |

**Response (201):**
```json
{
  "success": true,
  "message": "Waiter request created",
  "data": { "id": 1, "store": [1], "requestNumber": "WR0815-0042", "tableId": 3, "orderId": null, "type": "tisu", "notes": null, "customerName": null, "status": "pending", "table": { "id": 3, "name": "Meja 3" }, "order": null }
}
```

Key errors: 400 `store and type are required`; 400 `tableId is required`; 400 `Table not found`; 400 `Invalid request type`.

---

### PUT `/waiter-request/:id/status`
Auth required (super_admin/admin/kasir, store access; store-scoped via JSONB store array).

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `status` | string | **Required.** `pending` \| `approved` \| `rejected` \| `done`. |
| `notes` | string | Optional; overwrites `notes` when sent. |

**Response:**
```json
{
  "success": true,
  "message": "Waiter request approved",
  "data": { "id": 1, "status": "approved", "resolvedBy": 5, "resolvedAt": "2026-10-19T09:00:00.000Z", "table": { "id": 3, "name": "Meja 3" }, "order": null }
}
```

For `approved`/`rejected`/`done` the controller sets `resolvedBy` (caller) and `resolvedAt`; emits `waiter-request:statusChanged`.

Key errors: 400 `Invalid status`; 404 `Waiter request not found`.

---

## Supplier Contact


### GET `/supplier-contact/supplier/:supplierId`
Auth required. Lists contacts of a supplier; ownership is enforced through `supplier.store`, so a supplier outside the caller's store scope answers 404.

**Response:**
```json
{
  "success": true,
  "message": "Success get contacts",
  "data": [
    { "id": 1, "supplier": 2, "fullName": "Budi", "position": "Sales", "email": "budi@supplier.com", "phone": "08123456789" }
  ]
}
```

Key errors: 404 Supplier not found.

---

### GET `/supplier-contact/:id`
Auth required. Contact detail (ownership through `supplier.store`).

**Response:**
```json
{
  "success": true,
  "message": "Success get contact",
  "data": { "id": 1, "supplier": 2, "fullName": "Budi", "position": "Sales", "email": "budi@supplier.com", "phone": "08123456789", "supplierData": { "id": 2, "name": "PT Sumber Rejeki" } }
}
```

Key errors: 404 Contact not found.

---

### POST `/supplier-contact/supplier/:supplierId`
Auth required (super_admin/admin). Creates a contact for a supplier.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `fullName` | string | Required |
| `position` | string | Optional |
| `email` | string | Optional |
| `phone` | string | Optional |

**Response (201):**
```json
{
  "success": true,
  "message": "Success create contact",
  "data": { "id": 1, "supplier": 2, "fullName": "Budi", "position": "Sales", "email": "budi@supplier.com", "phone": "08123456789" }
}
```

Key errors: 400 Contact name is required; 404 Supplier not found.

---

### PUT `/supplier-contact/:id`
Auth required (super_admin/admin). Same fields, all optional.

**Response:**
```json
{ "success": true, "message": "Success update contact", "data": { "id": 1, "fullName": "Budi Santoso" } }
```

Key errors: 400 Contact name is required (empty `fullName`); 404 Contact not found.

---

### DELETE `/supplier-contact/:id`
Auth required (super_admin/admin). Deletes a contact.

**Response:**
```json
{ "success": true, "message": "Success delete contact" }
```

Key errors: 404 Contact not found.

---

---

## Supplier Category


### GET `/supplier-category`
Auth required. Paginated supplier-category list.

**Query:**
| Param | Type | Description |
|-------|------|-------------|
| `search` | string | Name filter (`iLike`) |
| `status` | string/boolean | `true` → active, otherwise inactive |
| `page` | number | Default 1 |
| `limit` | number | Default 50 |

**Response:**
```json
{
  "success": true,
  "message": "Success get supplier categories",
  "data": [
    { "id": 1, "name": "Sembako", "description": null, "status": "active" }
  ],
  "stats": { "total": 1 }
}
```

---

### GET `/supplier-category/:id`
Auth required. Category detail plus the suppliers assigned to it.

**Response:**
```json
{
  "success": true,
  "message": "Success get supplier category",
  "data": {
    "id": 1,
    "name": "Sembako",
    "description": null,
    "status": "active",
    "suppliers": [
      { "id": 2, "name": "PT Sumber Rejeki", "status": "active", "phone": "021-1234", "email": "info@sumber.com", "contactPerson": "Budi" }
    ],
    "supplierCount": 1
  }
}
```

Key errors: 404 Supplier category not found.

---

### POST `/supplier-category`
Auth required (super_admin/admin). Creates a supplier category (JSON body, no Zod schema on this route).

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Required |
| `description` | string | Optional |
| `status` | string | Default `active` |

**Response (201):**
```json
{
  "success": true,
  "message": "Success create supplier category",
  "data": { "id": 1, "name": "Sembako", "description": null, "status": "active" }
}
```

Key errors: 400 Category name is required; 409 Category name already exists (case-insensitive, including soft-deleted rows).

---

### PUT `/supplier-category/:id`
Auth required (super_admin/admin). Same fields, all optional.

**Response:**
```json
{ "success": true, "message": "Success update supplier category", "data": { "id": 1, "name": "Sembako", "status": "active" } }
```

Key errors: 404 Supplier category not found; 409 Category name already exists.

---

### DELETE `/supplier-category/:id`
Auth required (super_admin/admin). Deletes a supplier category (blocked while suppliers are still assigned).

**Response:**
```json
{ "success": true, "message": "Success delete supplier category" }
```

Key errors: 404 Supplier category not found; 400 `Cannot delete category: N supplier(s) still assigned to this category`.

---

---

## Supplier Bank Account


### GET `/supplier-bank-account/supplier/:supplierId`
Auth required. Lists a supplier's bank accounts (ownership through `supplier.store`); default account first.

**Response:**
```json
{
  "success": true,
  "message": "Success get bank accounts",
  "data": [
    { "id": 1, "supplier": 2, "bankName": "BCA", "accountNumber": "1234567890", "accountName": "PT Sumber Rejeki", "isDefault": true, "status": "active" }
  ]
}
```

Key errors: 404 Supplier not found.

---

### GET `/supplier-bank-account/:id`
Auth required. Bank-account detail (ownership through `supplier.store`).

**Response:**
```json
{
  "success": true,
  "message": "Success get bank account",
  "data": { "id": 1, "supplier": 2, "bankName": "BCA", "accountNumber": "1234567890", "accountName": "PT Sumber Rejeki", "isDefault": true, "status": "active", "supplierData": { "id": 2, "name": "PT Sumber Rejeki" } }
}
```

Key errors: 404 Bank account not found.

---

### POST `/supplier-bank-account/supplier/:supplierId`
Auth required (super_admin/admin). Creates a bank account; when `isDefault` is true, any other default account of the supplier is cleared first.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `bankName` | string | Required |
| `accountNumber` | string | Required |
| `accountName` | string | Required |
| `isDefault` | boolean | Optional |
| `status` | string | Default `active` |

**Response (201):**
```json
{
  "success": true,
  "message": "Success create bank account",
  "data": { "id": 1, "supplier": 2, "bankName": "BCA", "accountNumber": "1234567890", "accountName": "PT Sumber Rejeki", "isDefault": true, "status": "active" }
}
```

Key errors: 400 Bank name, account number, and account name are required; 404 Supplier not found.

---

### PUT `/supplier-bank-account/:id`
Auth required (super_admin/admin). Same fields, all optional; setting `isDefault` true clears the supplier's other defaults.

**Response:**
```json
{ "success": true, "message": "Success update bank account", "data": { "id": 1, "bankName": "Mandiri", "isDefault": false } }
```

Key errors: 404 Bank account not found.

---

### DELETE `/supplier-bank-account/:id`
Auth required (super_admin/admin). Deletes a bank account.

**Response:**
```json
{ "success": true, "message": "Success delete bank account" }
```

Key errors: 404 Bank account not found.

---

---

## Goods Request


### GET `/goods-request/get-all`
Auth required. Paginated goods-request (Permintaan Barang) list. Non-super_admin is pinned to its own store; `super_admin` may select a store with `queryStore`.

**Query:**
| Param | Type | Description |
|-------|------|-------------|
| `page` | number | Default 1 |
| `limit` | number | Default 10 |
| `status` | string | Filter (e.g. `pending`, `approved`, `rejected`, `cancelled`, `draft`) |
| `search` | string | Matches requestNumber, requestedBy, store name |
| `supplier` | number | Requests having an item for that supplier |
| `queryStore` | number | super_admin only — target store |
| `startDate` / `endDate` | string | ISO date range on createdAt |

**Response:**
```json
{
  "success": true,
  "message": "Success",
  "data": [
    {
      "id": 1,
      "requestNumber": "PB-20261019-0001",
      "status": "pending",
      "requestedBy": "Budi",
      "notes": "",
      "approvedAt": null,
      "purchaseOrderId": null,
      "purchaseOrderData": null,
      "store": { "id": 1, "name": "Store Jakarta" },
      "items": [
        { "id": 1, "supplier": 2, "productName": "Indomie Goreng", "ingredientName": null, "qty": 10, "unit": "pcs" }
      ],
      "totalItems": 1,
      "totalQty": 10
    }
  ],
  "pagination": { "page": 1, "limit": 10, "total": 1, "totalPages": 1 },
  "stats": { "total": 1, "pending": 1, "approved": 0, "rejected": 0, "cancelled": 0 }
}
```

---

### GET `/goods-request/get-by-id/:id`
Auth required. Full detail; non-super_admin requests pinned to the caller's store (foreign/missing ids answer 404).

**Response:**
```json
{
  "success": true,
  "message": "Success",
  "data": {
    "id": 1,
    "requestNumber": "PB-20261019-0001",
    "status": "pending",
    "requestedBy": "Budi",
    "store": 1,
    "storeData": { "id": 1, "name": "Store Jakarta" },
    "purchaseOrderData": null,
    "approvedByUser": null,
    "createdByUser": { "id": 5, "userName": "admin", "fullName": "Admin" },
    "items": [
      {
        "id": 1,
        "supplier": 2,
        "productName": "Indomie Goreng",
        "qty": 10,
        "unit": "pcs",
        "productData": null,
        "ingredientData": null,
        "supplierData": { "id": 2, "name": "PT Sumber Rejeki" }
      }
    ]
  }
}
```

Key errors: 404 Goods request not found.

---

### POST `/goods-request/create`
Auth required (super_admin/admin). Creates a pending request (`requestNumber` = `PB-YYYYMMDD-NNNN`); the store is resolved server-side.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `items` | array | Required, min 1 |
| `items[].product` / `items[].productName` | number / string | Product reference or free-text name |
| `items[].ingredient` / `items[].ingredientName` | number / string | Ingredient reference or free-text name |
| `items[].supplier` | number | Supplier for the item |
| `items[].qty` | number | Required |
| `items[].unit` | string | Default `pcs` |
| `items[].notes` | string | Optional |
| `requestedBy` | string | Default `''` |
| `requestDate` / `neededDate` | string | Optional dates |
| `notes` | string | Default `''` |

**Response (201):**
```json
{
  "success": true,
  "message": "Success create goods request",
  "data": {
    "id": 1,
    "requestNumber": "PB-20261019-0001",
    "store": 1,
    "status": "pending",
    "requestedBy": "Budi",
    "items": [
      { "id": 1, "productName": "Indomie Goreng", "ingredientName": null, "supplier": 2, "qty": 10, "unit": "pcs", "notes": null }
    ]
  }
}
```

Key errors: 400 Items are required (also enforced by schema).

---

### PUT `/goods-request/update/:id`
Auth required (super_admin/admin). Edits header fields and replaces the item list in one transaction; only `pending` or `cancelled` requests are editable (a cancelled request returns to `draft`).

**Body:** same fields as create, all optional (`items` still required by handler).

**Response:**
```json
{ "success": true, "message": "Success update goods request", "data": { "id": 1, "status": "pending" } }
```

Key errors: 404 Goods request not found; 400 `Only pending or cancelled goods request can be updated`; 400 Items are required.

---

### DELETE `/goods-request/delete/:id`
Auth required (super_admin/admin). Deletes a request; only `pending` or `cancelled` requests can be deleted.

**Response:**
```json
{ "success": true, "message": "Success delete goods request", "data": { "id": 1 } }
```

Key errors: 404 Goods request not found; 400 `Only pending or cancelled goods request can be deleted`.

---

### PATCH `/goods-request/status/:id`
Auth required (super_admin/admin). Transitions a request. `approved` creates a draft purchase order whose item prices are resolved from the supplier catalog (`supplier_product`, fallback 0); from `approved`, only `cancelled` is accepted and it removes the linked PO while it is still draft.

**Body:**
| Field | Type | Description |
|-------|------|-------------|
| `status` | string | Required: `approved` \| `rejected` \| `cancelled` |

**Response (approved):**
```json
{
  "success": true,
  "message": "Goods request approved, draft purchase order created",
  "data": { "id": 1, "status": "approved", "purchaseOrderId": 9, "orderNumber": "PO-20261019-0003" }
}
```

**Response (rejected/cancelled):**
```json
{ "success": true, "message": "Goods request rejected", "data": { "id": 1, "status": "rejected" } }
```

Key errors: 400 Invalid status; 404 Goods request not found; 400 `Goods request is already <status>`; 400 `Cannot cancel goods request because its purchase order is no longer a draft`.

---

---

## FAQ

### GET `/faq/faq`
No auth. **Query:** `search` (string), `category` (string).

**Response:**
```json
{
  "success": true,
  "data": [
    { "id": 1, "question": "How to add product?", "answer": "Go to Product > Add...", "category": "product" }
  ]
}
```

---

### POST `/faq/faq/ask`
No auth. Ask Gemini AI assistant.

**Request:**
```json
{ "question": "string (required)" }
```

**Response:**
```json
{
  "success": true,
  "data": { "answer": "AI-generated answer here" }
}
```

---

---

## Assistant

Two groups of routes under `/assistant`.

**Service-to-service (AI assistant):** `Authorization: Bearer $ASSISTANT_SERVICE_SECRET` — NOT JWT. Fails closed: without a configured secret (min 32 chars) every call returns 503 `ASSISTANT_NOT_CONFIGURED`; a wrong secret returns 401 `UNAUTHORIZED`. `:storeId` must be a positive integer; unknown store → 404 `STORE_NOT_FOUND`. Money is IDR; "paid" means `paymentStatus = 'paid'` and status not cancelled/void.

### GET `/assistant/stores/:storeId/summary`
Today vs yesterday sales (store timezone) and low-stock product count.

**Response:**
```json
{ "success": true, "data": { "store": { "id": 1, "name": "…", "city": "…", "status": "active", "timezone": "Asia/Jakarta" }, "currency": "IDR", "localDate": "2026-10-24", "today": { }, "yesterday": { }, "lowStockProducts": 3 } }
```

### GET `/assistant/stores/:storeId/stock`
**Query:** `q` (≤100 chars), `lowOnly` (`true`/`false`), `limit` (1–50, default 20).

**Response:** `{ "success": true, "data": { "store": "…", "total": 12, "products": [{ "id", "name", "sku", "unit", "stock", "minStock", … }] } }`

### GET `/assistant/stores/:storeId/sales`
**Query:** `from`, `to` (`YYYY-MM-DD`, `from ≤ to`, range < 92 days), `limit` (1–50, default 10).

**Response:** `{ "success": true, "data": { "store", "currency": "IDR", "from", "to", "totals", "byDay": [{ "date", "revenue", "orders" }], "byPaymentMethod": [{ "method", "revenue", "orders" }] } }`

### GET `/assistant/stores/:storeId/best-sellers`
Same query as `/sales`.

**Response:** `{ "success": true, "data": { "store", "currency": "IDR", "from", "to", "products": [{ "rank", "name", "quantity", "revenue" }] } }`

**Owner Telegram link (session JWT):** `authorization` + server-side authorization context + canonical permission `store.manage` on the owner's store (the session's active store, or the tenant's only store). No store resolved → 400 `STORE_REQUIRED`.

### POST `/assistant/telegram-link`
Creates a Telegram connect link for the store's assistant chat. **Response** (201): `{ "success": true, "data": <link> }`.

### GET `/assistant/telegram-link`
Link/connection status. **Response:** `{ "success": true, "data": <status> }`.

### DELETE `/assistant/telegram-link`
Disconnects the store's Telegram assistant. **Response:** `{ "success": true, "message": "Telegram disconnected" }`.

---

## Misc

### GET `/health`
No auth. Liveness probe; checks the database (`SELECT 1`).

**Response:**
```json
{ "success": true, "status": "ok", "database": "up", "uptime": 1234 }
```
Key errors: 503 `{"success": false, ...}` (database down).

---

### GET `/`
No auth. Health check.

**Response:**
```
POS API is running
```

### POST `/print-thermal`
Auth required (`super_admin`, `admin`, `kasir`) + private-network guard + rate limit. ESC/POS thermal print via Bluetooth.

---

**Total: 544 route handlers across 77 route modules, plus 3 inline routes in `api/index.js` (547 HTTP routes total).**
