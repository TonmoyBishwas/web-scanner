# Web Scanner API Reference

Base URL: `/api` — **27 route files** in `app/api/`.

All routes are Next.js App Router route handlers. All mutations (POST routes that modify a session or write persistent records) use `withLock(token, ...)` from `lib/redis.ts` to prevent race conditions. As of the 2026-06-30 Supabase migration, locking was extended to the previously-unlocked `multi-pallet-complete`, `multi-pallet-loose-complete`, and `manual-entry` routes; `withLock` is now a Postgres `locks` table (`acquire_lock` / `release_lock` RPCs), same 10s TTL + 20×250ms retry as the old Redis lock.

> **Data layer (2026-06-30)**: Airtable + Upstash Redis were replaced by **Supabase / Postgres**. Sessions live in the `scan_sessions` table (`token` PK, `kind` enum carton|pallet|multi_pallet, `data` jsonb, `expires_at`), accessed through the unchanged exports in `lib/redis.ts`. Persistent records (`box_inventory`, `stock_batches`, `transactions`, `pallets`) are accessed via `lib/supabase.ts`. **All cross-boundary record ids below — `record_id`, `box_record_id`, `batch_id`, `transaction_id`, `receipt_id` — are now Postgres uuids, not Airtable `rec…` ids.** The `rec…` examples in this doc are historical; treat them as uuids. The scanner now writes Supabase directly (issue-confirm + pallet-complete) and is no longer read-only.

## Authentication
All routes require a valid session `token` in the request body or query params. Token is a UUID v4 generated when the bot creates a session.

---

## Carton Scan Routes (Inbound — Receive Goods)

### 1. Create / Get Carton Session
**Endpoint**: `POST /api/session` (create) | `GET /api/session?token=` (get)

Creates or fetches a carton scanning session (`scan_sessions` row, `kind = 'carton'`, TTL 1h → extended to 24h on finalize).

**POST Request Body:**
```json
{
  "chat_id": "123456789",
  "operation_type": "RECEIVE",
  "invoice_items": [
    {
      "item_index": 0,
      "item_code": "7290123456789",
      "item_name_english": "Chicken Breast",
      "item_name_hebrew": "חזה עוף",
      "quantity_kg": 55.0,
      "expected_boxes": 5
    }
  ],
  "document_number": "INV-001",
  "invoice_image_url": "https://cloudinary.com/..."
}
```

**POST Response:**
```json
{ "token": "uuid", "scan_url": "https://scanner.vercel.app/scan/uuid", "expires_at": "..." }
```

---

### 2. Record Barcode Scan
**Endpoint**: `POST /api/scan`

Records a barcode scan. Deduplicates client-side and server-side.

**Request Body:**
```json
{
  "token": "uuid",
  "barcode": "scanned-barcode-string",
  "parsed_data": { "sku": "7290...", "weight": 0, ... },
  "image_url": "https://cloudinary.com/...",
  "detected_at": "ISO-timestamp"
}
```

**Response:**
```json
{
  "success": true,
  "is_duplicate": false,
  "matched_item": { "item_name": "Chicken Breast", "scanned_count": 3, ... }
}
```

---

### 3. Trigger Box OCR
**Endpoint**: `POST /api/ocr`

Sends box sticker image to the bot's `/webhook/process-box-ocr` endpoint for Gemini OCR. Returns immediately; OCR result written back to the `scan_sessions` row (Supabase) asynchronously.

**Request Body:**
```json
{
  "token": "uuid",
  "barcode": "barcode-string",
  "image_url": "https://cloudinary.com/..."
}
```

**Response:** `{ "success": true }`

---

### 4. Resolve OCR Issue
**Endpoint**: `POST /api/resolve`

Saves manual corrections when OCR failed or returned wrong data.

**Request Body:**
```json
{
  "token": "uuid",
  "barcode": "barcode-string",
  "resolved_item_name": "חזה עוף",
  "resolved_weight": 12.5,
  "resolved_expiry": "2026-03-31"
}
```

**Response:** `{ "success": true }`

---

### 5. Manual Entry Fallback
**Endpoint**: `POST /api/manual-entry`

Used when barcode scan completely fails. Worker types product info.

**Request Body:**
```json
{
  "token": "uuid",
  "item_name": "Chicken Breast",
  "weight": 10.5,
  "expiry": "2026-03-31",
  "image_url": "https://cloudinary.com/..."
}
```

---

### 6. Complete Carton Session
**Endpoint**: `POST /api/complete`

Finalizes the session, re-aggregates scans, and triggers `POST /webhook/scan-complete` on the bot.

