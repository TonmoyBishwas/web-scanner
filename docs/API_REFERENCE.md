# Web Scanner API Reference

Base URL: `/api`

## Authentication
All API routes (except `/api/log`) require a valid session `token` to be provided in the request body or query parameters. The token is a UUID v4 string generated when the session is created by the Telegram bot.

---

## 1. Scan Barcode
**Endpoint**: `POST /scan`

Records a barcode scan. This is a lightweight endpoint optimized for speed.

**Request Body:**
```json
{
  "token": "uuid-string",
  "barcode": "scanned-barcode-string",
  "timestamp": 1234567890
}
```

**Response:**
```json
{
  "success": true,
  "count": 5, // Total unique items scanned so far
  "isDuplicate": false
}
```

**Notes:**
- Returns `isDuplicate: true` if the barcode was already scanned in this session.
- Uses Redis locking to ensure thread safety.

---

## 2. Trigger OCR
**Endpoint**: `POST /ocr`

Initiates the AI processing for a captured image.

**Request Body:**
```json
{
  "token": "uuid-string",
  "barcode": "barcode-string",
  "image": "base64-string" // OR
  "image_url": "cloudinary-url-string" // PREFERRED
}
```

**Response:**
```json
{
  "success": true
}
```

**Behavior:**
- Sets user session status to `pending`.
- Forwards the request to the Telegram Bot Webhook (`/webhook/process-box-ocr`).
- The Bot handles the actual Gemini API call asynchronously.
- Returns immediately to unblock the UI.

---

## 3. Resolve Issue
**Endpoint**: `POST /resolve`

Manually resolves an OCR issue (missing weight, wrong product).

**Request Body:**
```json
{
  "token": "uuid-string",
  "barcode": "barcode-string",
  "resolved_item_name": "Hebrew Product Name", // Optional
  "resolved_weight": 12.5, // Optional (Float)
  "resolved_expiry": "2025-12-31" // Optional
}
```

**Response:**
```json
{
  "success": true
}
```

**Notes:**
- Updates `ocr_status` to `manual`.
- Recalculates expected vs scans totals for the invoice.
- **CRITICAL**: Uses Redis locking to prevent overwriting concurrent scans.

---

## 4. Get Session
**Endpoint**: `GET /session`

Fetches the current state of the scanning session.

**Query Parameters:**
- `token`: Session token
- `t`: Timestamp (cache buster)

**Response:**
```json
{
  "token": "...",
  "status": "ACTIVE",
  "scanned_barcodes": [
    {
      "barcode": "...",
      "ocr_status": "complete",
      "ocr_data": { ... }
    }
  ],
  "invoice_items": [ ... ], // The manifest
  "scanned_items": { ... } // Aggregated counts
}
```

---

## 5. Complete Session
**Endpoint**: `POST /complete`

Finalizes the session and triggers the inventory save.

**Request Body:**
```json
{
  "token": "uuid-string"
}
```

**Response:**
```json
{
  "success": true,
  "redirect": "https://t.me/YourBotName" // Redirects user back to Telegram
}
```

**Notes:**
- Marks session as `COMPLETED` in Redis.
- Triggers the Bot to save all data to Airtable.
