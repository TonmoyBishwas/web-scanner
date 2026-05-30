# Web Scanner API Reference

Base URL: `/api`

All routes are Next.js App Router route handlers. All mutations (POST routes that modify Redis session) use `withLock(token, ...)` from `lib/redis.ts` to prevent race conditions.

## Authentication
All routes require a valid session `token` in the request body or query params. Token is a UUID v4 generated when the bot creates a session.

---

## Carton Scan Routes (Inbound — Receive Goods)

### 1. Create / Get Carton Session
**Endpoint**: `POST /api/session` (create) | `GET /api/session?token=` (get)

Creates or fetches a carton scanning session (Redis key: `session:{token}`, TTL 1h).

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

Sends box sticker image to the bot's `/webhook/process-box-ocr` endpoint for Gemini OCR. Returns immediately; OCR result written back to Redis session asynchronously.

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
**Endpoint**: `POST /api/cloudinary/upload`

Proxies image uploads to Cloudinary (avoids exposing API secret to browser).

**Request Body:** `multipart/form-data` with `file` field

**Response:** `{ "url": "https://res.cloudinary.com/...", "public_id": "warehouse_scans/..." }`

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

**Success Response:**
```json
{
  "found": true,
  "box": {
    "record_id": "recXXX",
    "barcode": "...",
    "sku": "7290...",
    "weight": 12.5,
    "expiry": "311226",
    "status": "Available",
    "batch_id": "recBatchXXX",
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

Marks a box as issued in Airtable (Status → Issued, creates OUT transaction, decrements Stock Batches). Adds to `session.issued_boxes` in Redis.

**Request Body:**
```json
{
  "token": "uuid",
  "barcode": "full-barcode-string",
  "box_record_id": "recXXX",
  "batch_id": "recBatchXXX",
  "item_name": "Chicken Breast",
  "item_name_hebrew": "חזה עוף",
  "supplier": "Poultry Corp",
  "weight": 12.5,
  "quantity_to_subtract": 12.5
}
```

**Response:** `{ "success": true, "transaction_id": "recTxXXX" }`

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

Creates or fetches a multi-pallet scanning session (Redis key: `pallet:multi:{token}`, TTL 2h).

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
  "receipt_id": "recDeliveryXXX",
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

Finalises one pallet within a multi-pallet session: generates LPN, advances `session.current_pallet`, fires `POST /webhook/pallet-complete` to the bot.

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

- `all_done: true` (top-level response field) when this was the last pallet. The Redis session `status` only flips to `'completed'` once all pallets **and** loose boxes are done; while loose boxes are pending it stays `'active'` so a tab refresh can restore the loose-scanning phase.
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

**Steps performed:**
1. Load session from Redis, validate `status === 'active'`
2. Fire-and-forget `POST {BOT_URL}/webhook/loose-boxes-complete` with `{chat_id, document_number, receipt_id, scanned_boxes}`
3. Mark session `status = 'completed'` in Redis

**Response:** `{ "success": true }`

**Bot actions on `/webhook/loose-boxes-complete`:**
- Creates `Pallets` row with `pallet_type="Loose"`, `lpn="LOOSE-{YYYYMMDD}-{docShort}"` (no physical sticker)
- Creates `Box Inventory` rows for each scanned box
- Finalizes the Delivery record

---

### 18. Legacy Pallet Routes (kept for compatibility)

Some older single-pallet routes may still exist (`/api/pallet-session`, `/api/pallet-ocr`). The active path uses `/api/multi-pallet-session` and `/api/multi-pallet-ocr`.

---

## Redis Key Patterns

| Key | TTL | Purpose |
|-----|-----|---------|
| `session:{token}` | 1h | Carton scan session (RECEIVE or ISSUE) |
| `pallet:{token}` | 2h | Legacy single pallet verification session |
| `pallet:multi:{token}` | 2h | Multi-pallet session (current, includes `loose_box_count`) |
| `lock:{token}` | 10s | Distributed lock for mutations |

---

**Last Updated**: 2026-04-30 | Branch: `pallet-flow`