**Request Body:** `{ "token": "uuid" }`

**Response:**
```json
{
  "success": true,
  "summary": { "scanned_items": { ... }, "total_weight": 55.0 },
  "scanned_barcodes": [ ... ]
}
```

---

### 7. Image Upload Proxy
**Endpoint**: `POST /api/cloudinary/upload` (path kept for compatibility; now writes to **Supabase Storage**)

Server-side upload to the public Supabase Storage bucket `warehouse-images`
(keeps the service-role key off the browser). Used by the scanner box-scan flow
and by the bot (invoice + LPN sticker).

**Request Body (JSON):** `{ image | image_base64 | image_url, barcode, document_number?, image_type? }`
where `image_type` ∈ `box` (default) | `invoice` | `lpn_sticker`.

**Response:** `{ "success": true, "secure_url": "https://<ref>.supabase.co/storage/v1/object/public/warehouse-images/...", "public_id": "<object key>", "folder": "...", "created_at": "..." }`

---

## Issue Routes (Outbound — Issue to Production via Web Scanner)

### 8. Look Up Box for Issue
**Endpoint**: `POST /api/issue-lookup`

Looks up a box by barcode. Validates it is `Available`, not already issued in this session, and (if LPN-restricted) belongs to the correct pallet.

**Request Body:**
```json
{
  "token": "uuid",
  "barcode": "full-barcode-string"
}
```

**Success Response:** (`record_id` / `batch_id` are Postgres uuids)
```json
{
  "found": true,
  "box": {
    "record_id": "uuid",
    "barcode": "...",
    "sku": "7290...",
    "weight": 12.5,
    "expiry": "311226",
    "status": "Available",
    "batch_id": "uuid",
    "item_name": "Chicken Breast",
    "supplier": "Poultry Corp",
    "invoice_number": "INV-001",
    "received_date": "2026-03-19",
    "production_date": "2026-03-10"
  }
}
```

**Error Response:**
```json
{
  "found": false,
  "error": "not_found | already_issued | wrong_pallet | error",
  "message": "Human readable reason"
}
```

**Notes:**
- `wrong_pallet` error only fires when `session.pallet_record_id` is set (LPN-restricted sessions)
- Session must have `operation_type: "ISSUE"` and `status: "ACTIVE"`

---

### 9. Confirm Box Issue
**Endpoint**: `POST /api/issue-confirm`

Marks a box as issued in Supabase (Status → Issued, creates OUT transaction, decrements stock_batches), under `withLock`. Adds to `session.issued_boxes` in the `scan_sessions` row.

**Request Body:** (`box_record_id` / `batch_id` are Postgres uuids)
```json
{
  "token": "uuid",
  "barcode": "full-barcode-string",
  "box_record_id": "uuid",
  "batch_id": "uuid",
  "item_name": "Chicken Breast",
  "item_name_hebrew": "חזה עוף",
  "supplier": "Poultry Corp",
  "weight": 12.5,
  "quantity_to_subtract": 12.5
}
```

**Response:** `{ "success": true, "transaction_id": "uuid" }`

---

### 10. Complete Issue Session
**Endpoint**: `POST /api/issue-complete`

Finalizes issue session and triggers `POST /webhook/scan-complete` (operation_type: "ISSUE") on the bot.

**Request Body:** `{ "token": "uuid" }`

**Response:** `{ "success": true }`

Bot receives summary with `issued_items[]` and sends the worker a confirmation message with an undo button.

---

## Pallet Verification Routes (Inbound — Pallet Flow + Loose Boxes)

### 11. Create / Get Multi-Pallet Session
**Endpoint**: `POST /api/multi-pallet-session` (create) | `GET /api/multi-pallet-session?token=` (get)

Creates or fetches a multi-pallet scanning session (`scan_sessions` row, `kind = 'multi_pallet'`, TTL 2h).

**POST Request Body:**
```json
{
  "chat_id": "123456789",
  "pallet_number": 1,
  "pallet_count": 3,
  "loose_box_count": 8,
  "scale_weight": 210.5,
  "expected_box_count": 8,
  "invoice_document_number": "INV-001",
  "pallet_type": "single",
  "mix_items": [],
  "receipt_id": "uuid",
  "ocr_data": [
    {
      "item_code": "7290...",
      "item_name_english": "Ground Beef",
      "item_name_hebrew": "בשר טחון",
      "quantity_kg": 220.0
    }
  ]
}
```

- `loose_box_count`: number of loose individual boxes declared by worker (0 if none)
- For mix pallets, `pallet_type: "mix"` and `mix_items` contains per-item data including `uniform_weight` flag.

**POST Response:** `{ "token": "uuid", "url": "https://scanner.vercel.app/pallet-verify/uuid" }`

---

### 12. Record Pallet Box Scan
**Endpoint**: `POST /api/pallet-scan`

Records one box scan for pallet verification. Triggers OCR automatically via `/api/multi-pallet-ocr`.

**Request Body:**
```json
{
  "token": "uuid",
  "barcode": "...",
  "image_url": "https://cloudinary.com/...",
  "image_public_id": "warehouse_scans/..."
}
```

**Response:** `{ "success": true, "scan_count": 3, "unified": true }`

- `unified: true` if all boxes so far have consistent weights (or for mix pallets: each item group is internally consistent)

---

### 13. Synchronous Box OCR (Multi-Pallet)
**Endpoint**: `POST /api/multi-pallet-ocr`

Calls bot's `/webhook/process-box-ocr` synchronously (30s timeout) and returns the OCR result. Used by both pallet boxes and loose boxes (the image captured at scan time is the sticker).

**Request Body:**
```json
{
  "image": "base64-encoded-jpeg",
  "barcode": "optional-barcode-string"
}
```

**Response:**
```json
{
  "success": true,
  "ocr_data": {
    "product_name_hebrew": "חזה עוף",
    "product_name_english": "Chicken Breast",
    "weight_kg": 12.5,
    "expiry_date": "2026-12-31"
  }
}
```

**Notes:**
- The scanner captures a frame at the moment the barcode is detected. That frame IS the box sticker.
- Barcodes themselves carry no parseable data (weight/name/expiry come entirely from OCR).

---

### 14. Manual Box Entry (Pallet)
**Endpoint**: `POST /api/pallet-manual`

Fallback manual entry when OCR fails during pallet scanning.

**Request Body:** `{ "token": "uuid", "barcode": "...", "item_name": "...", "weight": 12.5, "expiry": "2026-03-31" }`

---

### 15. Assign Box to Mix Pallet Item
**Endpoint**: `POST /api/pallet-assign`

Manually assigns an OCR-unresolved box to a specific item on a mix pallet.

**Request Body:** `{ "token": "uuid", "barcode": "...", "item_index": 1 }`

---

### 16. Complete Pallet Verification
**Endpoint**: `POST /api/multi-pallet-complete`

Finalises one pallet within a multi-pallet session: generates LPN, advances `session.current_pallet`, fires `POST /webhook/pallet-complete` to the bot. Now runs under `withLock` (added in the Supabase migration). The sibling `POST /api/pallet-complete` route additionally inserts the pallet into the Supabase `pallets` table via `savePalletToSupabase`.

**Request Body:**
```json
{
  "token": "uuid",
  "scanned_boxes": [
    {
      "barcode": "7290000000550010000041220260001",
      "sku": "7290000000550",
      "item_name": "Ground Beef",
      "item_name_hebrew": "בשר טחון",
      "weight": 27.5,
      "expiry": "2026-12-22",
      "scanned_at": "ISO-timestamp"
    }
  ],
  "box_count": 8,
  "uniform_groups": [
    {
      "sku": "7290000000550",
      "total_count": 21,
      "avg_weight": 27.5
    }
  ]
}
```

- `scanned_boxes[].barcode` is **required** for the bot to persist Box Inventory rows. (It was being silently stripped in earlier versions, see COMMON_ISSUES.md.)
- `box_count` is the worker's declared total for this pallet (used as `Expected Box Count` for single-uniform pallets).
- `uniform_groups[]` is **optional** — present only for mix pallets where one or more sub-items are uniform-weight. Each entry overrides that SKU's per-item `box_count` with `total_count` and forces `uniform_weight: true`. The worker physically scans only 2 sample boxes per uniform sub-item but reports the real count via the prompt UI; the API trusts that count and computes `calculated_total_weight = avg_weight × total_count`.

**Response:**
```json
{
  "success": true,
  "lpn": "LPN-20260319-INV001-P1",
  "lpn_url": "https://scanner.vercel.app/pallet/LPN-...",
  "pallet_number": 1,
  "next_pallet": 2,
  "all_done": false
}
```

**Webhook payload sent to bot:**
```json
{
  "chat_id": "123456789",
  "pallet_number": 1,
  "pallet_count": 3,
  "lpn": "LPN-20260319-INV001-P1",
  "pallet_type": "single",
  "items": [
    {
      "item_code": "7290000000550",
      "item_name": "Ground Beef",
      "item_name_hebrew": "בשר טחון",
      "box_count": 21,
      "calculated_total_weight": 577.5,
      "uniform_weight": true
    }
  ],
  "scanned_boxes": [
    {
      "barcode": "7290000000550010000041220260001",
      "sku": "7290000000550",
      "item_code": "7290000000550",
      "weight": 27.5,
      "expiry": "2026-12-22",
      "item_name": "Ground Beef",
      "item_name_hebrew": "בשר טחון"
    }
  ],
  "scale_weight": 0,
  "document_number": "INV-001",
  "verified_scan_count": 2
}
```

- `all_done: true` (top-level response field) when this was the last pallet. The session `status` (in `scan_sessions.data`) only flips to `'completed'` once all pallets **and** loose boxes are done; while loose boxes are pending it stays `'active'` so a tab refresh can restore the loose-scanning phase.
- Bot creates: Pallet row, Pallet Items rows (Expected Box Count from `items[].box_count`), Box Inventory rows (one per `scanned_boxes` entry), Stock Batches records, IN_PALLET Transaction, updates Delivery Items received qty.

---

### 17. Complete Loose Box Phase
**Endpoint**: `POST /api/multi-pallet-loose-complete`

Submits all scanned loose boxes to the bot after the loose scanning phase is done.

**Request Body:**
```json
{
  "token": "uuid",
  "scanned_boxes": [
    {
      "barcode": "barcode-string",
      "sku": "7290...",
      "item_name": "Chicken Breast",
      "weight": 12.5,
      "expiry": "2026-12-31",
      "image_data": "base64-jpeg-optional"
    }
  ]
}
```

**Steps performed:** (entire handler now runs under `withLock`)
1. Load session from Supabase (`scan_sessions`, `kind = 'multi_pallet'`), validate `status === 'active'`
2. Fire-and-forget `POST {BOT_URL}/webhook/loose-boxes-complete` with `{chat_id, document_number, receipt_id, scanned_boxes}`
3. Mark session `status = 'completed'` in Supabase

**Response:** `{ "success": true }`

**Bot actions on `/webhook/loose-boxes-complete`:**
- Creates `Pallets` row with `pallet_type="Loose"`, `lpn="LOOSE-{YYYYMMDD}-{docShort}"` (no physical sticker)
- Creates `Box Inventory` rows for each scanned box
- Finalizes the Delivery record

---

### 18. AI Name Consolidation

`POST /api/consolidate-items`

Body: `{ groups: IncomingGroup[], language?: string }`

Asks the model whether two OCR'd name groups are the same product (OCR drift on
Hebrew names). The scanner surfaces the answer as the amber "these look like the
same item" banner; the worker accepts or dismisses it, and an accepted merge is
recorded in `acceptedMerges` so both groups share one group key.

---

### 19. Legacy Pallet Routes (kept for compatibility)

Some older single-pallet routes may still exist (`/api/pallet-session`, `/api/pallet-ocr`). The active path uses `/api/multi-pallet-session` and `/api/multi-pallet-ocr`.

---

## Split Assignment Routes (`SPLIT_ASSIGNMENT_ENABLED`)

One delivery's pallets divided across a crew: the manager plans, workers claim
slots. Shipped 2026-08-11; the bot-side flag gates whether the option is ever
offered.

### 20. Create Planning Session

`POST /api/split-plan-session`

Body: `{ chat_id, document_number, ocr_data, roster, language, category, receipt_id, meat_discrepancy }`

Returns the manager's `/assign/[token]` link. `meat_discrepancy` must be carried
through — without it split workers silently lose the damaged-sticker declared-count
mode and the "create LPN anyway" force-confirm.

### 21. Read / Save / Amend the Plan

- `GET  /api/split-plan?token=…` — current plan + live board state
- `POST /api/split-plan` — `{ token, pallet_count, loose_box_count?, assignments: [{chat_id, quota|null}], loose_owner? }`
- `PATCH /api/split-plan` — `{ token, worker_chat_id, pallet_count, assignments }`

A `null` quota means *pool-only* (the worker takes from the shared pool rather
than holding reserved slots). **Quotas are runtime-coerced with `Number()` before
any arithmetic** — the body is only TS-cast, so numeric strings would otherwise
concatenate (`"1"+"2"+"3"` → `123`) and reject a valid plan.

### 22. Claim / Release / Close a Slot

`POST /api/pallet-claim`

Body: `{ token, worker_chat_id, action, pallet_n?, to_chat_id? }`

Runs under `withLock`. Once an action leaves the job complete it sets
`session.status = 'completed'`, and every action is rejected outright thereafter —
otherwise "+ Add pallet" could mint a new claimed slot on a finished session,
pass `multi-pallet-complete`'s own guard, and re-run the bot's finalize,
**double-booking stock**.

---

## Drawer Routes (read-only)

Browsers behind the hamburger drawer. All four are guarded by
`lib/session-guard.ts`: the caller must present a **live `scan_sessions` token**.
They read only; none of them writes.

### 23. Pallets Browser

- `GET /api/pallets?token=…` — plus `barcode` (find the pallet holding a box),
  `lpn` (find by sticker), `status`, `q`, `page`
- `GET /api/pallets/detail?token=…&id=…` — one pallet with per-item remaining counts

Availability math mirrors the bot's: uniform → `expected − issued`, non-uniform →
count of `Available` rows, non-meat → `non_meat_inventory`, Loose → grouped by
batch/SKU. Note the `pallet_status` enum has **no `Receiving`** value — active
means `In Stock` / `Partially Issued` / `Verified`.

### 24. Documents Archive

- `GET /api/documents?token=…` — plus `category`, `month`, `q`, `page`
- `GET /api/documents/detail?token=…&source=…&id=…` — invoice photo, lines with
  their gaps (פער), pallets hand-off, and the Type B voice-note transcript

### 25. Carton Labels (צור קרטון / מדבקות)

- `GET /api/carton-labels?token=…&scope=delivery|all&status=all|created|printed`
  — the Labels list. `scope=delivery` (default) filters to the session's own
  document; an ISSUE session has none and falls back to `all`.
- `POST /api/carton-labels` — mint stickers for one invoice line.
  Body: `item_code`, `item_name_hebrew`/`_english`, `weight_kg` (nullable),
  `quantity` (1–500), `production_date`, `expiry_date`, `notes`,
  `print_barcode` (default **true**). Returns **one row per carton**, each with
  its own barcode — the inbound path dedupes on barcode, so shared codes would
  collapse into a single box.
- `DELETE /api/carton-labels?token=…&batch=…` — drop a whole batch.
- `GET /api/carton-labels/print?token=…&batches=…` — feeds the print sheet.
  Addressed by batch, not by label id: a 200-id URL exceeds what some browsers
  accept.
- `POST /api/carton-labels/print` — mark `{batch_ids | ids}` printed and bump
  `print_count`. Records the hand-off to the browser's print dialog; the
  browser never reports whether paper actually came out.

⚠️ These write, unlike the other drawer routes — but only to `carton_labels`.
**Creating a sticker books no stock**: it writes no delivery, pallet or box row.
The printed sticker goes on the carton and is scanned in through the normal
receiving flow, which is why every sticker carries a real Code 128 barcode
(`lib/code128.ts`; `28` + YYMMDD + 8 digits, the GS1 internal prefix range, so a
minted code can never collide with a supplier GTIN).

---

## Session Storage (`scan_sessions` table)

Backed by Supabase / Postgres since 2026-06-30 (was Upstash Redis). Single `scan_sessions` table keyed by `token`; the old Redis namespaces map to the `kind` column. TTL is enforced lazily on read (`expires_at > now()`).

| Old Redis key | `kind` | TTL | Purpose |
|---------------|--------|-----|---------|
| `session:{token}` | `carton` | 1h (→ 24h on finalize) | Carton scan session (RECEIVE or ISSUE) |
| `pallet:{token}` | `pallet` | 2h | Legacy single pallet verification session |
| `pallet:multi:{token}` | `multi_pallet` | 2h | Multi-pallet session (current, includes `loose_box_count`) |

Distributed locks now live in a Postgres `locks` table (`acquire_lock` / `release_lock` RPCs), 10s TTL — same semantics as the old `lock:{token}` Redis key.

## Environment Variables

| Var | Purpose |
|-----|---------|
| `SUPABASE_URL` | Supabase project URL (e.g. `https://vkeqzvwnqkuuwurgjjkd.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | `sb_secret_…` service-role key (server-side only; bypasses RLS) |
| `TELEGRAM_BOT_WEBHOOK_URL` | Bot webhook base URL (Railway) |
| `NEXT_PUBLIC_APP_URL` | Public scanner URL |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Also back image uploads to Storage (bucket `warehouse-images`) — Cloudinary removed |
| `OPENROUTER_API_KEY` | LLM invoice matching |
| `LPN_SECRET` | Shared HMAC secret for LPN sticker QR signatures |

Removed in the migration: `KV_REST_API_URL`, `KV_REST_API_TOKEN`, and all `AIRTABLE_*` vars.

---

**Last Updated**: 2026-08-14 (documented the split-assignment, drawer-browser and consolidate-items routes; route count 18 → 25) | Working branch: `preview` | Production branch: `main`
